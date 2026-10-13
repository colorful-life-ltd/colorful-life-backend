# Password recovery security and frontend #58

## Contract

- `POST /auth/forgot-password`: JSON `{ "email": "..." }`. Email is trimmed and lowercased. Valid requests return HTTP 200 with `{ "message": "If an account exists, a password reset email has been sent" }`, including unknown/deleted accounts, suppressed delivery and delivery failures. Invalid email input retains the existing HTTP 400 validation response.
- `POST /auth/reset-password`: JSON `{ "token": "...", "newPassword": "..." }`. Existing password complexity validation applies, plus a maximum of 72 UTF-8 bytes for all newly registered or reset passwords. Unicode characters may occupy multiple bytes; passwords are never silently truncated. Login remains compatible with historical longer passwords. There is no separate password-change endpoint. Success: HTTP 200 `{ "message": "Password reset successfully" }`. Invalid/expired/already-used token: HTTP 400 `{ "error": "Invalid or expired password reset token" }`. Persistence failure: HTTP 500, generic internal-server-error response.
- Both routes: HTTP 429 `{ "error": "Too many requests. Please try again later." }` when the per-IP budget is exhausted, with conservative `Retry-After: 3600`. Limiter persistence failure: HTTP 503 `{ "error": "Password recovery temporarily unavailable" }`.
- Forgot: 30 requests per IP per hour; at most 3 deliveries per normalized email per hour, irrespective of whether that account exists. Email-budget exhaustion returns the identical generic 200 response. Reset: 30 requests per IP per hour. Windows start at the first accepted counter insertion/reset; additional requests never extend a window.
- Reset email is plain UTF-8 text with real newlines. The trusted frontend URL contains `/reset-password?token=...`. Tokens remain random, SHA-256 hashed in storage, expire after one hour and are single-use.

Frontend #58 should show the generic forgot response, submit the URL token to reset, then clear locally stored access/refresh credentials and return to login. Every session on every device is invalidated after reset. Treat `SESSION_INVALID` HTTP 401 as logged out. Avoid logging or persisting the reset URL; use `Referrer-Policy: no-referrer` on the recovery page.

## Transactions and concurrency

Reset, reset-token replacement, login session issuance, refresh rotation and account deletion use the existing User-first PostgreSQL lock order. Reset verifies/conditionally consumes the exact token after acquiring the user lock, updates only the password and a random credential version, and revokes every live refresh-session row in the same transaction. Rollback preserves the previous password, token and sessions together. Expiry is checked after lock acquisition, rather than before bcrypt work or lock waits.

Login verifies bcrypt outside the transaction, then locks/re-reads the user and compares the verified password-hash snapshot before issuing credentials and persisting a refresh session. A reset that wins the race prevents stale-password session issuance. A login/refresh that wins the race produces credentials that the subsequent reset revokes.

All access-token issuers include the current credential version. Authentication compares it to current database state. Legacy JWTs with no version remain compatible only while the user has never reset (nullable version); after reset, they are rejected. New login/refresh tokens use the new version, and every subsequent reset changes it again. Account ID, email, role, verification and order ownership are preserved. Unverified-email changes invalidate prior reset links under the same User lock; token creation checks the requested email against current ownership to reject a stale pre-change lookup. Requests already authenticated before reset are not retroactively aborted.

## Shared limiter, proxy and timing

Counters are PostgreSQL atomic UPSERTs, using a stable database statement timestamp and saturating counts; separate backend instances share the same budgets when they use the same database and JWT secret. Keys are HMACs using the JWT secret, not plaintext IP/email addresses. An indexed, bounded cleanup deletes at most 100 counters older than two hours per IP-admitted recovery request, using `FOR UPDATE SKIP LOCKED`. It never deletes users, tokens, sessions, orders, payment evidence or historical test orders. With no recovery traffic stale counters remain until a later request; no separate worker is required. Rotating the JWT secret changes counter keys and temporarily resets effective budgets.

By default Express trusts no proxies. Optional `TRUSTED_PROXY_CIDRS` must list only actual proxy IPs/CIDRs whose forwarded headers are controlled by the operator. The limiter uses Express `req.ip`, never directly accepts an arbitrary forwarded header. Behind an unconfigured proxy clients share its IP budget. Do not set broad/untrusted CIDRs: restrict network access to the controlled proxy and configure its forwarded-header handling. IPv4 addresses have canonical individual budgets, including IPv4-mapped IPv6 equivalents. IPv6 recovery budgets aggregate the first 56 bits (/56), so rotating addresses within a typical allocation does not reset the budget. Compressed and expanded representations share keys. IPv6 scope IDs do not change identity; invalid addresses share a conservative unknown-address budget. Normalized-email throttling still applies across networks. Controlled proxies must supply plain IP addresses, not address-and-port strings.

Valid forgot responses have a two-second minimum measured from limiter entry, including email-suppressed responses. Actual SES sends are awaited with a 1.5-second abort signal; no fire-and-forget delivery is introduced. Generic responses and padding reduce timing enumeration but are not strict constant-time guarantees: lock waits, database delays, SDK credential resolution, scheduling or provider latency exceeding the budget can still differ. SES failures are logged without addresses, URLs, tokens or exception payloads. No durable email outbox/retry guarantee is added; a user can request another email within the budget. A transport timeout can leave delivery outcome uncertain.

