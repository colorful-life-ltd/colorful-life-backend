# Payment-safe customer cancellation and reservation expiry — Issue #154

## Production rollout limitation

**Any existing Payment record blocks ordinary cancellation and reservation expiry. Unresolved attempts can retain stock indefinitely, including abandoned attempts and provider failures. Production rollout requires a safe payment-resolution and reservation-release process. Never delete payment records or release inventory solely because a local timeout elapsed.**

## Intended transitions (defined before implementation)

| Operation | Eligibility under the order-row lock | Result | Inventory |
| --- | --- | --- | --- |
| Customer cancellation | Owned PENDING or CONFIRMED, uncancelled, no Payment record | CANCELLED | Release pending reservation or restore eligible confirmed New stock exactly once |
| Seller cancellation | Existing ADMIN authorization, PENDING or CONFIRMED, uncancelled, no Payment record | CANCELLED | Existing #151 behavior preserved |
| Reservation expiry | PENDING, deadline reached, no Payment record | EXPIRED | Release reservation exactly once |
| Cancellation with Payment | Any provider/status, including FAILED/CANCELED and placeholders | Reject with 409 after ownership/status checks | No change |
| Expiry with Payment | Any provider/status, including FAILED/CANCELED and placeholders | No-op (`null`) | Reservation retained |
| Verified Stripe success on retained PENDING order | Existing identity/amount/currency checks | Payment SUCCEEDED and order CONFIRMED atomically | Convert reservation to sale once, even after deadline |
| Stripe success on historical CANCELLED/EXPIRED order | Existing authoritative correlation | Record success and durable reconciliation exception | No resurrection or inventory change |
| PayPal success on historical CANCELLED/EXPIRED order | Existing authoritative correlation | Record success and durable reconciliation exception | Existing behavior; no resurrection or inventory change |

A successfully paid order cannot use ordinary cancellation. A failure notification does not prove an attempt is terminal: Stripe initiation reuses existing attempts, placeholders survive timeouts, and delayed success can supersede failure. CANCELED records are also retained conservatively; no provider-side cancellation/resolution workflow is introduced. This matches #151's payment-record boundary. All current providers persist their local Payment before provider I/O. No Payment means there is no supported provider attempt to resolve.

## Concurrency and invariants

Cancellation, expiry, Stripe initiation/recovery/reconciliation, PayPal initiation/capture preparation and manual initiation use the existing Order row lock. No external network calls are added inside transactions. If cancellation/expiry wins before initiation, initiation observes CANCELLED/EXPIRED and fails before creating a Payment or invoking a provider. If initiation wins, the durable Payment prevents both cancellation and expiry throughout provider I/O and every local payment state. Issue #153 also locks the Order before PayPal initiation response persistence, capture completion and webhook reconciliation. Payment existence, rather than mutable payment status, remains the conservative boundary protecting cancellation/expiry.

Inventory changes remain inside the same transaction as order transitions. Listing rows are processed in ascending listing ID, preserving existing lock ordering; durable cart tasks are queued after inventory updates. Missing reservations roll back all changes. Duplicate/repeated cancellation and expiry cannot release/restore twice. Consumed Used offers remain terminal. Stripe success/confirmation remains idempotent and success cannot regress through failure/cancellation notifications. No new transaction retry or process-local correctness lock is introduced.

## HTTP contract

Existing `POST /orders/:orderId/cancel` authentication, verified-email check, ownership and valid reasons remain unchanged. Successful responses remain unchanged. Other customers/missing orders still return 404; invalid reason or transition returns existing 400 errors.

New customer payment conflicts reuse #151's codes:

- 409 `{error:{code:"ORDER_ALREADY_PAID",message:"Paid orders cannot be customer-cancelled"}}` for SUCCEEDED or non-null paidAt.
- 409 `{error:{code:"ORDER_PAYMENT_UNRESOLVED",message:"Orders with an existing payment attempt cannot be customer-cancelled"}}` otherwise.

The payment check follows ownership and transition validation. Seller cancellation messages/codes are unchanged. Expiry keeps its existing internal return contract: updated Order for a successful expiry, null for an ineligible/no-op attempt.

## Operational limitations and #153 boundary

