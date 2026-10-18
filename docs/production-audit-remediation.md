# Production audit remediation — Issue #208

Baseline b78da7493dca8fce59b05b52978c7e9475d7ab92. NOT DEPLOYED. Independent review and staging acceptance remain mandatory.

## Finding matrix

|Finding|Remediation / disposition|Primary verification|
|---|---|---|
|F1 external refunds|Import exactly correlated, verified provider refunds; account finalized amounts once; unresolved parent-linked receipts block fulfilment. No metadata ownership guessing.|External full/partial, replay and out-of-order tests|
|F2 CORS|Explicit CORS_ALLOWED_ORIGINS; HTTPS origins required in production.|Configuration and HTTP tests|
|F3 deployment/CI|Non-root Docker packaging, separate migration image, ECS task template and CI on disposable PostgreSQL.|Build/schema/full suite; AWS acceptance still manual|
|F4 configuration|Production rejects weak JWT, non-HTTPS/placeholder origins, legacy mode, example sender and sandbox when PayPal enabled.|Pure validation and child-process tests|
|F5 manual payments|Active ADMIN, mandatory bank-evidence reference/reason, immutable actor audit. Never use manual API to repair a provider outcome.|Authorization/audit/replay tests|
|F6 unpaid confirmation|Verified succeeded payment required in all modes; amount/currency must reconcile.|Legacy unpaid regression and paid confirmation suites|
|F7 duplicate FBA|Shipment/listing unique identity plus existing listing lock and idempotency key.|Concurrent different-key duplicate tests|
|F8 oversized FBA|OWNER APPROVED: record actual, applied and shortfall even with reservations. Deduct only available book stock; preserve reservations. Unresolved discrepancies block new reservations, confirmation and fulfilment until an ADMIN stocktake with a mandatory reason verifies sufficient physical stock.|Oversize, reservation and concurrent tests|
|F9 disputes|Verified Stripe dispute receipts hold fulfilment without changing money or inventory. Uncorrelated evidence retained. No automatic release from a won/closed notification.|Dispute ordering and guard tests|
|F10 paid cancellation|Explicit staged process: fence dispatch with request-paid-cancellation, existing refund API then cancel-refunded endpoint after finalized full refund. No pretend atomic provider/DB transaction. Used offers require existing return inspection.|Cancellation/refund/stock tests|
|F11 delivery policy|GB delivery only, including billing fallback; billing itself may remain international.|Country tests|
|F12 deletion|Password reauthentication, checked hash under User lock.|Deletion/auth tests|
|F13 operations|Database readiness, HTTP drain, awaited worker stop, separate worker enablement.|Readiness/shutdown tests; ECS staging termination test required|
|F14 bootstrap|One-off CLI promotes an existing verified user only if no active ADMIN; advisory lock, reason/operator reference, credential rotation, refresh revocation and immutable audit.|Concurrent/bootstrap tests|
|F15 purchase visibility|OWNER CONFIRMED: keep importer-only access. Existing ownership remains unchanged.|Existing authorization tests retained|
|F16 HTTP headers|No x-powered-by, nosniff, frame denial, referrer restriction, production HSTS.|HTTP tests|
|F17 public stock|Legacy listing detail projects available stock; catalogue already does so.|Reserved-stock projection tests|
|F18 logs|HTTP errors omit raw exception objects. Operational messages retain context, not request data.|Source inspection and error-path tests|
|F19 accounts|Authenticated password change; verified email change requires password, revokes credentials/sessions and verifies replacement address.|Account security tests|
|F20 order replay|HTTP order creation requires Idempotency-Key; domain replay fingerprint/locking unchanged.|HTTP missing-key and replay tests|

## Review workflow

GET /admin/refund-reviews returns OPEN refund reviews (id cursor, max100).
GET /admin/refund-reviews/:orderId/:refundId returns refund and last100 immutable journal records.
POST /admin/refund-reviews/:orderId/:refundId/resolve requires Idempotency-Key and
`{expectedRevision,reason,evidenceReferences}`. Active ADMIN only. The server derives actor/time.

