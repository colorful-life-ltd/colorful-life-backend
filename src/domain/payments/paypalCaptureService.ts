import { Decimal } from "@prisma/client/runtime/client";
import { OrderStatus, PaymentProvider, PaymentStatus } from "../../generated/prisma-client/enums.js";
import { prisma } from "../../prisma/runtime.js";
import { config } from "../../config/index.js";

export class PayPalCaptureOrderNotFoundError extends Error {}
export class PayPalCaptureOwnershipError extends Error {}
export class PayPalCapturePaymentNotFoundError extends Error {}
export class PayPalCaptureWrongProviderError extends Error {}
export class PayPalCaptureExpiredError extends Error {}
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
    const decisionTime = new Date();
    if (order.status === OrderStatus.EXPIRED || (order.reservationExpiresAt && order.reservationExpiresAt <= decisionTime)) throw new PayPalCaptureExpiredError();
    const payment = await tx.payment.findUnique({ where: { orderId } });
    if (!payment) throw new PayPalCapturePaymentNotFoundError();
    if (payment.provider !== PaymentProvider.PAYPAL) throw new PayPalCaptureWrongProviderError();
    if (payment.status === PaymentStatus.SUCCEEDED) throw new PayPalCaptureAlreadyCompletedError();
    if (!payment.providerReference || payment.providerReference.startsWith("pending:")) throw new PayPalCaptureProviderError("PayPal Order is not available");
    const requestId = payment.captureIdempotencyKey ?? `order-${orderId}-paypal-capture`;
    if (!payment.captureIdempotencyKey) await tx.payment.update({ where: { id: payment.id }, data: { captureIdempotencyKey: requestId } });
    return { paymentId: payment.id, paypalOrderId: payment.providerReference, requestId, amount: new Decimal(payment.amount) };
  });

  let captured: PayPalCaptureResponse;
  try {
    captured = await (client ?? testClient ?? createPayPalCaptureClient()).captureOrder(prepared.paypalOrderId, prepared.requestId);
  } catch (error) {
    if (error instanceof PayPalCaptureProviderError) throw error;
    throw new PayPalCaptureProviderError("PayPal capture operation failed");
  }
  const capture = captured.purchase_units?.flatMap((unit) => unit.payments?.captures ?? [])[0];
  if (captured.id !== prepared.paypalOrderId || captured.status !== "COMPLETED" || capture?.status !== "COMPLETED" || !capture.id || capture.amount?.currency_code?.toUpperCase() !== "GBP" || capture.amount.value !== amountString(prepared.amount)) {
    throw new PayPalCaptureMismatchError("PayPal capture did not match the local payment");
  }

  return prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<Array<{ id: number; status: OrderStatus; reservationExpiresAt: Date | null }>>`SELECT "id", "status", "reservationExpiresAt" FROM "Order" WHERE "id" = ${orderId} FOR UPDATE`;
    const order = locked[0];
    const payment = await tx.payment.findUnique({ where: { id: prepared.paymentId } });
    if (!order || !payment) throw new PayPalCaptureOrderNotFoundError();
    if (payment.status === PaymentStatus.SUCCEEDED) return { paymentId: payment.id, paypalOrderId: payment.providerReference, captureId: payment.providerCaptureReference };
    const expired = order.status === OrderStatus.EXPIRED || (order.reservationExpiresAt && order.reservationExpiresAt <= new Date());
    const now = new Date();
    const updated = await tx.payment.update({ where: { id: payment.id }, data: { status: PaymentStatus.SUCCEEDED, paidAt: now, providerCaptureReference: capture.id } });
    if (expired || order.status === OrderStatus.CANCELLED) {
      await tx.paymentWebhookEvent.create({ data: { provider: PaymentProvider.PAYPAL, providerEventId: `capture:${capture.id}`, eventType: "PAYMENT.CAPTURE.COMPLETED", processedAt: now, processingError: order.status === OrderStatus.CANCELLED ? "Captured payment for cancelled order requires refund/reconciliation" : "Captured payment for expired order requires refund/reconciliation" } });
    }
    return { paymentId: updated.id, paypalOrderId: updated.providerReference, captureId: updated.providerCaptureReference };
  });
}

export async function capturePayPalOrder(orderId: number, userId: number, client?: PayPalCaptureClient): Promise<CaptureResult> {
  const existing = inFlight.get(orderId);
  if (existing) return existing;
  const operation = execute(orderId, userId, client);
  inFlight.set(orderId, operation);
  try { return await operation; } finally { if (inFlight.get(orderId) === operation) inFlight.delete(orderId); }
}
