# FBA and London AWS deployment integration

Local integration branch: `feature/fba-aws-deployment-integration`.

## Sources and boundaries

- Base: Backend main `fd158e9035c521cc09ea2d5b280d0c3fa71c5250`.
- Complete FBA implementation retained as ancestor `7471780dea29da9b3ef8c561a1aba6c8f8be51c2`.
- AWS compatibility sources copied from the existing `colorful-life-backend-infra` worktree, excluding its generated Prisma output. No source worktree was edited.
- Generated Prisma Client rebuilt from the complete FBA schema with `prisma`, `@prisma/client` and `@prisma/adapter-pg` all pinned to 7.10.1. Express 4.22.3, Multer 2.4.0 and the existing deployment security dependency fixes are retained.
- No changes to FBA business rules, historical migration SQL, payment admission, provider signature checks or existing runtime permissions.
- London only. No AWS calls, provisioning, ShortBreakHub changes, real database changes, publication or deployment form part of this integration.

The only directly overlapping FBA/deployment tracked files were generated `internal/class.ts` and `internal/prismaNamespace.ts`. Regeneration resolved the overlap; generated clients from different Prisma versions were not manually combined.

## Contracts and rollout

The Backend `integration-v1.json` and `fba-shipments-v1.json` fixtures remain byte-identical to both the FBA Backend source and Admin feature worktree. Admin commit `8b5276aa073a44f8618a7d9e13b6f960d55c39d2` pins Backend `7471780dea29da9b3ef8c561a1aba6c8f8be51c2`; that ancestor and its contracts remain in this integration history.

After independent review and separate publication authorization, make the complete Backend/deployment commit available on main before selecting it in Infra's release workflow. Publish compatible Storefront deployment changes separately; this branch does not modify that worktree. Apply the reviewed schema migration and grant refresh before activating API/Worker revisions, then distribute the matching Admin release after endpoint verification. Do not drop additive tables or rewrite migration history as an application rollback.

## Database acceptance

The existing fresh/recovery rehearsal retains the owner/migrator/runtime boundary and all 16 runtime-denial probes. `FbaShipment` has SELECT/INSERT plus its serial-sequence access; `FbaShipmentSequence` has SELECT/INSERT/UPDATE for its atomic counter, with DELETE/TRUNCATE denied. No runtime DDL or owner credential access is added.

New command:

```bash
python3 scripts/rehearse-database.py --fba-upgrade --skip-application-tests
```

It creates a new, loopback-only, disposable PostgreSQL 16 cluster. It applies all 72 baseline migrations from an owned temporary directory, grants runtime privileges, and seeds a synthetic legacy outbound through the runtime identity. It then runs the normal deployment preflight/migration/grant sequence for migration 73 and executes the real compiled FBA service as `cl_runtime`.

Assertions cover unchanged legacy outbound history and nullable header, concurrent same-key exactly-once recording, replay, same-key changed-payload conflict, duplicate Amazon reference refusal, reservation-preserving stock deduction, insufficient-available-stock refusal, denied header UPDATE/DELETE and denied counter DELETE/TRUNCATE. Counter upsert and serial-sequence permissions remain covered by the existing probes. Source migrations are never moved, hidden or copied individually into another application branch. The temporary cluster is stopped on success or failure. This rehearsal is included in the Backend deployment-rehearsal CI job.

The first run exposed missing synthetic abuse-startup configuration in the new rehearsal; the harness now supplies a random local HMAC and explicit direct-client mode. Application startup validation was not weakened.

The initial full regression run also exposed a PostgreSQL 16 fixture assumption in `paymentResolutionFoundation.integration.test.ts`: a non-superuser creator cannot automatically SET ROLE to its synthetic test role. The test now explicitly grants SET membership to CURRENT_USER inside its rollback transaction. All protected-history DELETE/TRUNCATE assertions and the non-superuser owner remain unchanged; no production grant was added. The known-failed run was stopped with its disposable cluster shut down, then the complete suite restarted. The focused non-superuser rehearsal now includes this financial foundation test and both FBA integration files as well as metrics/email isolation.

## Validation evidence

Current-run results and exact changed paths are recorded below before the local integration commit. Historical evidence in `docs/aws-deployment.md` does not replace these results.

| Check | Result |
|---|---|
| Complete Backend regression suite, Node 22.23.2 / PostgreSQL 16 | PASS, exit 0: 2,159 tests; 2,156 passed; 0 failed/cancelled; 3 existing credential-dependent Stripe sandbox skips; 136 suites; 1,337,357 ms (22m 17s) |
| Fresh identity initialization, all 73 migrations, runtime grants and injected migration failure / owner recovery | PASS; all 16 runtime-denial probes preserved |
| Populated 72 -> 73 upgrade and real restricted-runtime FBA journey | PASS; legacy outbound unchanged; concurrent replay exactly once; reserved stock preserved |
| Runtime and Prisma migration TLS | PASS; correct CA/host accepted; wrong CA/host and plaintext rejected |
| Backend deployment contract tests | 4 passed |
| Expanded financial foundation, FBA, operational metrics and email isolation integration tests | 66 passed |
| Prisma validate, no-emit typecheck, certificate checksums | PASS |
| Repeated client generation | PASS; all 61 generated TypeScript files unchanged |
| Runtime dependency audit and development-inclusive audit | PASS; zero reported vulnerabilities in each |
| actionlint with ShellCheck; whitespace and staged artifact/credential review | PASS |
| Admin fixture checker | PASS; both fixture files byte-identical |
| Actual compiled Admin service against integrated Backend over HTTP | PASS, seven journeys, including lost committed response and same-key recovery |

