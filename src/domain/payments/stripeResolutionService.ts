import { completedSweep } from "../../operations/health.js";
import {logOperationalError} from "../../utils/operationalLog.js";
import { resolvePayPalPaymentOutcome } from "./paypalResolutionService.js";
import type Stripe from "stripe";
import { prisma } from "../../prisma/runtime.js";
import { config } from "../../config/index.js";
import { createStripePaymentClient } from "./stripePaymentService.js";
import { applyStripePaymentOutcome, validateStripePaymentOutcome, replayManagedStripeReceipts } from "./stripeReconciliationService.js";
import { finalizeManagedStripeRetrieval, databaseNow, journalResolutionOperation, managedResolution, PaymentResolutionOwnershipError,
  PaymentResolutionUnavailableError, recordManagedFailure, attemptManagedRelease } from "./paymentResolutionService.js";
import { randomUUID } from "node:crypto";
import { expireUnledgeredUnpaidReservations } from "../orders/orderExpiryService.js";

export type StripeResolutionClient = { paymentIntents: Pick<Stripe["paymentIntents"], "retrieve" | "cancel"> };
const LEASE_MS = 60_000;
/** A retrieved canceled intent is final only with exact identity/financial validation and zero received funds. */
export function isTerminalUnpaidStripeIntent(intent: Stripe.PaymentIntent) {
  return intent.status === "canceled" && intent.amount_received === 0 && intent.amount_capturable === 0;
}
export function canSafelyCancelStripeIntent(intent: Stripe.PaymentIntent) {
  // requires_capture cancellation automatically refunds; processing may be ambiguous. Neither is permitted.
  return ["requires_payment_method", "requires_confirmation", "requires_action"].includes(intent.status)
    && intent.amount_received === 0 && intent.amount_capturable === 0;
}
export async function resolvePaymentReservation(orderId: number, client?: StripeResolutionClient) {
  const provider = await prisma.payment.findUnique({ where: { orderId }, select: { provider: true } });
  if (provider?.provider === "PAYPAL") { await resolvePayPalPaymentOutcome(orderId); return; }
  const claim = await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "Order" WHERE id=${orderId} FOR UPDATE`;
    const r = await managedResolution(tx, orderId);
    const order = await tx.order.findUnique({ where: { id: orderId } });
    if (!r || !order || r.reservationDisposition !== "HELD" || r.state === "PAID") return null;
    if (order.status !== "PENDING") {
      await tx.paymentResolution.update({where:{orderId},data:{state:"REVIEW_REQUIRED",quarantineReason:"Terminal order has an unreconciled held disposition",escalatedAt:r.escalatedAt??await databaseNow(tx)}});
      return null;
    }
    const now = await databaseNow(tx);
    const pay = await tx.payment.findUnique({ where: { orderId } });
    if (!pay) {
      if (!r.paymentAdmissionClosedAt && now < (r.retryDeadline ?? r.initialPaymentDeadline)) {
        await tx.paymentResolution.update({ where: { orderId }, data: { resolutionNextCheckAt: r.retryDeadline ?? r.initialPaymentDeadline } });
        return null;
      }
      if (!await attemptManagedRelease(tx, orderId, r.closureReason === "CUSTOMER_ABANDONED")) {
        await tx.paymentResolution.update({ where: { orderId }, data: { state: "SAFETY_HOLD", resolutionNextCheckAt: new Date(now.getTime()+300_000), escalatedAt: r.escalatedAt ?? now } });
      }
      return null;
    }
    if (pay.status === "SUCCEEDED" || pay.paidAt) {
      await tx.paymentResolution.update({ where: { orderId }, data: { state: "SAFETY_HOLD", resolutionNextCheckAt: new Date(now.getTime()+300_000), escalatedAt: r.escalatedAt ?? now } });
      return null;
    }
    const attempt = await tx.paymentAttempt.findFirst({ where: { paymentId: pay.id, historical: false, providerReference: pay.providerReference } });
    if (!attempt || pay.provider !== "STRIPE" || !pay.providerReference.startsWith("pi_")) {
      // PayPal has no generic cancel, and placeholders cannot be redispatched safely after key retention.
      await tx.paymentResolution.update({ where: { orderId }, data: { state: "SAFETY_HOLD", resolutionNextCheckAt: new Date(now.getTime()+300_000), escalatedAt: r.escalatedAt ?? now } });
      return null;
    }
    const unfinishedRead = await tx.paymentOperation.count({ where: { attemptId: attempt.id, type: "RETRIEVE", state: { not: "RESULT_RECORDED" } } });
    if (!(attempt.finalityEvidenceId && unfinishedRead) && !r.paymentAdmissionClosedAt && now < (r.retryDeadline ?? r.initialPaymentDeadline)) {
      await tx.paymentResolution.update({ where: { orderId }, data: { resolutionNextCheckAt: r.retryDeadline ?? r.initialPaymentDeadline } });
      return null;
    }
    if (attempt.finalityEvidenceId && !unfinishedRead) {
      await replayManagedStripeReceipts(tx, orderId, pay.providerReference);
      await attemptManagedRelease(tx, orderId, r.closureReason === "CUSTOMER_ABANDONED");
      return null;
    }
    const active = await tx.paymentOperation.findFirst({ where: { attemptId: attempt.id, type: { in: ["TERMINATE", "RETRIEVE"] }, leaseExpiresAt: { gt: now } } });
    if (active) return null;
    const reusable = await tx.paymentOperation.findFirst({ where: { attemptId: attempt.id, type: "RETRIEVE",
      state: { in: ["POTENTIALLY_DISPATCHED", "UNKNOWN"] }, OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }] }, orderBy: { id: "asc" } });
    const operation = reusable ?? await journalResolutionOperation(tx, attempt.id, "RETRIEVE");
    const owner = randomUUID();
    await tx.paymentOperation.update({ where: { id: operation.id }, data: { claimOwner: owner, claimGeneration: { increment: 1 }, executionCount: reusable ? { increment: 1 } : undefined, leaseExpiresAt: new Date(now.getTime()+LEASE_MS) } });
    await tx.paymentResolution.update({ where: { orderId }, data: { resolutionNextCheckAt: new Date(now.getTime()+LEASE_MS) } });
    return { payment: pay, attempt, operation, owner };
  });
  if (!claim) return;
  let intent: Stripe.PaymentIntent;
  try {
    const provider = client ?? createStripePaymentClient();
    intent = await provider.paymentIntents.retrieve(claim.payment.providerReference);
    const current = await prisma.payment.findUniqueOrThrow({ where: { id: claim.payment.id }, include: { order: true } });
    const outcome = { type: "payment_intent.succeeded" as const, paymentIntentId: intent.id, amount: intent.amount, currency: intent.currency, metadata: intent.metadata };
    if (validateStripePaymentOutcome(current, outcome) || intent.metadata.orderId !== String(orderId)) throw new PaymentResolutionUnavailableError();
    // A qualifying failure is accepted before deciding whether to terminate. Days-late verification opens 30m now.
    const decision = await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "Order" WHERE id=${orderId} FOR UPDATE`;
      await replayManagedStripeReceipts(tx, orderId, intent.id);
      const payment = await tx.payment.findUniqueOrThrow({ where: { id: claim.payment.id }, include: { order: true } });
      const op = await tx.paymentOperation.findUniqueOrThrow({ where: { id: claim.operation.id } });
      const now = await databaseNow(tx);
      if (op.claimOwner !== claim.owner || !op.leaseExpiresAt || op.leaseExpiresAt <= now || payment.providerReference !== intent.id) return false;
      if (payment.status === "SUCCEEDED" || payment.paidAt) return false;
      if (intent.status === "succeeded") {
        if (intent.amount_received !== intent.amount) throw new PaymentResolutionUnavailableError();
        await applyStripePaymentOutcome(tx, payment, outcome);
        await finalizeManagedStripeRetrieval(tx, payment, op.id, intent, claim.owner);
        return false;
      }
      if (intent.status === "requires_payment_method" && intent.last_payment_error) {
        await recordManagedFailure(tx, payment, intent.id, `retrieved-failure:${claim.attempt.id}`);
      }
      const r = await managedResolution(tx, orderId);
      return !!r && !payment.paidAt && (!r.retryDeadline || now >= r.retryDeadline || r.closureReason === "CUSTOMER_ABANDONED");
    });
    if (decision && canSafelyCancelStripeIntent(intent)) {
      const cancellationKey = await prisma.$transaction(async tx => {
        await tx.$queryRaw`SELECT id FROM "Order" WHERE id=${orderId} FOR UPDATE`;
        const payment = await tx.payment.findUniqueOrThrow({ where: { id: claim.payment.id } });
        const r = await managedResolution(tx, orderId);
        const op = await tx.paymentOperation.findUniqueOrThrow({ where: { id: claim.operation.id } });
        const now = await databaseNow(tx);
        if (!r || payment.status === "SUCCEEDED" || payment.paidAt || r.state === "PAID" || op.claimOwner !== claim.owner
          || !op.leaseExpiresAt || op.leaseExpiresAt <= now || (r.closureReason !== "CUSTOMER_ABANDONED" && now < (r.retryDeadline ?? r.initialPaymentDeadline))) return null;
        const cancellation = await journalResolutionOperation(tx, claim.attempt.id, "TERMINATE");
        await tx.paymentOperation.update({ where: { id: cancellation.id }, data: { claimOwner: claim.owner, claimGeneration: 1, leaseExpiresAt: op.leaseExpiresAt } });
        return cancellation.operationKey;
      });
      if (cancellationKey) await provider.paymentIntents.cancel(intent.id, { cancellation_reason: "abandoned" }, { idempotencyKey: cancellationKey });
      // A request/response alone is not release authority. Independently retrieve after cancellation.
      intent = await provider.paymentIntents.retrieve(intent.id);
    }
    await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "Order" WHERE id=${orderId} FOR UPDATE`;
      await replayManagedStripeReceipts(tx, orderId, intent.id);
      const payment = await tx.payment.findUniqueOrThrow({ where: { id: claim.payment.id }, include: { order: true } });
      const op = await tx.paymentOperation.findUniqueOrThrow({ where: { id: claim.operation.id } });
      const now = await databaseNow(tx);
      if (op.claimOwner !== claim.owner || !op.leaseExpiresAt || op.leaseExpiresAt <= now || payment.providerReference !== intent.id) return;
      const outcome = { type: "payment_intent.succeeded" as const, paymentIntentId: intent.id, amount: intent.amount, currency: intent.currency, metadata: intent.metadata };
      if (validateStripePaymentOutcome(payment, outcome) || intent.metadata.orderId !== String(orderId)) throw new PaymentResolutionUnavailableError();
      if (intent.status === "succeeded") {
        if (intent.amount_received !== intent.amount) throw new PaymentResolutionUnavailableError();
        await applyStripePaymentOutcome(tx, payment, outcome);
        await finalizeManagedStripeRetrieval(tx, payment, op.id, intent, claim.owner);
      } else if (isTerminalUnpaidStripeIntent(intent) && !payment.paidAt && payment.status !== "SUCCEEDED") {
        const operations = await tx.paymentOperation.findMany({ where: { attemptId: claim.attempt.id }, orderBy: { id: "asc" } });
        let finalityId: number | undefined;
        for (const operation of operations) {
          // One final provider-object retrieval covers every previously journalled permission/call.
          const evidence = await tx.financialEvidence.create({ data: { orderId, provider: "STRIPE", operationId: operation.id,
            evidenceKey: `terminal:${operation.id}:${intent.id}:${claim.operation.id}`, kind: "TERMINAL_UNPAID", verifiedAt: now,
            normalized: { providerReference: intent.id, amount: payment.amount.toFixed(2), currency: payment.currency,
              providerStatus: intent.status, amountReceived: 0, amountCapturable: 0 } } });
          if (operation.id === claim.operation.id) finalityId = evidence.id;
          if (operation.state !== "RESULT_RECORDED") await tx.paymentOperation.update({ where: { id: operation.id }, data: {
            state: "RESULT_RECORDED", evidenceId: evidence.id, claimOwner: null, leaseExpiresAt: null } });
        }
        const latestAttempt = await tx.paymentAttempt.findUniqueOrThrow({ where: { id: claim.attempt.id } });
        if (!latestAttempt.finalityEvidenceId) await tx.paymentAttempt.update({ where: { id: claim.attempt.id }, data: { finalityEvidenceId: finalityId } });
        await tx.payment.update({ where: { id: payment.id }, data: { status: "CANCELED" } });
        const r = await managedResolution(tx, orderId);
        await attemptManagedRelease(tx, orderId, r?.closureReason === "CUSTOMER_ABANDONED");
      }
      const currentOp = await tx.paymentOperation.findUniqueOrThrow({ where: { id: op.id } });
      if (currentOp.state !== "RESULT_RECORDED") await tx.paymentOperation.update({ where: { id: op.id }, data: { state: "UNKNOWN", claimOwner: null, leaseExpiresAt: null } });
      const r = await managedResolution(tx, orderId);
      if (r && r.reservationDisposition === "HELD" && r.state !== "PAID") await tx.paymentResolution.update({ where: { orderId }, data: {
        resolutionNextCheckAt: new Date(now.getTime()+300_000), escalatedAt: r.escalatedAt ?? now } });
    });
  } catch {
    await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "Order" WHERE id=${orderId} FOR UPDATE`;
      const op = await tx.paymentOperation.findUnique({ where: { id: claim.operation.id } });
      if (op?.claimOwner !== claim.owner || op.state === "RESULT_RECORDED") return;
      const now = await databaseNow(tx);
      await tx.paymentOperation.updateMany({ where: { attemptId: claim.attempt.id, claimOwner: claim.owner, state: { not: "RESULT_RECORDED" } }, data: { state: "UNKNOWN", claimOwner: null, leaseExpiresAt: null, lastErrorCode: "PROVIDER_OUTCOME_UNRESOLVED", nextCheckAt: new Date(now.getTime()+300_000) } });
      await tx.paymentResolution.update({ where: { orderId }, data: { resolutionNextCheckAt: new Date(now.getTime()+300_000) } });
    });
  }
}
export async function abandonPaymentReservation(orderId: number, userId: number, client?: StripeResolutionClient) {
  await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "Order" WHERE id=${orderId} FOR UPDATE`;
    const order = await tx.order.findUnique({ where: { id: orderId } });
    if (!order || order.userId !== userId) throw new PaymentResolutionOwnershipError();
    const r = await managedResolution(tx, orderId);
    const paid = await tx.payment.findFirst({ where: { orderId, OR: [{ status: "SUCCEEDED" }, { paidAt: { not: null } }] } });
    if (!r || r.historical || paid || r.reservationDisposition !== "HELD" || order.status !== "PENDING") throw new PaymentResolutionUnavailableError();
    const now = await databaseNow(tx);
    if (!r.paymentAdmissionClosedAt) await tx.paymentResolution.update({ where: { orderId }, data: { state: "CLOSED_RESOLVING", paymentAdmissionClosedAt: now, closureReason: "CUSTOMER_ABANDONED" } });
  });
  await resolvePaymentReservation(orderId, client);
  return prisma.paymentResolution.findUniqueOrThrow({ where: { orderId }, select: { state: true, reservationDisposition: true } });
}
/** One bounded sweep; dependency injection permits local provider fakes in database tests. */
export async function runPaymentResolutionSweep(resolve: (orderId: number) => Promise<void> = resolvePaymentReservation, shouldStop: () => boolean = () => false) {
      const rows = await prisma.paymentResolution.findMany({ where: { historical: false, quarantineReason: null, reservationDisposition: "HELD",
        state: { notIn: ["PAID", "REVIEW_REQUIRED"] }, OR: [{ resolutionNextCheckAt: null }, { resolutionNextCheckAt: { lte: new Date() } }] },
        orderBy: [{ resolutionNextCheckAt: { sort: "asc", nulls: "first" } }, { orderId: "asc" }], take: 25 });
      for (const row of rows) {
        if (shouldStop()) break;
        try { await resolve(row.orderId); }
        catch {
          await prisma.$transaction(async tx => {
            await tx.$queryRaw`SELECT id FROM "Order" WHERE id=${row.orderId} FOR UPDATE`;
            const r = await managedResolution(tx, row.orderId);
            if (r && r.reservationDisposition === "HELD") await tx.paymentResolution.update({ where: { orderId: row.orderId }, data: {
              resolutionNextCheckAt: new Date(Date.now()+300_000), escalatedAt: r.escalatedAt ?? new Date() } });
          });
        }
      }

}
export function startPaymentResolutionWorker(intervalMs = 15_000) {
  if (!config.PAYMENT_RESOLUTION_ENABLED) return () => {};
  let running = false, stopped = false;
  const tick = async () => {
    if (running || stopped) return;
    running = true;
    try { await runPaymentResolutionSweep(resolvePaymentReservation, () => stopped); completedSweep('payment');
    } catch { logOperationalError("Payment resolution sweep failed; durable records retained"); }
    // Orders from before managed enrolment have no ledger for the sweep above.
    try { if (!stopped) await expireUnledgeredUnpaidReservations();
    } catch { logOperationalError("Unledgered reservation expiry failed; reservations retained"); }
    finally { running = false; }
  };
  let pending:Promise<void>=Promise.resolve();
  const launch=()=>{if(!running&&!stopped)pending=tick();};
  const timer = setInterval(launch, intervalMs); timer.unref(); launch();
  return async () => { stopped = true; clearInterval(timer); await pending; };
}
