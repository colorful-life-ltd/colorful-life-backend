# PayPal finality and reservation release (PP-2 / #189)

Customer PayPal initiation remains unconditionally disabled. These services only
process existing payments and internal, explicitly requested retry flows. No new
customer PayPal checkout or payment-window action is enabled.

## Authority and admission

PP-2 uses the existing MANAGED PaymentResolution / PaymentAttempt / PaymentOperation
ledger. The initial deadline remains order creation + 30 minutes. The existing
first verified failure rule grants one 30-minute retry window, never extended by
repeated failures. A worker which observes an elapsed effective deadline closes
admission permanently under the Order lock before obtaining finality. A later
failure cannot reopen that closure. Explicit customer abandonment closes admission
through the existing authenticated `/orders/:id/abandon` path.

Capture permission is persisted before provider I/O under the same Order lock used
by expiry, abandonment and release. Closing admission prevents new permissions;
an already admitted capture can still execute or succeed. Such a permission must
remain covered until its financial outcome is proved. Provider calls run outside
the transaction. Retrievers use leased operations and owner/generation fencing.

## Outcomes and proof

| Outcome | Authority | Reservation behavior |
| --- | --- | --- |
| NOT_DISPATCHED | Nonhistorical bound managed attempt, closed admission, no CAPTURE/CONFIRM/TERMINATE permission, no capture key/binding or contradictory capture inbox evidence | Persist TERMINAL_UNPAID for every operation, then attempt atomic release |
| DEFINITIVELY_DECLINED | Exact authenticated order GET containing one matching GBP capture with DECLINED status; or a durable HTTP 422 INSTRUMENT_DECLINED response for the sole capture permission plus exact CAPTURE-intent APPROVED empty order GET and matching purchase-unit GBP amount | Retire this attempt with TERMINAL_UNPAID; release only when admission closes or the effective deadline expires |
| PENDING | Matching provider capture remains PENDING | Retain inventory; no retry permission |
| UNKNOWN | Transport errors, absent captures after a possible dispatch, unbound creation, unsupported status, mismatched identity/amount/currency, incomplete or contradictory coverage | Retain inventory, schedule read-only recheck / operator review |
| COMPLETED | Verified matching successful capture | Existing PP-1 confirmation, WEBSITE_SALE, CONSUMED disposition and immutable invoice/email outbox; never unpaid release |

A timeout, local FAILED status, webhook denial, expired order deadline, 404, an
empty retrieval or an apparent VOIDED status alone is **not** terminal-unpaid proof.
Only the HTTP 422 allowlisted funding rejection is classified definitively; generic
422/5xx/authentication failures are uncertain. Raw provider payloads and credentials
are not persisted. Allowlisted evidence records identities, GBP amount, outcome,
operation and retrieval IDs. Pending/denied webhook receipts remain durable.
The DENIED webhook is a failure signal, not a recognized Orders v2 retrieval status.
A denial schedules independent retrieval promptly while the retry window is open.

Release reuses `attemptManagedRelease` / `releaseManagedReservation`: all attempts
and operations must be covered, admission closed, no paid evidence or unresolved
relevant inbox, and no conflicting returns. The proof, reservation disposition,
stock decrement and terminal Order status commit together, exactly once. Inventory
errors roll back release only, retaining already verified finality for later review
and a safe local reattempt. No provider capture is replayed by the resolver.

## Explicit retry

1. A verified decline may open the existing retry deadline, but does not itself
   authorize another capture.
2. Read-only resolution independently establishes finality for the original
   attempt. Its capture/creation identities are permanently retired.
3. An explicit internal `createOrReusePayPalOrder` request, while admission remains
   open and all original operations are resolved, creates a fresh PayPal order and
   PaymentAttempt using a fresh UUID request key. The compatibility Payment keeps
   its original authoritative amount and shipping-inclusive total.
4. After the new order is approved, an explicit capture obtains a fresh UUID
   capture permission. There is at most one permission per PayPal order/attempt.
   Concurrent creates cannot redispatch a managed pending creation; concurrent
   captures cannot obtain a second permission.

No retry, order creation or reconciliation mutation is triggered by customer reads.
The existing customer paymentWindow continues to prohibit PayPal initiation/resume
(OTHER_PROVIDER); PAID and terminal projections remain authoritative. A fresh
provider order requires fresh buyer approval in any future approved integration.

## Conservative compatibility limits

Legacy/historical orders have no complete operation coverage and are never
retrofitted with invented admission or unpaid evidence. Their uncertain captures
are not redispatched, even with the same key: PayPal retains idempotency keys only
for a limited period. They retain inventory for explicit operator reconciliation.
Unbound managed CREATE outcomes similarly remain held, rather than assuming an
unknown provider object is safe. A late create response cannot bind a new provider
identity after managed admission has closed. These safety holds can require manual
review; PP-2 does not guarantee automatic release of every historical unpaid order.

Old-attempt receipts after a fresh retry remain correlated by retained attempt
identities in the release inbox guard. An unexpected contradictory success remains
durable for review and prevents unpaid release; it does not overwrite the current
payment binding. Late EXPIRED/CANCELLED success continues through PP-1's financial
evidence/manual-remediation path without stock resurrection or automatic refund.

Stripe's financial verification, finality predicates, admission/retry rules,
recovery, confirmation, refunds and reservation policies are unchanged. No shared
payment-window eligibility was broadened to expose customer PayPal actions.

## Migration and deployment

`20261022120000_paypal_unpaid_finality` is an additive function/trigger migration;
there are no model/client or historical-data changes. It retains the existing
Stripe branch verbatim, adding tightly scoped PayPal no-dispatch/verified-decline
coverage and a database capture-permission fence. Global paid/inbox/coverage/return
and immutable-evidence protections remain active.

Apply migrations before running PP-2 workers. The migration is transactional with a
5-second lock timeout: failure rolls back the entire migration; resolve a failed
Prisma deployment only after checking migration status, then retry under the
normal release procedure. Do not edit applied migration history. Without the new
migration, the older Stripe-only release guard fails closed for PayPal and stock
remains held. Do not drop proofs/evidence or manually relax guards to force release.
Rollback should disable the affected worker/process under operator control and
retain the migration and all evidence; do not restore pre-ledger capture binaries.
No production migration, activation or deployment is authorized by this PR.

## Provider references

- [PayPal funding failures](https://developer.paypal.com/api/handle-payment-failures/)
- [Capture statuses](https://developer.paypal.com/sdk/orders/v2/definitions/capture_status/)
- [Idempotency and retention](https://developer.paypal.com/api/rest/reference/idempotency/)

Validation uses disposable PostgreSQL 16, synthetic credentials, mocked provider
responses, captured MIME/PDF and a guard blocking external network requests. It is
not real PayPal/Stripe/SES E2E and does not establish production readiness. No
Dashboard webhook registration or production configuration is part of PP-2.
