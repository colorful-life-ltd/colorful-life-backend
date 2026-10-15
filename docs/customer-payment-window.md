# Customer payment window — Issue #177

`paymentWindow` is an additive, typed read model for Stripe customer checkout. Use its capabilities instead of deriving permission from `reservationExpiresAt` or `payment.status`. PayPal initiation remains disabled by #175. No admission, retry, expiry, worker, webhook, capture, refund, or stock-release policy is changed.

## Responses and compatibility

- `POST /orders`, including idempotent replays: the existing creation payload plus `paymentWindow`.
- `GET /orders`: one payment window per owned order.
- `GET /orders/:orderId`: the existing customer detail plus `paymentWindow`.
- `GET /orders/:orderId/payment-resolution`: existing `serverTime` and `paymentResolution` plus `paymentWindow`. `serverTime` equals its `evaluatedAt`.
- `POST /orders/:orderId/payments/stripe/reconcile`: already returns customer detail, so includes the window.

Existing fields, authentication, verified-email checks, ownership boundaries and Admin responses are preserved. Ordinary order responses never contain a Stripe client secret, provider reference, journal key, evidence payload or operational diagnostic. The initiation endpoint remains the only route returning `{clientSecret}` for checkout. Other mutation responses are unchanged; refresh the customer detail afterward.

## Exact schema

The exported definition is `CustomerPaymentWindow` in `src/domain/payments/customerPaymentWindow.ts`. Every field is present. Dates are ISO 8601 UTC strings or explicit nulls.

```ts
{
  version: 1;
  evaluatedAt: string;
  mode: "LEGACY" | "MANAGED" | "UNAVAILABLE";
  state: "INITIAL_PAYMENT" | "CHECKOUT_RESUMABLE" | "PROCESSING"
    | "OUTCOME_UNRESOLVED" | "RETRY_AVAILABLE"
    | "RETRY_REQUIRES_PROVIDER_CHECK" | "PAID" | "NOT_PAYABLE";
  paymentOutcome: "NOT_STARTED" | "PENDING" | "UNRESOLVED" | "SUCCEEDED" | "UNPAID";
  paymentDeadline: string | null;
  retryDeadline: string | null;
  resumeEligibility: "ELIGIBLE" | "INELIGIBLE" | "REQUIRES_PROVIDER_CHECK";
  initiationEligibility: "ELIGIBLE" | "INELIGIBLE" | "REQUIRES_PROVIDER_CHECK";
  reason: "EXISTING_CHECKOUT_OPEN" | "INITIAL_WINDOW_OPEN"
    | "AWAITING_PAYMENT_OUTCOME" | "PAYMENT_OUTCOME_UNRESOLVED"
    | "PROVIDER_CHECK_REQUIRED" | "VERIFIED_UNPAID_RETRY" | "PAYMENT_SUCCEEDED"
    | "ORDER_NOT_PENDING" | "WINDOW_CLOSED" | "ADMISSION_UNAVAILABLE"
    | "STRIPE_UNAVAILABLE" | "INVALID_AMOUNT" | "OTHER_PROVIDER";
}
```

## Authoritative sources

| Field | Source and meaning |
| --- | --- |
| `version` | Read-model contract version 1; this addition remains uncommitted and unpublished. |
| `evaluatedAt` | One PostgreSQL `clock_timestamp()` per projection invocation, shared across batches. Reads have fresh timestamps. |
| `mode` | A non-historical, non-quarantined PaymentResolution is MANAGED, even with new enrollment disabled. No ledger and the flag off is LEGACY. Missing required, historical or quarantined coverage is UNAVAILABLE; reads do not reconstruct it. |
| `paymentDeadline` | Valid managed ledger: `retryDeadline ?? initialPaymentDeadline`. Legacy: `reservationExpiresAt`. Unavailable: null. A null legacy deadline means no recorded bound, matching legacy admission. This limits admission, not eventual provider success or stock release. |
| `retryDeadline` | Valid managed ledger's immutable retry deadline; otherwise null. Its presence never grants permission by itself. |
| `paymentOutcome` | Success from Payment status/paidAt, successful attempt/evidence or PAID resolution. Final unpaid requires matching non-historical attempt finality and all current operations RESULT_RECORDED. Unknown financial operations, unresolved inbox evidence, placeholders or incomplete coverage remain UNRESOLVED. Bound PENDING/PROCESSING with no verified first failure means PENDING (awaiting evidence); no financial activity means NOT_STARTED. A managed first failure without finality remains UNRESOLVED even if initiation overwrites local FAILED with PROCESSING. |
| `resumeEligibility` | Permission to use the existing-payment Stripe initiation reuse path, not permission to create another intent. ELIGIBLE means local reuse preconditions are met. REQUIRES_PROVIDER_CHECK means a managed first failure requires the endpoint's fresh `requires_payment_method` check. INELIGIBLE never advertises resume. |
| `initiationEligibility` | ELIGIBLE means either initial Stripe creation or a verified-unpaid replacement retry. REQUIRES_PROVIDER_CHECK means same-intent retry needs provider verification. Existing normal checkout resume is represented separately by `resumeEligibility`, with initiationEligibility INELIGIBLE. |
| `state`, `reason` | Derived lifecycle/capability classification below. State is independent of the order's fulfilment status. |

