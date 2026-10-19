# PR #209 — D1/D2/D3 targeted review remediation

Review baseline: `723c844`. Branch: `feature/production-audit-remediation`. This implements the completed review's targeted findings; it is not a new audit. No production data, deployment or merge operations are part of this change.

## D1 — Stripe financial holds

`src/domain/payments/providerFinancialGuard.ts` classifies retained provider evidence against locally bound attempt identities and immutable financial proof. `processingError` is diagnostic, not financial finality. A historical flag or a canceled/failed notification alone is insufficient.

An earlier attempt's negative receipt becomes non-blocking only when its `TERMINAL_UNPAID` evidence belongs to that attempt/order/provider, has verified identity/principal/currency, proves canceled with zero received/capturable funds, covers completed operations, and has no success evidence. Both the attempt success pointer and independently recorded operation success evidence are checked. Missing, malformed, mismatched or conflicting proof remains held.

Verified SUCCESS on the same current Stripe intent explains nonterminal declines, including delayed deliveries. A terminal cancellation conflicting with that success remains held. Earlier-attempt successes, actual disputes and unresolved refunds are never treated as harmless negative receipts. Existing fully refunded/in-flight/review fulfilment fences remain authoritative.

Legacy Stripe payments without managed attempts can explain nonterminal failures through a fully validated, processed successful provider receipt for the same exact identity/principal. The GET recovery service now retains an allowlisted immutable `payment_intent.recovered` success payload as well, so recovery does not require a later webhook. This does not manufacture managed attempts or FinancialEvidence. Terminal cancellations and invalid financial identities still hold.

Each explained receipt appends one immutable `PROVIDER_RECEIPT_FINANCIAL_RESOLVED` audit, referencing payment, receipt, attempt and financial-evidence IDs, or an explicit verified success-receipt ID for the legacy path. Its unique request key deduplicates concurrent evaluation. Original provider evidence and processing diagnostics remain unchanged. The guard recomputes the decision on every use; an audit record is not a force-clear token and does not exempt later contradictory receipts.

`src/domain/payments/paymentResolutionService.ts` also revalidates this classification at retry admission. This handles an old cancellation delivered while a new provider intent is being created. Only individually audited, freshly revalidated benign receipts can satisfy that admission check; other inbox errors remain blocking. Existing database stock-release/inbox triggers are unchanged. There is no new financial-finality shortcut or provider mutation.

## D2 — PayPal financial holds

The same guard distinguishes:

- `CUSTOMER.DISPUTE.*`: DISPUTE hold, including resolved notifications pending financial investigation.
- Capture/approval reversals: REVERSAL hold, exposed internally as `PROVIDER_REVERSAL_REVIEW_REQUIRED`.
- Capture declines or unresolved capture observations: PAYMENT hold unless independently explained by verified attempt-level proof.

An old decline can become non-blocking only with an exact matching Order/Capture pair and independent `DEFINITIVELY_DECLINED` finality from the existing resolver, with completed operation coverage, verified amount/currency and no success conflict. The historical flag, an empty/no-dispatch observation, or `reviewedAt` alone never clears it. A decline contradicting the current successful capture, malformed receipt, mixed-attempt IDs, actual dispute or reversal remains held.

Resolution appends the same immutable proof-linked audit. No administrative financial override or new provider call is introduced; provider retrieval remains in the established resolver outside database locks. Unproven historical cases continue to require authorized financial investigation.

## D3 — Cancellation withdrawal contract

`POST /admin/orders/:orderId/request-paid-cancellation` now returns:

```json
{"requested":true,"replayed":false,"requestId":"123","active":true}
```

`requestId` is a decimal string representing the immutable request's audit ID. Replaying a withdrawn request returns its original ID and `active:false`; it never reactivates the intent. A new cancellation after withdrawal requires a new key and produces a new request ID. Reusing an active request with a different key conflicts.

New route:

```http
POST /admin/orders/:orderId/withdraw-paid-cancellation
Authorization: Bearer <active ADMIN token>
Idempotency-Key: <stable withdrawal key>
Content-Type: application/json

{"requestId":"123","reason":"Withdraw mistaken cancellation before any refund"}
```

Successful response:

```json
{"withdrawn":true,"replayed":false,"requestId":"123"}
```

Requirements and behavior:

- Active ADMIN, valid idempotency key and reason of10–1000 characters; actor/time come from the server.
- The referenced request must still be active. Request identity acts as the concurrency version.
- Order must remain confirmed and unshipped, with no blocking return and a verified matching GBP payment.
- **No refund may ever have been initiated for the payment**, including a refund that later failed. Refunded/reserved amounts must be zero and no unresolved provider evidence may exist.
- Order → Payment locks serialize withdrawal with cancellation requests, refund initiation and dispatch. There are no provider calls under these locks.
- Withdrawal appends `PAID_CANCELLATION_WITHDRAWN` referencing the request, reason, actor and key; it never edits/deletes the original request.
- Fulfilment evaluates active requests through `paidCancellationState.ts`, excluding only requests with a matching immutable withdrawal.
- Exact withdrawal replay returns its original result, even after a newer request exists; it cannot withdraw that newer request. Changed actor/reason/request under the same key conflicts.

