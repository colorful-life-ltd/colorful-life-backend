# PP-4: PayPal webhook verification boundary (#193)

## Audit and official contract

Baseline: c5c28284fff841ed06dfe4affcdb264786e0a429 (PP-1, PP-2, PP-3 merged).
No repository/ancestor AGENTS.md instructions were present.

Confirmed gaps before this change:

- `src/app.ts` correctly mounts the PayPal raw route before `express.json()`.
  This ordering is preserved. `express.raw()` previously allowed decompression,
  which changes the signed request bytes.
- `src/controllers/paypalWebhookController.ts` used official OAuth/postback
  verification, but parsed and reserialized the original event. Lexical numbers,
  whitespace, Unicode escapes and large numbers could change on that round trip.
- Required transmission headers were forwarded without local validation. API
  origins were unconstrained; redirects could be followed. Certificate URLs were
  not constrained to the configured environment.
- OAuth, verification and response-body consumption had no network deadline.
  Exceptions returned a generic invalid-signature result, hiding transient outage
  recovery behind the same status as an actual invalid signature.
- Existing inbox commit/replay/deduplication and financial correlation/finality
  are already downstream of verification and are preserved unchanged.

Checked against official PayPal documentation on 2026-10-17:

- [Verify webhook signature contract](https://developer.paypal.com/api/webhooks/v1/verify-webhook-signature-post/)
  defines the five transmission fields, configured webhook ID, event and SUCCESS/FAILURE result.
- [Integration/postback guidance](https://developer.paypal.com/api/rest/webhooks/rest/)
  requires posting the event without changing its formatting/content. It also
  explains non-2xx delivery retries and that simulator events do not support
  postback verification.
- [REST environment origins](https://developer.paypal.com/api/rest/requests/)
  describes Sandbox and Live API requests.

## Implemented boundary

Only this route is changed: `POST /payments/paypal/webhook`.

- Require application/json, with UTF-8 if a charset is supplied. Preserve the
  existing 100 KiB limit explicitly. Reject compression rather than inflating
  signed bytes. Parser errors have sanitized JSON responses, with no raw-body logs.
- Require a Buffer containing valid UTF-8 JSON with an object root. Parsing here
  is structural validation only and grants no financial authority.
- Require one string value per PayPal transmission header; reject duplicate wire
  headers, arrays, whitespace/comma combinations and oversized values.
- Support SHA256withRSA, bounded transmission identifiers, canonical base64
  signatures and RFC3339 transmission timestamps. No local freshness cutoff is
  added: legitimate PayPal redelivery remains possible and inbox event-ID
  deduplication remains authoritative for database effects.
- Constrain configured PAYPAL_BASE_URL to HTTPS API origins api-m.sandbox.paypal.com,
  api.sandbox.paypal.com, api-m.paypal.com or api.paypal.com (optional trailing slash).
  No credentials, alternate port, query, fragment or path is accepted in that origin.
- Require configured credentials and an alphanumeric webhook ID, maximum 50
  characters. Environment is selected by that explicit API origin, not NODE_ENV.
  Credentials/webhook ID must belong to that environment and app; PayPal's
  authenticated verification result is the authority for their correctness.
- Require an HTTPS certificate URL under /v1/notifications/certs/CERT-... on an
  API host in the same environment. No certificate fetch is performed locally,
  and no caller-supplied URL can select the OAuth or verification destination.
- Disable HTTP redirects for both requests. One five-second deadline covers OAuth,
  token JSON, signature POST and verification JSON, with abort and bounded rejection.
- Embed the original body Buffer verbatim as webhook_event in the JSON verification
  request. Neither its JSON formatting nor bytes are regenerated.
- Require HTTP 200 and correctly typed token/verification responses. Only explicit
  SUCCESS permits the existing controller to parse and process the event.

Missing/invalid headers, unsupported certificate inputs, malformed JSON or explicit
FAILURE receive a non-2xx rejection. Missing/invalid server configuration, provider
HTTP/transport/JSON failures and timeouts receive sanitized HTTP 503. No failure
is acknowledged as processed, stored in the verified inbox or passed to payment,
refund, dispute or inventory processing. No provider response, signature, token,
credential or raw webhook body is logged by verification.

The existing internal verifier mock used by lifecycle tests remains unchanged;
new security tests exercise the real production verifier with mocked fetch.
There is no HTTP, configuration or environment switch that bypasses verification.

## Deployment and limitations

No migration, dependency, payment policy, Dashboard configuration, email setting,
or customer initiation setting changes. PayPal initiation remains disabled.

Before deploying, operators must supply the correct environment-specific API
origin, app credentials and subscribed webhook ID. A mismatched certificate
host is rejected; a syntactically valid wrong webhook ID or invalid credentials
must fail authenticated PayPal verification. Monitor sanitized HTTP status/error
rates; correct configuration or restore provider connectivity and allow redelivery.
Existing durable verified receipts continue replaying without re-verification;
never insert unverified requests into that inbox manually.

This release deliberately retains official remote postback verification, so new
verification depends on PayPal availability. No offline/self-verification,
certificate cache, token cache, IP allowlist, delivery-age policy or new edge
rate limiter is introduced. Simulator payloads cannot count as authentic
postback-verified events. External test-mode acceptance should be performed in a
separately authorized stage; automated tests make no real provider calls.
