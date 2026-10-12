# PayPal payment safety — Issue #153

## Intended transitions (defined before implementation)

| Operation | Before | Required behavior |
| --- | --- | --- |
| Initiation response | Unconditionally writes PENDING and clears paidAt | Lock Order, reread Payment, bind only its placeholder identity; preserve current status and paidAt |
| Capture/cache access | In-flight result can precede ownership check | Check current database ownership for every caller before cache access and before returning identifiers |
| Capture preparation | EXPIRED/deadline checked; CANCELLED omitted | Lock Order; reject CANCELLED/EXPIRED and elapsed deadlines before new provider calls; persist/reuse capture request key |
| Successful capture replay | Rejects every SUCCEEDED payment | Return the authorized persisted successful result when capture identity exists; no new provider call |
| Capture/webhook success | Separate paths; webhook has no Order lock | Lock Order, reread Payment, validate financial/provider identities, preserve first paidAt and terminal success |
| Pending/denied webhook | Stale snapshot can overwrite success | Reread under Order lock; never downgrade SUCCEEDED or a payment with paidAt evidence |
| Duplicate receipt | Every P2002 is acknowledged | Deduplicate the exact provider/event key and immutable evidence; retry pending processing, never overwrite evidence |
| Success before identity binding | Unknown receipt is marked processed and acknowledged; later duplicates cannot reconcile | Commit verified evidence first; keep uncorrelated success pending and replay locally after binding or restart |
| Historical CANCELLED/EXPIRED late success | Can have inconsistent concurrent outcomes | Record SUCCEEDED and durable reconciliation exception; preserve terminal Order and inventory |

PayPal completion continues to record payment only. Existing ADMIN order confirmation remains the separate operation that consumes reservations. No automatic fulfilment, refund, provider cancellation or new payment/order state is introduced. The approved recovery extension adds a nullable receipt evidence field and a pending-receipt index.

## Coordination and unresolved attempts

Order is locked before Payment for all PayPal financial writes. Provider calls remain outside transactions. Initiation first commits a durable Payment; capture first commits/reuses its durable capture request key. These records, not the process-local cache, protect #151/#154 cancellation and expiry across processes. Concurrent provider calls reuse the same existing PayPal order and request key; PayPal may reject one simultaneous request, which is an unavailable/retryable result rather than evidence of failure or permission to release stock. See [PayPal idempotency](https://developer.paypal.com/api/rest/reference/idempotency/). Provider idempotency retention is finite; this is not a promise of unlimited provider retries.

**Any Payment record blocks ordinary cancellation/expiry, including FAILED/CANCELED and placeholders. Unresolved attempts can retain inventory indefinitely. Production rollout requires an approved payment-resolution and reservation-release process. Never delete payment records or release stock solely because a local timeout elapsed.** Ambiguous provider responses and unknown webhook correlation require operational reconciliation; this issue does not invent a resolution/refund policy.

## Implemented transaction boundaries and state rules

1. Initiation: Order `FOR UPDATE` → current ownership/status → read/create Payment and durable create request key → commit → provider I/O → new Order lock → reread Payment → validate/bind provider order identity only → commit → immediate replay attempt for that provider identity. A conflicting identity is rejected. Delayed responses preserve PROCESSING/FAILED/CANCELED as well as SUCCEEDED and paidAt; an already-successful payment detected in initiation returns the existing 409 conflict. Immediate replay failures leave committed identity/evidence available for the polling worker; they do not undo binding. A 201 initiation response confirms provider-order creation, not a claim that payment is still pending.
2. Capture: database ownership check before cache access → transaction Order lock → ownership, terminal-order/deadline and Payment checks → persist/reuse capture request key → commit → provider I/O → transaction Order lock → reread Payment → validate one completed capture, amount, GBP currency and existing order/capture identity → SUCCEEDED with first paidAt → any reconciliation exception in the same transaction. Ownership is checked again before identifiers are returned. A complete persisted successful capture can be replayed after its deadline with no provider call; CANCELLED/EXPIRED orders still reject capture requests.
3. Webhook acceptance: verified provider signature (outside transaction) → transaction insert with `ON CONFLICT (provider, providerEventId) DO NOTHING` → receipt lock → check immutable normalized evidence/type → commit. This transaction never waits for Order or Payment. Persistence failures are not acknowledged as HTTP 2xx.
4. Financial processing/replay: read durable evidence → lookup for correlation only → Order lock if correlated → receipt lock → reread receipt and Payment → validate identities and completed amount/currency → apply outcome and mark receipt processed in one transaction → commit. Pending/denied cannot change SUCCEEDED or paidAt evidence; conflicting capture IDs cannot replace an established identity. Processing failure rolls back payment/receipt-completion changes, while the previously committed evidence remains pending.

