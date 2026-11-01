# Pre-launch data policy and Sandbox disposal

Production RDS in eu-west-2 is authoritative for real catalogue, prices, images and opening inventory. The EC2 Sandbox database is a disposable copy. It must remain operational until Return V1 and Stripe testing finish. No Sandbox customers, orders, payments, refunds, returns, sessions, inventory movements or counters may be transferred to Production. Production is outside the cleanup target and must remain untouched. Disposing of Sandbox does not attest that Production is free of test data: a separately scoped, read-only Production launch audit must confirm that before public launch; any required Production remediation needs its own approval.

Stripe is the only supported customer payment provider. PayPal creation, capture and new-refund HTTP endpoints reject new operations even if old Sandbox flags/credentials remain configured. Return V1 authorization, receipt, inspection and completion do not initiate refunds. Any financial refund remains a separate deliberate operation. Return authorization emails remain disabled by default.

## Repeatable procedure (future maintenance; not authorized)

1. Finish Return V1 and Stripe tests and retain their evidence. Independently review this change before deployment. Dry-run reports are observations, never permission to destroy data.
2. Record the exact EC2 identity, Compose project, full PostgreSQL container ID, PostgreSQL system identifier, database name, volume IDs/paths and migration checksums. Review a fresh read-only inventory with the tool below. A name alone is insufficient. Do not accept a Production/RDS connection string as a target.
3. Obtain an approved, consistent **catalogue-only** Production snapshot from a separately authorized export process. This procedure neither connects to RDS nor exports data from it. The approved artifact must include catalogue, prices, image/category links and authoritative opening inventory, its source revision/migration requirements, manifest counts and SHA-256 checksums. Do not use a full Production dump or a Sandbox dump as the recreation source. Exclude all customer/account/session and transactional rows. Preserve required migrations, grants, constraints and catalogue identity/sequence dependencies. Do not infer inventory from Sandbox counters.
4. Rehearse restoration into a new isolated disposable database first. Verify artifact checksums, catalogue relationships/prices/images and opening inventory against the approved manifest; verify required migration checksums, roles/grants, application schema compatibility and sequences. Check **every table** against an explicit reviewed catalogue/schema/configuration allowlist; all other application tables, including User, orders, payments, refunds, returns, sessions, ledger, jobs, admissions and security counters, must be empty. Reject unknown tables or unexpected rows. No account allowlist or per-listing Sandbox stock restoration is needed. Synthetic-only tests must exercise rejection of a full dump, residual transactional/customer rows, inventory mismatch and missing migrations before approving a recreation implementation.
5. Request separate owner approval for a bounded Sandbox maintenance window and the exact target, snapshot hash, backup and restore procedure. Until then, do not stop services, destroy/reset/recreate databases, create approvals, or change routing, credentials or migrations.
6. In that separately approved window, quiesce only Sandbox writers, including Worker/jobs and inbound callbacks. Take and verify a fresh encrypted Sandbox backup outside the root volume and retain recovery-key custody. Recheck target identity and the dry-run. Prefer restoring to a **new Sandbox database/volume**, leaving the old one intact for rollback. Use only the approved artifact; never propagate Sandbox data into Production. Do not provide a generic destructive URL-based command or use TRUNCATE/CASCADE against an existing database.
7. Before allowing writers, repeat the full manifest and zero-transaction/account acceptance checks in step 4. Verify migration checksum/history and application readiness without enabling emails, refunds, checkout or external workers. Capture the report at this quiesced point: later test traffic can legitimately create new synthetic rows.
8. Only under that approval, switch the Sandbox to the verified replacement and run approved smoke tests. If restoration, manifest, zero-row, readiness or identity checks fail, leave the old database intact, revert Sandbox configuration to the preserved old database and restore only approved Sandbox services. Do not apply reverse migrations to Production. Delete the old database/volume/backup only under a later explicit retention/disposal approval.

A repeated run starts with a fresh identity check, approved snapshot, backup and dry-run. There is intentionally no selective deletion, inventory-repair program, staff allowlist, automatic destruction mode or automatic Production connection in this change.

## Read-only dry-run

`scripts/sandbox-disposal-preflight.py` only inspects the fixed EC2 Sandbox PostgreSQL Docker container and runs a read-only repeatable-read transaction via its local Unix socket. It cannot accept a database URL or an apply flag. It records counts for **all** public tables, migration checksums and database/cluster/container identity; no customer records, credentials or environment dumps are printed. It creates no database marker and writes no database data. Inspection, query, timeout or identity failure produces no accepted report.

An operator first independently verifies the host and obtains the full container ID and PostgreSQL system identifier using read-only Docker/SQL inspection. Run the reviewed script on the verified EC2 (installation, if needed, requires separate authorization):

```sh
python3 -B scripts/sandbox-disposal-preflight.py \
  --expected-container-id '<verified full 64-hex Sandbox container ID>' \
  --expected-system-id '<verified Sandbox PostgreSQL system identifier>'
```

The output always says `DRY_RUN_ONLY` and `KEEP_SANDBOX_OPERATIONAL`. This inventory is not a catalogue export, approved opening-stock baseline, final cleanliness attestation or destructive execution approval. A current report must be regenerated before future maintenance; neither stale counts nor test fixtures are operational evidence.

## Current dry-run status

A read-only inventory was captured on 2026-10-31 through SSH/SSM by streaming this script to Python stdin; nothing was installed on EC2. The verified Sandbox cluster `7700559377687638053` remains at migration 73. The report records 54 public tables, including 57 products, 71 listings, 3 users, 11 orders, 9 payments and 16 refresh sessions; refunds and returns are zero. See [the complete count/migration report](sandbox-disposal-dry-run-2026-10-31.json). The observation does not classify users by email or certify that catalogue stock matches Production.

No destructive cleanup or recreation has run. No approved catalogue-only snapshot or approved destruction window is supplied. The dry-run decision is **KEEP SANDBOX OPERATIONAL** while Return V1 and Stripe tests continue. Both persistent databases remain unchanged. Automated safety tests use synthetic inspection/query fixtures; they do not claim a completed snapshot restore test. Disposable snapshot-restore acceptance is a prerequisite for a future recreation PR and owner approval, not a blocker to keeping the current Sandbox operational.

## Admin follow-up: remove the obsolete PayPal enable control

The separate Admin repository still offers `PAYPAL` in `electron/operations-contract.ts` (`providerPolicy`) and describes it as disabled only pending acceptance. That wording/control is obsolete under the final Stripe-only decision. Follow up in a separately reviewed Admin PR: restrict the provider-policy selector to Stripe, remove the PayPal enabling option and state that PayPal checkout is unsupported. Keep Stripe's existing admission controls intact. This Backend CI repair does not modify or deploy the separate Admin repository.

The current Admin policy endpoint can still store a PayPal policy flag, and its monitoring response reports the configured legacy environment flag. Neither can reopen the unconditionally blocked customer create/capture or new-refund HTTP endpoints. The remaining Admin control is a misleading management affordance, not a supported PayPal launch path. No historical-order migration or compatibility work is required.