Orders with any Payment record may retain inventory indefinitely after deadline, even when the provider fails or cancels. This is intentional fail-closed behavior; safely resolving those attempts is a separate explicit lifecycle decision. New payment attempts after deadline still reject under existing checkout rules; Stripe webhook/recovery may finalize an already initiated attempt. No automatic refund or provider cancellation is introduced. #154 required no migration, new state or dependency; #153's separately approved durable webhook recovery adds nullable receipt evidence and a pending index.

An elapsed payment deadline does not necessarily mean the Order status is EXPIRED. Under #154, payment-backed PENDING orders may retain their inventory beyond that deadline. Issue #153 distinguishes actual CANCELLED/EXPIRED orders from a merely elapsed reservation deadline in PayPal capture/reconciliation diagnostics. Verify the persisted order and inventory state before operational resolution; an elapsed deadline is not proof that inventory was released.

PayPal-specific capture eligibility/races, in-flight authorization and terminal-state regression are addressed separately in [Issue #153](paypal-payment-safety.md). #154 originally added only cancelled-order late-success diagnostics alongside existing expiry diagnostics; #153 serializes outcome processing and preserves terminal success and paidAt. PayPal completion still does not automatically confirm an order. Existing exceptions use PaymentWebhookEvent.processingError and require operational resolution; #154 does not create alerting, repair historical paid/cancelled records without new evidence, or invent a refund policy.


## Confirmed root causes and changed files

Customer cancellation previously locked the Order and checked ownership/status but never checked Payment. Reservation expiry previously excluded only SUCCEEDED, allowing release during PROCESSING/PENDING or retryable FAILED/CANCELED attempts. Stripe reconciliation correctly records financial outcomes, but cannot safely fulfil an order whose inventory was already released. PayPal late-success diagnostics previously covered expiry without covering cancellation.

Application changes are limited to:

- `src/domain/orders/orderCancellationService.ts` — customer payment eligibility under the existing lock; seller logic unchanged.
- `src/domain/orders/orderCancellationErrors.ts` — reuse existing paid/unresolved error with customer-specific text; seller defaults unchanged.
- `src/controllers/orders.ts` — customer 409 mappings.
- `src/domain/orders/orderExpiryService.ts` — require no Payment records to expire.
- `src/domain/payments/paypalCaptureService.ts` and `paypalReconciliationService.ts` — cancelled-order late-success exception only.

Tests: add `src/__tests__/paymentSafeCancellationExpiry.integration.test.ts`; update `checkoutPaymentHardening.integration.test.ts`, `stripePaymentRecovery.integration.test.ts` and `cartProvenance.integration.test.ts` so normal operations retain payments, while explicitly seeded historical terminal orders still exercise late-payment exception handling. Existing seller, expiry, dispatch, Used offer and cart tests remain regression coverage. The new test file uses real PostgreSQL transactions, signed local Stripe webhook payloads and an observed PostgreSQL lock-wait graph; only external provider I/O is faked.

Documentation: this file plus the #151 admin handoff's limitations paragraph. No schema, configuration or dependencies change.

## Validation results

- Build: passed, including after the final test/documentation corrections.
- Final strengthened PayPal/payment-safety tests: 23 passed, 0 failed, 0 skipped. The full suite was not repeated for these test/documentation-only corrections.
- Focused order/payment/cancellation/expiry/seller/PayPal regression: 117 passed, 0 failed, 0 skipped.
- Final corrected cart-provenance and payment-safety regression: 74 passed, 0 failed, 0 skipped (including all 23 new payment-safety tests).
- Final full backend suite: 951 passed, 3 skipped, 0 failed (954 total). Run with `RUN_STRIPE_SANDBOX_TESTS=false RUN_STRIPE_WEBHOOK_E2E_TESTS=false RUN_STRIPE_REFUND_WEBHOOK_E2E_TESTS=false npm test`.
- The first full run identified three obsolete cart-test expectations permitting payment-backed cancellation/expiry. Those expectations were corrected; the final full run passed.
- The established runner validated the dedicated `colorful_life_test` database. No pending migrations were applied.
- `git diff --check`: passed.

The three skipped tests are the opt-in Stripe sandbox charge/refund and webhook end-to-end tests. External provider I/O in the added tests uses local fakes; no live Stripe or PayPal charges or refunds were made. Final read-only security review: PASS WITH WARNINGS for commit and a review PR; production rollout remains subject to the reservation-resolution requirement; see the separate #153 handoff for current PayPal guarantees and limitations. No merge or deployment is authorized.
