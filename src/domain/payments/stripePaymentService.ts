import { replayManagedStripeReceipts } from "./stripeReconciliationService.js";
import { randomUUID } from "node:crypto";
import { finalizeManagedStripeRetrieval, checkPaymentAdmission, guardPendingCreation, journalNewPayment, bindManagedProvider, journalManagedRetrieval, managedResolution } from "./paymentResolutionService.js";
import Stripe from "stripe";
import { Decimal } from "@prisma/client/runtime/client";
import { PaymentProvider, PaymentStatus, OrderStatus } from "../../generated/prisma-client/enums.js";
import { prisma } from "../../prisma/runtime.js";
import { config } from "../../config/index.js";

export class StripePaymentOrderNotFoundError extends Error {}
export class StripePaymentOwnershipError extends Error {}
export class StripePaymentExpiredError extends Error {}
export class StripePaymentAlreadyCompletedError extends Error {}
export class StripePaymentNotPayableError extends Error {}
export class StripePaymentProviderError extends Error {}

export type StripePaymentClient = Pick<Stripe, "paymentIntents">;
let testClient: StripePaymentClient | undefined;

export function setStripePaymentClientForTests(client: StripePaymentClient): () => void {
  const previous = testClient;
  testClient = client;
  return () => { testClient = previous; };
}

export function createStripePaymentClient(): StripePaymentClient {
  if (!config.STRIPE_SECRET_KEY) throw new StripePaymentProviderError("Stripe is not configured");
  return new Stripe(config.STRIPE_SECRET_KEY);
}

function toMinorUnits(amount: Decimal): number {
  const minor = amount.mul(100);
  if (!minor.isInteger() || minor.lte(0) || !minor.lte(Number.MAX_SAFE_INTEGER)) {
    throw new StripePaymentProviderError("Invalid payment amount");
  }
  return minor.toNumber();
}

export async function createOrReuseStripePaymentIntent(
  orderId: number,
  userId: number,
  client?: StripePaymentClient,
) {
  const local = await prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<Array<{ id: number; userId: number; status: OrderStatus; totalAmount: Decimal; reservationExpiresAt: Date | null }>>`
      SELECT "id", "userId", "status", "totalAmount", "reservationExpiresAt"
      FROM "Order" WHERE "id" = ${orderId} FOR UPDATE
    `;
    const order = locked[0];
    if (!order) throw new StripePaymentOrderNotFoundError();
    if (order.userId !== userId) throw new StripePaymentOwnershipError();
    const managed = await checkPaymentAdmission(tx, orderId);
    if (order.status === OrderStatus.EXPIRED || (!managed && order.reservationExpiresAt && order.reservationExpiresAt <= new Date())) throw new StripePaymentExpiredError();
    if (order.status !== OrderStatus.PENDING) throw new StripePaymentNotPayableError();
    const amount = toMinorUnits(order.totalAmount);
    const existing = await tx.payment.findUnique({ where: { orderId } });
    if (existing) {
      if (existing.provider !== PaymentProvider.STRIPE) throw new StripePaymentAlreadyCompletedError();
      if (existing.status === PaymentStatus.SUCCEEDED) throw new StripePaymentAlreadyCompletedError();
      if (managed && existing.status === PaymentStatus.CANCELED && managed.retryDeadline) {
        const previous = await tx.paymentAttempt.findFirst({ where: { paymentId: existing.id, providerReference: existing.providerReference, historical: false } });
        if (!previous?.finalityEvidenceId || await tx.paymentOperation.count({ where: { attemptId: previous.id, state: { not: "RESULT_RECORDED" } } })) throw new StripePaymentNotPayableError();
        const idempotencyKey = `stripe-retry-${randomUUID()}`;
        const payment = await tx.payment.update({ where: { id: existing.id }, data: { providerReference: `pending:${idempotencyKey}`, idempotencyKey, status: PaymentStatus.PROCESSING } });
        const journal = await journalNewPayment(tx, payment, "CREATE");
        return { payment, amount, attemptId: journal?.attempt.id };
      }
      await guardPendingCreation(tx, existing);
      const retrieval = !existing.providerReference.startsWith("pending:") ? await journalManagedRetrieval(tx, existing) : null;
      return { payment: existing, amount, retrievalId: retrieval?.id };
    }
    const idempotencyKey = `order-${orderId}-stripe`;
    const payment = await tx.payment.create({ data: { orderId, amount: order.totalAmount, currency: "GBP", provider: PaymentProvider.STRIPE, providerReference: `pending:${idempotencyKey}`, idempotencyKey, status: PaymentStatus.PROCESSING } });
    const journal = await journalNewPayment(tx, payment, "CREATE");
    return { payment, amount, attemptId: journal?.attempt.id };
  });

  let intent: Stripe.PaymentIntent;
  try {
    const providerClient = client ?? testClient ?? createStripePaymentClient();
    const isPending = local.payment.providerReference.startsWith("pending:");
    intent = isPending
      ? await providerClient.paymentIntents.create({ amount: local.amount, currency: "gbp", metadata: { orderId: String(orderId), ...(local.attemptId ? { attemptId: String(local.attemptId) } : {}) }, automatic_payment_methods: { enabled: true } }, { idempotencyKey: local.payment.idempotencyKey ?? `order-${orderId}-stripe` })
      : await providerClient.paymentIntents.retrieve(local.payment.providerReference);
  } catch (error) {
    throw new StripePaymentProviderError("Stripe payment operation failed");
  }

  // Initiation/retrieval is not the authoritative payment-success boundary.
  // Verified webhook/reconciliation processing owns SUCCEEDED and paidAt.
  const payment = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${orderId} FOR UPDATE`;
    await bindManagedProvider(tx, local.payment.id, intent.id);
    // A webhook may have finalized payment while the network request was in flight.
    await tx.payment.updateMany({
      where: { id: local.payment.id, status: { not: PaymentStatus.SUCCEEDED } },
      data: { providerReference: intent.id, status: PaymentStatus.PROCESSING },
    });
    const current = await tx.payment.findUniqueOrThrow({ where: { id: local.payment.id } });
    await finalizeManagedStripeRetrieval(tx, current, local.retrievalId, intent);
    return current;
  });
  await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "Order" WHERE id=${orderId} FOR UPDATE`;
    if (await managedResolution(tx, orderId)) await replayManagedStripeReceipts(tx, orderId, intent.id);
  });
  const latest = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
  if (latest.status === PaymentStatus.SUCCEEDED) throw new StripePaymentAlreadyCompletedError();
  await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "Order" WHERE id=${orderId} FOR UPDATE`;
    const order = await tx.order.findUniqueOrThrow({ where: { id: orderId } });
    if (order.userId !== userId) throw new StripePaymentOwnershipError();
    await checkPaymentAdmission(tx, orderId);
  });
  if (await prisma.paymentResolution.findFirst({ where: { orderId, historical: false, firstFailureVerifiedAt: { not: null } } })
    && intent.status !== "requires_payment_method") throw new StripePaymentNotPayableError();
  return { paymentId: payment.id, providerReference: intent.id, clientSecret: intent.client_secret, status: intent.status };
}
