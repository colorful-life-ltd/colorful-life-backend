import { Decimal } from "@prisma/client/runtime/client";
import { randomUUID } from "node:crypto";
import { OrderStatus, PaymentProvider, PaymentStatus } from "../../generated/prisma-client/enums.js";
import { prisma } from "../../prisma/runtime.js";
import { config } from "../../config/index.js";

export class PayPalOrderNotFoundError extends Error {}
export class PayPalOrderOwnershipError extends Error {}
export class PayPalOrderExpiredError extends Error {}
export class PayPalOrderAlreadyCompletedError extends Error {}
export class PayPalProviderError extends Error {}

type PayPalCreateInput = { intent: "CAPTURE"; purchase_units: [{ reference_id: string; custom_id: string; amount: { currency_code: "GBP"; value: string } }] };
type PayPalCreateResponse = { id: string; links?: Array<{ rel: string; href: string }> };
export type PayPalOrderClient = { createOrder(input: PayPalCreateInput, requestId: string): Promise<PayPalCreateResponse> };
let testClient: PayPalOrderClient | undefined;

export function setPayPalOrderClientForTests(client: PayPalOrderClient): () => void { const previous = testClient; testClient = client; return () => { testClient = previous; }; }

function amountString(amount: Decimal): string {
  const value = amount.toFixed(2);
  if (amount.lte(0) || !amount.mul(100).isInteger()) throw new PayPalProviderError("Invalid payment amount");
  return value;
}

function createPayPalClient(): PayPalOrderClient {
  if (!config.PAYPAL_CLIENT_ID || !config.PAYPAL_CLIENT_SECRET) throw new PayPalProviderError("PayPal is not configured");
  let accessToken: string | undefined;
  return {
    async createOrder(input, requestId) {
      try {
        if (!accessToken) {
          const credentials = Buffer.from(`${config.PAYPAL_CLIENT_ID}:${config.PAYPAL_CLIENT_SECRET}`).toString("base64");
          const auth = await fetch(`${config.PAYPAL_BASE_URL}/v1/oauth2/token`, { method: "POST", headers: { Authorization: `Basic ${credentials}`, "Content-Type": "application/x-www-form-urlencoded" }, body: "grant_type=client_credentials" });
          if (!auth.ok) throw new Error("oauth failure");
          accessToken = (await auth.json() as { access_token: string }).access_token;
        }
        const response = await fetch(`${config.PAYPAL_BASE_URL}/v2/checkout/orders`, { method: "POST", headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json", "PayPal-Request-Id": requestId }, body: JSON.stringify(input) });
        if (!response.ok) throw new Error("create failure");
        return await response.json() as PayPalCreateResponse;
      } catch { throw new PayPalProviderError("PayPal order operation failed"); }
    },
  };
}

export async function createOrReusePayPalOrder(orderId: number, userId: number, client?: PayPalOrderClient) {
  const local = await prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<Array<{ id: number; userId: number; status: OrderStatus; totalAmount: Decimal; reservationExpiresAt: Date | null }>>`SELECT "id", "userId", "status", "totalAmount", "reservationExpiresAt" FROM "Order" WHERE "id" = ${orderId} FOR UPDATE`;
    const order = locked[0];
    if (!order) throw new PayPalOrderNotFoundError();
    if (order.userId !== userId) throw new PayPalOrderOwnershipError();
    if (order.status === OrderStatus.EXPIRED || (order.reservationExpiresAt && order.reservationExpiresAt <= new Date())) throw new PayPalOrderExpiredError();
    if (order.status === OrderStatus.CANCELLED) throw new PayPalOrderAlreadyCompletedError();
    const value = amountString(order.totalAmount);
    const existing = await tx.payment.findUnique({ where: { orderId } });
    if (existing) {
      if (existing.provider !== PaymentProvider.PAYPAL || existing.status === PaymentStatus.SUCCEEDED) throw new PayPalOrderAlreadyCompletedError();
      if (!existing.providerReference.startsWith("pending:")) return { payment: existing, value, requestId: existing.idempotencyKey ?? `order-${orderId}-paypal` };
      return { payment: existing, value, requestId: existing.idempotencyKey ?? `order-${orderId}-paypal` };
    }
    const requestId = `order-${orderId}-paypal`;
    const payment = await tx.payment.create({ data: { orderId, amount: order.totalAmount, currency: "GBP", provider: PaymentProvider.PAYPAL, providerReference: `pending:${requestId}`, idempotencyKey: requestId, status: PaymentStatus.PENDING } });
    return { payment, value, requestId };
  });
  if (!local.payment.providerReference.startsWith("pending:")) return { paymentId: local.payment.id, paypalOrderId: local.payment.providerReference };
  let created: PayPalCreateResponse;
  try {
    const provider = client ?? testClient ?? createPayPalClient();
    created = await provider.createOrder({ intent: "CAPTURE", purchase_units: [{ reference_id: String(orderId), custom_id: String(orderId), amount: { currency_code: "GBP", value: local.value } }] }, local.requestId);
  } catch { throw new PayPalProviderError("PayPal order operation failed"); }
  await prisma.payment.update({ where: { id: local.payment.id }, data: { providerReference: created.id, status: PaymentStatus.PENDING, paidAt: null } });
  return { paymentId: local.payment.id, paypalOrderId: created.id, approvalUrl: created.links?.find((link) => link.rel === "approve")?.href };
}