Resolution changes only reviewRequired. It requires a terminal outcome and a fresh successful provider GET corroboration for the current review revision. Opposite terminal evidence and PROCESSING refunds cannot be acknowledged away. Provider GET recovery retains the existing activation control, eight-attempt lifetime cap and no POST replay rule. Exhausted/conflicting financial cases require separately approved investigation/correction; this endpoint never resets counters or invents financial proof.

GET /admin/refund-reviews/provider-evidence?afterId=0 lists up to100 unresolved receipts. POST /admin/refund-reviews/provider-evidence/:id/replay requires `{reason}` and Idempotency-Key. It records the active ADMIN and request before replaying existing signature-verified evidence; there are no provider calls or caller-supplied financial facts. This recovery may finalize accounting only through the existing validated webhook finalizer, not an administrative financial override. Ordinary incomplete receipts may be corroborated by later immutable terminal proof; contradictory or unbound identities remain held. Historical-attempt evidence is held against its owning order but never booked against a newer attempt automatically.

Evidence journal and resolution audit are append-only. Repeated normalized evidence does not reopen an explained review; fresh conflicting evidence increments revision and reopens. Exact request replay returns the original audit result, never clears a later review. Financial capacity, principal, identities and stock are untouched by review resolution. Late POST/GET validation conflicts must survive terminal finalization.

## Contract changes

* Every POST /orders requires an Idempotency-Key. Delivery must resolve to GB.
* POST /orders/:id/payments requires reason and evidenceReference (bank receipt), active ADMIN and explicit actor audit. Not for Stripe/PayPal repairs.
* DELETE /users/me requires `{password}`. Wrong/missing password returns403 REAUTHENTICATION_REQUIRED.
* POST /users/me/password: `{currentPassword,newPassword}`;204 revokes all existing sessions/access credentials. Log in again.
* PATCH /users/me/email accepts password for verified customers. Replacement email must be verified; verified users must log in again.
* POST /admin/orders/:orderId/request-paid-cancellation: `{reason}`, Idempotency-Key. This audited intent fences dispatch before any refund operation. The operator then uses the existing refund API with an explicitly chosen amount. No automatic provider call or shipping refund allocation. An accepted intent remains a hold until completion.
* POST /admin/orders/:orderId/cancel-refunded: `{reason}`, Idempotency-Key; only fully refunded, confirmed, unshipped NEW orders with no return/review ambiguity.
* FBA responses include actual quantity, appliedQuantity and shortfall. Duplicate shipment/listing under a new key is409.

## Deployment and operational checklist