The batched reader mirrors `checkPaymentAdmission` from `paymentResolutionService.ts`: valid ledger coverage, unresolved correlated provider inbox, unfinished TERMINATE operations, PENDING order, held disposition, no permanent closure, non-PAID ledger and current effective deadline. It also applies the existing database CREATE/CONFIRM admission guard (INITIAL_OPEN or RETRY_OPEN) where a new operation is required. Legacy reads conservatively inspect known unresolved receipts correlated by order ID or compatibility Payment references. These read-only predicates do not change the initiation service or database guards; integration tests exercise the real initiation/reuse path as the authority.

## Resume and UNKNOWN retrieval semantics

`createOrReuseStripePaymentIntent` locks and checks the order, applies admission/deadline/amount checks, then reuses a bound existing Stripe payment unless it is successful or belongs to another provider. Managed canceled replacement has separate finality prerequisites. Normal reuse journals RETRIEVE, contacts Stripe outside the transaction, binds identity, finalizes retrieval, replays evidence and rechecks admission. With a managed first failure, its final check additionally requires the retrieved status to be `requires_payment_method`.

A bound local PENDING/PROCESSING Stripe payment with open admission, valid amount/configuration, complete required coverage, no financial UNKNOWN/unfinished termination and no unresolved inbox can therefore expose CHECKOUT_RESUMABLE with resumeEligibility ELIGIBLE. The client can call `POST /orders/:orderId/payments/stripe` to re-obtain the existing checkout secret. This does **not** claim Stripe is currently awaiting customer input: the compatibility Payment does not store a current Stripe status, and even an existing intent that is processing can be retrieved by that endpoint. The capability means the reuse handshake is locally admissible; the provider/client SDK still determines the next checkout step. Ordinary reads never retrieve Stripe or return a secret.

`finalizeManagedStripeRetrieval` deliberately records RETRIEVE as UNKNOWN for ordinary successful read observations without a recognized financial outcome, including `requires_payment_method` without a last-payment error. An in-flight or UNKNOWN RETRIEVE is read uncertainty, not evidence of an ambiguous charge; it does not block ordinary resume in this projection. UNKNOWN CREATE/CONFIRM/CAPTURE/TERMINATE, pending placeholder identity, unfinished termination and unresolved inbox still fail closed. Verified-unpaid replacement retry still requires **every** current operation RESULT_RECORDED, including reads, exactly as the initiation endpoint requires.

After a managed first failure, both a local FAILED payment and a local PROCESSING payment rewritten by reuse remain RETRY_REQUIRES_PROVIDER_CHECK while admission is open, with conditional resume/retry eligibility. A failure receipt alone cannot guarantee current provider payability. Even a freshly retrieved failure can race later activity. No Boolean claims otherwise.

## State precedence and transitions

1. Verified financial success yields PAID, no initiation/resume. Fulfilment remains separate: historical PayPal can be paid but unconfirmed; terminal late success can require reconciliation.
2. Non-PENDING orders without success yield NOT_PAYABLE. Their paymentOutcome may independently remain UNRESOLVED.
3. Explicit financial/admission uncertainty yields OUTCOME_UNRESOLVED, no advertised action. Read-only RETRIEVE uncertainty alone is excluded as explained above.
4. A pending bound payment after admission/deadline closure, with no first-failure evidence, remains PROCESSING, with both capabilities INELIGIBLE. The deadline is never used to declare final failure or release stock.
5. Closure with no financial activity or proven unpaid finality yields NOT_PAYABLE; closure with a failed/unresolved outcome yields OUTCOME_UNRESOLVED. A managed first failure remains unresolved at retry expiry even if compatibility status was rewritten to PROCESSING.
6. Fresh initiation requires PENDING, no financial activity, open admission/deadline, configured Stripe and positive representable minor-unit amount. New managed operations must also satisfy INITIAL_OPEN or RETRY_OPEN.
7. A managed CANCELED Stripe payment with a matching non-historical attempt, verified finality, all current operations resolved and an open retry window yields RETRY_AVAILABLE / initiationEligibility ELIGIBLE.
8. A managed first failure with an open window and reusable Stripe identity, but without verified unpaid finality, yields RETRY_REQUIRES_PROVIDER_CHECK. Both capabilities are conditional, never safely retryable guarantees.
9. Otherwise a bound pending Stripe payment passing reuse preconditions yields CHECKOUT_RESUMABLE. A legacy FAILED/CANCELED payment without finality remains OUTCOME_UNRESOLVED, not NOT_PAYABLE. Missing Stripe configuration or an invalid amount also leaves an existing non-final payment OUTCOME_UNRESOLVED; no-payment/proven-unpaid cases are NOT_PAYABLE. Other-provider records never expose a Stripe action.

