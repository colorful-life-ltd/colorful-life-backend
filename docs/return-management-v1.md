# Return Management V1 — review and release notes

## Confirmed eligibility policy

Owner confirmed: Return Management begins only after confirmed dispatch on a paid order. Before dispatch, paid orders use the existing cancellation/refund/support process; unpaid orders never initiate payment refunds. Admission is enforced by Backend as well as UI. The missing selected-item/quantity pre-dispatch refund workflow is documented as a separate gap in Backend `docs/pre-dispatch-item-refund-gap.md`; this PR does not add it.


This branch is not a release authorisation. No serving database, payment provider, infrastructure or customer record was changed during implementation.

## Model and behaviour

One `ReturnCase` with a UNIQUE `orderId` owns the permanent `BB-R-{orderId}` reference. Each `ReturnSubmission` has its own immutable idempotency key/hash and request date. Existing `OrderReturn` rows remain the individual lines, with independent reasons, quantities and lifecycle timestamps. Customer submission does not choose or assign a postage payer; it remains null until an administrator decides.

The existing Order → OrderItem → OrderReturn lock order, exact inventory-deduction evidence, reservation counters, conditional transitions, inspection restrictions and completion/restocking ledger are reused. A multi-line submission is atomic. Concurrent requests cannot reserve more than the purchased quantity less completed/outstanding returns. Reusing a submission key with different content fails. Identical action retries are safe; completion restocks once. Legacy admin action URLs retain their existing line response and duplicate-transition contracts while using the audited workflow.

Only REQUESTED lines can be rejected. REQUESTED or AUTHORIZED lines may be withdrawn before physical receipt; the UI warns customers not to withdraw posted goods. Cancellation/rejection releases the reserved quantity once. RECEIVED/INSPECTED/COMPLETED lines cannot be cancelled. Receipt records its actual date, authenticated operator and note, without changing stock, inspecting goods, completing a return or calling Stripe/PayPal. Existing inspection and completion are separate.

No automatic return-age rejection, voluntary return window or refund deadline is invented. A statutory cancellation needs no explanation; the default return type records that notice without requiring notes. Fault/non-conformity claims are not rejected merely because the cancellation window elapsed. The administrator must review the applicable rights/evidence and provide a customer-visible rejection reason. Accepted damaged/defective/wrong/misdescribed claims require seller postage. For change-of-mind postage, the administrator must check pre-sale disclosure and any applicable exception before assigning customer postage. Opening/assembling a set is not an automatic rejection. Original-order cancellation and existing refund operations remain separate.

Policy source: https://www.gov.uk/accepting-returns-and-giving-refunds and the already approved storefront Delivery & Returns policy. This workflow does not replace an email cancellation notice or remove statutory rights.

## API

Customer (authenticated, verified, owned order; foreign/missing orders return 404):

- GET `/orders/:orderId/return-case`
- POST `/orders/:orderId/return-requests` — `{idempotencyKey: UUID, lines: [{orderItemId, quantity, reason?, reasonNote?}]}`; default reason CHANGE_OF_MIND.
- POST `/orders/:orderId/return-requests/:returnId/cancel` — `{note}`.

ADMIN only:

- GET `/admin/returns?status=REQUESTED&page=1&pageSize=25` (all lifecycle states supported; page size 1–100).
- GET `/admin/returns/:orderId` — original order/customer, grouped submissions, lines, instruction preview, receipt/decision operators and email state.
- POST `/admin/returns/:orderId/requests` — optional admin-assisted submission, same reservation service.
- POST `/admin/returns/:orderId/lines/:returnId/{authorize|reject|receive|cancel|inspect|complete}`.

