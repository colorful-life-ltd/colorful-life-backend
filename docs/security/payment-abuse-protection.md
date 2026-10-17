# Issue #194 — payment abuse admission (staging policy)

This is an application control, pending independent review and AWS Staging integration acceptance. It does not establish production readiness. No provider Dashboard or AWS controls were configured by this implementation.

## Boundaries and invariants

Authenticated, verified-email checkout is required; there is no guest payment endpoint. Signup, login, refresh and checkout previously lacked distributed general throttles. Login has a source-network budget only: email addresses are public identifiers and must never be sufficient to lock an account. Unknown/deleted accounts receive the same INVALID_CREDENTIALS response and a dummy bcrypt check. Network brute-force limits remain; widely distributed credential stuffing requires edge/bot controls and monitoring. A hostile customer on the same NAT can still consume a shared login budget; no email-only denial is imposed. Password recovery already has its own PostgreSQL limiter. Express trusts only explicitly configured `TRUSTED_PROXY_CIDRS`; these controls use `req.ip` through the existing canonical IPv4/IPv6-/56 normalizer, never forwarding headers directly. New sessions do not reset account/network budgets. There is no trustworthy stable session identifier in the current access token; client session identifiers are deliberately not counted as independent identities.

PostgreSQL token buckets serialize all dimensions in deterministic key order with transaction-scoped advisory locks and database-clock refill. All dimensions succeed or all changes roll back. Financial admission is in the existing Order-locked transaction, before Payment creation/retry or the PayPal capture journal. Operation identities come from server-generated payment keys, not customer idempotency headers. A committed admission survives a provider error/timeout; bound retrieval and authoritative operation replays do not debit new-operation quotas. HTTP request quotas still apply. Existing journal, provider idempotency, ownership, reservation finality, refunds and dispute rules remain authoritative. An abuse rejection is never proof of unpaid finality.

Order creation checks account/network creation budgets after authoritative idempotent replay checks and before stock mutation. A separate account lock serializes the active payment-free reservation cap across different order keys. Elapsed payment-free reservations no longer count as active; this does not itself release any stock. Payment-bearing reservations are never released by this feature. Invalid requests roll back new-order allowance along with the existing transaction.

PayPal customer order creation remains unconditionally unsupported. The additional service-level controls cannot enable it. Recovery workers, verified webhook inbox processing, refunds, disputes, abandonment finality checks and provider read-only resolution do not consult initiation switches. Customer-triggered Stripe recovery has an HTTP work budget; background reconciliation remains available.

## Configuration (all instances must agree)

- `PAYMENT_ABUSE_HMAC_SECRET`: mandatory shared deployment secret, at least 32 non-padding characters. No JWT-secret or random fallback. Outside tests, missing/malformed secrets fail configuration loading before API startup; messages name the key only. Test-mode mutable config still fails protected operations closed. Changing valid security configuration requires a reviewed restart; no hot reload is claimed. Store in the existing secrets mechanism. Rotation resets identity buckets, so use a coordinated maintenance/monitoring plan, never rotate as a routine way to clear limits.
- `PAYMENT_STRIPE_INITIATION_ENABLED=false` and `PAYMENT_PAYPAL_INITIATION_ENABLED=false` by default. Explicit environment enablement **and** the corresponding shared policy row must permit new operations. Environment changes require a reviewed process restart. Credentials alone do not enable payments.
- `PAYMENT_ABUSE_LIMITS_JSON`: optional object mapping the names below to `[burstCapacity, refillIntervalSeconds]`. Positive integers; unknown keys/invalid values fail startup outside tests with a sanitized key-only error. In tests, invalid mutable overrides fail protected work closed. The removed `loginEmail` limit must not remain in overrides. These are staging defaults, not immutable production policy. Changes require a coordinated restart. Capacity is a token-bucket burst, **not** a strict rolling-window maximum.
- `PAYMENT_CHALLENGE_ENABLED=false`, `TURNSTILE_SECRET_KEY`, `TURNSTILE_HOSTNAME`: see frontend contract. With challenges disabled/unconfigured, elevated admissions remain denied until activity decays; there is no bypass.