A first verified managed failure grants exactly 30 minutes from database verification time, even when observed after the original deadline. Duplicates and reads cannot extend it. Delayed success can confirm after either deadline. ELIGIBLE is a local snapshot, not a guarantee against concurrent success, closure, deadline passage or provider failure. Revalidate through the endpoint at execution time.

## Batching, snapshots and creation failure safety

Customer list/detail/status responses use RepeatableRead. List projection loads at most 100 order IDs per batch, always filtered by authenticated userId, plus one inbox query per batch. It derives admission from that same snapshot rather than invoking the per-order admission service. One database clock is shared across all batches. No transaction timeout increase is used.

For N orders the projection performs `ceil(N / 100)` ORM relation loads and the same number of inbox queries, plus one clock query (none for an empty list). Prisma's nested relation loading expands each load into a fixed number of table queries independent of N: Order, Payment, PaymentResolution, PaymentAttempt, PaymentOperation and FinancialEvidence. Thus projection round trips are O(ceil(N / 100)), at most `1 + 7 * ceil(N / 100)` SELECT statements with the current relation strategy, in addition to the existing constant number of list/item/shipment queries and transaction control. Data volume remains proportional to the relevant records. The 205-order tests exercise three batches in both modes, assert batch bounds/call counts and shared clock, and exclude a foreign order ID even when supplied to the helper. No arbitrary history truncation is used.

For fresh customer creation, `createOrder(..., true)` projects the response **inside the existing creation transaction**, after enrollment/cart allocation and before commit. Any projection failure rolls back the new Order, enrollment and reservation. The controller performs no additional database read after commit. Existing domain callers keep their original payload through the default overload. Idempotent replay retains its key checks and adds only a read projection; the common fast replay uses RepeatableRead and never creates another reservation. Fault-injection tests in both modes force the inbox read to fail, verify unchanged order/inventory state, then prove an unkeyed retry creates exactly one additional order/reservation.

## JSON examples

These are exact paymentWindow objects embedded in the existing responses. Values are illustrative.

Initial managed payment:

```json
{"version":1,"evaluatedAt":"2026-10-15T12:00:00.000Z","mode":"MANAGED","state":"INITIAL_PAYMENT","paymentOutcome":"NOT_STARTED","paymentDeadline":"2026-10-15T12:30:00.000Z","retryDeadline":null,"resumeEligibility":"INELIGIBLE","initiationEligibility":"ELIGIBLE","reason":"INITIAL_WINDOW_OPEN"}
```

Existing checkout can be resumed via the Stripe initiation reuse endpoint:

```json
{"version":1,"evaluatedAt":"2026-10-15T12:00:00.000Z","mode":"MANAGED","state":"CHECKOUT_RESUMABLE","paymentOutcome":"PENDING","paymentDeadline":"2026-10-15T12:30:00.000Z","retryDeadline":null,"resumeEligibility":"ELIGIBLE","initiationEligibility":"INELIGIBLE","reason":"EXISTING_CHECKOUT_OPEN"}
```

Unstarted legacy window elapsed while the order is still PENDING:

```json
{"version":1,"evaluatedAt":"2026-10-15T12:31:00.000Z","mode":"LEGACY","state":"NOT_PAYABLE","paymentOutcome":"NOT_STARTED","paymentDeadline":"2026-10-15T12:30:00.000Z","retryDeadline":null,"resumeEligibility":"INELIGIBLE","initiationEligibility":"INELIGIBLE","reason":"WINDOW_CLOSED"}
```

Ordinary expired or cancelled legacy order without payment:

```json
{"version":1,"evaluatedAt":"2026-10-15T12:00:00.000Z","mode":"LEGACY","state":"NOT_PAYABLE","paymentOutcome":"NOT_STARTED","paymentDeadline":null,"retryDeadline":null,"resumeEligibility":"INELIGIBLE","initiationEligibility":"INELIGIBLE","reason":"ORDER_NOT_PENDING"}
```

Processing beyond the admission deadline; late success remains possible:

```json
{"version":1,"evaluatedAt":"2026-10-15T12:31:00.000Z","mode":"MANAGED","state":"PROCESSING","paymentOutcome":"PENDING","paymentDeadline":"2026-10-15T12:30:00.000Z","retryDeadline":null,"resumeEligibility":"INELIGIBLE","initiationEligibility":"INELIGIBLE","reason":"AWAITING_PAYMENT_OUTCOME"}
```