Errors include `INVALID_CANCELLATION` (400), `FORBIDDEN` (403), and409 conflicts: `CANCELLATION_VERSION_CONFLICT`, `IDEMPOTENCY_CONFLICT`, `CANCELLATION_ALREADY_REQUESTED`, `REFUND_ALREADY_INITIATED`, `ORDER_NOT_CANCELLABLE`, `VERIFIED_PAYMENT_REQUIRED`, `PAYMENT_PROVIDER_EVIDENCE_UNRESOLVED`.

A generic refund may legitimately begin **after** a committed withdrawal. Its own in-flight/refund/review fence then blocks dispatch. Withdrawal cannot erase that financial hold. Tests explicitly exercise both transaction orderings rather than assuming all concurrent API calls must be mutually exclusive.

## F10 — Staged approach for owner review

The agreed implementation approach for this remediation remains:

1. Record an audited cancellation intent to fence dispatch.
2. Use the existing durable, idempotent refund API with an explicitly chosen amount.
3. After full finalized refund, use `cancel-refunded` to atomically cancel/restock eligible unshipped NEW orders.

Before step2, an eligible mistaken request can now be withdrawn. Once refund initiation occurs, the cancellation follows the existing financial recovery/finalization workflow. Used offers retain their inspection/return policy.

**The original single-action refund/cancel/restock contract has not been delivered and is not claimed.** The staged approach is preserved by the user's targeted implementation instruction and submitted for owner review. No network/database atomicity is asserted; no new automatic refund orchestration is introduced.

## Regression and verification evidence

`src/__tests__/productionReviewRemediation.integration.test.ts` adds25 tests:

- Real Stripe service journey: create → decline → independently retrieved canceled/zero-money finality → distinct retry → verified success; late old cancellations/failures and concurrent duplicate delivery remain fulfillable with one audit per proof/receipt.
- A late old Stripe event during provider creation does not strand the valid retry. Same-intent delayed nonterminal failures remain explained by verified success. Legacy webhook and GET-only recovery journeys remain fulfillable without a managed ledger.
- Earlier success contradictions, amount/capture mismatches, unproven historical attempts, actual disputes/reversals and current PayPal success/decline conflicts stay held. Acknowledgement never supplies proof.
- Real PayPal create/capture-decline → independent resolver GET → new Order/Capture → success; retained earlier decline resolves only through exact immutable finality.
- Full external dashboard refund after paid retry is booked exactly once and still blocks fulfilment; the original successful dashboard-refund regressions remain unchanged.
- Withdrawal authorization/validation, HTTP contract, exact and concurrent replay, old/new request generations, immutable audit, initiated/failed refunds and unresolved financial holds.
- Real PostgreSQL lock queues exercise refund-first/withdrawal-first and dispatch-first/withdrawal-first orderings, preserving stock and shipment invariants.

Targeted suite: **25 passed, 0 failed, 0 skipped**. Broader focused financial suite: **320 passed, 0 failed, 0 skipped**. Build and Prisma validation passed. All71 existing committed migrations applied on a new disposable PostgreSQL16 cluster; schema drift diff empty. No schema, migration, generated-client, dependency or infrastructure change is needed for this follow-up. Final full-suite and final-head CI results are recorded in the PR #209 description after completion; the existing CI checks are unchanged.

Local focused disposable targets: ports55440/55441; final fresh full-suite target: `127.0.0.1:55442/colorful_life_test`; the normal URL used an unused different database name. The safe runner enforces synthetic AWS credentials, injected providers, disabled real-provider tests and the external-network guard. No real payments or emails are sent.

## Outstanding staging and owner acceptance

- Exercise signed Stripe/PayPal events and delayed retries in an isolated provider environment, including exact sandbox payload shapes and retained-receipt processing.
- Verify ADMIN/frontend integration with requestId, withdrawal/replay conflicts, separate reversal/dispute diagnostics and staged cancellation operator controls.
- Validate homogeneous API rollout, ECS/ALB drain/readiness, worker supervision, least-privilege ledger permissions, approved secrets/origins/SES controls, backup/PITR/restore and alert routing. Existing immutable-ledger grants already permit these new append-only audit kinds.
- Owner reviews the staged F10 operating process and bank/refund approval, evidence retention and authorized financial-correction policies. Unknown/conflicting historic cases have no force-clear bypass.
- Independent follow-up review, merge and deployment remain user-controlled. No review agent is initiated by this implementation.
