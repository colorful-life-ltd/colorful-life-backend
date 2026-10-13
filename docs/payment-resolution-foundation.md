# Issue #156 Phase 2A: fail-closed data foundation

No checkout, provider, admission, cancellation, expiry, confirmation, inventory mutation or webhook-replay behavior changes. Existing Payment remains the compatibility aggregate. This phase provides storage and structural guards only, not runtime provider authentication/finality verification.

## Non-negotiable Phase 2A release gate

PostgreSQL CHECK `phase2a_no_release` rejects both RELEASED reservation disposition and RELEASED resolution state on INSERT and UPDATE. No local payment status, completed operation, empty/missing coverage, JSON proof or successful financial evidence can bypass this gate. Historical dispositions remain quarantined and unknown. A proof row is evidence scaffolding, never permission to release inventory.

Phase 2B may replace this prohibition only after independent review verifies authoritative provider finality, every relevant attempt/operation, same-order proof, Order-first transactional locking and exactly-once stock handling. No release algorithm is enabled now.

## Data and immutable policy

- PaymentAttempt preserves expected amount/currency and write-once provider/create/admission identities. Primary IDs cannot change. One historical attempt per compatibility Payment is enforced by a partial unique index, including NULL placeholder identities.
- PaymentOperation journals individual calls with immutable primary identity, request hash, admission/deadline and operation key. Historical operations have no invented admission/hash/deadline. Recovery generation and execution count cannot decrease.
- Supported journal transitions are PREPARED -> POTENTIALLY_DISPATCHED -> UNKNOWN or RESULT_RECORDED, and UNKNOWN -> RESULT_RECORDED. RESULT_RECORDED cannot regress. New nonhistorical rows begin PREPARED; historical rows begin UNKNOWN. Other transitions wait for Phase 2B. RESULT_RECORDED is not terminal unpaid.
- FinancialEvidence references its exact operation for verified observations. Order/provider must match the operation's attempt. Receipt provider must match, including a later one-time receipt binding. Known normalized provider identities and available PayPal receipt order/capture identities must match the attempt; later attempt binding is also checked against existing evidence. Missing provider payload fields are not invented or taken as finality. Application/provider authenticity and full amount/currency validation remain Phase 2B responsibilities.
- PaymentResolution is unique per Order; its creation timestamp must match Order. The initial deadline is exactly creation +30 minutes. First-failure timestamp, evidence/operation references and retry deadline bind together once, with retry deadline exactly +30 minutes. There is no maximum verification age. Failure must reference a nonhistorical, timely admitted initial CONFIRM/CAPTURE operation whose result references that same FAILURE evidence. Its original admission deadline, timestamps, order/provider and current unpaid HELD/not-permanently-closed/PENDING eligibility must be consistent.
- Verified evidence timestamp must equal the first failure timestamp. Phase 2B must assign that database verification timestamp after acquiring Order first. Duplicate failures cannot alter the stored window. Permanent closure cannot be reset.
- HELD may become CONSUMED only in PAID state; consumed disposition/time cannot reverse. RELEASED remains categorically prohibited. UNKNOWN historical disposition is represented by NULL only in quarantined REVIEW_REQUIRED rows.

## Conservative backfill

Every historical Order enters REVIEW_REQUIRED with unknown disposition. Creation time is preserved as UTC and the policy's initial deadline is +30 minutes; this is not a historical admission assertion. No retry window, permanent closure, disposition, provider finality or release proof is fabricated.

Existing Payments remain untouched. Historical attempts retain real provider/capture identities and create keys; pending placeholders become NULL only in the new attempt. Each gets an UNKNOWN journal entry representing unreconstructed activity, not proof that a CREATE call was actually sent. Local status/paidAt are unverified normalized evidence, even for SUCCEEDED aggregates. Existing services continue using the original Payment to protect inventory. Existing webhook evidence and stock/order records are unchanged.

Backfill is repeatable without duplicating placeholder attempts; identities already snapshotted are not overwritten. It is not a continuous catch-up worker. Old binaries create new Orders/Payments without foundation coverage; Phase 2B must establish a catch-up/cutover protocol before using this data for decisions. Historical missing admission cannot open retry; audited reconstruction requires a separately reviewed design.

