# Colorful Life Backend: production-readiness, security and business-integrity audit

- **Target:** `colorful-life-ltd/colorful-life-backend` `origin/main` at `b78da74` (includes merged #204 and #206). Its tree is byte-identical to `01d0b41` (PR #206 head).
- **Date:** 18 October 2026.
- **Method:** read-only. All work used a scratch snapshot and a throwaway PostgreSQL 16 database. No provider APIs or real email were used. The repository, the local checkout (`main`, 5 uncommitted launcher files) and all business databases were untouched.
- **Excluded by instruction:** the manual resolution workflow for `refund.reviewRequired` conflicts.

## 1. Executive summary

**Production-ready: NO** (CONDITIONAL once the P1 items below are closed).

The financial core is unusually strong. Payment and refund state transitions are journalled. Webhooks are signature-verified and deduplicated. Stock moves under row locks and guarded updates. PayPal finality is enforced by database triggers, and payment-abuse controls are in place. Object-level authorization holds on every endpoint I traced.

The blockers are elsewhere:

- **One confirmed P1 money-loss path:** goods ship after a refund made outside the app.
- **Two P1 deployment blockers:**
  - CORS is hardcoded to localhost.
  - There is no deployment or CI tooling at all.
- **One P1 configuration hazard:** production-unsafe defaults are not validated at startup.
- **Several P2 business-integrity gaps**, three of them reproduced: duplicate FBA deductions, legacy admin confirmation of unpaid orders, and manual payments without an actor.

## 2. Findings (sorted by severity)

| ID | Sev | Area | Finding | Status | Evidence | Business impact | Recommended fix |
|---|---|---|---|---|---|---|---|
| F1 | P1 | Refunds and fulfilment | A refund issued outside the app (Stripe or PayPal dashboard) is recorded only as `REFUND_UNCORRELATED`. No refund row is created, `refundedAmount` stays 0, there is no hold, and the order can still be prepared and dispatched. | **Confirmed (reproduced)** | `refunds/refundWebhookService.ts:42`; guard `fulfilment/fulfilmentService.ts` (`assertPaymentVerifiedForFulfilment`, refund checks only use local rows and amounts) | Goods shipped after the money was returned: direct loss | Uncorrelated refund evidence whose parent matches a payment must place a fulfilment hold (or count as reserved or refunded) until resolved |
| F2 | P1 | Infrastructure | CORS origin is hardcoded to `http://localhost:5173` | Confirmed | `src/app.ts:33` | Production storefront cannot call the API | Configurable allowed origins, validated at startup |
| F3 | P1 | Infrastructure | No deployment or CI artefacts: no Dockerfile, ECS task definition, IaC, CI workflow, migration step or runbook | Confirmed (absence) | Repository root has no `Dockerfile`, `.github/`, `infra/`; README has only manual `prisma migrate deploy` | Unreproducible deploys; tests not enforced on merge; migrations unmanaged | Dockerfile, CI (typecheck, full suite on disposable Postgres), a migration task before service start, ECS runbook |
| F4 | P1 | Configuration | Production-unsafe defaults accepted without validation | Confirmed | `config/index.ts` schema | Broken signup links; HIGH-2 declined-payment stock lock-up returns; sandbox PayPal in production; forgeable JWTs if a weak secret is used | Production-mode startup validation of all of these |

**Detail of the F4 defaults:**
- `FRONTEND_URL` defaults to `http://localhost:3000`, which is used to build verification and reset links.
- `PAYMENT_RESOLUTION_ENABLED` defaults to `false`, i.e. legacy mode.
- `PAYPAL_BASE_URL` defaults to the sandbox.
- `SES_FROM_EMAIL` defaults to `noreply@example.com`.
- `JWT_SECRET` is only required to be non-empty.

| ID | Sev | Area | Finding | Status | Evidence | Business impact | Recommended fix |
|---|---|---|---|---|---|---|---|
| F5 | P2 | Payments | Admin "manual payment" marks an order SUCCEEDED for its full total from free-text `providerReference`, with no evidence and **no actor recorded** | Confirmed (code) | `controllers/payments.ts:26-46` (admin id not passed); `payments/paymentService.ts:86-98`; `Payment` model has no actor field | One admin can release goods without money and leave no trail | Record actor, reason and evidence; consider second approval; or remove if unused |
| F6 | P2 | Orders and inventory | In legacy mode, an admin can confirm an **unpaid** order: stock is consumed, status becomes CONFIRMED, and there is no expiry | **Confirmed (reproduced)** | `orders/orderConfirmationService.ts:35-39` (payment required only for managed orders) | Stock locked against an order that will never be paid; manual repair needed | Require a succeeded payment for confirmation in all modes |
| F7 | P2 | FBA inventory | The same Amazon shipment can be recorded twice under different idempotency keys | **Confirmed (reproduced: 10 to 4 for a 3-unit shipment)** | `inventory/fbaOutboundService.ts:45-71`; migration `20261018150000_add_fba_outbound_ledger` (non-unique `shipmentReference` index) | Double deduction; stock understated | Unique (`shipmentReference`, `productListingId`) or explicit confirmation on reuse |
| F8 | P2 | FBA inventory | An outbound larger than available stock is refused, so actual shipments cannot be recorded (agreed rule: keep the actual quantity, floor at zero) | **Confirmed (reproduced)** | `inventory/fbaOutboundService.ts:58-62` | Recorded stock overstated; overselling | Owner decision (reserved-stock interaction); record actual and shortfall |
| F9 | P2 | Payments | Stripe disputes (chargebacks) are not handled at all | Confirmed (absence) | `controllers/stripeWebhookController.ts:12,18`; zero dispute references outside PayPal | Disputed orders still ship; chargebacks unrecorded | Handle `charge.dispute.*`: hold fulfilment, record evidence, alert |
| F10 | P2 | Orders | No cancel-and-refund workflow for paid, unshipped orders. Cancellation refuses any order with a payment; the only restock route is the five-step return flow plus a separate refund. | Confirmed (code) | `orders/orderCancellationService.ts:50,153`; returns allowed on CONFIRMED (`orders/returnInventorySafety.ts:58`) | Slow error-prone operations; risk of refunding without restocking | Atomic seller cancellation with refund and restock |
| F11 | P2 | Checkout | Delivery accepted to any ISO country at UK shipping prices | Confirmed (code) | `orders/orderValidator.ts:28-34` | Undercharged international shipping; non-UK orders | Enforce GB (or a priced country list) server-side |
| F12 | P2 | Auth | Account deletion is irreversible and needs only a valid access token (no password or recent-login check) | Confirmed (code) | `controllers/accountDeletionController.ts:9-13` | A stolen 1-hour token can destroy an account | Require password re-authentication |
| F13 | P2 | Operations | No graceful shutdown; `/health` is static; workers start in every API task | Confirmed (code) | `src/index.ts:9-21`; `src/app.ts:60` | Abrupt termination on deploy; health stays green while the database is down | SIGTERM drain; database-aware readiness; option to run workers separately |
| F14 | P2 | Operations | No way to create the first ADMIN (no route, script or seed) | Confirmed (absence) | `src/scripts/` contains only `pollCarrierTracking.ts` | Cannot administer a fresh environment without manual SQL | One-off audited bootstrap command and runbook |
| F15 | P2 | Purchasing | Purchases visible only to the importing admin | Confirmed (code) | `importedByUserId` scoping in `controllers/purchases.ts` and `domain/purchases/*` (9 sites) | Multi-admin operations blocked | Owner decision; admin-wide access if confirmed |
| F16 | P3 | HTTP security | No security headers (no helmet; `x-powered-by` exposed) | Confirmed (absence) | `src/app.ts` | Hardening | helmet or ALB headers |
| F17 | P3 | Data exposure | Public product endpoints return raw `currentStock`, not available stock | Confirmed | `controllers/products.ts:302` | Leaks exact counts; overstates availability | Return available or a band |
| F18 | P3 | Logging | Many handlers log entire error objects; Prisma validation errors include input values | Confirmed (code) | e.g. `controllers/userProfile.ts:42,76,100`; `controllers/products.ts` | Possible PII in logs | Structured, sanitised error logging |
| F19 | P3 | Accounts | No logged-in password change; verified users cannot change email | Confirmed (absence) | `routes/auth.ts`, `routes/users.ts`; `auth/emailChangeService.ts:24` | Support burden | Add both flows with re-authentication |
| F20 | P3 | Checkout | `Idempotency-Key` optional on order creation | Confirmed (code) | `orders/orderService.ts` (`idempotencyKey?`) | Duplicate orders from non-storefront clients | Require it |

No P0 findings were identified.

## 3. P1 technical evidence

### F1: dashboard refunds do not block dispatch (reproduced)

**Path:**
1. `POST /payments/stripe/webhook` (verified).
2. `reconcileStripeRefundEvent` (`stripeReconciliationService.ts:146`).
3. `reconcileRefundWebhook`, then `processRefundWebhookReceipt` (`refundWebhookService.ts:26-51`). With no refund matching `reference` or `localRefundId`, it returns `unresolved("REFUND_UNCORRELATED")` (line 42). No `Refund` row is written, `Payment.refundedAmount` is unchanged, and `reviewRequired` is not set.
4. `assertPaymentVerifiedForFulfilment` blocks only on `refund.reviewRequired`, `reservedRefundAmount > 0` or `refundedAmount >= amount`. None of these is true, so fulfilment proceeds.

**Reproduction** (`audit-repro.mjs`, scenario R1, throwaway database, legacy-mode default):
1. Create a paid £23.99 Stripe order and confirm it.
2. Feed a verified-style `refund.updated` for the same PaymentIntent with an unknown refund id, `succeeded`, for the full amount.
3. Result: `webhookHandled=false`, `receiptError=REFUND_UNCORRELATED`, `localRefundRows=0`, `refundedAmount=0.00`, then `startPreparing` and `dispatchShipment` returned **DISPATCHED**.

**Prerequisites:** a staff member refunds in the provider dashboard (common), or the provider refunds on its own.

**Not covered by the exclusion:** this path creates no `reviewRequired` refund at all.

### F2: CORS
`src/app.ts:33` sets `cors({ origin: "http://localhost:5173" })`, which is not configurable. Every browser call from the production storefront fails preflight. The Electron admin calls from Node and is unaffected.

### F3: no deployment tooling
There is no Dockerfile, ECS task definition, IaC, CI workflow, migration job or deployment runbook in the repository. Merges are not gated by the 1,887-test suite.

### F4: unvalidated production defaults
`config/index.ts` accepts everything listed under F4 above. Only the payment-abuse settings are validated for production (`config/paymentAbuse.ts`). In particular, `PAYMENT_RESOLUTION_ENABLED=false` returns production to the legacy flow that HIGH-2 (PR #184) depended on managed mode to fix.

## 4. Business workflow completeness matrix

| Workflow | Status |
|---|---|
| Signup, verification, login, refresh rotation, logout, password reset (with session revocation) | Implemented and verified |
| Customer order creation, server pricing, frozen shipping, reservations, expiry (managed mode) | Implemented and verified |
| Stripe payment initiation, verified webhooks, recovery and reconciliation | Implemented and verified (unit/integration); live provider not exercised |
| PayPal create, capture, finality, signed webhooks, refunds | Implemented and verified locally; customer initiation disabled; sandbox not exercised |
| In-app refunds (Stripe, PayPal, manual) with capacity accounting | Implemented and verified |
| Refunds made outside the app | **Missing** (F1) |
| Disputes and chargebacks (Stripe) | **Missing** (F9); PayPal risk events recorded for review |
| Fulfilment (preparing, dispatch, tracking, completion) with payment, refund and review guards | Implemented and verified (except F1) |
| Paid-order cancellation with refund and restock | **Missing** as a single workflow (F10); return-flow workaround exists |
| Returns (request to complete, restock, eligibility) | Implemented; admin-only initiation (no customer self-service) |
| Inventory adjustments, stocktake, condition conversion, write-off | Implemented and verified |
| FBA outbound | Implemented but insufficiently verified against business rules (F7, F8) |
| Invoices and transactional email outbox | Implemented and verified; SES isolation in tests verified (#206) |
| Payment abuse controls, review holds | Implemented and verified (#194) |
| Admin bootstrap, user and role management | **Missing** (F14) |
| Deployment, CI, migrations in pipeline, monitoring and alerts, backups and DR | **Missing or unknown** (F3) |
| Data retention policy for order PII after account deletion | Unknown (no policy found) |

## 5. Production launch blockers (ordered by business risk)

1. **F1** Block fulfilment on uncorrelated provider refunds.
2. **F4** Production startup validation:
   - `PAYMENT_RESOLUTION_ENABLED=true`;
   - HTTPS `FRONTEND_URL`;
   - live PayPal base URL with matching credentials;
   - verified SES sender;
   - a JWT secret of at least 32 bytes.
3. **F2** Configurable CORS origins.
4. **F3** Dockerfile, CI gate, migration task, ECS runbook, health and readiness checks.
5. **F14** Admin bootstrap runbook or command.
6. **F9** Stripe dispute handling, at minimum a fulfilment hold and alert.
7. **F6, F5** Close unpaid-confirmation and unaudited manual-payment paths.
8. **F7, F8, F11** FBA duplicate protection and floor rule; UK-only delivery enforcement.
9. **Operational prerequisites already documented elsewhere:**
   - `CLIENT_IP_MODE` and `TRUSTED_PROXY_CIDRS`;
   - payment abuse secret;
   - Stripe Radar and PayPal controls;
   - the business details bundle;
   - scheduled maintenance;
   - backups and alerts.

## 6. Existing safeguards confirmed working

- **Authentication:**
  - JWT verified with the database-authoritative role, a `credentialVersion` check and deleted-user rejection (`middleware/auth.ts`).
  - Refresh tokens hashed, rotated and replay-safe; per-session refresh budget.
  - Login without per-account lockout; uniform invalid-credentials response with equal bcrypt cost (12).
  - Password reset hashed, single-use, expiring, rotating credentials and revoking all refresh sessions (`passwordResetService.ts:65-73`).
- **Authorization:**
  - Every admin route checks ADMIN at route, router or controller level (all ~45 sensitive handlers traced).
  - Customer orders, addresses and cart are owner-scoped.
  - Admin order reads are behind the admin router.
- **Pricing:** server-side prices; zero and invalid prices rejected and re-checked at purchase (#199, `products/listingPrice.ts`).
- **Payments:**
  - Stripe webhook signature verification (`stripeWebhookController.ts:7-10`).
  - PayPal raw-byte postback verification with environment isolation (#193).
  - Durable inbox with immutable evidence and replay; journalled operations; PayPal finality triggers (#189); capture fence; abuse controls and fulfilment holds (#194).
- **Refunds:** capacity (refunded + reserved + requested ≤ amount) under a row lock (`refundCapacityService.ts:18-21`); fulfilment blocked during refund review, in-flight refunds and full refunds (#203).
- **Inventory:** guarded conditional updates under row locks for reservation, confirmation, release, adjustment, stocktake and FBA; movement ledger for every change.
- **Uploads:** admin-only, 8 MB limit, magic-byte type verification, Cloudinary public-id ownership checks.
- **SQL:** no unsafe raw SQL; all raw queries are parameterised tagged templates.
- **Email:** SES unreachable from tests, with synthetic credentials and a network guard (#206; verified under a hostile environment).

## 7. Proposed issue backlog (not created)

Implementation order: 1, 2, 3, 4, 5, then the rest in parallel.

1. **Block fulfilment on uncorrelated provider refunds (F1).**
   - *Acceptance:* a verified refund event whose parent matches a payment but no local refund places a durable hold. Dispatch and preparing return `REFUND_REVIEW_REQUIRED`. Resolution is audited (coordinate with the separate review-workflow agent).
   - *Regression:* scenario R1 must block dispatch; correlated in-app refunds unchanged.
2. **Production configuration validation (F4).**
   - *Acceptance:* `NODE_ENV=production` refuses to start without `PAYMENT_RESOLUTION_ENABLED=true`, an HTTPS `FRONTEND_URL`, a live `PAYPAL_BASE_URL` when PayPal is enabled, a non-example `SES_FROM_EMAIL`, and a `JWT_SECRET` of at least 32 bytes. Error messages contain names only.
   - *Regression:* child-process matrix.
3. **Configurable CORS (F2).**
   - *Acceptance:* `CORS_ALLOWED_ORIGINS` validated as https origins in production; unknown origins rejected.
4. **Deployment and CI baseline (F3).**
   - *Acceptance:* Dockerfile (non-root, production dependencies); CI runs typecheck and the full suite on disposable Postgres; a migration task precedes service rollout; a runbook covers rollback and backups.
5. **Admin bootstrap command (F14).**
   - *Acceptance:* a one-off CLI promotes an existing verified user, refuses if an ADMIN exists unless forced, prints an audit line; no HTTP route.
6. **Stripe dispute handling (F9).**
   - *Acceptance:* `charge.dispute.created/updated/closed` stored, holds fulfilment, alerts; tests for dispute before and after dispatch.
7. **Require payment for confirmation in all modes (F6).**
   - *Regression:* scenario R3 is refused.
8. **Audit and constrain manual payments (F5).**
   - *Acceptance:* actor, reason and evidence persisted; optional second approval; listed in admin audit.
9. **FBA shipment uniqueness (F7).**
   - *Acceptance:* the same shipment and listing cannot be deducted twice under a new key.
   - *Regression:* scenario R2.
10. **FBA floor rule (F8).**
    - *Acceptance:* per owner decision, record actual and applied quantities and the shortfall; never negative.
11. **Paid-order cancellation workflow (F10).**
    - *Acceptance:* one admin action refunds, restocks, cancels and audits atomically; refuses after dispatch.
12. **UK-only delivery (F11).**
    - *Acceptance:* non-GB delivery refused before reservation.
13. **Re-authentication for account deletion (F12).**
14. **Graceful shutdown and readiness (F13).**
    - *Acceptance:* SIGTERM stops new work, drains HTTP and workers, closes Prisma; `/ready` checks the database.
15. **Purchases visible to all admins** (F15, after owner decision).
16. **P3 hardening** (F16 to F20): security headers, available-stock projection, sanitised error logging, password change and verified email change, required order idempotency key.

## 8. Coverage limitations

- **No live provider behaviour verified:** Stripe, PayPal, SES and Cloudinary were not exercised (by instruction). Webhook payload shapes for dashboard refunds are inferred from the reconciler's evidence contract, not captured from Stripe.
- **No AWS infrastructure exists to inspect:** IAM, VPC, ALB, ECS, RDS backups and CloudWatch cannot be audited.
- **No load or soak testing;** concurrency was assessed by code and by existing multi-process tests.
- **Test baseline:** the full suite was not re-run for this audit. `main`'s tree equals the PR #206 commit, whose full suite passed under a hostile-credential environment (1,884 passed, 0 failed, 3 skipped).
- **Frontend and admin** were inspected only where contracts matter. GDPR and retention obligations need legal input.
- **Not individually line-reviewed** (rely on prior reviews and tests): carrier-tracking polling and budgets, sitemap, and purchase-import PDF parsing.

## 9. Reproduction artefacts

- **Script:** `/tmp/claude-1000/-home-yejun-guan-projects-colorful-life-backend/34d99e9d-b4c8-4bfd-b808-98f26b5221ad/scratchpad/prod-audit/be/audit-repro.mjs` (scenarios R1, R2, R2b, R3).
- **Environment:** throwaway database `audit_repro` on a scratch PostgreSQL 16, synthetic users, AWS blackholed, no provider calls.