Managed failure with a conditional same-intent retry:

```json
{"version":1,"evaluatedAt":"2026-10-15T12:00:00.000Z","mode":"MANAGED","state":"RETRY_REQUIRES_PROVIDER_CHECK","paymentOutcome":"UNRESOLVED","paymentDeadline":"2026-10-15T13:05:00.000Z","retryDeadline":"2026-10-15T13:05:00.000Z","resumeEligibility":"REQUIRES_PROVIDER_CHECK","initiationEligibility":"REQUIRES_PROVIDER_CHECK","reason":"PROVIDER_CHECK_REQUIRED"}
```

Verified canceled/unpaid intent with fully resolved operations and an open replacement window:

```json
{"version":1,"evaluatedAt":"2026-10-15T12:00:00.000Z","mode":"MANAGED","state":"RETRY_AVAILABLE","paymentOutcome":"UNPAID","paymentDeadline":"2026-10-15T13:05:00.000Z","retryDeadline":"2026-10-15T13:05:00.000Z","resumeEligibility":"INELIGIBLE","initiationEligibility":"ELIGIBLE","reason":"VERIFIED_UNPAID_RETRY"}
```

Financial uncertainty or relevant unresolved inbox:

```json
{"version":1,"evaluatedAt":"2026-10-15T12:00:00.000Z","mode":"MANAGED","state":"OUTCOME_UNRESOLVED","paymentOutcome":"UNRESOLVED","paymentDeadline":"2026-10-15T12:30:00.000Z","retryDeadline":null,"resumeEligibility":"INELIGIBLE","initiationEligibility":"INELIGIBLE","reason":"PAYMENT_OUTCOME_UNRESOLVED"}
```

Verified success; fulfilment remains separately represented:

```json
{"version":1,"evaluatedAt":"2026-10-15T12:00:00.000Z","mode":"MANAGED","state":"PAID","paymentOutcome":"SUCCEEDED","paymentDeadline":"2026-10-15T12:30:00.000Z","retryDeadline":null,"resumeEligibility":"INELIGIBLE","initiationEligibility":"INELIGIBLE","reason":"PAYMENT_SUCCEEDED"}
```

## Remediation and test coverage

The independent Claude review returned FAIL; these changes address its findings and remain uncommitted for a fresh independent review.

| Finding | Fix and regression evidence |
| --- | --- |
| Missing resume | CHECKOUT_RESUMABLE and resumeEligibility; authenticated existing-payment initiation returns HTTP 201 and the same secret in both modes; detail refresh contains no secret; closure/deadline removes capability. |
| UNKNOWN reads | Operation type distinguishes retrieval from financial uncertainty. Tests cover repeated resume with UNKNOWN RETRIEVE, an in-flight delayed read, UNKNOWN financial operations, permanent closure during a read and delayed success winning over a stale response. |
| List performance | Batches of 100 and set-based inbox correlation, no per-order admission queries. 205-order owned histories in both modes verify bounded calls, shared timestamp and foreign-ID exclusion. |
| Post-commit creation read | Projection moved before commit. Both-mode fault injection verifies rollback and one reservation after an unkeyed retry. Existing keyed replay/order creation regressions also run. |
| State semantics | Existing unresolved failures stay OUTCOME_UNRESOLVED when unavailable/expired; terminal order lifecycle is independently NOT_PAYABLE. First-failure semantics survive compatibility PROCESSING rewrites; unit/integration tests exercise both. |

The compatibility Payment still does not persist a current Stripe status. Resume is permission to retrieve the existing checkout, not a provider-state assertion. Existing unresolved payments may retain stock under unchanged resolution policy. No migration or new provider-status persistence is introduced. Tests use disposable local PostgreSQL, sanitized fake credentials and mocked providers; external payment sandbox tests remain disabled. Production services are not accessed.

## Validation after remediation

- Baseline: `a4950556769c831fe5a1024706e8c81a19f9831f`, including merged PR #176; the original main worktree remains clean.
- Focused projection/creation/read/recovery/resolution regression: **136 passed, 0 failed, 0 skipped**.
- Entire backend suite: **1,365 passed, 0 failed, 3 skipped** (1,368 tests, 127 suites). The skips are the three explicitly disabled external payment sandbox tests.
- TypeScript build, tracked/untracked whitespace checks and final nine-file scope checks pass.
- Fresh disposable local PostgreSQL, sanitized environment, fake Stripe key and mocked providers only. No production access or migrations. The disposable instance is stopped after validation.
- No production load benchmark was performed. Batch round-trip bounds and 205-order histories in both modes are covered by integration tests. Admission predicate parity must be maintained if payment policy changes later.
- All implementation remains uncommitted for independent read-only review; no commit, push, PR, merge or deployment.