These choices follow the [OWASP forgot-password guidance](https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html) and [Express proxy guidance](https://expressjs.com/en/guide/behind-proxies/).

## Migration and rollout

`20261014120000_password_recovery_security` atomically adds nullable `User.credentialVersion` and the independent `PasswordRecoveryLimit` table with primary key, positive-count check and timestamp index. No existing financial, stock, ownership or password records are rewritten. A five-second lock timeout fails the migration instead of waiting indefinitely for the brief User ALTER TABLE lock. The index is built on the new empty table. The Prisma client includes the new column/model; no dependency or cloud-resource changes are required.

The application database role needs SELECT/INSERT/UPDATE/DELETE on the new limiter table and SELECT/UPDATE access to the new User column (table-level grants normally cover new columns). Verify role grants before cutover; the limiter deliberately fails closed if its persistence or pruning cannot run. Monitor counter-table growth and autovacuum under abuse; IP limits are not a substitute for upstream volumetric-abuse controls.

Apply the reviewed migration before activating the new binary. Use a coordinated cutover/drain of old instances: old binaries do not enforce credential versions and must not continue serving authentication once hardened recovery is enabled. Do not downgrade to a binary ignoring versions after resets; that would undo access-token revocation. Keep the additive schema on rollback. If a PostgreSQL migration fails, inspect its transactional rollback and Prisma migration status before a controlled retry. No production migration/deployment has been performed by this task.

Payment-resolution #156, inventory and webhook runtime behavior are outside this change. The separately approved foundation test-harness correction verifies that foundation and historical backfill migrations both exist and occur in the correct relative order; it no longer assumes the backfill is the newest repository migration. No payment migration or business rule was changed.

## Changed-file inventory

- Runtime: `src/app.ts`, `src/config/index.ts`, `src/controllers/authController.ts`, `src/domain/auth/passwordResetService.ts`, `src/domain/auth/refreshSessionService.ts`, `src/domain/auth/emailChangeService.ts`, `src/middleware/auth.ts`, `src/middleware/passwordRecoveryLimit.ts`, `src/routes/auth.ts`, `src/services/emailService.ts`, `src/utils/authValidation.ts`, `src/utils/recoveryClientIp.ts`.
- Database: `prisma/schema.prisma`, `prisma/migrations/20261014120000_password_recovery_security/migration.sql`.
- Tests: `src/__tests__/passwordRecoverySecurity.integration.test.ts`, `src/__tests__/passwordRecoveryMigration.integration.test.ts`, `src/__tests__/passwordResetForgot.integration.test.ts`, `src/__tests__/passwordResetHttp.integration.test.ts`, `src/__tests__/passwordRecoveryPolicy.test.ts`, `src/__tests__/paymentResolutionFoundation.integration.test.ts` (approved assertions only).
- Generated Prisma client: `browser.ts`, `client.ts`, `internal/class.ts`, `internal/prismaNamespace.ts`, `internal/prismaNamespaceBrowser.ts`, `models.ts`, `models/User.ts`, `models/PasswordRecoveryLimit.ts` under `src/generated/prisma-client/`.
- Documentation: this file.

## Verification results

- Baseline authentication/recovery/email-change and isolated PostgreSQL migration tests: 66 passed, zero failures/skips.
- Final remediation focused run: 100 passed, zero failures/skips (74 authentication/security tests and 26 foundation PostgreSQL tests).
- Baseline before independent-review remediation: 1,033 passed, three external sandbox tests intentionally skipped, zero failures; 26 foundation PostgreSQL tests passed. Final remediation full suite: 1,041 passed, three external sandbox tests intentionally skipped, zero failures (1,044 total).
- TypeScript build, Prisma validation, guarded-test-database migration status and `git diff --check`: passed.
- No credential literals detected in the changed files. No frontend or payment/inventory implementation files changed. No production migration, data cleanup, live provider operation, commit, push or deployment performed.

## Independent-review remediation

New password writes reject more than 72 UTF-8 bytes before bcrypt hashing, including direct reset-service calls. Registration and reset use the shared policy; login deliberately does not reject historical passwords. Frontend #58/#59 currently lacks this maximum: add a local `new TextEncoder().encode(password).length <= 72` check and explain the byte limit. Request/response contracts remain unchanged; a server validation error is HTTP 400. No frontend files were modified.

Targeted timing tests await slow injected delivery (including delivery failure) and delayed database lookup/failure, asserting the same generic response. They deliberately demonstrate that operations exceeding two seconds extend the response time. Timing mocks do not replace the real PostgreSQL locking in concurrency tests. A two-second floor provides practical padding for ordinary latency, not a guarantee against account enumeration under sustained differential delays. Do not describe it as constant-time. Rate budgets limit sampling, but distributed attackers can still compare slow account-specific paths.

Keep awaited delivery and the existing SES abort signal. Monitor recovery duration, database lock waits, SES errors and timeouts without email/token labels. Tune database/provider latency operationally and investigate persistent responses beyond the floor. Raising the floor alone cannot eliminate unbounded delays. Stronger response decoupling would require an approved durable email outbox/delivery design; no queue, worker or fire-and-forget path is introduced here. This residual timing limitation remains for owner review.
