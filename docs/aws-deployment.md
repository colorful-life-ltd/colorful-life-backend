# AWS deployment compatibility

Infrastructure and coordinated release automation are in the separate local colorful-life-infra repository. Nothing here provisions AWS, enables payments or migrates an existing database automatically.

- API: node dist/index.js, BACKGROUND_WORKERS_ENABLED=false.
- Worker: node dist/worker.js, BACKGROUND_WORKERS_ENABLED=true; localhost-only health listener, no application routes/ALB.
- Runtime credentials: DB_HOST/PORT/NAME/USER/PASSWORD, or a legacy DATABASE_URL (not both).
- Production requires RDS_CA_FILE; deployed CA is certs/rds-ca-rsa2048-g1.pem, matching the configured RDS CA. Runtime pg verifies trust and hostname explicitly; connection-string SSL overrides are rejected.
- Prisma7 migration engine uses sslmode=require, sslaccept=strict and sslcert. Its semantics differ from libpq/pg; migrationDatabaseUrl assembles its URL. The exact engine source was checked, but actual RDS acceptance still requires staging tests.
- scripts/migrate.mjs allows status/deploy only; deploy requires explicit approval. scripts/migration-preflight.mjs checks owner environment/host binding and checksums/history. A newly restored endpoint fails this binding until owner-controlled reconciliation.
- scripts/database-identities.mjs initialize is owner-only and limited to a new empty DB. grant runs as migrator after schema acceptance, with explicit immutable-ledger restrictions and a model allowlist.
- Operational metrics emit only counts/ages to awslogs/EMF. No automatic refund, dispute clearance, reservation release or uncertain-operation replay is added by monitoring.
- All provider initiation/email activation remains default-off in infrastructure. Existing raw webhook parsers, payment transitions, audit guards and Cloudinary integration remain unchanged.
- No Prisma schema or historical migration SQL was changed in this infrastructure implementation.
- The existing independent email test isolated-cwd fix is preserved in this worktree, with the production child CA configuration added. Other main-checkout test-isolation/clock changes remain untouched and are not copied. Full guarded tests and new disposable PostgreSQL migration/privilege/TLS rehearsals are documented in the infra validation report; real staging acceptance remains required.

See the infra configuration matrix, acceptance checklist and runbooks for IAM, secrets, rollback and owner approval. This implementation is not a production-readiness declaration.

Remediation adds owner-only scripts/recover-migration.mjs for explicitly approved, checksum/host/environment-bound failed migration metadata recovery. It never undoes SQL, resumes services or replays payments. Owner audit records remain inaccessible to runtime. See infra docs/runbooks.md before any authorized use.
