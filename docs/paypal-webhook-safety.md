# PP-3: verified PayPal webhook coverage and operator review (#191)

## Contracts and trust boundary

Checked against official PayPal documentation on 2026-10-17:

- [Event names](https://developer.paypal.com/api/rest/webhooks/event-names/):
  Payments v2 `PAYMENT.CAPTURE.DECLINED`, v1 `PAYMENT.CAPTURE.DENIED`, capture
  reversals, and `CUSTOMER.DISPUTE.CREATED/UPDATED/RESOLVED`.
- [Uncaptured payment sample](https://developer.paypal.com/v5/checkout/uncaptured-payments/):
  `CHECKOUT.PAYMENT-APPROVAL.REVERSED` identifies the order in **resource.order_id**,
  not resource.id and not purchase_units[].custom_id.
- [Official Disputes API schema](https://github.com/paypal/paypal-rest-api-specifications/blob/main/openapi/customer_disputes_v1.json):
  the dispute identity is resource.dispute_id; the merchant's
  transaction IDs are disputed_transactions[].seller_transaction_id. Buyer IDs,
  invoice numbers and custom metadata are not payment ownership proof.
- [Disputes operations](https://developer.paypal.com/platforms/disputes/integrate-disputes/)
  describe retrieving current dispute details for operator investigation.

Existing signature verification runs **before** normalization or inbox persistence.
PP-4 raw-body/signature hardening is not included. No Dashboard registration or
provider calls are introduced. Customer PayPal initiation remains disabled.

## Processing and ordering

The existing committed inbox/replay boundary is reused. New receipts retain only
allowlisted provider IDs, status, amount/currency, dispute outcome, update time
and invalid-field names. No raw payload, customer details, links, credentials,
buyer transaction IDs or untrusted local ownership hints are stored.

`DECLINED` may signal FAILED only with matching bound provider IDs, resource
status DECLINED, amount and currency. It schedules existing PP-2 read-only
resolution; it never certifies TERMINAL_UNPAID or releases stock. Existing DENIED
handling remains compatible. Older attempt identifiers can identify a review,
but cannot fail the current retry's Payment. Paid evidence is never downgraded.

All other new events are **review-only**. They do not refund, cancel, confirm,
restock, close payment admission, or reverse a paid/fulfilled order. They do not
emit invoice/email jobs. FinancialEvidence remains reserved for existing
success/failure/finality semantics: risk observations stay in the durable inbox,
not misleading SUCCESS or TERMINAL_UNPAID evidence.

Correlation uses Payment and historical PaymentAttempt provider bindings. Multiple
seller transactions are supported; unknown or conflicting IDs remain visible in
a review. Missing/malformed resources are acknowledged after durable evidence
and diagnostics commit. Such receipts do not acquire guessed ownership.

Each provider event ID has one immutable inbox receipt and one review. Concurrent
redelivery is serialized by the receipt lock; Order locks are acquired in ID order
before receipt locks, consistently with financial processing. Distinct event IDs
retain distinct observations, even if their resources are identical; there are
**no financial effects to duplicate**. Provider update time is evidence, not an
ordering/ownership authority. No mutable "latest dispute status" exists, so an
older delivery cannot overwrite a newer observation or clear its review. A
RESOLVED webhook does not automatically acknowledge other reviews.

## Admin API and runbook

Authenticated ADMIN only (current database role, not JWT role claim):

- `GET /admin/paypal/webhook-reviews?afterId=0&includeAcknowledged=false`
  returns `{ "reviews": [...] }`, in ascending receipt ID, maximum 100. Advance
  afterId to the last returned ID. Use includeAcknowledged=true for audit.
  Each result includes event ID/type, timestamps, normalized evidence,
  processingError, reviewDetails and reviewedAt.
- `POST /admin/paypal/webhook-reviews/:receiptId/acknowledge` with `{}` records
  reviewedAt and acknowledgedByUserId once. Repeats preserve the first actor/time.
  No operator-supplied correlation, financial status or stock mutation is accepted.

reviewDetails contains a reason (PROVIDER_EVENT_REQUIRES_REVIEW,
MALFORMED_RESOURCE or UNCORRELATED_PROVIDER_IDENTIFIERS), correlated local
order/payment/customer IDs, and unmatched capture IDs. These are admin-only.

1. Monitor open reviews and inbox processing errors. This release supplies an API,
   not a new admin frontend or alerting system; operational polling is required.
2. Inspect provider event/capture/order/dispute IDs against authenticated PayPal
   account records and the existing local payment/attempt ledger. Check current
   provider dispute status and deadlines; do not use event arrival order.
3. For uncorrelated/malformed events, investigate provider records and retained
   normalized evidence; obtain a corrected signed notification where applicable.
   No endpoint permits assigning an order from metadata. Unmatched review-only
   receipts remain durable; unlike capture-success receipts they are not retried
   indefinitely by the financial replay worker.
4. Acknowledge each inspected receipt. Acknowledgement means **reviewed**, not
   "won dispute", "unpaid", "refund succeeded", or "safe to release stock".
   It leaves evidence and processingError intact. Other open notifications remain.
5. Any refund, finality investigation or inventory remediation must use the
   existing audited workflows and PP-2 provider proof requirements. Never manually
   downgrade success or release inventory based on a reversal/dispute label.
   Provider dispute responses, escalations and reversal accounting require manual
   operations outside this API. No automatic provider mutations are included.

## Deployment

Apply the additive inbox metadata migration **before** this application version;
then generate/deploy the matching Prisma client. Existing receipts remain intact,
with no historical review backfill. Migration has a local five-second lock timeout
and an explicit transaction; on lock contention it rolls back, and operators must
resolve the failed Prisma migration before retrying normally. Do not edit applied
migration history. No payment-security triggers or finality predicates change.

No production activation, real webhook registration, email or payment was performed.
Production PayPal enablement and PP-4 signature hardening remain separate work.