## Migration locking, rollback and deployment

Two migrations separate schema DDL (`20261013120000_payment_resolution_foundation`) from historical backfill (`20261013121000_payment_resolution_historical_backfill`). Each is transactional; backfill uses REPEATABLE READ for one consistent snapshot. DDL commits before backfill begins.

ADD FOREIGN KEY takes SHARE ROW EXCLUSIVE locks on referenced Order/Payment/webhook tables; these block ordinary writes and remain held until the DDL transaction commits. The earlier single-transaction design would have retained those locks through backfill. New indexes are built on empty new tables. Backfill reads legacy tables and inserts new rows; referential checks may still hold key-share locks and conflict with deletes/key changes, but do not retain the DDL write-blocking table locks. Assess data volume, WAL, transaction duration, and configure controlled lock/statement timeouts before production migration. No production deployment was performed.

A backfill failure rolls back only that migration; DDL remains committed. Retry the failed migration after resolving the cause; do not drop legacy or financial records. Application rollback can leave dormant additive tables in place. Once Phase 2B introduces multiple attempts, rollback to unaware binaries needs a stricter boundary.

## Required production privilege boundary

UPDATE triggers are not absolute audit immutability. DELETE/reinsert or TRUNCATE by a table owner/superuser can reset history; deleting parent Order/Payment can cascade into foundation records. Existing cascades are preserved for compatibility.

Production requires a separate non-owner runtime role with SELECT/INSERT/UPDATE only on foundation tables and required sequence privileges; no DELETE/TRUNCATE on PaymentResolution, PaymentAttempt, PaymentOperation, FinancialEvidence or ReservationReleaseProof. It must also lack DELETE/TRUNCATE on audited Order/Payment/PaymentWebhookEvent parents, and lack owner/superuser/inherited administrative capabilities or grants via PUBLIC. Audit every transitive cascade route before enabling Phase 2B. DDL/backfill uses a separate controlled migration role. Legitimate parent deletion needs a separately audited retention process.

Actual production role names/privileges have not been configured in this issue; this is a rollout prerequisite, not a claim about current grants. PostgreSQL tests create a transactional non-owner role with SELECT/INSERT/UPDATE, prove counter updates work, and prove audit/parent DELETE and TRUNCATE fail. The role is removed by transaction rollback. No production role or AWS infrastructure is provisioned.

## Validation

Tests use full migration history in disposable schemas in the guarded colorful_life_test database, real CHECK/trigger/FK enforcement, injected DDL/backfill failure and transactional privilege tests. They cover unconditional release rejection, uncovered Payments, successful operation evidence, proven days-late admission, rejected historical admission, permanent closure, source identity, primary IDs, counter/state regression and replay-safe backfill. Existing payment safety regressions remain required.

Pre-existing cart ON UPDATE foreign-key drift remains outside #156. Prisma diff does not inspect custom trigger/check semantics; PostgreSQL tests do. No full backend suite or live provider operations are needed for this remediation.

Remediation validation: 18 foundation PostgreSQL tests and 136 tests across seven focused foundation/payment-regression files passed, with zero failures or skips. Prisma validation, guarded deployment of both migrations, migration status, TypeScript build and git diff --check passed. Datasource/schema diff reports only the established cart foreign-key drift. No production migration, role provisioning, live provider operation or full-suite run occurred.


Final identity remediation: normalized and referenced receipt identities are compared independently, including PayPal order and capture IDs. Conflicting available sources are rejected on FinancialEvidence insertion/receipt binding and subsequent attempt identity binding; no COALESCE precedence hides disagreement. Attempt success/finality references must trace through an operation belonging to that exact attempt. Tests cover two PayPal attempts on one order, matching positive controls, and a legacy receipt gaining contradictory evidence after linkage. Existing receipt backfill/replay behavior is unchanged; conflicts discovered later block binding and require investigation rather than guessed identity or finality.

Final identity validation: all 144 focused tests passed (including 26 foundation tests), with zero failures/skips. Prisma validation, guarded migration deployment/status, TypeScript build and git diff --check passed. The datasource/schema diff still contains only the pre-existing cart ON UPDATE foreign-key differences. No full-suite rerun, runtime-flow change or production operation occurred.
