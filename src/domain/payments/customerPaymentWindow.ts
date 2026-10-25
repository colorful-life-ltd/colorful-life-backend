import { Prisma as PrismaSql } from "../../generated/prisma-client/client.js";
import type { Order, Payment, PaymentAttempt, PaymentOperation, PaymentResolution, Prisma } from "../../generated/prisma-client/client.js";
import { paypalSandboxAvailable } from "./paypalSandbox.js";
import { config } from "../../config/index.js";

export type CustomerPaymentWindow = {
  version: 1;
  provider: "STRIPE" | "PAYPAL" | "MANUAL";
  evaluatedAt: string;
  mode: "LEGACY" | "MANAGED" | "UNAVAILABLE";
  state: "INITIAL_PAYMENT" | "CHECKOUT_RESUMABLE" | "PROCESSING" | "OUTCOME_UNRESOLVED" | "RETRY_AVAILABLE" | "RETRY_REQUIRES_PROVIDER_CHECK" | "PAID" | "NOT_PAYABLE";
  paymentOutcome: "NOT_STARTED" | "PENDING" | "UNRESOLVED" | "SUCCEEDED" | "UNPAID";
  paymentDeadline: string | null;
  retryDeadline: string | null;
  resumeEligibility: "ELIGIBLE" | "INELIGIBLE" | "REQUIRES_PROVIDER_CHECK";
  initiationEligibility: "ELIGIBLE" | "INELIGIBLE" | "REQUIRES_PROVIDER_CHECK";
  reason: "EXISTING_CHECKOUT_OPEN" | "INITIAL_WINDOW_OPEN" | "AWAITING_PAYMENT_OUTCOME" | "PAYMENT_OUTCOME_UNRESOLVED" | "PROVIDER_CHECK_REQUIRED" | "VERIFIED_UNPAID_RETRY" | "PAYMENT_SUCCEEDED" | "ORDER_NOT_PENDING" | "WINDOW_CLOSED" | "ADMISSION_UNAVAILABLE" | "STRIPE_UNAVAILABLE" | "PAYPAL_UNAVAILABLE" | "INVALID_AMOUNT" | "OTHER_PROVIDER";
};

type Attempt = Pick<PaymentAttempt, "paymentId" | "providerReference" | "historical" | "finalityEvidenceId" | "successEvidenceId"> & {
  operations: Array<Pick<PaymentOperation, "type" | "state">>;
};
export type PaymentWindowInput = {
  order: Pick<Order, "status" | "reservationExpiresAt" | "totalAmount">;
  payment: Pick<Payment, "id" | "provider" | "providerReference" | "status" | "paidAt"> | null;
  resolution: Pick<PaymentResolution, "historical" | "quarantineReason" | "state" | "initialPaymentDeadline" | "retryDeadline" | "firstFailureVerifiedAt" | "paymentAdmissionClosedAt" | "reservationDisposition"> | null;
  attempts: Attempt[];
  hasUnresolvedInbox: boolean;
  hasSuccessEvidence: boolean;
  hasFinancialEvidence: boolean;
  admission: "OPEN" | "CLOSED" | "UNAVAILABLE";
  managedEnabled: boolean;
  stripeConfigured: boolean;
  paypalConfigured?: boolean;
  preferredProvider?: "STRIPE" | "PAYPAL";
  newInitiationEnabled?: boolean;
  now: Date;
};