1. Owner decisions: F8/F15 confirmed in this session (preserve reservations with discrepancy; importer-only purchases). Still required: manual bank-payment approval policy; data/evidence retention; financial correction escalation. No policy silently inferred.
2. Back up and verify point-in-time restore. Read-only audit duplicate shipment/listing pairs; migration intentionally fails on duplicates. Never delete financial history to make it pass.
3. Stop old writers. Run one migration task using a separate DDL role and immutable release image. Five-second DDL lock timeout; transaction rollback is safe. Retry only after inspecting blockers and migration status. Application rollback to pre-safety code is unsupported; disable writes instead.
4. Runtime database role: required SELECT/INSERT/UPDATE and sequences, no DDL, trigger disabling or TRUNCATE. Grant SELECT/INSERT only on OperationalAudit, FbaOutbound and InventoryMovement; revoke UPDATE/DELETE on those append-only ledgers. Do not use the RDS master/schema-owner credentials for API tasks. Bootstrap uses a one-off authorized role/task; never public HTTP. Invoke `node dist/scripts/bootstrapAdmin.js <verified-user-id> "<audit reason>" "<operator/task reference>"`. Re-login is mandatory after promotion; pre-promotion tokens are revoked. Restrict DB ingress to service security groups; private subnets, TLS and encrypted storage/backups.
5. Secrets Manager injection: database URL, random >=32-byte JWT, abuse HMAC, provider secrets. ECS execution role can read only named secret ARNs and pull the image/write logs. Task role grants only configured sender SES operations, with separate email activation. Never bake .env or AWS files into images.
6. Configure FRONTEND_URL, CORS_ALLOWED_ORIGINS, SES sender, PAYMENT_RESOLUTION_ENABLED=true and trusted ALB proxy CIDRs. Set DEPLOYMENT_ENVIRONMENT explicitly: staging accepts only test-mode provider credentials/endpoints while retaining production runtime hardening; production rejects test credentials/sandbox when a provider is configured. Explicitly configure provider environment and mode. Provider initiation stays default-off. Radar/3DS/PayPal controls, webhook subscriptions and signed sandbox acceptance are manual prerequisites, not claimed enabled here.
7. API tasks set BACKGROUND_WORKERS_ENABLED=false. Separate worker-capable service sets true; database leases/locks/idempotency remain authoritative across replicas. Worker failure alarms and stale-job monitoring required. Do not deploy API-only without workers: expiry/recovery require them.
8. ALB readiness /ready; liveness /health. SIGTERM drains HTTP/active workers within25s (ECS stopTimeout30s). Readiness DB outage returns503. Test actual target deregistration and in-flight requests in staging.
9. CloudWatch alarms: unresolved refund/dispute receipt age/count, review backlog, reconciliation failures, outbox UNKNOWN, database connectivity, worker lag, API5xx, inventory shortfalls. Sanitize logs; approve retention. Alarm delivery/IAM/backups require real infrastructure review.
10. Docker/ECS templates are unexecuted until owner-approved isolated packaging/staging validation. No deployment, real email or payment has been performed. No production-readiness claim.

Provider contracts checked against https://docs.stripe.com/api/events/types and https://docs.stripe.com/api/disputes and https://developer.paypal.com/api/payments/v2/captures-refund . Dispute name alone never changes a financial outcome.

## Finding-to-code-to-test index

All paths below are relative to this repository. Tests use only disposable PostgreSQL and injected providers.

|ID|Code / artefacts|Regression evidence|
|---|---|---|
|F1|src/domain/refunds/refundWebhookService.ts; src/domain/fulfilment/fulfilmentService.ts|productionAudit.integration.test.ts; refundProviderSafety.integration.test.ts|
|F2|src/app.ts; src/config/production.ts|productionConfig.test.ts; productionAudit.integration.test.ts|
|F3|Dockerfile; Dockerfile.migrations; infra/ecs-task.template.json; .github/workflows/backend.yml|Build/typecheck/schema/migration/full-suite checks; actual AWS/Docker acceptance remains operational|
|F4|src/config/index.ts; src/config/production.ts|productionConfig.test.ts; paymentAbuseRemediation.integration.test.ts; testEnvironment.test.ts|
|F5|src/domain/payments/paymentService.ts; src/controllers/payments.ts|productionAudit.integration.test.ts; payment.test.ts; payment.integration.test.ts|
|F6|src/domain/orders/orderConfirmationService.ts; existing expiry sweep|productionAudit.integration.test.ts; orderConfirmation.test.ts; orderExpiry.test.ts; paymentResolutionRuntime.integration.test.ts|
|F7|src/domain/inventory/fbaOutboundService.ts; new migration|productionAudit.integration.test.ts; fbaOutbound.integration.test.ts; productionAuditMigration.integration.test.ts|
|F8|src/domain/inventory/inventoryDiscrepancy.ts; inventoryAdjustmentService.ts; order/fulfilment guards|productionAudit.integration.test.ts; fbaOutbound.integration.test.ts; inventoryAdjustment.integration.test.ts|
|F9|src/controllers/stripeWebhookController.ts; src/domain/payments/stripeDisputeService.ts|productionAudit.integration.test.ts; existing signed-webhook/payment tests|
|F10|src/domain/orders/paidCancellation.ts; src/routes/adminOrders.ts|productionAudit.integration.test.ts; paymentSafeCancellationExpiry.integration.test.ts; returnInventorySafety.integration.test.ts|
|F11|src/domain/orders/orderValidator.ts; orderService.ts|productionConfig.test.ts; addressCountryCode.integration.test.ts; orderCreation.integration.test.ts|
|F12|src/controllers/accountDeletionController.ts; src/domain/auth/reauthentication.ts|productionAudit.integration.test.ts; accountDeletionHttp.integration.test.ts; accountDeletion.test.ts|
|F13|src/index.ts; src/app.ts; worker stop callbacks|productionAudit.integration.test.ts; productionLifecycle.integration.test.ts; existing resolution concurrency tests|
|F14|src/domain/auth/adminBootstrap.ts; src/scripts/bootstrapAdmin.ts|productionAuditMigration.integration.test.ts (real PostgreSQL concurrency, verification, token invalidation and audit)|
|F15|Existing importer-only purchase services/controllers preserved by owner decision|Existing purchase ownership/authorization tests|
|F16|src/app.ts|productionAudit.integration.test.ts|
|F17|src/controllers/products.ts; src/domain/products/productCatalogueService.ts|productCatalogue.integration.test.ts; productPublication.integration.test.ts|
|F18|src/utils/operationalLog.ts; HTTP/domain logging boundaries|operationalLog.test.ts; existing HTTP failures; sanitized JSON parser error handler|
|F19|src/controllers/passwordChange.ts; src/domain/auth/emailChangeService.ts; src/routes/users.ts|productionAudit.integration.test.ts; existing email-change/password-reset/refresh tests|
|F20|src/controllers/orders.ts|productionAudit.integration.test.ts; existing idempotency/concurrency/payment-window tests|

