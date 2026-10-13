# Payment resolution — Issue #156 Phase 2B

This is a staged runtime extension of the Phase 2A data foundation. It is not production activation. `PAYMENT_RESOLUTION_ENABLED` defaults to `false`. No historical order is automatically enrolled, released or given a fabricated admission/retry timestamp. Existing quarantined records, including order #16964, require separate reviewed recovery. No automatic refunds are implemented.

## Admission and retry policy

New orders created while enabled receive a database-timed initial payment deadline 30 minutes after creation. Admission checks run under the Order row lock. An eligible initial financial operation must have immutable admission evidence before that deadline.

The first qualifying, verified failure accepted transactionally opens exactly 30 minutes from the database verification timestamp. There is no verification-age cutoff or global 60-minute cap. Further failures cannot extend the window. Failure of a charge attempt is not proof that its provider object cannot succeed later. Pending receipts or unfinished financial operations block competing financial admission.

Examples: failure verified at minute 5 permits retry until minute 35; at minute 29 until minute 59; at minute 50 until minute 80. Failure days later has the same rule if the original operation was eligible and the order remains unpaid, HELD and not permanently closed. A failure at minute 55 after the first failure at minute 50 does not change minute 80. Initial deadline expiry temporarily closes new admission; it does not by itself permanently close eligible delayed failure verification. Explicit abandonment permanently closes admission. Paid, released or otherwise permanently closed orders cannot reopen.

A Stripe verified `payment_intent.payment_failed`, or an authenticated retrieval showing `requires_payment_method` with a payment error, can supply qualifying attempt-failure evidence. A verified PayPal denied capture can do so only with matching order, capture, amount and currency. Neither observation establishes provider-object finality. Historical UNKNOWN operations without proven admission cannot open retry.

## Provider rules

| Provider observation | Local action | Inventory |
| --- | --- | --- |
| No Payment, attempt, operation or relevant financial evidence | Close admission and atomically establish NO_PAYMENT proof after deadline or explicit abandonment | Release once |
| Stripe succeeded, exact identity/amount/currency | Record immutable success and paidAt; confirm once when inventory permits | Consume once; never release |
| Stripe requires_payment_method / requires_confirmation / requires_action with zero received/capturable amounts | Journal termination before cancellation; independently retrieve afterward | Hold until verified canceled and complete coverage |
| Stripe canceled, zero received/capturable amounts, exact identity and financial evidence | Establish terminal-unpaid evidence; release only after applicable windows and complete evidence checks | Hold or release once |
| Stripe processing, requires_capture, unexpected amounts, timeout, missing identity or inconsistent evidence | Reconcile/escalate; do not cancel or infer finality | Hold |
| PayPal completed capture | Preserve existing paid-but-unconfirmed flow and durable evidence | Hold pending explicit confirmation; never release purchased inventory |
| PayPal denied/pending, missing order, outage, approval timeout or cancellation redirect | Reconcile and escalate; no generic order cancellation or terminal-unpaid assertion | Hold |