Authorisation requires payer, actual postage arrangements, instruction text and rights-review acknowledgement. Address comes from the owner-approved server constant (Colorful Life Ltd, 3 Hawthorne Drive, Bolton upon Dearne, S63 8NS, United Kingdom). The instruction snapshot is used in both account read and email. Operator IDs are derived from authentication, never trusted from a body. Customer reads exclude operator notes/IDs and internal notification diagnostics. The shared wire contract is `src/domain/orders/return-contract.ts`; clients verify their copies against a pinned Backend commit.

## Notifications

Authorisation and the unique `return:{lineId}` RETURN_AUTHORIZATION outbox job commit together. The existing SES worker handles leases, bounded attempts, retryable explicit rejection, UNKNOWN provider acceptance and manual requeue. Cancelled returns/deleted accounts suppress unsent instructions. No historical email is backfilled. The return email shares the existing durable dispatch-email enablement/cutoff and approved business/sender/readiness bundle; no new service or secret. If that existing channel is disabled/unready, jobs remain durable and account instructions remain available; the admin view exposes delivery state for review. UNKNOWN must not be blindly resent.

## Migration and controlled release prerequisites

`20261029150000_return_management_v1` adds two tables, nullable metadata/link columns on OrderReturn, indexes/FKs and immutable case/submission identity guards. It groups every historical return under its original order; each historical line becomes a separate submission because original multi-line submission boundaries are unknown. It preserves all old states, dates, reasons, quantities and inventory counters. Existing authorised legacy lines do not acquire invented historical instructions or automatic emails. It extends the existing outbox event-identity constraint for return authorisations. No refund/payment table or existing migration is modified.

Before a separately authorised release: inspect historical counts and orphan/mismatched links, rehearse the populated upgrade, apply the migration through the existing migration procedure, apply the reviewed grant contract and run runtime probes. ReturnCase/ReturnSubmission allow only runtime SELECT/INSERT; runtime cannot delete the original Order. Their identity remains permanent for that order. Parent-order cascades exist for privileged database lifecycle/disposable-test cleanup, not customer account deletion (which preserves orders).

The **existing browser Nginx proxy does not yet allow these three new customer paths**. A separately reviewed/approved allowlist update must permit only the GET/POST methods above under `/api`, preserving authentication forwarding, proxy headers, request limits and the default denial of `/admin`. No proxy configuration has been edited here. Do not deploy the customer UI before Backend/schema/grants/proxy prerequisites are verified. Admin continues through its existing authenticated private connection.

Rollback is application first. Restore the previous application images through the approved workflow; leave the additive schema, historical links and audit/outbox evidence in place. Never reverse counters, restore deleted profiles or delete return cases as rollback. A release owner must review any queued authorisation jobs before re-enabling delivery after rollback.

## Acceptance checklist

- [ ] Owned customer order: submit A, then B later; one permanent reference and two independently dated submissions.
- [ ] Retry an identical key; one submission. Same key/different body refuses. Parallel excessive quantities refuse atomically.
- [ ] Foreign customer/missing authentication/unverified account cannot read or mutate; CUSTOMER cannot perform ADMIN actions.
- [ ] Queue filters/pagination and customer/original-order context display correctly.
- [ ] Authorise A and legitimately reject B independently; rejection/cancellation releases only its reservation.
- [ ] Preview correct address, instructions and postage; exactly one durable job; captured email and account match.
- [ ] Worker pause/retry/UNKNOWN rules preserved; cancellation suppresses unsent authorisation email.
- [ ] Confirm physical receipt with date/operator/note; no refund or stock change.
- [ ] Inspect, then complete; existing condition restrictions remain, restock once, retain financial evidence.
- [ ] Admin View Original Order / View Returns navigate directly both ways; queue filter remains.
- [ ] Customer sees history, per-line states, instructions and shipping responsibility; can request remaining quantities later.
- [ ] Claude Opus reviews all three exact PR heads; owner separately approves migrations and release.

Automated evidence and final counts are recorded in the PR description. All database tests use newly owned disposable PostgreSQL 16 clusters and captured email/synthetic payment fixtures.