/** Read model only. Local PROCESSING means awaiting evidence, not a verified Stripe status. */
export function presentCustomerPaymentWindow(input: PaymentWindowInput): CustomerPaymentWindow {
  const { order, payment, resolution: r, attempts, now } = input;
  const provider = payment?.provider ?? input.preferredProvider ?? "STRIPE";
  const configured = provider === "PAYPAL" ? !!input.paypalConfigured : input.stripeConfigured;
  const unavailableReason = provider === "PAYPAL" ? "PAYPAL_UNAVAILABLE" : "STRIPE_UNAVAILABLE";
  const managed = !!r && !r.historical && !r.quarantineReason;
  const unavailable = !managed && (input.managedEnabled || !!r);
  const deadline = managed ? r.retryDeadline ?? r.initialPaymentDeadline : unavailable ? null : order.reservationExpiresAt;
  const current = payment && attempts.find(a => a.paymentId === payment.id && !a.historical && a.providerReference === payment.providerReference);
  const finalUnpaid = !!current?.finalityEvidenceId && !current.successEvidenceId && current.operations.every(o => o.state === "RESULT_RECORDED");
  const success = payment?.status === "SUCCEEDED" || !!payment?.paidAt || input.hasSuccessEvidence || attempts.some(a => a.successEvidenceId !== null) || r?.state === "PAID";
  const uncertain = input.hasUnresolvedInbox || input.admission === "UNAVAILABLE" || unavailable || !!payment?.providerReference.startsWith("pending:")
    || attempts.some(a => a.operations.some(o => (o.type !== "RETRIEVE" && o.state === "UNKNOWN") || (o.type === "TERMINATE" && o.state !== "RESULT_RECORDED"))) || (managed && !!payment && !current)
    || (!payment && (attempts.length > 0 || input.hasFinancialEvidence));
  const paymentOutcome: CustomerPaymentWindow["paymentOutcome"] = success ? "SUCCEEDED" : uncertain ? "UNRESOLVED"
    : !payment ? "NOT_STARTED" : finalUnpaid ? "UNPAID" : managed && r.firstFailureVerifiedAt ? "UNRESOLVED" : payment.status === "PROCESSING" || payment.status === "PENDING" ? "PENDING" : "UNRESOLVED";
  const result: CustomerPaymentWindow = {
    version: 1, provider, evaluatedAt: now.toISOString(), mode: managed ? "MANAGED" : unavailable ? "UNAVAILABLE" : "LEGACY",
    state: "OUTCOME_UNRESOLVED", paymentOutcome, paymentDeadline: deadline?.toISOString() ?? null,
    retryDeadline: managed ? r.retryDeadline?.toISOString() ?? null : null,
    resumeEligibility: "INELIGIBLE", initiationEligibility: "INELIGIBLE", reason: "PAYMENT_OUTCOME_UNRESOLVED",
  };
  const finish = (state: CustomerPaymentWindow["state"], reason: CustomerPaymentWindow["reason"], eligibility: CustomerPaymentWindow["initiationEligibility"] = "INELIGIBLE") => ({ ...result, state, reason, initiationEligibility: eligibility });
  if (success) return finish("PAID", "PAYMENT_SUCCEEDED");
  if (order.status !== "PENDING") return finish("NOT_PAYABLE", "ORDER_NOT_PENDING");
  if (uncertain) return finish("OUTCOME_UNRESOLVED", unavailable || input.admission === "UNAVAILABLE" ? "ADMISSION_UNAVAILABLE" : "PAYMENT_OUTCOME_UNRESOLVED");
  const closed = input.admission === "CLOSED" || (!!deadline && now >= deadline)
    || (managed && (!!r.paymentAdmissionClosedAt || r.reservationDisposition !== "HELD"));
  // Closing admission never proves an existing provider attempt cannot succeed.
  const pending = !!payment && !finalUnpaid && (payment.status === "PROCESSING" || payment.status === "PENDING");
  if (closed && pending && !r?.firstFailureVerifiedAt) return finish("PROCESSING", "AWAITING_PAYMENT_OUTCOME");
  if (closed) return finish(payment && !finalUnpaid ? "OUTCOME_UNRESOLVED" : "NOT_PAYABLE", "WINDOW_CLOSED");
  if (!configured) return finish(payment && !finalUnpaid ? "OUTCOME_UNRESOLVED" : "NOT_PAYABLE", unavailableReason);
  const minor = order.totalAmount.mul(100);
  if (!minor.isInteger() || minor.lte(0) || !minor.lte(Number.MAX_SAFE_INTEGER)) return finish(payment && !finalUnpaid ? "OUTCOME_UNRESOLVED" : "NOT_PAYABLE", "INVALID_AMOUNT");
  // Database operation-admission guards require these states for CREATE/CONFIRM.
  if (managed && (!payment || (finalUnpaid && payment.status === "CANCELED"))
    && r.state !== "INITIAL_OPEN" && r.state !== "RETRY_OPEN") return finish("OUTCOME_UNRESOLVED", "ADMISSION_UNAVAILABLE");
  if ((!payment || (managed && finalUnpaid && payment.status === "CANCELED")) && input.newInitiationEnabled === false) return finish("NOT_PAYABLE", unavailableReason);
  if (!payment) return finish("INITIAL_PAYMENT", "INITIAL_WINDOW_OPEN", "ELIGIBLE");
  if (payment.provider === "PAYPAL") {
    if (managed && r.retryDeadline && finalUnpaid && payment.status === "CANCELED") return finish("RETRY_AVAILABLE", "VERIFIED_UNPAID_RETRY", "ELIGIBLE");
    if (pending && !finalUnpaid) {
      const capture = current?.operations.some(o => o.type === "CAPTURE");
      if (capture || payment.status === "PROCESSING" || r?.firstFailureVerifiedAt) return finish("PROCESSING", "AWAITING_PAYMENT_OUTCOME");
      if (input.newInitiationEnabled !== false && managed && current && current.operations.some(o => o.type === "CREATE") && current.operations.every(o => o.type === "RETRIEVE" || (o.type === "CREATE" && (o.state === "RESULT_RECORDED" || o.state === "POTENTIALLY_DISPATCHED")))) return { ...finish("CHECKOUT_RESUMABLE", "EXISTING_CHECKOUT_OPEN"), resumeEligibility: "ELIGIBLE" };
    }
    return finish("OUTCOME_UNRESOLVED", "PAYMENT_OUTCOME_UNRESOLVED");
  }
  if (payment.provider !== "STRIPE") return finish("OUTCOME_UNRESOLVED", "OTHER_PROVIDER");
  if (managed && r.retryDeadline && finalUnpaid && payment.status === "CANCELED") return finish("RETRY_AVAILABLE", "VERIFIED_UNPAID_RETRY", "ELIGIBLE");
  // A failure receipt opens a window but does not persist the current provider status.
  // Initiation still retrieves Stripe and requires requires_payment_method after failure.
  if (managed && r.firstFailureVerifiedAt && payment.providerReference.startsWith("pi_") && (pending || payment.status === "FAILED")) {
    return { ...finish("RETRY_REQUIRES_PROVIDER_CHECK", "PROVIDER_CHECK_REQUIRED", "REQUIRES_PROVIDER_CHECK"), resumeEligibility: "REQUIRES_PROVIDER_CHECK" };
  }
  if (pending && payment.providerReference.startsWith("pi_")) {
    // Resume retrieves the existing intent; it does not authorize a new charge or
    // claim that Stripe is currently waiting for input. No secret is exposed here.
    return { ...finish("CHECKOUT_RESUMABLE", "EXISTING_CHECKOUT_OPEN"), resumeEligibility: "ELIGIBLE" };
  }
  return finish("OUTCOME_UNRESOLVED", "PAYMENT_OUTCOME_UNRESOLVED");
}

