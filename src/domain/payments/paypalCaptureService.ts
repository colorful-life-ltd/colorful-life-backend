import { checkPaymentAdmission, journalPayPalCapture } from "./paymentResolutionService.js";
import { Decimal } from "@prisma/client/runtime/client";
import { OrderStatus, PaymentProvider, PaymentStatus } from "../../generated/prisma-client/enums.js";
import { prisma } from "../../prisma/runtime.js";
import { config } from "../../config/index.js";
import { payPalLateSuccessDiagnostic, recordPayPalSuccess } from "./paypalPaymentOutcome.js";

export class PayPalCaptureOrderNotFoundError extends Error {}
export class PayPalCaptureOwnershipError extends Error {}
export class PayPalCapturePaymentNotFoundError extends Error {}
export class PayPalCaptureWrongProviderError extends Error {}
export class PayPalCaptureExpiredError extends Error {}
export class PayPalCaptureCancelledError extends Error {}
export class PayPalCaptureAlreadyCompletedError extends Error {}
export class PayPalCaptureProviderError extends Error {}
export class PayPalCaptureMismatchError extends Error {}

export type PayPalCaptureResponse = {
  id: string;
  status: string;
  purchase_units?: Array<{ payments?: { captures?: Array<{ id?: string; status?: string; amount?: { value?: string; currency_code?: string } }> } }>;
};

export type PayPalCaptureClient = {
  captureOrder(orderId: string, requestId: string): Promise<PayPalCaptureResponse>;
};

let testClient: PayPalCaptureClient | undefined;
type CaptureResult = { paymentId: number; paypalOrderId: string; captureId: string | null };
const inFlight = new Map<number, Promise<CaptureResult>>();

export function setPayPalCaptureClientForTests(client: PayPalCaptureClient): () => void {
  const previous = testClient;
  testClient = client;
  return () => { testClient = previous; };
}

function amountString(amount: Decimal): string {
  return amount.toFixed(2);
}

