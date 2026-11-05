import { prisma } from "../../prisma/runtime.js";

/**
 * Operator visibility for verified Stripe receipts whose reconciliation could not complete
 * (`PaymentWebhookEvent.processingError`), correlated to a local Stripe payment.
 *
 * Read-only: it never refunds, cancels, releases inventory or changes financial state. A receipt
 * leaves the list when a later replay clears its error, or when an operator records
 * `PROVIDER_RECEIPT_FINANCIAL_RESOLVED` for it. Uncorrelated receipts (e.g. another environment's
 * events on a shared Stripe account) are not shown.
 */
export type StripeReconciliationKind =
  | "INVENTORY_RECONCILIATION_REQUIRED"
  | "CAPTURED_ON_TERMINAL_ORDER"
  | "RESERVATION_COVERAGE_REVIEW"
  | "CORRELATION_MISMATCH"
  | "DISPUTE_REVIEW_REQUIRED"
  | "REVIEW_REQUIRED";

const guidance: Record<StripeReconciliationKind, string> = {
  INVENTORY_RECONCILIATION_REQUIRED: "Funds were captured but the order could not be confirmed. Check stock for the order's items, then confirm or refund it.",
  CAPTURED_ON_TERMINAL_ORDER: "Funds were captured for an order that is no longer active. Review the order and refund the customer if appropriate.",
  RESERVATION_COVERAGE_REVIEW: "Funds were captured for an order without complete reservation coverage. Check stock before confirming or refunding.",
  DISPUTE_REVIEW_REQUIRED: "The customer's bank has opened or updated a dispute. Respond in the Stripe Dashboard before its deadline; do not refund the disputed charge.",
  CORRELATION_MISMATCH: "The Stripe event did not match this payment's identity or amount. Compare it with the Stripe Dashboard before acting.",
  REVIEW_REQUIRED: "Reconciliation needs operator review. Compare the order with the Stripe Dashboard before acting.",
};

export function classifyStripeReconciliationError(error: string): StripeReconciliationKind {
  if (error.startsWith("Captured payment requires manual inventory reconciliation")) return "INVENTORY_RECONCILIATION_REQUIRED";
  if (error.startsWith("Captured payment with historical or incomplete reservation coverage")) return "RESERVATION_COVERAGE_REVIEW";
  if (error.startsWith("Captured payment for ")) return "CAPTURED_ON_TERMINAL_ORDER";
  if (error === "STRIPE_DISPUTE_REVIEW_REQUIRED") return "DISPUTE_REVIEW_REQUIRED";
  if (/mismatch/i.test(error)) return "CORRELATION_MISMATCH";
  return "REVIEW_REQUIRED";
}

type Row = { receiptId: bigint | number; eventType: string; receivedAt: Date; processedAt: Date | null; processingError: string;
  orderId: number; paymentId: number; paymentIntentId: string; amount: string; currency: string; paymentStatus: string; orderStatus: string };

export async function listUnresolvedStripeReconciliation(limit = 100) {
  const rows = await prisma.$queryRaw<Row[]>`
    SELECT w.id AS "receiptId", w."eventType", w."receivedAt", w."processedAt", w."processingError",
      p."orderId", p.id AS "paymentId", p."providerReference" AS "paymentIntentId", p.amount::text AS amount, p.currency,
      p.status::text AS "paymentStatus", o.status::text AS "orderStatus"
    FROM "PaymentWebhookEvent" w
    JOIN "Payment" p ON p.provider = 'STRIPE' AND p."providerReference" = w.evidence->>'paymentIntentId'
    JOIN "Order" o ON o.id = p."orderId"
    WHERE w.provider = 'STRIPE' AND w."processingError" IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM "OperationalAudit" a WHERE a."orderId" = p."orderId"
        AND a.kind = 'PROVIDER_RECEIPT_FINANCIAL_RESOLVED' AND a.details->>'receiptId' = w.id::text)
    ORDER BY w."receivedAt" ASC, w.id ASC
    LIMIT ${limit}`;
  return rows.map(row => {
    const kind = classifyStripeReconciliationError(row.processingError);
    return { receiptId: String(row.receiptId), provider: "STRIPE", eventType: row.eventType, receivedAt: row.receivedAt, processedAt: row.processedAt,
      kind, action: guidance[kind], processingError: row.processingError, orderId: row.orderId, orderStatus: row.orderStatus,
      paymentId: row.paymentId, paymentStatus: row.paymentStatus, paymentIntentId: row.paymentIntentId, amount: row.amount, currency: row.currency };
  });
}
