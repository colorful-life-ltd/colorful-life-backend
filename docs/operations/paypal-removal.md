# PayPal removal

Stripe is the only payment provider. PayPal was used only in Sandbox. This change removes
PayPal from the Backend completely: code, routes, workers, configuration, tests, docs and
database structures. Stripe payments, refunds, webhooks, order lifecycle and inventory
behaviour are unchanged.

## Removed

- **Payment code:** PayPal webhook route and verification, webhook replay worker,
  reconciliation, resolution, finality, risk events, payment outcome and webhook review
  services, PayPal refund client, and the Admin PayPal webhook-review routes. Create/capture
  and refund submission were already removed by #224/#234.
- **Shared code branches:** the PayPal branches in the payment window, abuse admission,
  provider financial holds, payment resolution, refund lifecycle/reconciliation/webhook
  evidence, verified-payment and return-eligibility predicates, Admin payment security,
  production validation and operational metrics.
- **Configuration:** `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_BASE_URL`,
  `PAYPAL_WEBHOOK_ID`. Supplying them has no effect (unknown keys are ignored).
- **Schema** (migration `20261106120000_remove_paypal`):
  - `PAYPAL` from the `PaymentProvider` and `RefundProvider` enums (both types are recreated);
  - the `paypal_capture_admission` trigger and its function;
  - the PayPal branch of `payment_runtime_release_guard` (the rest of the function is
    byte-identical to the live definition);
  - PayPal from the `Refund`, `PaymentInitiationPolicy` and `PaymentAdmission` provider
    constraints, and the `PAYPAL` policy row (configuration, not financial data);
  - the PayPal-only `PaymentWebhookEvent.reviewDetails` / `reviewedAt` columns and their index.
- PayPal-only tests, fixtures, the PayPal payment-window contract fixture and PayPal docs.

## Deliberately kept

- **`PayPalSweepAge` / `PayPalInboxAge` metrics, emitted as constant 0.** Infra's `monitor.py`
  thresholds and two CloudWatch alarms still expect them, and alert when a metric is
  missing. Remove them here after Infra drops them.
- **Inert JSON-key checks** (`evidence->>'paypalOrderId'`) inside the shared Stripe trigger
  functions `payment_foundation_validate` and `payment_runtime_inbox_guard`. They can
  never match once no PayPal evidence exists, and rewriting live Stripe financial guards
  for cosmetic reasons is not worth the risk. They can be removed in a later migration.
- Historical migrations and migration-history fixtures (immutable).
- Guard tests asserting that a stale `PAYMENT_PAYPAL_INITIATION_ENABLED` has no effect,
  while Infra bootstraps still emit it.

## The migration is fail-closed — evidence before data

The migration **never deletes payment, refund, webhook or evidence data**. Its first step
aborts the whole transaction, changing nothing, if any PayPal record exists in `Payment`,
`Refund`, `PaymentAttempt`, `FinancialEvidence`, `PaymentWebhookEvent` (including review
data), `PaymentAdmission` or `PaymentSecurityEvent`. The error names the tables found.

## Deployment order (owner-approved; nothing here is executed)

The new code cannot read a `PAYPAL` row (its Prisma client no longer has the value), so the
migration must be applied **before** the new API/Worker image runs against a database.

1. **Production evidence first.** Through the approved SELECT-only path (Infra PR #55 templates),
   confirm zero rows with provider `PAYPAL` in the seven tables above, and zero
   `PaymentWebhookEvent` rows with `reviewDetails` or `reviewedAt` set. Record the result.
   If anything is found, stop: those are financial records and need a separate decision.
2. **Sandbox:** it contains PayPal records, so the migration will refuse there. Complete the
   approved disposable Sandbox recreation (`docs/operations/prelaunch-sandbox-disposal.md`)
   from a catalogue-only snapshot first, or keep the Sandbox on the previous release.
3. **Migration approval.** Approve the new migration checksum through the existing Infra
   migration gate, then apply it with the API and Worker stopped (or restart both immediately
   afterwards so no pooled connection keeps a plan for the dropped types).
4. **Deploy** the new API/Worker image.
5. **Rollback** to the previous image is schema-compatible: it only ever wrote `STRIPE`/`MANUAL`
   and does not read the dropped review columns outside the removed PayPal review route.
   The migration itself is not reversed.

## Infra follow-up (for Sol)

- Remove `PAYPAL_*` from the runtime bundles and the `secret-bootstrap.mjs` /
  `restricted-bootstrap.mjs` allowlists, the PayPal webhook Nginx routes and limits, and the
  browser-Sandbox PayPal routes (Infra #58 handoff, now unblocked).
- Remove the `PayPalSweepAge` / `PayPalInboxAge` thresholds and alarms, then tell the Backend
  owner so the constant metrics can be dropped.
- After the migration, delete the PayPal app/webhook in the PayPal dashboard and the stored
  PayPal secrets (owner action).