function createPayPalCaptureClient(): PayPalCaptureClient {
  if (!config.PAYPAL_CLIENT_ID || !config.PAYPAL_CLIENT_SECRET) throw new PayPalCaptureProviderError("PayPal is not configured");
  let accessToken: string | undefined;
  return {
    async captureOrder(orderId, requestId) {
      try {
        if (!accessToken) {
          const credentials = Buffer.from(`${config.PAYPAL_CLIENT_ID}:${config.PAYPAL_CLIENT_SECRET}`).toString("base64");
          const auth = await fetch(`${config.PAYPAL_BASE_URL}/v1/oauth2/token`, { method: "POST", headers: { Authorization: `Basic ${credentials}`, "Content-Type": "application/x-www-form-urlencoded" }, body: "grant_type=client_credentials" });
          if (!auth.ok) throw new Error("oauth failure");
          accessToken = (await auth.json() as { access_token: string }).access_token;
        }
        const response = await fetch(`${config.PAYPAL_BASE_URL}/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, { method: "POST", headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json", "PayPal-Request-Id": requestId } });
        if (!response.ok) throw new Error("capture failure");
        return await response.json() as PayPalCaptureResponse;
      } catch { throw new PayPalCaptureProviderError("PayPal capture operation failed"); }
    },
  };
}

async function execute(orderId: number, userId: number, client?: PayPalCaptureClient) {
  const prepared = await prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<Array<{ id: number; userId: number; status: OrderStatus; reservationExpiresAt: Date | null }>>`SELECT "id", "userId", "status", "reservationExpiresAt" FROM "Order" WHERE "id" = ${orderId} FOR UPDATE`;
    const order = locked[0];
    if (!order) throw new PayPalCaptureOrderNotFoundError();
    if (order.userId !== userId) throw new PayPalCaptureOwnershipError();
    if (order.status === OrderStatus.CANCELLED) throw new PayPalCaptureCancelledError();
    if (order.status === OrderStatus.EXPIRED) throw new PayPalCaptureExpiredError();
    const payment = await tx.payment.findUnique({ where: { orderId } });
    if (!payment) {
      if (order.reservationExpiresAt && order.reservationExpiresAt <= new Date()) throw new PayPalCaptureExpiredError();
      throw new PayPalCapturePaymentNotFoundError();
    }
    if (payment.provider !== PaymentProvider.PAYPAL) throw new PayPalCaptureWrongProviderError();
    if (payment.status === PaymentStatus.SUCCEEDED || payment.paidAt) {
      if (payment.status === PaymentStatus.SUCCEEDED && payment.providerCaptureReference && !payment.providerReference.startsWith("pending:")) {
        return { completed: { paymentId: payment.id, paypalOrderId: payment.providerReference, captureId: payment.providerCaptureReference } };
      }
      throw new PayPalCaptureAlreadyCompletedError();
    }
    const managed = await checkPaymentAdmission(tx, orderId);
    if (!managed && order.reservationExpiresAt && order.reservationExpiresAt <= new Date()) throw new PayPalCaptureExpiredError();
    const operation = await journalPayPalCapture(tx, payment);
    if (payment.currency !== "GBP") throw new PayPalCaptureMismatchError("Unsupported payment currency");
    if (!payment.providerReference || payment.providerReference.startsWith("pending:")) throw new PayPalCaptureProviderError("PayPal Order is not available");
    const requestId = operation?.operationKey ?? payment.captureIdempotencyKey ?? `order-${orderId}-paypal-capture`;
    if (!payment.captureIdempotencyKey) await tx.payment.update({ where: { id: payment.id }, data: { captureIdempotencyKey: requestId } });
    return { paymentId: payment.id, paypalOrderId: payment.providerReference, requestId, amount: new Decimal(payment.amount) };
  });

  if ("completed" in prepared) return prepared.completed!;

  let captured: PayPalCaptureResponse;
  try {
    captured = await (client ?? testClient ?? createPayPalCaptureClient()).captureOrder(prepared.paypalOrderId, prepared.requestId);
  } catch (error) {
    if (error instanceof PayPalCaptureProviderError) throw error;
    throw new PayPalCaptureProviderError("PayPal capture operation failed");
  }
  const captures = captured.purchase_units?.flatMap((unit) => unit.payments?.captures ?? []) ?? [];
  const capture = captures[0];
  if (captures.length !== 1 || captured.id !== prepared.paypalOrderId || captured.status !== "COMPLETED" || capture?.status !== "COMPLETED" || !capture.id || capture.amount?.currency_code?.toUpperCase() !== "GBP" || capture.amount.value !== amountString(prepared.amount)) {
    throw new PayPalCaptureMismatchError("PayPal capture did not match the local payment");
  }

  return prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<Array<{ id: number; status: OrderStatus; reservationExpiresAt: Date | null }>>`SELECT "id", "status", "reservationExpiresAt" FROM "Order" WHERE "id" = ${orderId} FOR UPDATE`;
    const order = locked[0];
    const payment = await tx.payment.findUnique({ where: { id: prepared.paymentId } });
    if (!order || !payment) throw new PayPalCaptureOrderNotFoundError();
    if (payment.orderId !== orderId || payment.provider !== PaymentProvider.PAYPAL || payment.providerReference !== prepared.paypalOrderId || payment.currency !== "GBP" || amountString(new Decimal(payment.amount)) !== capture.amount!.value || (payment.providerCaptureReference && payment.providerCaptureReference !== capture.id)) throw new PayPalCaptureMismatchError("PayPal capture did not match the current payment");
    const now = new Date();
    const updated = await recordPayPalSuccess(tx, payment, capture.id!, now);
    const processingError = payPalLateSuccessDiagnostic(order, now);
    if (processingError) {
      await tx.paymentWebhookEvent.upsert({ where: { provider_providerEventId: { provider: PaymentProvider.PAYPAL, providerEventId: `capture:${capture.id}` } },
        create: { provider: PaymentProvider.PAYPAL, providerEventId: `capture:${capture.id}`, eventType: "PAYMENT.CAPTURE.COMPLETED", processedAt: now, processingError },
        update: { processedAt: now, processingError } });
    }
    return { paymentId: updated.id, paypalOrderId: updated.providerReference, captureId: updated.providerCaptureReference };
  });
}

export async function capturePayPalOrder(orderId: number, userId: number, client?: PayPalCaptureClient): Promise<CaptureResult> {
  // The cache is only an optimization. Every caller is authorized against current
  // database ownership, even while another customer's provider operation is paused.
  const order = await authorize(orderId, userId);
  if (order.status === OrderStatus.CANCELLED) throw new PayPalCaptureCancelledError();
  if (order.status === OrderStatus.EXPIRED) throw new PayPalCaptureExpiredError();
  const existing = inFlight.get(orderId);
  if (existing) { const result = await existing; await authorize(orderId, userId); return result; }
  const operation = execute(orderId, userId, client);
  inFlight.set(orderId, operation);
  try { const result = await operation; await authorize(orderId, userId); return result; } finally { if (inFlight.get(orderId) === operation) inFlight.delete(orderId); }
}

async function authorize(orderId: number, userId: number) {
  const order = await prisma.order.findUnique({ where: { id: orderId }, select: { userId: true, status: true } });
  if (!order) throw new PayPalCaptureOrderNotFoundError();
  if (order.userId !== userId) throw new PayPalCaptureOwnershipError();
  return order;
}
