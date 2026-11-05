# PayPal retirement (Backend)

Stripe is the only customer payment provider. PR #224 made PayPal initiation reject
unconditionally; this change removes the obsolete executable code. No schema change,
migration, data change or Stripe behaviour change is involved.

## Removed

- `POST /orders/:orderId/payments/paypal` and `/paypal/capture` (now 404) and
  `controllers/paypalPaymentController.ts`.
- `domain/payments/paypalOrderService.ts`, `paypalCaptureService.ts` (create/capture) and
  `paypalSandbox.ts`.
- PayPal refund submission: `createOrReusePayPalRefund` and the runtime client's
  `refundCapture` POST. The runtime PayPal client is retrieval-only (GET).
- `PAYMENT_PAYPAL_INITIATION_ENABLED`. A deployment that still sets it is ignored. PayPal
  admission is permanently closed in a deployed process; Admin's payment-security read
  reports `environmentEnabled.PAYPAL: false` (unchanged wire shape) and a PayPal
  provider-policy write is rejected (400).
- PayPal-only unit/HTTP tests for the removed services.

The former create/capture/refund-submission code is kept **only** as test fixtures under
`src/__tests__/fixtures/retiredPayPal/`, so retained historical tests still create PayPal
records exactly as production once did. The runtime image deletes `dist/__tests__`; a
regression test asserts no application module imports these fixtures. Their admission is
open only inside automated test processes (`isTestExecution`).

## Retained for historical compatibility (and why)

Existing PayPal payments, refunds and webhook evidence may exist (Sandbox certainly; Production
expected none but unverified). These stay so those financial records remain readable,
reconcilable and auditable:

- PayPal webhook route, signature verification and inbox (`/payments/paypal/webhook`),
  replay worker, reconciliation/resolution/finality, risk events and payment outcome.
- PayPal refund retrieval and reconciliation of existing PayPal refunds.
- Admin PayPal webhook review (read/acknowledge; audit only).
- `PAYPAL_CLIENT_ID/SECRET/BASE_URL/WEBHOOK_ID` (used only by the above) and the
  Production `PAYPAL_BASE_URL` live-host check.
- `PaymentProvider`/`RefundProvider` `PAYPAL` enum values, PayPal migrations and columns.
  These are permanent: removing them would need a migration and would break historical rows.
- Refunds against a historical PayPal payment are refused (503 `PAYPAL_INITIATION_DISABLED`);
  the customer payment window never offers a PayPal action.

## Removing the retained code later

Requires owner approval and, first, read-only evidence: zero `provider='PAYPAL'` rows in
`Payment`, `Refund` and `PaymentWebhookEvent` in Production (approved SELECT-only path), and
the approved disposable Sandbox recreation. See Infra `docs/paypal-retirement-handoff.md`
for the coordinated order (Backend modules and metrics, then Infra credentials, routes and
alarms, then the PayPal dashboard app and stored secrets).