| Limit name | Burst | Refill interval |
|---|---:|---:|
| signupNetwork | 5 | 1 hour |
| loginNetwork | 30 | 15 minutes |
| refreshSession (stable validated session row) | 30 | 15 minutes |
| orderAccount | 5 | 15 minutes |
| orderNetwork | 20 | 15 minutes |
| activeReservations (capacity only) | 3 | not a time bucket |
| paymentAccount (cross-provider) | 5 | 15 minutes |
| paymentAccountDay (cross-provider) | 15 | 24 hours |
| paymentNetwork (cross-provider) | 20 | 15 minutes |
| paymentNetworkDay (cross-provider) | 60 | 24 hours |
| paymentOrder | 5 | 15 minutes |
| provider (separate Stripe/PayPal) | 100 | 15 minutes |
| requestAccount | 60 | 15 minutes |
| requestNetwork | 120 | 15 minutes |
| recoveryAccount | 60 | 15 minutes |
| recoveryNetwork | 120 | 15 minutes |
| recoveryOrder (account + order) | 30 | 15 minutes |
| challengeAfter (recent admissions, not a token bucket) | 3 | 15 minutes |

`requestAccount`/`requestNetwork` are shared across order/payment HTTP work. Recovery/resend-verification has independent account/network budgets, plus an account/order budget for recovery, so initiation abuse cannot exhaust its allowance. Idempotent order/payment replays consume HTTP work allowance but not fresh order/financial allowance. Network-wide limits affect NAT customers; calibrate with staging measurements.

Refresh admission is inside validated token rotation, keyed by the stable RefreshSession row ID, not IP, account/email or the rotating credential. Login traffic and other sessions cannot exhaust it. Invalid/revoked/expired tokens fail before bucket writes; rotation and its debit commit atomically under the existing User lock. A denied rotation leaves the token usable after refill, without extending its expiry. Unknown-token endpoint flooding still requires edge request controls; it cannot lock an authenticated session. Tokens/digests are never logged.

`CLIENT_IP_MODE=direct|proxy` must be explicitly selected in production. Proxy mode requires validated nonempty `TRUSTED_PROXY_CIDRS`; direct mode forbids them, and trust-all /0 ranges are rejected. Development with no mode uses direct connections; any configured proxies require explicit proxy mode outside tests. This validates a declared topology, not the actual ALB deployment: independently verify proxy ranges and origin reachability in staging. Never set trust proxy to true or trust raw forwarding headers.

PayPal create and capture have distinct operation admissions (both still consume hard operation/provider budgets), but share a server-bound logical `attemptIdentity`. Progressive thresholds count distinct attempts. A capture continuing an admitted create does not demand a second challenge; definitive-unpaid retries get a new identity. This does not authorize an otherwise unsafe capture, bypass provider switches or alter PP-2 journals/finality.

## Independent emergency switches and operational adjustment

ADMIN authentication is rechecked against the current database role/deleted-account status.

- `GET /admin/payment-security`: shared policies, first 100 oldest outstanding holds, audit event counts and processed-webhook event-type counts over 10 minutes, stored provider token balances with their timestamps. Stored balances are not live refill calculations; missing bucket means no consumption yet. Webhook counts are operational observations, not an authoritative ledger or a count of every Stripe card attempt. Database policy `enabled` does not override a false environment switch.
- `POST /admin/payment-security/providers/STRIPE` (or `PAYPAL`): `{"enabled":false,"capacity":100,"note":"Emergency staging investigation"}`. `capacity` is a positive integer up to 1,000,000 or null to use environment defaults; it overrides only the provider new-operation burst. Audited update. Environment false always wins. Re-enable through the same endpoint after review. Disabling does not destroy budgets; refilling continues from database time. Increasing capacity does not reset spent balance. Never add an automatic disable on bot-triggerable denial metrics.
- Policy SHARE locks serialize admission with policy changes. Operations admitted before a switch change may finish afterward. The switch is not a revocation of in-flight provider requests or existing Stripe secrets. Bound Stripe retrieval/resume, already-completed PayPal capture reads and financial recovery remain available. A pending provider POST is rejected while disabled; do not invent a replacement attempt. Customer paymentWindow hides initial/new retry actions when Stripe new initiation is disabled; existing checkout retrieval remains represented.

Shared global budgets can be exhausted by distributed attackers and can starve genuine new initiations during an active attack. There is deliberately no account-age, client-key or challenge bypass of the atomic global cap. Mitigation is monitored capacity planning and an audited, temporary provider-cap adjustment after validating provider metrics/legitimate demand, combined with provider Radar/fraud controls and separately approved edge filtering/challenges. Continue read-only recovery, webhooks and refunds during incidents; never recycle uncertain payments to free capacity. Time-box elevated caps operationally, record follow-up to restore them, and alert before exhaustion (for example <20% stored balance, interpreted with its update timestamp). This task adds no paid infrastructure or automatic policy escalation.

Every bucket refills automatically: exhausting a global budget is temporary, not a permanent ban. Operators should inspect provider balances/denials, confirm genuine traffic and adjust capacity with an audit note. Do not erase the ledger or reset buckets to resolve uncertain payments.