Financial processing acquires Order before receipt and Payment; no financial transition takes a Payment/receipt lock then waits for Order. Receipt acceptance is a separate receipt-only transaction that commits before attempting financial processing, so it introduces no lock-order inversion. Capture completion still acquires Order before Payment and its diagnostic receipt; the common Order lock serializes these paths. PayPal does not touch listing/cart locks. Existing confirmation/cancellation acquire Order before listing rows in ascending ID, then durable cart tasks. There is no added transaction retry loop or network I/O under a database lock. The cache coalesces authorized requests in one process; independent processes may call PayPal with the same persisted key. Provider errors never erase the attempt or release reservations.

Success is monotonic: PENDING/PROCESSING/FAILED/CANCELED may become SUCCEEDED on verified, matching success; SUCCEEDED remains SUCCEEDED and its original paidAt and capture identity are retained. Pending/denied events do not prove a provider attempt cannot later succeed. Historical paidAt evidence is preserved even if the old status was already inconsistent; this change does not bulk-repair historical rows.

## Late success and webhook receipts

Actual CANCELLED/EXPIRED orders keep that status and their existing stock state. Successful provider outcomes remain SUCCEEDED and generate a durable `PaymentWebhookEvent.processingError` requiring refund/reconciliation. A capture response records an idempotent `capture:<captureId>` exception, including when a webhook already recorded success; webhooks retain their provider event receipts. Neither path re-reserves, consumes or restores inventory, or resurrects terminal orders.

A still-PENDING payment-backed order after its deadline retains stock under #154. Its diagnostic explicitly says the reservation deadline elapsed and inventory may remain retained; this is different from actual EXPIRED status. New provider capture attempts after the deadline remain rejected; already-in-flight outcomes and verified webhooks can still be recorded.

HTTP 200 means verified normalized evidence has committed durably. It does not mean an uncorrelated or mismatched payment has been processed. Such financial receipts retain `processedAt = NULL`, their evidence and a diagnostic, and return `handled:false`. They remain discoverable for local replay after provider redelivery stops. Supported successfully processed receipts have a non-null processedAt; unsupported event types are retained and marked ignored/processed without changing Payment. Refund events remain receipt-only.

Exact-key duplicate delivery returns `duplicate:true`. Pending duplicates are processed again using the original immutable evidence; processed duplicates return their existing outcome without financial writes or timestamp replacement. A differing event type or normalized financial payload under the same key is rejected with sanitized HTTP 500 and cannot overwrite evidence, diagnostics or success. Truly unknown identities and mismatches stay pending for investigation rather than being guessed into a paid order. Evidence stores only version, provider event ID/type, provider order ID, capture ID, amount and currency; no signature headers, credentials, approval URLs or customer information.

Any receipt-persistence failure returns HTTP 500 with no success acknowledgement. Financial processing database failures also return HTTP 500; the durable inbox row remains pending. Only the exact provider/event uniqueness conflict is deduplication. A failed Payment/capture-key or unrelated receipt primary-key constraint is never treated as handled success. Financial updates and receipt completion commit or roll back together.