Stripe documents cancellation restrictions and automatic refund behavior for `requires_capture`: [PaymentIntent cancellation](https://docs.stripe.com/api/payment_intents/cancel). This implementation excludes `requires_capture` and `processing`, even where Stripe may permit cancellation. A request, SDK response or local timeout alone is never a release proof.

PayPal [Orders v2](https://developer.paypal.com/api/orders/v2) provides no generic CAPTURE order cancellation endpoint. The authenticated [get-order operation](https://developer.paypal.com/api/orders/v2/orders-get) is used for reconciliation, not as a guarantee that an absent or aged order can no longer be paid. PayPal automatic release and a new capture after an uncertain/denied prior capture remain unsupported. Retry eligibility can be recorded while financial admission remains blocked by unresolved provider finality. This is an operational limitation, not permission to force release.

## Additive migrations

Applied Phase 2A migrations are unchanged. Five separate migrations are required, in order:

1. `20261015120000_payment_resolution_runtime`: nullable proof evidence reference; `NO_PAYMENT` / `PROVIDER_FINALITY` proof enum and pairing constraint; replaces the Phase 2A unconditional RELEASED prohibition with full transactional proof validation; permanently closed admission rejects new Payment insertion.
2. `20261015121000_payment_resolution_runtime_scheduling`: bounded-worker due index; supports existing seller cancellation reason alongside customer abandonment for no-payment release.
3. `20261015122000_payment_resolution_inbox_guard`: checks relevant pending, errored and success receipts before proof creation, including provider identities and normalized order evidence.
4. `20261015123000_payment_resolution_late_failure`: accepts distinct qualifying first-failure evidence after a previously recorded terminal-unpaid observation while retaining the original immutable operation evidence. All operation identity/admission requirements remain enforced.

5. `20261015124000_payment_resolution_release_inbox_recheck`: revalidates relevant inbox evidence on the RELEASED disposition write, including direct SQL paths after proof creation.

DDL is transactional with a five-second lock timeout. There is no historical backfill or financial/stock rewrite in these migrations. Deployment still requires controlled PostgreSQL DDL locking and the Phase 2A non-owner runtime-role privilege boundary. Test migrations were applied only to the guarded `colorful_life_test` database. Do not apply them to production as part of this work.

Generated Prisma client files are included. `Payment` remains the compatibility aggregate; previous attempts, operations, receipts and evidence remain durable when a verified canceled Stripe intent is replaced during retry.

## Proof and concurrency guarantees

Financial transitions acquire Order first, then relevant receipt/payment state; inventory rows are locked in listing ID order. Provider I/O occurs outside database transactions. Immutable operation journals precede provider calls and record actual provider idempotency keys. Recovery uses durable owner tokens, increasing claim generations, counters and expiring leases. A stale worker cannot apply a fenced result. Read-only retrieval is recoverable; uncertain creates/captures are not blindly redispatched, including after provider idempotency retention could have elapsed.

Inventory release requires unpaid status, same-order proof, permanent admission closure, exact coverage of all PaymentAttempts and PaymentOperations, no historical/quarantined attempt, no unresolved operation or relevant inbox evidence, and expired applicable windows unless explicitly abandoned. PROVIDER_FINALITY is presently restricted to independently verified canceled Stripe intents with zero received and capturable amounts. NO_PAYMENT requires complete absence of payment and financial evidence. Proof, closure, disposition, stock restoration and order transition commit atomically. Purchased stock is never restored. Listing updates also protect the lower bound of known HELD reservations; discrepancies fail closed rather than inventing stock.

Savepoints isolate failed release/fulfillment from durable provider observations. Verified managed financial success is retained as SUCCEEDED with paidAt even if inventory cannot be converted. Such an order remains paid and unfulfilled with a durable diagnostic for manual reconciliation; it is not released or silently fulfilled. Historical/quarantined late success similarly retains evidence without automatic fulfillment. Operator intervention is required.

Stripe receipts now retain normalized allowlisted evidence for delayed correlation. Binding and resolution replay relevant receipts with exact validation under the Order lock. Unknown/mismatched evidence blocks admission and release. PayPal continues using the existing durable inbox and replay from #153. #151 seller cancellation and #154 customer/expiry guards remain; ordinary cancellation with payment records is not broadened. Provider-backed abandonment uses the dedicated resolution path.

Prisma PostgreSQL sessions explicitly use UTC. Admission/deadline/failure acceptance uses database time, avoiding host-clock drift and adapter timestamptz offset loss. Legacy stored Order timestamps are interpreted explicitly as UTC when enrolling only newly created orders; historical rows are not rewritten.

## API contract

Existing checkout/payment APIs remain. Managed Stripe initiation may return HTTP 409 with `PAYMENT_ADMISSION_CLOSED` or `PAYMENT_OUTCOME_UNRESOLVED`; consumers must reconcile rather than repeatedly create/capture. PayPal retains its existing generic `{ error }` envelope for these HTTP 409 restrictions.

- `GET /orders/:orderId/payment-resolution`: authenticated, verified-email owner only. HTTP 200: `{ serverTime, paymentResolution: { state, reservationDisposition, initialPaymentDeadline, firstFailureVerifiedAt, retryDeadline, paymentAdmissionClosedAt } }`, ISO timestamps/null where applicable. No resolution returns `paymentResolution: null`. No provider IDs, journals, proofs or credentials are exposed.
- `POST /orders/:orderId/abandon`: same ownership protection, no payload required. HTTP 200: `{ state, reservationDisposition }`. HELD is a valid result when provider outcome is unresolved; it does not promise immediate stock release. Repeated ineligible abandonment returns 409; retries of uncertain operations are journaled/reconciled.
- Invalid ID 400, missing/other customer's order 404, unauthenticated 401, unverified email follows existing 403 behavior, unavailable persistence 503.

Admin #39 must distinguish paid-but-unconfirmed from ordinary unpaid PENDING and must not offer force release or promise PayPal immediate cancellation. No Admin/Storefront files were changed.

## Worker and production prerequisites

The existing API process starts a feature-gated worker: every 15 seconds, at most 25 due nonhistorical HELD rows, serial processing with no overlapping cycle in one process. PostgreSQL leases protect cross-instance provider work; Order locks serialize no-payment release. Active windows are rescheduled to their deadline; unresolved/error cases back off five minutes. Failed rows yield rather than occupying the head indefinitely. The due-row scheduler uses a bounded indexed query. Relevant-inbox JSON evidence checks still need production-scale query-plan/load validation; bounding the batch does not bound every underlying receipt scan. Lease duration is 60 seconds. PayPal authenticated calls use ten-second timeouts; Stripe uses the existing SDK client. A slow SDK call can exceed a lease, but stale results are fenced and subsequent work retrieves current provider state before any new termination operation.

No AWS resources are provisioned. Each enabled API instance polls; budget database/provider load for instance count and backlog. Monitor due-row age/count, held units and duration, SAFETY_HOLD/REVIEW_REQUIRED, escalation timestamps, provider failures, lease recovery, receipt errors and paid-but-unconfirmed orders. There is no automatic force-release threshold. Missing provider identities, provider outages and unresolved PayPal outcomes can retain stock indefinitely and need a separately approved resolution process.

The worker returns a stop function, but the current server bootstrap does not wire it into graceful shutdown or await in-flight work. Process crashes are recoverable through leases and durable state; a fully drained shutdown is a remaining operational improvement. Application-level monitoring/alerts and long-hold operational runbooks are deployment prerequisites.

Apply migrations and generated client before enabling the flag. Use a coordinated cutover: old binaries do not enforce managed admission; do not mix them with enabled writers. Runtime role must have required table/sequence and trigger-function permissions, without ownership/DDL or audit DELETE/TRUNCATE privileges. Do not enable on historical stock by fabricating coverage. Disabling the flag stops enrollment/worker but does not safely unwind existing managed rows; reconcile/drain them through reviewed code. There is no destructive down migration; rollback requires operational planning.

## Independent review remediation

Owner reconciliation and initiation retrievals now journal definitive authenticated observations as RESULT_RECORDED evidence. Success and verified failure do not fabricate provider finality; only a validated canceled intent with zero received/capturable amounts supplies terminal-unpaid evidence. Existing finality pointers remain immutable. Pending/ambiguous provider outcomes remain UNKNOWN.

The resolver recovers unfinished reads even with existing finality and an open retry window. Failed release attempts, including false/no-op eligibility results, receive a future check time so overdue blocked records yield to newer worker jobs. The bounded sweep is tested against a 25-record PostgreSQL backlog. Shutdown still stops admission of subsequent jobs in the current sweep; it does not drain provider calls already in flight.

Verified early Stripe failures/cancellations bind an unbound Payment and its exact pending PaymentAttempt under the Order lock only after amount, currency, order metadata and attempt metadata checks. A lost create response is not redispatched. The recorded identity permits safe retrieval and preserves the independent immutable retry window. Manual-payment admission conflicts now return HTTP 409 rather than HTTP 500.

## Validation

46 Phase 2B targeted tests cover real PostgreSQL constraints/migrations, rollback and historical preservation, admission, immutable days-late retry, Stripe cancellation/retrieval races, durable early-event replay, stale leases, exact-once inventory, ownership, PayPal conservative resolution and paid inventory exceptions. Provider calls use local fakes; no live charges, cancellation or refunds.

Final remediation validation: 1,087 full-suite tests passed, 3 external sandbox tests intentionally skipped, 0 failures. The focused payment regression run passed 225 tests, including all 46 Phase 2B targeted cases and the five new review regressions. TypeScript typecheck/build, Prisma validation, guarded test-database migration status and git diff checks passed. No lint script or lint configuration exists in this repository. No application/development database migration, order cleanup, commit, push or deployment was performed.

## Changed-file manifest

- `docs/payment-resolution-runtime.md`
- `prisma/migrations/20261015120000_payment_resolution_runtime/migration.sql`
- `prisma/migrations/20261015121000_payment_resolution_runtime_scheduling/migration.sql`
- `prisma/migrations/20261015122000_payment_resolution_inbox_guard/migration.sql`
- `prisma/migrations/20261015123000_payment_resolution_late_failure/migration.sql`
- `prisma/migrations/20261015124000_payment_resolution_release_inbox_recheck/migration.sql`
- `prisma/schema.prisma`
- `src/__tests__/paymentResolutionPolicy.test.ts`
- `src/__tests__/paymentResolutionRuntime.integration.test.ts`
- `src/__tests__/paymentResolutionRuntimeMigration.integration.test.ts`
- `src/config/index.ts`
- `src/controllers/payments.ts`
- `src/controllers/paypalPaymentController.ts`
- `src/controllers/stripePaymentController.ts`
- `src/domain/orders/orderCancellationService.ts`
- `src/domain/orders/orderConfirmationService.ts`
- `src/domain/orders/orderExpiryService.ts`
- `src/domain/orders/orderService.ts`
- `src/domain/payments/paymentResolutionService.ts`
- `src/domain/payments/paymentService.ts`
- `src/domain/payments/paypalCaptureService.ts`
- `src/domain/payments/paypalOrderService.ts`
- `src/domain/payments/paypalPaymentOutcome.ts`
- `src/domain/payments/paypalReconciliationService.ts`
- `src/domain/payments/paypalResolutionService.ts`
- `src/domain/payments/stripePaymentRecoveryService.ts`
- `src/domain/payments/stripePaymentService.ts`
- `src/domain/payments/stripeReconciliationService.ts`
- `src/domain/payments/stripeResolutionService.ts`
- `src/generated/prisma-client/commonInputTypes.ts`
- `src/generated/prisma-client/enums.ts`
- `src/generated/prisma-client/internal/class.ts`
- `src/generated/prisma-client/internal/prismaNamespace.ts`
- `src/generated/prisma-client/internal/prismaNamespaceBrowser.ts`
- `src/generated/prisma-client/models/FinancialEvidence.ts`
- `src/generated/prisma-client/models/ReservationReleaseProof.ts`
- `src/index.ts`
- `src/prisma/runtime.ts`
- `src/routes/orders.ts`
- `src/utils/apiErrorResponse.ts`