The Admin HTTP check compiled only the Electron main-process TypeScript into a temporary archive snapshot of Admin `8b5276aa073a44f8618a7d9e13b6f960d55c39d2`; it did not start Electron or change the Admin worktree. Its Backend and database were local and disposable. This is additional to the `cl_runtime` service journey: the HTTP fixture harness uses an owned test-database identity for setup/cleanup.

Local evidence logs: `/tmp/colorful-fba-aws-full-suite.log`, `/tmp/colorful-fba-aws-upgrade.log`, `/tmp/colorful-fba-aws-tls.log`, `/tmp/colorful-fba-aws-admin-http.log`. These logs are not committed. The API/migration Docker build remains unavailable because Docker Desktop WSL integration is disabled.

Validation completed on 2026-10-22. The complete suite ran after the role-fixture correction; no test was removed or weakened, and no additional test was skipped. The three sandbox checks require real provider credentials/webhook infrastructure and remain unverified. All disposable PostgreSQL clusters were stopped. Git HEAD, status and content hashes of all tracked/untracked source files were checked against a pre-integration snapshot for the existing Backend main, AWS, FBA, Admin FBA and Infra worktrees; all remained unchanged.

Real Docker builds, ECR scans and scan timestamp reliability, AWS IAM/OIDC authorization, RDS/ECS/SES acceptance, signed sandbox provider events, backup/restore and remote CI remain separate acceptance requirements. No claim of staging or production readiness is made.

## Exact integrated file scope against main

Includes the complete FBA ancestor plus this deployment integration. Generated Prisma TypeScript is intentional source output; compiled application files, Python bytecode and test evidence are excluded.

```text
.github/workflows/backend.yml
.gitignore
Dockerfile
Dockerfile.migrations
README.md
certs/README.md
certs/SHA256SUMS
certs/eu-west-2-bundle.pem
certs/rds-ca-rsa2048-g1.pem
contracts/fba-shipments-v1.json
docs/aws-deployment.md
docs/fba-aws-integration.md
package-lock.json
package.json
prisma/migrations/20261027120000_fba_shipment_builder/migration.sql
prisma/schema.prisma
scripts/database-identities.mjs
scripts/database-tables.json
scripts/deploy-database.mjs
scripts/fba-runtime-journey.mjs
scripts/generate-client.mjs
scripts/migrate.mjs
scripts/migration-contract.mjs
scripts/migration-contract_test.mjs
scripts/migration-preflight.mjs
scripts/recover-migration.mjs
scripts/recovery-contract.mjs
scripts/recovery-contract_test.mjs
scripts/rehearse-database.py
scripts/rehearse-tls.py
scripts/runtime-privilege-probes.mjs
scripts/scram-verifier.mjs
scripts/tls-probe.mjs
src/__tests__/adminProductListings.integration.test.ts
src/__tests__/deploymentDatabase.test.ts
src/__tests__/emailIsolation.test.ts
src/__tests__/fbaShipment.integration.test.ts
src/__tests__/fbaShipmentContract.integration.test.ts
src/__tests__/operationalMetrics.integration.test.ts
src/__tests__/paymentResolutionFoundation.integration.test.ts
src/__tests__/workerHealth.test.ts
src/config/database.ts
src/config/index.ts
src/controllers/fbaShipments.ts
src/domain/cart/cartProvenanceService.ts
src/domain/inventory/fbaShipmentService.ts
src/domain/payments/paypalWebhookReplayService.ts
src/domain/payments/stripeResolutionService.ts
src/domain/products/adminProductListingService.ts
src/domain/products/adminProductListingValidator.ts
src/generated/prisma-client/browser.ts
src/generated/prisma-client/client.ts
src/generated/prisma-client/internal/class.ts
src/generated/prisma-client/internal/prismaNamespace.ts
src/generated/prisma-client/internal/prismaNamespaceBrowser.ts
src/generated/prisma-client/models.ts
src/generated/prisma-client/models/Address.ts
src/generated/prisma-client/models/BusinessExpense.ts
src/generated/prisma-client/models/Cart.ts
src/generated/prisma-client/models/CartItem.ts
src/generated/prisma-client/models/Category.ts
src/generated/prisma-client/models/EmailVerificationToken.ts
src/generated/prisma-client/models/FbaOutbound.ts
src/generated/prisma-client/models/FbaShipment.ts
src/generated/prisma-client/models/FbaShipmentSequence.ts
src/generated/prisma-client/models/InventoryAudit.ts
src/generated/prisma-client/models/InventoryMovement.ts
src/generated/prisma-client/models/Order.ts
src/generated/prisma-client/models/OrderReturn.ts
src/generated/prisma-client/models/PasswordResetToken.ts
src/generated/prisma-client/models/Payment.ts
src/generated/prisma-client/models/PaymentWebhookEvent.ts
src/generated/prisma-client/models/Purchase.ts
src/generated/prisma-client/models/PurchaseDocument.ts
src/generated/prisma-client/models/PurchaseItem.ts
src/generated/prisma-client/models/Refund.ts
src/generated/prisma-client/models/User.ts
src/index.ts
src/operations/health.ts
src/operations/metrics.ts
src/operations/readiness.ts
src/prisma/runtime.ts
src/routes/inventory.ts
src/utils/apiErrorResponse.ts
src/worker.ts
```