[PayPal retries non-2xx delivery up to 25 times over 3 days](https://developer.paypal.com/api/rest/webhooks/rest/). HTTP 500 alone is therefore best-effort recovery. After evidence has committed, the local replay worker provides recovery independent of further delivery, conditional on eventual identity binding, valid evidence, database availability and an operating worker. No unconditional recovery is claimed if evidence could never be persisted during an outage, identity never becomes known, or provider evidence is missing/mismatched.

Legacy receipts have evidence=NULL. They cannot be reconstructed by this migration. A verified redelivery can backfill evidence once and reopen a legacy unknown/mismatch receipt; it cannot reset successful completion. Legacy pending receipts without evidence remain visible and receive a diagnostic requiring redelivery or manual reconciliation. Legacy already-processed unknown receipts need verified redelivery or an approved operational resolution; the worker does not fabricate their missing payload.

Refund notifications retain the existing receipt-only behavior. No refund bookkeeping or provider refund/cancellation operations are added. Exceptions are durable database evidence, not a new alerting system or a completed payment-resolution workflow.

## Replay scheduling and production operation

`src/index.ts` calls `startPayPalWebhookReplayWorker()` alongside the existing cart worker. Normal `npm start` starts replay immediately and polls every 5 seconds in each backend/ECS Fargate process. No AWS scheduler, queue or infrastructure is provisioned. `app.ts` alone does not start a worker; API-only custom entry points must invoke the exported starter or arrange repeated calls to `replayPendingPayPalWebhooks()`.

Each sweep reads pending PAYPAL receipts directly from PostgreSQL using the `(provider, processedAt, id)` index, up to 100 rows per keyset page. It captures an ID upper bound and advances through older unresolved rows, so a stream of new events or an uncorrelated first page cannot prevent later receipts from being visited. A new sweep/restarted process starts from the beginning. There is no persistent claim, lease, process-local queue or cached cursor. Database transaction rollback releases locks on crash; a receipt stays pending until completion commits atomically. Multiple Fargate processes may select the same work; the Order and receipt locks plus the processedAt recheck make financial application idempotent. In-memory `running` only avoids overlapping ticks in one process.

Immediate replay runs after provider identity binding has committed. It is an optimization; a crash between binding and replay is covered by the periodic database scan. Operators can also invoke the exported one-sweep function from an authorized backend task with the normal database configuration; it performs no provider calls.

Before rollout, apply migration `20261012120000_add_paypal_webhook_evidence` and deploy the matching generated client. Drain old webhook receivers or route PayPal webhook traffic only to the new version: old code can still acknowledge uncorrelated events without evidence. Ensure the production entry point starts replay and valid PayPal webhook verification is configured. Monitor pending count/oldest age, processingError diagnostics and sanitized replay-failure logs. Do not delete pending receipts/payment records or release stock based only on age. Production rollout remains subject to #154's approved payment-resolution/reservation-release process.

## Approved migration

The additive migration adds nullable `PaymentWebhookEvent.evidence JSONB` and the index `PaymentWebhookEvent_provider_processedAt_id_idx` on `(provider, processedAt, id)`. No new enum, table or payment/order state. Existing data and the `(provider, providerEventId)` unique key are retained; no evidence is invented for historical receipts. Five tracked Prisma client files are regenerated for the new field. The migration is applied only to the guarded test database during this work; no production migration/deployment is performed.

## HTTP and Admin #39 handoff

Existing routes, authenticated/verified-email middleware, payloads and response shapes remain:

- `POST /orders/:orderId/payments/paypal`: 201 `{paypalOrderId, approvalUrl?}`. Server-owned GBP amount and persisted create key; successful payments cannot be initiated again.
- `POST /orders/:orderId/payments/paypal/capture`: 200 `{paypalOrderId,captureId}`. Authorized completed capture replay now returns the stored result without contacting PayPal.
- Invalid IDs: 400. Missing/foreign orders: generic 404. Ineligible/terminal orders or mismatched provider results: 409. Provider unavailable/ambiguous response: 503. Webhook database processing failure: 500, without internal error details.

#151 ADMIN reads and seller-cancellation restrictions are unchanged. #154 customer cancellation, lazy/worker expiry and all-payment-record inventory retention are unchanged. Admin #39 must continue to display payment and order states separately: PayPal SUCCEEDED does not imply CONFIRMED. Existing ADMIN confirmation/dispatch rules govern fulfilment; terminal late-success exceptions require an approved payment-resolution process, not ordinary cancellation or automatic dispatch.

## Tests and scope

`paypalPaymentSafety.integration.test.ts` uses real PostgreSQL transactions and fixtures with real reservations; provider calls and webhook signature verification use local fakes. Tests observe PostgreSQL lock waits, load independent capture service instances to remove cache coordination, and introduce actual unrelated capture-reference and receipt primary-key uniqueness conflicts. Recovery tests use separate Node.js OS processes with independent PostgreSQL connections; one is killed with SIGKILL while blocked and replaced. Early-success tests cover PENDING/CANCELLED/EXPIRED, verified HTTP delivery, identity binding, redelivery, immediate replay, worker-only recovery, immutable evidence and stable paidAt/inventory. Historical terminal fixtures explicitly release reservations before seeding their inconsistent Payment, or simulate a pre-#154 release during provider I/O. Existing #151/#154, PayPal HTTP/webhook and full backend regressions remain validation coverage.

The only schema/migration changes are the explicitly approved additive receipt field/index and generated client; no dependency, external API operation or Storefront/Admin repository changes. No live charges/refunds, production services or deployment. The payment-resolution/reservation-release operational prerequisite from #154 remains outstanding.

## Changed-file inventory

The complete uncommitted #153 scope, including the original fixes and approved recovery extension:

- `prisma/schema.prisma`
- `prisma/migrations/20261012120000_add_paypal_webhook_evidence/migration.sql`
- `src/domain/payments/paypalOrderService.ts`
- `src/domain/payments/paypalCaptureService.ts`
- `src/domain/payments/paypalReconciliationService.ts`
- `src/domain/payments/paypalPaymentOutcome.ts`
- `src/domain/payments/paypalWebhookReplayService.ts`
- `src/controllers/paypalPaymentController.ts`
- `src/controllers/paypalWebhookController.ts`
- `src/index.ts`
- `src/__tests__/paypalPaymentSafety.integration.test.ts`
- `src/generated/prisma-client/commonInputTypes.ts`
- `src/generated/prisma-client/internal/class.ts`
- `src/generated/prisma-client/internal/prismaNamespace.ts`
- `src/generated/prisma-client/internal/prismaNamespaceBrowser.ts`
- `src/generated/prisma-client/models/PaymentWebhookEvent.ts`
- `docs/paypal-payment-safety.md`
- `docs/admin-order-management.md`
- `docs/payment-safe-cancellation-expiry.md`

## Validation results

- TypeScript build: passed with the new schema/client and recovery tests.
- Targeted PayPal lifecycle/security/recovery tests: 41 passed, 0 failed, 0 skipped, including 16 new durable-recovery tests (25 original #153 tests).
- Focused PayPal/#151/#154 cancellation and expiry regression: 119 passed, 0 failed, 0 skipped. External sandbox tests were explicitly disabled.
- The approved migration applied successfully to the validated `colorful_life_test` database only.
- The previous full backend run was 976 passed, 3 skipped, 0 failed **before this recovery extension/migration**. It has not been rerun for this correction.
- `git diff --check`: passed. All 19 changed files (including five generated client files) are scoped to backend #153 and its approved recovery extension.
- External sandbox tests remain disabled; no live payment or refund operations.

Changes remain uncommitted; no push, PR, merge, production migration or deployment was performed. Recovery is conditional as documented above; permanently missing correlation/evidence and inventory-release policy still require operational resolution.
