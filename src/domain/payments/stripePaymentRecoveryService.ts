import { finalizeManagedStripeRetrieval, journalManagedRetrieval, managedResolution, recordManagedFailure } from "./paymentResolutionService.js";
import type Stripe from "stripe";
import { Decimal } from "@prisma/client/runtime/client";
import { PaymentProvider } from "../../generated/prisma-client/enums.js";
import { prisma } from "../../prisma/runtime.js";
import { getCustomerOrder } from "../orders/orderReadService.js";
import { createStripePaymentClient, StripePaymentProviderError } from "./stripePaymentService.js";
import { applyStripePaymentOutcome, validateStripePaymentOutcome, type StripePaymentOutcome } from "./stripeReconciliationService.js";

export class StripeRecoveryOrderNotFoundError extends Error {}
export class StripeRecoveryUnavailableError extends Error {}
export class StripeRecoveryMismatchError extends Error {}

type StripeRecoveryClient = { paymentIntents: Pick<Stripe["paymentIntents"], "retrieve"> };
let testClient: StripeRecoveryClient | undefined;

export function setStripeRecoveryClientForTests(client: StripeRecoveryClient): () => void {
  const previous = testClient;
  testClient = client;
  return () => { testClient = previous; };
}

/** Retrieve only the owner's locally correlated attempt; never create a charge. */
export async function recoverStripePayment(orderId: number, userId: number, client?: StripeRecoveryClient) {
  const order = await prisma.order.findFirst({ where: { id: orderId, userId }, select: { payments: true } });
  if (!order) throw new StripeRecoveryOrderNotFoundError();
  const local = order.payments[0];
  // A pending placeholder is not a provider reference. Recovery must not guess
  // an intent from browser input or create another provider object to find it.
  if (!local || local.provider !== PaymentProvider.STRIPE || !local.providerReference.startsWith("pi_")) {
    throw new StripeRecoveryUnavailableError();
  }

  const retrieval = await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "Order" WHERE id=${orderId} FOR UPDATE`;
    const current = await tx.payment.findUniqueOrThrow({ where: { id: local.id }, include: { order: true } });
    if (current.order.userId !== userId || current.providerReference !== local.providerReference) throw new StripeRecoveryMismatchError();
    return journalManagedRetrieval(tx, current);
  });
  let intent: Stripe.PaymentIntent;
  try {
    const providerClient = client ?? testClient ?? createStripePaymentClient();
    // Stripe network I/O deliberately occurs before acquiring database locks.
    intent = await providerClient.paymentIntents.retrieve(local.providerReference);
  } catch {
    throw new StripePaymentProviderError("Stripe payment recovery unavailable");
  }

  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${orderId} FOR UPDATE`;
    const payment = await tx.payment.findUnique({ where: { id: local.id }, include: { order: true } });
    // Recheck identity after network I/O: a webhook, expiry or another operation
    // may have committed meanwhile. Never reconcile against a stale snapshot.
    if (!payment || payment.order.userId !== userId || payment.orderId !== orderId ||
        payment.provider !== PaymentProvider.STRIPE || payment.providerReference !== local.providerReference ||
        intent.id !== payment.providerReference || intent.metadata?.orderId !== String(orderId) ||
        !new Decimal(payment.amount).equals(payment.order.totalAmount) || payment.currency.toUpperCase() !== "GBP") {
      throw new StripeRecoveryMismatchError();
    }
    const outcome: StripePaymentOutcome = {
      type: "payment_intent.succeeded", paymentIntentId: intent.id,
      amount: intent.amount, currency: intent.currency, metadata: intent.metadata,
    };
    // Validate the financial identity even for a non-successful retrieval.
    if (validateStripePaymentOutcome(payment, outcome) ||
        (intent.status === "succeeded" && intent.amount_received !== intent.amount)) {
      throw new StripeRecoveryMismatchError();
    }
    await finalizeManagedStripeRetrieval(tx, payment, retrieval?.id, intent);
    // Non-success observations never regress success. Managed canceled observations
    // complete terminal-unpaid journals above; legacy behavior remains unchanged.
    if (intent.status !== "succeeded") {
      if (intent.status === "requires_payment_method" && intent.last_payment_error && await managedResolution(tx, orderId)) {
        await recordManagedFailure(tx, payment, intent.id, `recovery-failure:${payment.id}:${intent.id}`);
      }
      return;
    }

    const reconciliation = await applyStripePaymentOutcome(tx, payment, outcome);
    // Durable recovery evidence uses a namespaced identity and distinct type;
    // it is explicitly not a Stripe webhook event. Retain late-payment errors
    // through the existing operational reconciliation exception store.
    const providerEventId = `recovery:${payment.id}:${intent.id}:succeeded`;
    // Legacy orders have no managed attempt ledger. Retain the exact allowlisted
    // verified GET identity/amount as immutable success proof, not an invented attempt.
    const evidence = { version: 1, paymentIntentId: intent.id, amount: intent.amount, currency: payment.currency.toLowerCase(), orderId: String(orderId) };
    await tx.paymentWebhookEvent.upsert({
      where: { provider_providerEventId: { provider: PaymentProvider.STRIPE, providerEventId } },
      create: { provider: PaymentProvider.STRIPE, providerEventId, eventType: "payment_intent.recovered", processedAt: new Date(), processingError: reconciliation, evidence },
      update: { processingError: reconciliation, evidence },
    });
  });

  const result = await getCustomerOrder(userId, orderId);
  if (!result) throw new StripeRecoveryOrderNotFoundError();
  return result;
}