Audit table workflow completeness notes: customer self-service returns and ongoing role-management policy were not individual defects F1–F20. Existing ADMIN return operations remain supported. The first-admin CLI has no force/escalation override; additional role-management policy requires separate approval. Legal retention, actual AWS resources and provider Dashboard configuration remain human operational prerequisites, not inferred code facts.


## Migration and schema notes

* `20261025120000_production_audit`: FBA actual/applied/shortfall and unique shipment/listing identity; nullable provider-origin refund actor; refund review revisions; immutable operational audit and terminal identity guards.
* `20261025121000_audit_lookup_indexes`: bounded indexed lookup support for order holds and FBA discrepancies.
* Prisma declarations now explicitly match seven existing `ON UPDATE NO ACTION` foreign keys (cart provenance/allocation and confirmation/invoice records). These existing constraints are NOT altered or recreated.
* Existing duplicate shipment/listing pairs intentionally block the unique index migration. Run the documented read-only preflight, retain both historical movements, and obtain an approved reconciliation plan. Never delete evidence or replay a shipment to make migration pass.
* Physical FBA actualQuantity is the reported movement; InventoryMovement.quantityChange is the applied book-stock deduction. The shortfall bridges them explicitly. Book stock never becomes negative or falls below unchanged reservations. A shortage blocks new reservations, confirmation and fulfilment until an explicit ADMIN stocktake with a reason proves sufficient physical units. A count below reservations cannot clear the discrepancy; no reservation is silently removed.
* Provider risk holds (including PayPal risk reviews) are independent of operational acknowledgements. Opposite terminal refund proof, missing IDs, exhausted recovery budgets, old-attempt refunds and provider dispute clearance require approved financial investigation/correction; this release provides no force-clear or counter-reset shortcut.

## AWS acceptance and operating procedures (not applied)

The execution-role and runtime-role policies are separate templates under infra/. Sending actions are scoped to the approved SES identity and From address. The three readiness reads are action-limited account reads. Execution permissions are limited to the image repository, precreated log group and named injected secrets. Remove the KMS statement if no customer-managed key is used; otherwise scope it and its encryption-context conditions with the infrastructure owner. Migration/bootstrap tasks use a separately authorized database role and have no SES sending permissions. No AWS permission, network or provider control is asserted active.