## Frontend Turnstile contract (not integrated here)

On `403` with `error.code=CHECKOUT_CHALLENGE_REQUIRED`, render an approved Turnstile widget using public site key, expected hostname and `action: "checkout"`. Send the newly issued token in `X-Checkout-Challenge` on the original authenticated Stripe-initiation/PayPal-capture request. Obtain a fresh token for each subsequent submission; never persist it or a client secret. Retain the original order and its idempotent request; never automatically create another payment/order. The order endpoint also accepts a token but currently does not demand one.

The backend calls fixed Cloudflare Siteverify with a 3-second abort deadline, requires success, exact configured hostname/action and a recent timestamp (maximum 5 minutes, 30-second future clock tolerance). Provider errors/malformed replies/timeouts fail closed. A token digest is inserted uniquely in PostgreSQL before handing verification to this one request, preventing cross-instance replay even with a faulty provider response. Verification does not bypass hard quotas. No challenge proof is accepted from request JSON, arbitrary headers or a frontend Boolean. No remote IP is sent to Cloudflare by this implementation. Tokens and Siteverify secrets/results are not logged. Aborted validation may consume a token; request a new one rather than assuming success.

Responses use the existing `{ "error": { "code": "...", "message": "..." } }` envelope with `Retry-After`:
- 429 `CHECKOUT_RATE_LIMITED`: wait, then explicitly retry the same order; support can assist and the existing safe abandonment flow can release demonstrably unpaid reservations.
- 403 `CHECKOUT_CHALLENGE_REQUIRED`: obtain fresh challenge proof; if unavailable, wait for recent activity to decay or contact support.
- 503 `PAYMENT_INITIATION_DISABLED` or `CHECKOUT_PROTECTION_UNAVAILABLE`: no permission to create replacement payments. Read order/payment status and contact support.

Never interpret these errors as a failed charge or retry permission for an uncertain payment. Frontend integration, accessibility, domain/site-key setup, CSP and acceptance tests are deployment dependencies. Full bot protection is not claimed.