export const PAYMENT_WINDOW_BATCH_SIZE = 100;
const paymentWindowSelect = {
  id: true, status: true, reservationExpiresAt: true, totalAmount: true,
  payments: { select: { id: true, provider: true, providerReference: true, status: true, paidAt: true } },
  paymentResolution: { select: { historical: true, quarantineReason: true, state: true, initialPaymentDeadline: true, retryDeadline: true, firstFailureVerifiedAt: true, paymentAdmissionClosedAt: true, reservationDisposition: true } },
  paymentAttempts: { select: { paymentId: true, providerReference: true, historical: true, finalityEvidenceId: true, successEvidenceId: true, operations: { select: { type: true, state: true } } } },
  financialEvidence: { select: { kind: true } },
} as const;

/** Bounded batches, no per-order queries. Caller owns the consistent transaction. */
export async function readCustomerPaymentWindows(tx: Prisma.TransactionClient, userId: number, orderIds: readonly number[]) {
  const windows = new Map<number, CustomerPaymentWindow>();
  if (!orderIds.length) return windows;
  // Fetch policy with the existing clock read, preserving fixed queries per batch.
  const [clock] = await tx.$queryRaw<Array<{ now: Date; enabled: boolean; paypalEnabled: boolean }>>`SELECT clock_timestamp() AS now,
    COALESCE((SELECT "enabled" FROM "PaymentInitiationPolicy" WHERE "provider"='STRIPE'), false) AS enabled,
    COALESCE((SELECT "enabled" FROM "PaymentInitiationPolicy" WHERE "provider"='PAYPAL'), false) AS "paypalEnabled"`;
  const now = clock.now;
  const paypalConfigured = paypalSandboxAvailable();
  const preferredProvider = paypalConfigured && config.PAYMENT_PAYPAL_INITIATION_ENABLED && clock.paypalEnabled && !config.PAYMENT_STRIPE_INITIATION_ENABLED ? "PAYPAL" : "STRIPE";
  for (let offset = 0; offset < orderIds.length; offset += PAYMENT_WINDOW_BATCH_SIZE) {
    const orders = await tx.order.findMany({ where: { userId, id: { in: orderIds.slice(offset, offset + PAYMENT_WINDOW_BATCH_SIZE) } }, select: paymentWindowSelect });
    if (!orders.length) continue;
    // Match the managed admission inbox predicate, plus compatibility Payment
    // references for legacy records. Only already-owned IDs reach this query.
    const inbox = await tx.$queryRaw<Array<{ id: number }>>(PrismaSql.sql`
      /* customer payment window inbox */
      SELECT o.id FROM "Order" o WHERE o.id IN (${PrismaSql.join(orders.map(o => o.id))})
      AND EXISTS (SELECT 1 FROM "PaymentWebhookEvent" w
        WHERE (w."processedAt" IS NULL OR w."processingError" IS NOT NULL)
        AND ((w.provider <> 'STRIPE' AND w.evidence->>'orderId'=o.id::text) OR EXISTS (
          SELECT 1 FROM "PaymentAttempt" a WHERE a."orderId"=o.id AND a.provider=w.provider
          AND (w.evidence->>'paymentIntentId'=a."providerReference"
            OR w.evidence->>'paypalOrderId'=a."providerReference"
            OR w.evidence->>'captureId'=a."providerCaptureReference")) OR EXISTS (
          SELECT 1 FROM "Payment" p WHERE p."orderId"=o.id AND p.provider=w.provider
          AND (w.evidence->>'paymentIntentId'=p."providerReference"
            OR w.evidence->>'paypalOrderId'=p."providerReference"
            OR w.evidence->>'captureId'=p."providerCaptureReference"))))`);
    const unresolved = new Set(inbox.map(row => row.id));
    for (const order of orders) {
      const r = order.paymentResolution;
      const managed = !!r && !r.historical && !r.quarantineReason;
      // Read-only equivalent of checkPaymentAdmission. Keep these predicates in
      // sync; parity tests exercise the real initiation endpoint as authority.
      const terminating = order.paymentAttempts.some(a => a.operations.some(o => o.type === "TERMINATE" && o.state !== "RESULT_RECORDED"));
      const admission: PaymentWindowInput["admission"] = !managed
        ? config.PAYMENT_RESOLUTION_ENABLED ? "UNAVAILABLE" : "OPEN"
        : unresolved.has(order.id) || terminating ? "UNAVAILABLE"
        : order.status !== "PENDING" || r.paymentAdmissionClosedAt || r.reservationDisposition !== "HELD" || r.state === "PAID"
          || now >= (r.retryDeadline ?? r.initialPaymentDeadline) ? "CLOSED" : "OPEN";
      windows.set(order.id, presentCustomerPaymentWindow({ order, payment: order.payments[0] ?? null, resolution: r,
        attempts: order.paymentAttempts, hasUnresolvedInbox: unresolved.has(order.id),
        hasSuccessEvidence: order.financialEvidence.some(e => e.kind === "SUCCESS"), hasFinancialEvidence: order.financialEvidence.length > 0,
        admission, managedEnabled: config.PAYMENT_RESOLUTION_ENABLED, stripeConfigured: !!config.STRIPE_SECRET_KEY, paypalConfigured, preferredProvider,
        newInitiationEnabled: (order.payments[0]?.provider ?? preferredProvider) === "PAYPAL" ? config.PAYMENT_PAYPAL_INITIATION_ENABLED && clock.paypalEnabled : config.PAYMENT_STRIPE_INITIATION_ENABLED && clock.enabled, now }));
    }
  }
  return windows;
}

export async function readCustomerPaymentWindow(tx: Prisma.TransactionClient, userId: number, orderId: number): Promise<CustomerPaymentWindow> {
  const window = (await readCustomerPaymentWindows(tx, userId, [orderId])).get(orderId);
  if (!window) throw new Error("Owned payment window not found");
  return window;
}