References: [ECS execution roles](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task_execution_IAM_role.html), [SES IAM permissions](https://docs.aws.amazon.com/ses/latest/dg/control-user-access.html), [SES authorization actions](https://docs.aws.amazon.com/service-authorization/latest/reference/list_amazonses.html).

Suggested initial staging alert criteria, requiring owner tuning before production:

* Any new inventory discrepancy, provider financial conflict or UNKNOWN email acceptance: create an operator incident. Never release a hold because an alert ages.
* Unprocessed verified receipt or OPEN financial review older than5minutes: escalate. Monitor uncorrelated receipts too, since no order can be held safely without a trusted binding.
* Worker last-success more than two polling intervals plus60seconds: alert. Readiness failures over60seconds or API5xx over5% for5minutes: page.
* Database connection utilization above80% for5minutes: warn. Missing backup success for24hours or no restore drill within30days: alert.

Backups: enable encrypted RDS automated backups/PITR and deletion protection before launch; owner must approve retention and RPO/RTO. Restore into an isolated database for drills, verify schema/evidence/invoice hashes and hold states, and never replay provider mutations or email UNKNOWN jobs as part of a restore. Use separate staging/test resources and identities; authentication email sending in non-test deployments still requires a reviewed SES recipient/sender policy or capture arrangement.

Migration preflight is read-only; execute only against an owner-approved target with a read-only role:

```sql
BEGIN READ ONLY;
SELECT f."shipmentReference", m."listingId", count(*)
FROM "FbaOutbound" f JOIN "InventoryMovement" m ON m.id=f."movementId"
GROUP BY f."shipmentReference",m."listingId" HAVING count(*)>1;
SELECT o.id FROM "Order" o WHERE o.status='CONFIRMED'
AND NOT EXISTS (SELECT 1 FROM "Payment" p WHERE p."orderId"=o.id AND p.status='SUCCEEDED' AND p."paidAt" IS NOT NULL);
SELECT id,"paymentId",status,"resolutionCode" FROM "Refund" WHERE "reviewRequired" OR status='PROCESSING';
COMMIT;
```

Do not repair findings by deleting movements, fabricating provider proof or backdating an actor. Historical manual bank payments without audit evidence need owner verification before fulfilment; use the existing audited security hold to pause individual orders during investigation. External refunds colliding with an uncertain local reservation remain held until the original refund is independently finalized, then the retained external receipt can be replayed. A refund from an old provider attempt is never silently charged against the current attempt's accounting.

Release sequence: immutable image builds → CI/disposable migration tests → read-only preflight/backup verification → disable old writers → one migration task → verify both migrations and schema → start API tasks → start supervised workers → isolated signed-provider staging acceptance → owner-controlled initiation/email activation. Ensure Stripe subscription coverage includes disputes and refunds; no Dashboard changes are made here. Keep PayPal customer initiation disabled. Do not deploy incomplete environment templates.

Rollback: stop new initiation and writes, retain webhooks/reconciliation and financial holds, and roll forward or use the current compatible binary. Never downgrade to pre-audit binaries that bypass the review/FBA fences; never drop audit/evidence tables or migration records. An ECS termination after the drain deadline may leave durable leases/UNKNOWN outcomes for established recovery; it must not trigger a blind financial or email retry.

## Final validation and independent-review handoff

Final full backend suite: **1,943 passed, 0 failed, 3 skipped** (1,946 tests). The three skips require real Stripe sandbox/payment/webhook access and were intentionally not executed. Final focused regression run: **181 passed, 0 failed, 0 skipped**. TypeScript build and no-emit typecheck passed; Prisma schema validation passed; all **71 migrations**, including the two additive audit migrations, applied to disposable PostgreSQL 16 and the schema drift diff was empty. Git whitespace checks and credential-pattern inspection passed. No lint script/tool is configured. No real provider operations or emails were performed.

Docker/ECS/IAM and CI templates were statically inspected, including JSON/YAML parsing; container builds, AWS provisioning and staging provider acceptance remain outstanding. This is not a production-readiness certification.

Independent review should concentrate on refund evidence provenance and revision-safe resolution, historical provider-attempt fences, paid cancellation before dispatch, FBA shortage/reservation preservation, and startup/drain behavior. The F1–F20 matrix and exact file manifest accompany this handoff. The owner explicitly retained importer-only purchase access (F15). No production migration, deployment, Dashboard change or activation was performed.