Official references: [Turnstile server validation](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/), [Stripe card testing](https://docs.stripe.com/disputes/prevention/card-testing), [Stripe 3DS](https://docs.stripe.com/payments/3d-secure/authentication-flow), [Stripe Radar](https://docs.stripe.com/radar/rules), [PayPal fraud protection](https://developer.paypal.com/platforms/checkout/advanced/customize/fraud-protection/).

## Fulfilment holds and monitoring

Elevated admissions that pass the challenge create a durable fulfilment hold in the same transaction. The shared fulfilment guard blocks preparing and both dispatch paths. Verified successful payments remain SUCCEEDED/CONFIRMED and inventory conversion/invoice jobs continue normally. This is separate from payment-resolution quarantine and cannot authorize refunds, cancellations or stock release.

- `POST /admin/payment-security/orders/:orderId` with `{"action":"HOLD","note":"Investigate confirmed payment activity"}` adds/reopens a hold.
- Same endpoint with `action:"RELEASE"` and a 10–500 character review note requires a verified succeeded payment. The release records actor/time/note and a durable audit event. Only ADMIN can release. Notes must contain no card data, provider secrets or unnecessary personal information.
- Holds and dispatch use the same Order lock. A hold arriving after dispatch cannot undo fulfilment: escalate manually. Financial/provider disputes remain in their existing review path. This endpoint is not a replacement for dispute processing.

`checkout_protection` structured warnings contain only a coarse decision and optional HMAC account/network keys. No raw IP, email, card/CVV, token, client secret or provider failure body is recorded. Operator changes and hold creation are durable `PaymentSecurityEvent` rows. Proposed initial CloudWatch/log alerts: 10 denials per pseudonymous subject per 5 minutes, 25 total per 5 minutes, any protection-unavailable spike, or a sustained review backlog. Use processed provider outcome metrics for a 10-minute failure alert only at >=20 observations and >=50% failures; do not call event counts unique charges. Set log retention/aggregation to prevent alert/log amplification. No alerting infrastructure has been deployed or verified.

`POST /admin/payment-security/maintenance` prunes at most 1,000 expired buckets and 1,000 expired challenge digests per call with SKIP LOCKED. Schedule bounded calls and alert on table growth. Audit/admission retention requires owner approval; do not delete uncertain-operation identities or financial records as housekeeping. HMAC data remains pseudonymous personal data; approve retention/access before launch. Outstanding reviews are bounded to 100 in the API; work oldest first and monitor backlog in the database.

## Mandatory pre-production acceptance and deployment

1. Apply migration `20261024120000_payment_abuse_controls` before code; generate matching Prisma client. No historical orders/payments are repriced or backfilled. The two new Order foreign keys explicitly use ON UPDATE CASCADE as Prisma expects (and ON DELETE CASCADE). Migration creates additive tables/policy rows only, within an explicit transaction with a 5-second lock timeout and 30-second statement timeout. A failure rolls back its DDL; inspect the failed Prisma migration record and follow reviewed `migrate resolve --rolled-back`/retry procedures after clearing the blocker. Never mark partially inspected schema as applied. Missing schema fails protected operations/fulfilment closed; webhook financial processing remains independent. Leave environment initiation flags false during migration/code rollout. Pre-Issue-194 instances do not enforce these flags or admission controls: drain/remove them from payment-serving traffic before checkout activation, and verify every serving instance runs the reviewed version. A mixed-version rollout cannot claim distributed enforcement. Arrange an owner-approved deployment traffic gate if old instances are already serving checkout; this task configures no such gate.
2. Supply the same abuse secret and threshold config on every instance; verify trusted ALB/proxy CIDRs against actual topology, direct-origin access restrictions and spoofed forwarding-header tests. No Redis/new paid service is required. RDS receives small atomic writes per protected request; global bucket contention serializes new financial admission. Load-test connection pools, lock contention, latency and budget sizes in AWS Staging.
3. Implement frontend challenge/error handling, configure Cloudflare credentials/hostname and test failures/replays. Check Cloudflare account terms, quota and privacy requirements; no infrastructure or paid plan is assumed.
4. **Mandatory** Stripe Dashboard acceptance: verify Radar and card-testing controls/rules actually active for this integration/account, issuer/3DS/SCA policy, review handling, decline/fraud alerts, and test with actual Staging Payment Element. Current automatic payment methods/Payment Element are retained. Backend counters cannot see every `confirmPayment` sent directly to Stripe with a previously issued client secret. A kill switch cannot revoke it. 3DS is issuer-dependent and is not universally forced by this change. Do not enable checkout without accepting and testing provider-side protection.
5. Verify PayPal account/product fraud capabilities and relevant risk/review settings with PayPal; advanced-card Fraud Protection must not be assumed to protect a wallet Orders/Capture integration. No PayPal Dashboard/webhook setting is changed, and customer PayPal initiation remains disabled.
6. Configure AWS structured-log metrics/alarms, support/review runbooks, retention, maintenance scheduling and sensible staging global caps. These controls limit distributed abuse; widely distributed low-rate attacks and compromised real accounts still require provider risk tooling and operational review.
7. Complete independent review and AWS Staging payment/webhook/refund/finality concurrency tests. Keep both environment switches false until provider controls have actually been configured and accepted. After signed-off staging evidence and owner approval, deliberately set `PAYMENT_STRIPE_INITIATION_ENABLED=true` and confirm the shared Stripe policy is enabled. PayPal is a separate decision: setting `PAYMENT_PAYPAL_INITIATION_ENABLED=true` and its policy can permit existing capture operations only; customer create remains unconditionally disabled until separately approved PayPal work. Record the owner, change, provider-control checklist and acceptance evidence; verify the effective state after restart. Never enable both merely because credentials were supplied. Rollback must retain the additive schema and financial evidence; reverting to old code removes these controls and is not an acceptable activated-checkout rollback. Use switches to disable new initiation while keeping financial processing running.

## Isolated test reproduction

Use disposable PostgreSQL and synthetic credentials, no developer `.env`; block external networking. Compile only the isolated test copy with TypeScript, then use `dist/testing/runTests.js run` (which validates TEST_DATABASE_URL and deploys migrations before tests). Existing lifecycle tests require explicitly enabled synthetic initiation flags, a synthetic shared HMAC secret and a high-volume test-only limits profile; the new security suite resets to real staging defaults and supplies small limits to exercise enforcement. This is explicit test configuration, not a production test bypass. Separate Node processes share one database in the atomicity regression. No real provider calls or email delivery are needed.

## Remediation review — existing schema drift

The Issue #194 foreign keys now match Prisma's CASCADE update/delete actions. Read-only `prisma migrate diff` against the isolated database still reports seven older ON UPDATE differences for OrderCartProvenance, OrderCartAllocation, OrderConfirmationJob and CommercialInvoice. These originate in the committed pre-Issue-194 cart/email migrations, which omit ON UPDATE while their Prisma relations default to CASCADE. They are not changed here; review them as a separate schema-maintenance follow-up. Do not apply the generated diff as part of this feature. The feature changes only its own uncommitted migration.
