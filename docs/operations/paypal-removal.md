# PayPal removal (expand / deploy / contract)

Stripe is the only payment provider. PayPal was used only in Sandbox. The application code is
removed completely in this release. The database is changed in two phases so that rolling back
to the previous application image always stays safe.

| Phase | What | Where | Destructive? | Rollback to previous image |
| --- | --- | --- | --- | --- |
| 1. Compatibility (this release, #235) | Application code only. **No schema or data change** (no migration) | — | No | **Safe**: the previous image's full suite passes (rehearsed in CI) |
| 2. Contract (later, separately approved) | Remove `PAYPAL` enum values, PayPal review columns, PayPal constraints, policy row, capture trigger/function and the PayPal branch of the release guard | `prisma/contract/remove_paypal.sql` (prepared, **not applied**) | Yes | **Breaks** the pre-#235 image (see evidence) |

## Phase 1 — this release

### Application (removed)
- PayPal webhook route and verification, webhook replay worker, reconciliation, resolution,
  finality, risk events, payment outcome and webhook review (service and Admin routes), and the
  PayPal refund client. Create/capture and refund submission were removed in #224/#234.
- PayPal branches in shared code: payment window, abuse admission, provider financial holds,
  payment resolution, refund lifecycle/reconciliation/webhook evidence, verified-payment and
  return eligibility, Admin payment security, production validation, metrics.
- `PAYPAL_*` configuration (ignored if still supplied), PayPal tests, fixtures and docs.

### Residual PayPal rows fail closed
Until Phase 2, a database may still contain PayPal records (Sandbox does). The Prisma schema
therefore keeps `PAYPAL` and the review columns as **deprecated** fields so such rows stay
readable, and every financial path treats an unsupported provider conservatively:
- the payment window offers no action (`OTHER_PROVIDER`);
- `POST /orders/:id/refunds` refuses with 409 `PAYMENT_PROVIDER_UNSUPPORTED`, writing nothing;
- `providerFinancialHold` returns `PAYMENT` (fulfilment, cancellation and refunds stay held);
- unpaid proof is never accepted, return eligibility requires Stripe or manual payment, invoices
  require Stripe, and payment resolution places the order on `SAFETY_HOLD`.

### Why Phase 1 has no migration
The new code runs on the existing schema unchanged: Prisma tolerates the retained enum value and
columns, and the release guard's `'PAYPAL'` literal stays valid while the value exists. An earlier
draft also dropped the PayPal capture trigger and disabled the PayPal policy row. Neither is
reachable by the previous image's runtime, but its full suite showed both change its observable
behaviour (4 of 2249 tests), so both moved to the contract step. Phase 1 therefore needs no
migration-gate approval, and rollback cannot be affected by the schema.

### Deployment order
1. Deploy the new API/Worker image (no migration to approve or apply).
2. Rollback to the previous image (`9bc8757`, main after #234) is safe without reversing the
   migration. This is rehearsed on every CI run: `scripts/rehearse-previous-image.py` builds the
   previous release from git with its own locked dependencies and Prisma client, migrates an owned
   PostgreSQL 16 cluster with this revision, then runs the previous build's Stripe payment webhook,
   refund webhook and Worker metrics/readiness tests against it.

Sandbox can receive this release before its recreation: residual PayPal rows fail closed.

## Phase 2 — contract migration (not part of #235)

`prisma/contract/remove_paypal.sql` is prepared and tested (it is applied inside a rolled-back
transaction by `paypalRemoval.integration.test.ts`) but **must not** be moved into
`prisma/migrations` until all prerequisites hold:

1. The Phase 1 release is deployed, and the rollback baseline is a release that no longer needs
   `PAYPAL` (i.e. #235 or later). Rehearse with
   `python3 scripts/rehearse-previous-image.py --previous <that release> --apply-contract`.
   Against the pre-#235 image this negative control fails (107 of 184 focused tests:
   `PaymentWebhookEvent.reviewDetails` missing, `invalid input value for enum "PaymentProvider": "PAYPAL"`).
2. Production evidence via the approved SELECT-only path (Infra PR #55 templates): zero rows with
   provider `PAYPAL` in `Payment`, `Refund`, `PaymentAttempt`, `FinancialEvidence`,
   `PaymentWebhookEvent`, `PaymentAdmission`, `PaymentSecurityEvent`, and zero
   `PaymentWebhookEvent` rows with `reviewDetails`/`reviewedAt` set.
3. Sandbox recreated from a catalogue-only snapshot (it contains PayPal records), or kept on the
   previous release.
4. In the contract PR: move the file to a new, later-dated `prisma/migrations/<timestamp>_remove_paypal`,
   remove the deprecated `PAYPAL` values and review fields from `schema.prisma`, regenerate the
   client, add the migration to `scripts/rehearse-database.py`, and approve its checksum.

**Fail-closed:** the contract migration never deletes payment, refund, webhook or evidence data.
It aborts the whole transaction, changing nothing, if any PayPal record exists in the tables above,
naming them. It only deletes the PayPal policy row (configuration).

## Deliberately kept (both phases)
- `PayPalSweepAge` / `PayPalInboxAge` emitted as constant 0 until Infra removes the monitor
  thresholds and CloudWatch alarms that expect them.
- Inert `evidence->>'paypalOrderId'` JSON checks in the shared Stripe trigger functions
  `payment_foundation_validate` and `payment_runtime_inbox_guard` (cannot match without PayPal
  evidence; rewriting live Stripe financial guards for cosmetics is not worth the risk).
- Guard tests asserting a stale `PAYMENT_PAYPAL_INITIATION_ENABLED` has no effect.

## Merge and rebase dependencies (not resolved here)
- **#218** (Stripe refund rejections): no migration. It edits `refundLifecycleService.ts`,
  `refundReconciliationService.ts` and `refundProviderSafety.integration.test.ts`, which #235 also
  edits (PayPal branches and PayPal test cases removed). Whichever merges second needs a rebase;
  #218's own refund logic should be kept, dropping only PayPal-specific code it may reintroduce.
- **#219** (Stripe refund failure after success): its never-applied migration, originally
  `20261028120000_…`, is renamed byte-identically to
  `20261106120000_stripe_refund_failure_after_success` (Migration 77, after every migration on
  main). The rehearsal guard pins the new positions; the Single-Admin upgrade rehearsal runs the
  unchanged pinned Migration 75/76 installer against its exact 76-migration bundle, then applies
  Migration 77 through the ordinary deployment path. #235
  adds no migration, so it does not conflict with #219's migration history; the future contract
  migration must be dated after whatever #219 lands as.

## Infra follow-up (Sol)
- Remove `PAYPAL_*` from runtime bundles and bootstrap allowlists, the PayPal webhook Nginx routes
  and limits, and browser-Sandbox PayPal routes (Infra #58 handoff).
- Remove the `PayPalSweepAge` / `PayPalInboxAge` thresholds and alarms; then the Backend drops the
  constant metrics.
- After Phase 2: delete the PayPal dashboard app and stored PayPal secrets (owner action).
