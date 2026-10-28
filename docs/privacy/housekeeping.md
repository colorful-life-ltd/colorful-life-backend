# Phase 1 authentication and account-deletion housekeeping

Local review candidate, 28 October 2026. No deployment or existing database change is authorised by this document. Frontend PR #91 contains the proposed retention schedule and provider register; its two legal gates remain unresolved. This is not six-year automatic deletion.

## Changed behaviour

Existing private ADMIN `POST /admin/payment-security/maintenance` additionally removes expired RefreshSession, EmailVerificationToken and PasswordResetToken rows. Each table is limited to 1,000 per call, ordered deterministically and using FOR UPDATE SKIP LOCKED. Active credentials are preserved; locked replacements are skipped. Repeating calls drains backlog then returns zero counts. Existing abuse/challenge cleanup remains. Responses contain counts only. No new worker, public route or scheduler.

Self-service account deletion acquires the existing customer-cart lock before the User lock, removes refresh sessions and cart items in addition to existing profile/address/token erasure. Empty Cart and order provenance remain deliberately: deleting Cart would cascade reconciliation evidence. CartItem deletion sets allocation.cartItemId null; subsequent reconciliation does not resurrect basket content. Orders/address snapshots, payments, refunds, invoices and append-only audit remain unchanged. Repeat deletion does not duplicate audit or rewrite the tombstone. Historical tombstones are not retrospectively swept.

## Permission and rollout dependency — not executed

`database-identities.mjs` adds DELETE only for RefreshSession. Existing token/CartItem delete rights suffice. Review and apply the normal owner/migrator grant procedure before deploying this code; without the new permission, deletion/maintenance transactions fail atomically. Runtime still cannot DELETE Order/Payment/Refund/OperationalAudit or alter invoice snapshots. No new migration, elevated runtime ownership or IAM changes.

Owner must adopt the proposed cadence/process separately. Suggested daily bounded maintenance is not installed or claimed active. Use the existing authenticated private administration path, never a public Nginx route or credentials embedded in cron. Verify count-only responses, monitor backlog and repeat bounded calls if required. Rollback code only if needed; do not restore deleted expired credentials or rehydrate erased basket/profile data from backups. Follow the separately reviewed restore/erasure ledger procedure.

## Verification

Use the guarded test runner against a newly owned disposable PostgreSQL16 cluster, never existing databases. Relevant suites: authenticationMaintenance, accountDeletion/HTTP, passwordReset, emailVerification, cartProvenance, paymentAbuse and paymentAbuseRemediation. Runtime grant rehearsal uses scripts/rehearse-database.py --skip-application-tests and preserves 16 negative privilege probes plus an actual expired-session deletion under cl_runtime. See draft PR for exact totals/results.

No data-export implementation, financial purge, provider setting change, production write, payment call or deployment is included.

Final local result: 131/131 tests passed across the eight selected suites above, zero skipped; build/typecheck passed. Four deployment-contract tests and both changed-script syntax checks passed. Fresh PostgreSQL16 rehearsal applied all 73 committed migrations, tested allowed expired-session deletion and passed all 16 financial/audit/DDL denial probes. Both newly owned temporary clusters were stopped; no existing database was used. No full Backend regression run was claimed for this focused Phase 1 change. The first test runs exposed invalid fixture setup/cleanup: corrected to respect invoice constraints and retain immutable synthetic invoice evidence, without weakening database protections.
