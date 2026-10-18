# Automated email isolation

## Audit

- `src/controllers/authController.ts` sends signup/resend verification and password-reset emails through `src/services/emailService.ts`.
- `src/controllers/userProfile.ts` sends email-change verification through the same service. Reset completion, login, refresh and ordinary profile updates do not send email.
- `src/domain/orderConfirmation/legacyDispatch.ts` uses `sendDispatchNotification`; the durable worker uses `sesConfirmationTransport` in `src/domain/orderConfirmation/delivery.ts` for confirmation/invoice and dispatch MIME.
- `src/domain/email/verificationEmail.ts` and durable `delivery.ts` use Nodemailer **streamTransport**, buffer output and disabled file/URL access; no SMTP integration exists in the audited source.
- The prior auth service constructed a default SES client at module load and used it even with NODE_ENV=test. Tests without sender overrides could send through AWS's default credential chain. The runner loads dotenv first; application config loads it again. Worker flags alone do not protect authentication email.

AWS documents credential discovery through environment, shared files/profiles, identity/role and container/instance providers: [Node credential chain](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/setting-credentials-node.html), [IMDS opt-out](https://docs.aws.amazon.com/sdkref/latest/guide/feature-imds-credentials.html).

## Guarantees and usage

`src/config/testEmail.ts` recognizes NODE_ENV=test and native Node test execution (including cases that temporarily change NODE_ENV). Default auth senders become deterministic no-send functions; they never construct/invoke SES. Existing explicit sender overrides remain available for recipient/token/content/failure assertions, and restoring one returns to the guarded default. SES is now constructed lazily only outside test execution.

Default legacy and durable dispatch/confirmation transports reject test delivery instead of pretending an outbox message was accepted. Use the existing capture transport for worker tests. SES readiness accepts an explicit fake object; it rejects a real SESClient even if explicitly passed in tests, before credentials or requests are resolved. MIME/template generation and PDF content tests remain independent of sending.

After database safety validation, the runner replaces all inherited AWS values with empty/synthetic test values; redirects shared config/credentials and web-identity/token files to the OS null device; clears profiles, roles and ECS endpoints/tokens; and disables IMDS. Present empty values prevent a later dotenv reload from restoring inherited credentials. Test-mode application config repeats this isolation for direct Node tests. No real credential files are read or modified by the isolation code.

The runner preloads `src/testing/noExternalNetwork.ts` in test workers through NODE_OPTIONS. Standard Node HTTP(S)/fetch requests outside loopback fail before provider transport; the preload is inherited by normal subprocesses. Local disposable PostgreSQL and loopback mock servers remain usable. Provider tests must inject fakes; the standard runner forces real Stripe sandbox/webhook test switches off. Do not remove NODE_OPTIONS or import new custom network transports to work around this guard.

This is a test safety boundary, not an OS sandbox: arbitrary test code can deliberately replace hooks, clear its environment or use raw sockets/another executable. CI should additionally deny outbound network access and avoid mounting real credential files. Direct test commands that bypass the runner still receive the application email guard; use the runner for credential/network isolation. No live-email/provider acceptance test is authorized by this setup.

Development/production processes outside test execution retain their original SES configuration, credential resolution, sending and failure semantics. Subprocess regressions exercise these branches with SESClient.send mocked, never with real AWS requests. No migration, dependency or production configuration change is required.

## Validation

Run `npm test` with a disposable TEST_DATABASE_URL different from DATABASE_URL; the launcher validates the target before any migration. Focused coverage includes default auth HTTP paths without injected senders, sender restoration/capture, legacy and durable email protection, readiness, dotenv/inherited credentials, metadata/profile isolation and mocked non-test behavior. Full template, invoice, dispatch and authentication regressions remain required. There is no configured lint command in the current repository.
