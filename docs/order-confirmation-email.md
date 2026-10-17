# Issue #180: transactional emails and commercial invoices

## Status and activation controls

**NOT DEPLOYED. No new production email sending is enabled automatically.**
All validation uses synthetic identities/branding, disposable PostgreSQL, capture
transports and local SES mocks. No real emails or live payments were initiated.

The new mechanisms have independent controls:

| Control | Default | Meaning |
|---|---|---|
| ORDER_CONFIRMATION_EMAIL_ENABLED | false | Enable durable paid-order/invoice delivery. |
| DISPATCH_CONFIRMATION_EMAIL_ENABLED | false | Route NEW dispatches to the durable branded sender instead of the existing best-effort sender. |
| ORDER_CONFIRMATION_EMAIL_ACTIVE_FROM | unset | Fixed approved cutoff for durable order/invoice jobs. |
| DISPATCH_CONFIRMATION_EMAIL_ACTIVE_FROM | unset | Separate fixed approved cutoff for durable dispatch jobs. |

Both cutoffs must be valid UTC ISO timestamps no later than this process's
configuration load time. Global configuration keeps these values as raw strings;
missing, malformed or future cutoffs NEVER terminate the API. Only the affected email
worker pauses before provider checks or job claims, with a sanitized warning naming
the email type and asking operators to correct configuration and restart.

Configuration is loaded once; no live reload is supported. Correct the value and
restart the process, then required configuration/SES readiness must pass before work
resumes. The load-time epoch is fixed: a future cutoff does NOT become active merely
because time passes in the running process. A restart takes a new snapshot, so operators
must review flags/cutoffs before restarting. Schema incompatibility remains fatal;
SES outages remain nonfatal and independently recoverable.
Sending flags are not SES readiness indicators. A failed readiness probe pauses the
respective durable worker without blocking checkout, reconciliation, webhooks or API
startup. A disabled durable order worker still captures new verified confirmations.

**Dispatch false does NOT mean no dispatch notification.** The existing plain-text,
best-effort SES sender remains active for newly committed dispatches until the owner
explicitly activates durable dispatch. It uses the existing SES_FROM_EMAIL and existing
notification wording, without requiring the new business bundle. Its existing lack of
automatic durable retry/branding/monitored Reply-To remains a compatibility limitation.
The new durable sender adds those features only after approved activation.

## Dispatch transition and rollback

`fulfilmentService.recordDispatch` creates Shipment + DISPATCHED audit event + email
routing record atomically. Both dispatch APIs use it. At that moment, the dispatch
flag records immutable `deliveryRoute`: LEGACY or DURABLE. Routing never changes
because flags or readiness change later. Event keys are `shipment:<id>`; uniqueness
prevents duplicate jobs. Current fulfilment supports one full-order shipment only.
Partial shipments/multiple parcels require separate domain/item-snapshot work.

- Before activation: the post-commit `notifyLegacyDispatch` handoff makes one
  best-effort attempt for a LEGACY routing record. It uses a database claim under the
  Order lock and rechecks account deletion/order state. Concurrent/repeated handoffs
  cannot send twice. This helper is called by both committed dispatch service wrappers,
  never inside the dispatch transaction. Failed dispatch/rollback sends nothing.
- After activation: NEW dispatches are DURABLE and do not invoke the legacy sender.
  The shared worker claims only DURABLE rows, using the branded HTML/text template.
- Configuration rollback: disable only DISPATCH_CONFIRMATION_EMAIL_ENABLED. NEW
  dispatches use LEGACY again. Existing DURABLE jobs remain durable and paused; they
  never fall back to legacy, including UNKNOWN jobs. Resume those jobs by restoring
  the durable flag after repair/review. Previously sent legacy records are never
  picked up by the durable worker, even after activation.

For a future authorized transition, first verify the target/schema and approved
company/SES configuration, choose a fixed non-future dispatch cutoff, drain old
workers/processes and explicitly change the flag. Keep the cutoff fixed across
restarts. During rollback, drain/stop the old durable workers before restarting with
the dispatch flag false; in-flight acceptance uncertainty remains UNKNOWN. Do not
rewrite routing records, reset SENT/UNKNOWN tasks, drop migrations or retroactively
create dispatch jobs. Rollback to pre-Issue-180 application code is unsupported because it loses new
payment/invoice capture guarantees; the supported rollback is configuration-only.

Legacy post-commit delivery is still best-effort: a process crash before the handoff
can leave its routing record pending, and no automatic legacy retry is introduced.
Failure/uncertainty is recorded for operator review. SDK hidden retries are disabled.
The real legacy sender is refused under NODE_ENV=test; rollout tests inject capture
callbacks. No production sending configuration was changed in this worktree.

## Invoice obligation and status-aware delivery

Verified Stripe or bound PayPal capture success actually taking PENDING → CONFIRMED captures exactly one
ORDER_CONFIRMATION task inside the existing payment transaction. Signed webhooks,
receipt replay, recovery and managed retrieval share this trusted path. Re-observing
historical confirmed success creates no job. Ownership, amount/currency/correlation,
reservation, inventory and admission rules are unchanged; MANAGED coverage must be
CONSUMED. Unpaid, paid-but-unconfirmed, cancelled/expired and returned orders do not
get ordinary confirmation tasks.

The task is also the immutable invoice-delivery obligation. **Dispatch does not
suppress or discard it.** Eligible paid CONFIRMED, DISPATCHED and COMPLETED orders
can issue/deliver the same commercial invoice:

- CONFIRMED: normal order confirmation, with the future dispatch notification.
- DISPATCHED: status-aware invoice delivery stating payment received and already
  dispatched; no future dispatch promise.
- COMPLETED: invoice delivery stating payment received and order completed; no
  delivery-date claim or future dispatch promise.

The worker builds the presentation from current backend state, then checks that state
again under the Order lock before committing send-start. A presentation change causes
RETRY/ORDER_PRESENTATION_CHANGED without sending stale wording. It does not alter the
financial snapshot, invoice date/number or PDF bytes. Dispatch emails never attach
another invoice. An already SENT invoice task creates no new delivery on dispatch.

SES readiness outages leave tasks unclaimed. Definite provider rejection can retry
the same task/PDF after dispatch; ambiguous acceptance becomes UNKNOWN and does not
automatically resend. Explicit operator acknowledgement is required for an UNKNOWN
resend, which may duplicate an externally accepted email but never another invoice
or payment. Tests cover a signed webhook while SES is unavailable, early dispatch,
readiness recovery, delayed retry, duplicate events and identical attachment bytes.

An order/invoice job before its approved cutoff is BLOCKED/BEFORE_ACTIVATION_CUTOFF,
not silently lost. After a separately approved per-order backlog review, internal
`requeueConfirmation(jobId, acknowledgeUnknown, true)` records a one-write immutable
backlogApprovedAt and authorizes that invoice only, without moving the global cutoff.
This approval cannot apply to dispatch jobs or bypass payment/data/deletion checks.
An earlier Issue #180 stale-suppressed invoice can also be explicitly requeued if its
diagnostic is CONFIRMATION_SUPERSEDED_BY_DISPATCH. No automatic migration backfill or
HTTP recovery endpoint is provided. Record operator, reason, job ID and duplicate-risk
acknowledgement in the approved operational audit procedure.

Manual/admin confirmation missing a task can use internal
`recoverOrderConfirmation(orderId, true)` only after explicit historical review. It
locks Order, requires settled Stripe or capture-bound PayPal payment and eligible order/managed state, then
captures one source or returns the existing job. It never overwrites an immutable
incomplete snapshot. Correcting historical financial data needs a separately reviewed
procedure, not guessed prices or snapshot edits.

## Recipient policy and deletion

The order/invoice recipient is the verified, non-deleted account email at the verified
confirmation transaction (or explicit operator recovery). Dispatch recipient is the
account email at the committed shipment; durable dispatch requires verified email.
Legacy routing preserves the old sender's policy of using the account email without
adding a verification prerequisite. The legacy template does not capture a delivery
offer it never displayed. First name is optional and missing names use “Hello,”.

These recipient addresses are immutable event snapshots, not live profile lookups.
Later profile/email changes do not silently redirect historical invoices or queued
shipment notifications. Both durable retries and the legacy handoff use that recorded
recipient. Owner approval of this policy is required: delivery can reach a previously
owned mailbox after an email change. A different-recipient resend requires a separately
approved procedure; no endpoint or automatic substitution is implemented.

Deletion overrides all routes. Deleted accounts create suppressed/no-recipient tasks,
and pending delivery rechecks deletedAt immediately before sending. ACCOUNT_DELETED
suppresses delivery to the original or tombstoned mailbox. Issued invoice records are
retained; no blind accounting-record deletion or unapproved PII purge occurs. Optional
empty address lines/counties/names normalize to null. Owner-approved retention, access
controls and privacy/accounting policy remain activation prerequisites.

## Financial and shipping dependencies

Issue #182 implements explicit checkout shipping selection and server pricing; see
[checkout-shipping.md](checkout-shipping.md) for the API and coordinated frontend
rollout. actualShippingCost remains the seller's expense, not a customer charge.
New checkout orders atomically persist the existing handoff:

```ts
Order.confirmationDeliverySnapshot = {
  method: string, chargePence: number, minWorkingDays: number,
  maxWorkingDays: number, estimatesFrom: "DISPATCH"
}
```

STANDARD is £3.99 with 3–5 working days after dispatch; EXPRESS is £7.99 with
1–3 working days after dispatch. No implicit default or guaranteed arrival date.
Line amounts, subtotal, delivery charge, order total and verified GBP payment must
exactly reconcile. Historical rows without the handoff remain unknown and their
immutable tasks remain blocked with SHIPPING_NOT_PERSISTED; no backfill is performed.
Older synthetic invoice fixtures intentionally retain their frozen estimates.
New order items preserve description/set
number alongside existing price/condition snapshots; current catalogue data is never
substituted for missing historical descriptions.

Dispatch can accurately report actual persisted carrier/tracking without any invoice
or delivery-offer snapshot. Service/estimates appear only with a valid persisted
offer. Tracking links use only the existing trusted carrier mappings and valid
normalized numbers; arbitrary supplied URLs are not accepted as links. Missing
tracking is stated honestly. No arrival dates or partial shipment claims are invented.

## Approved company bundle and issuance semantics

ORDER_CONFIRMATION_BUSINESS_JSON is unset by default. The validated approval bundle
requires approved:true, legalName:"Colorful Life Ltd", verified registrationNumber,
registeredAddress lines, fromEmail, monitored replyToEmail/replyToMonitored:true,
retentionPolicy and approved invoicePrefix/numberDigits. Since Issue #185 the Build & Bloom
artwork and palette are versioned in the repository; the legacy primaryColor, accentColor
and logo fields are optional and still validated when present. The same monitored
replyToEmail is the Reply-To for account verification emails. No real legal details or
business approval is supplied by the repository; they belong to environment configuration.
No VAT number/amount is accepted.

Invoice financial/customer data is frozen at confirmation. **Number allocation and
invoice date are actual UTC issuance time when complete data is approved**, not a
backdated payment date. purchase.paidAt is separate and shown in the PDF. The global
PostgreSQL sequence can have gaps on rollback. Numbers are stable and never derived
from counts. Owner/accountant approval of numbering, issue-date semantics, company
identity, retention, monitored mailbox and branding is required before activation.

Invoice JSON/number/date cannot change; PDF bytes/SHA-256 can be populated once and
never replaced. Issued invoice deletion and cascading order deletion are protected.
Cached PDFs remain identical even when later email wording changes with order status.
The shared OrderConfirmationJob table retains its existing name and now includes
immutable type/event/routing/source and one-write dispatch branding/backlog approval.
The confirmation source.orderId must equal its job orderId at the database boundary.

## Build & Bloom configuration (Issue #185)

Business details are environment configuration (`ORDER_CONFIRMATION_BUSINESS_JSON`), never
source code. In addition to the fields above, the optional `registeredIn` (e.g. "England and
Wales") supplies the place of registration. Every customer email footer shows the UK trading
disclosures built from this configuration: legal name, place of registration, company number
and registered office. Account verification emails use the same configured identity and
monitored `replyToEmail` (only when `replyToMonitored` is `true`), without requiring the
invoice-only fields.

**Invoice numbering.** Numbers are `{invoicePrefix}-{sequence}` with the sequence value
zero-padded to `numberDigits`, allocated from the single global PostgreSQL sequence
`commercial_invoice_number_seq` inside the issuing transaction. Migration
`20261021120000_invoice_number_start` advances the sequence to the owner-approved first value
102801 only if it is still below it (it never resets or rewinds a live sequence and creates no
invoices), so with prefix `BB` and 8 digits the first invoice is `BB-00102801`, then
`BB-00102802`, and so on. It first takes a conflicting lock on the sequence (a no-op `ALTER SEQUENCE`),
so invoice issuing may stay active during the deploy: concurrent `nextval()` calls wait for it and
never receive a reused or lower number. It fails after a 10 s lock timeout rather than queueing
behind a long transaction, and is safe to re-run. `invoiceNumber` is unique, the snapshot must repeat it, and
immutability triggers prevent later edits. The sequence is never reset, gaps are possible after
rollbacks, and values above the padded width simply grow longer. Changing the prefix later does
not renumber issued invoices, which keep the number recorded in their snapshot.

**Record retention.** `retentionPolicy` records the approved policy statement; it is a governance
attestation and is not printed on emails or invoices. Nothing in the application deletes invoices,
orders or payment records automatically (issued invoices are deletion-protected). Different record
categories have different legal bases and periods, for example:

- Accounting records: a private company must keep them for at least 3 years from when they are
  made (Companies Act 2006, s.388).
- Corporation Tax records (invoices, orders, payments, refunds): HMRC generally requires
  6 years from the end of the accounting period, and longer in some cases (e.g. open enquiries
  or late returns).
- Customer personal data that is not needed for those records: kept only as long as necessary
  (UK GDPR storage limitation), to be defined in the privacy policy.

The longest applicable period governs records that serve several purposes. This summary is not
legal advice; the owner or accountant approves the final statement.

## Templates, PDF and MIME

Pure typed templates are independent of SES, with HTML/plain-text versions, escaped
customer content, responsive max-600px tables, inline CSS, system fonts and descriptive
CID Build & Bloom artwork. They use no scripts, remote CSS/images/fonts, tracking pixels or marketing.
Dispatch and status-aware invoice presentation reuse the approved branding.

PDFKit creates A4 commercial invoices with actual persisted GBP paid amounts and
addresses. Bundled DejaVu Sans/fontkit refuse unsupported glyphs (FONT_COVERAGE) rather
than corrupt names; missing/corrupt assets produce FONT_ASSET_UNAVAILABLE. Deploy
assets/fonts with dist, including licence and AUTHORS; nothing downloads fonts at
runtime. Broader Unicode coverage requires an approved font. PDF/A is not claimed.
The PDF includes the exact statement:

> Colorful Life Ltd is not VAT registered. No VAT has been charged. This document is a commercial invoice, not a VAT invoice.

Nodemailer stream transport composes MIME only. File/URL loading is disabled. Durable
messages include HTML/text, embedded artwork and monitored Reply-To. Only invoice delivery attaches
the cached PDF (maximum 3 MB); raw MIME maximum is 9 MB, below SES classic's 10 MB.
Real SES is refused in tests, including when flags are enabled.

## Nonfatal SES readiness and durable worker

`index.ts` awaits a database-only `assertEmailStartupReady` before listening. Missing
required outbox/invoice tables, columns, sequence, unique event indexes, immutable
triggers or validated source/routing constraints are fatal even when sending is off.
Schema errors are never swallowed in payment/dispatch capture transactions.

After the API begins starting, each enabled durable email type has an asynchronous
readiness gate. A probe validates its cutoff/business configuration (and order-invoice
font), credentials, account sending status, regional quota and verified sender/domain
using read-only SES operations. The total worker probe deadline is 10 seconds; failed
probes emit only a sanitized operational warning and pause that type. The normal
five-second worker tick retries readiness after 30 seconds. Recovered readiness resumes
queued work after a transient SES outage; no operator restart is required for provider
recovery. Correcting environment-based cutoff configuration DOES require a restart. Late probe results cannot start sending
after a timed-out probe. Order and dispatch flags remain independent.

Tests inject SES/readiness clients, including outages/timeouts/recovery; no AWS calls
occur. Real SES identity/quota checks do not prove SendRawEmail IAM permission, inbox
monitoring, sandbox-recipient permissions or actual delivery. Production access, IAM,
SPF/DKIM/DMARC, quotas, region, bounce/complaint monitoring and mailbox ownership need
separate operational approval. Provider acceptance is not inbox delivery.

The shared worker claims only DURABLE rows of enabled types, at most 25 per batch,
with DB time, row locks/SKIP LOCKED, two-minute leases and owner/generation fencing.
It holds Order → dependent-row locks with NO KEY UPDATE compatibility, never during
network/PDF I/O. Lost leases exit without being mislabeled as ineligible orders.

- PENDING → PROCESSING → SENT records provider acceptance/time.
- Definite throttle/credential/DNS/refused-connection failure → bounded RETRY.
- Permanent rejection or eight failed attempts → FAILED.
- Missing/inconsistent purchase/company/font or unapproved invoice backlog → BLOCKED.
- Deleted/ineligible/stale dispatch → SUPPRESSED.
- Timeout/reset/abort/lost acknowledgement/possible acceptance → UNKNOWN; no auto-resend.

Expired preparation leases can recover; expired potentially-sent leases become UNKNOWN.
SDK hidden retries are disabled. Callback generation checks prevent stale updates.
Readiness failures do not claim tasks or consume their attempts. Explicit internal
requeue requires review; UNKNOWN additionally requires duplicate-risk acknowledgement.
LEGACY routing is never converted into durable work by requeue or flag changes.

Monitor per-type due/oldest age, paused readiness, failed/blocked/unknown counts and
lease recovery. Log IDs/error codes only, never addresses, MIME, invoices, raw provider
errors or credentials. Existing verification/password-reset senders are unchanged.
The worker stop helper drains known work, but global server graceful shutdown is not
yet orchestrated. Leases conservatively handle process loss.

A state/account change after final committed checks can race acceptance, and accepted
mail cannot be recalled. Exactly-once external delivery is not promised; reviewed
UNKNOWN resend can duplicate an email, never an invoice or charge. Bounded logo bytes
are intentionally duplicated per immutable branding snapshot rather than introducing
an asset store. These operational/privacy/storage risks require owner acceptance.

## Migration and release sequence

No deployment is authorized by this document. Future authorized release order:

1. Verify the target, drain incompatible processes and preserve routing records.
2. Apply/verify Issue #180 migrations BEFORE starting this backend version.
3. Verify packaged fonts and start with new durable flags false: legacy dispatch
   remains available and order/invoice capture remains durable.
4. Validate approved data/company/SES configuration and review per-type backlog.
5. Explicitly approve fixed non-future cutoffs and independently activate new senders.

Existing migrations were NOT consolidated/re-written: they have already been applied
in isolated review databases. A new additive migration preserves history/checksums:

- 20261020120000_order_confirmation_outbox: purchase fields, job/invoice tables,
  sequence, immutable source/invoice/PDF rules.
- 20261020130000_dispatch_email_outbox: type/event/shipment keys, per-shipment
  idempotency, one-write dispatch branding; no historical shipment backfill.
- 20261020140000_email_rollout_integrity: immutable deliveryRoute (existing rows stay
  DURABLE), one-write backlogApprovedAt, validated confirmation source/order identity.

If an existing malformed confirmation source fails the new constraint, migration
rolls back atomically; investigate rather than fabricate/overwrite historical data.
Rollback/upgrade tests prove preservation and no automatic emails. No production
migration or configuration operation was performed.

## Final remediation evidence

| Requested fix | Result and regression evidence |
|---|---|
| Dispatch rollout preservation | FIXED: immutable LEGACY/DURABLE routing, independent flags, post-commit legacy handoff; before/after/rollback, concurrent requests, unknown acceptance and no dual delivery tests. |
| SES must not block API startup | FIXED: schema-only fatal gate, async bounded readiness/retry, sanitized warnings; HTTP health and signed payment webhook during outage, then recovery. |
| Invoice after early dispatch | FIXED: same job/PDF with current status wording; outage, retry, early dispatch, duplicate event, UNKNOWN recovery and backlog-review tests. |
| Synthetic Stripe configuration | FIXED: signed-webhook tests set/restore both fake secret key and webhook secret, and pass with ambient keys removed. |
| Future cutoffs | FIXED: worker-local ISO/load-time validation pauses only the affected type without exiting the API, claiming jobs or automatically maturing a future value. Configuration correction requires restart. |
| Recipient snapshot policy | FIXED: documented event-time policy, changed-address tests for durable/legacy delivery and deleted-account overrides. Owner policy approval remains required. |
| Source/job order integrity | FIXED: validated DB constraint plus insertion/migration rollback tests. |
| Optional migration consolidation | Reviewed: preserve prior applied migrations; use an additive migration instead. |

Prior first-review fixes remain: no automatic historical capture, explicit manual
recovery, optional empty-address normalization, missing-font diagnostics/AUTHORS,
lease fencing and immutable financial records. Stale confirmation suppression is now
superseded by status-aware invoice delivery so accounting obligations survive dispatch.

Final focused run: **150 passed, 0 failed, 0 skipped**, with ambient Stripe keys removed.
Build and separate no-emit TypeScript checks passed. Final complete backend suite: **1,502 passed, 0 failed, 3 skipped**
(1,505 tests across 127 suites). The three external Stripe sandbox/webhook tests were explicitly disabled.
Prisma validation and migration status passed: all **64 migrations** are applied only
to the disposable database. All migration rollback/upgrade tests passed. Tracked and
untracked text diff checks passed; no lint script is configured. Chromium previews passed all 16
combinations: four presentation types × 320/375/600/900 widths, long escaped text,
embedded-logo decode, no overflow/scripts/external requests; no future dispatch promise
in DISPATCHED/COMPLETED views. Actual Gmail/Outlook/Apple Mail certification remains
outside this isolated run.

Evidence is outside Git at /tmp/colorful-life-issue180-evidence: delivery-focused.log,
delivery-full.log, delivery-build.log, delivery-typecheck.log, final-layout-results.json
and final schema/migration/Git inventories. Tests use only disposable loopback PostgreSQL
127.0.0.1:55480/colorful_life_test, capture email and fake Stripe/SES clients/signatures.
This is isolated application integration, not real Stripe/SES provider E2E.

Independent Claude review: **PASS — Code Acceptance** (owner-reported). The final
cutoff-startup LOW was fixed with five additional regression tests. This is code
acceptance, not production activation. Shipping persistence, company/branding/accounting/retention/recipient
policy/Reply-To approvals and actual SES readiness remain production blockers.
Implementation and validation use the isolated Issue #180 worktree; original main
is untouched. No live email, production migration or deployment occurred. Owner has
separately authorized feature-branch commit/push/PR after successful final validation.

## Exact changed-file inventory

The Issue #180 change consists of these 59 intended files. The generated Prisma TypeScript
follows the repository convention. Fonts/licences are intentional runtime assets.
Compiled output, database files, temporary credentials and local evidence are excluded.

- `.env.example`
- `README.md`
- `assets/fonts/DejaVu-AUTHORS.txt`
- `assets/fonts/DejaVu-LICENSE.txt`
- `assets/fonts/DejaVuSans.ttf`
- `docs/order-confirmation-email.md`
- `package-lock.json`
- `package.json`
- `prisma/migrations/20261020120000_order_confirmation_outbox/migration.sql`
- `prisma/migrations/20261020130000_dispatch_email_outbox/migration.sql`
- `prisma/migrations/20261020140000_email_rollout_integrity/migration.sql`
- `prisma/schema.prisma`
- `src/__tests__/carrierTrackingMigration.integration.test.ts`
- `src/__tests__/dispatchEmail.integration.test.ts`
- `src/__tests__/dispatchEmail.test.ts`
- `src/__tests__/dispatchEmailMigration.integration.test.ts`
- `src/__tests__/emailReadiness.integration.test.ts`
- `src/__tests__/emailRolloutMigration.integration.test.ts`
- `src/__tests__/fixtures/dispatch-confirmation.html`
- `src/__tests__/fixtures/dispatch-confirmation.text`
- `src/__tests__/fixtures/order-confirmation.html`
- `src/__tests__/fixtures/order-confirmation.text`
- `src/__tests__/fixtures/orderConfirmation.fixture.ts`
- `src/__tests__/orderConfirmationEmail.integration.test.ts`
- `src/__tests__/orderConfirmationEmail.test.ts`
- `src/__tests__/orderConfirmationEmailMigration.integration.test.ts`
- `src/__tests__/orderDispatch.integration.test.ts`
- `src/__tests__/orderDispatchNotification.integration.test.ts`
- `src/__tests__/orderFulfilment.integration.test.ts`
- `src/config/index.ts`
- `src/controllers/orders.ts`
- `src/domain/fulfilment/fulfilmentService.ts`
- `src/domain/orderConfirmation/contract.ts`
- `src/domain/orderConfirmation/delivery.ts`
- `src/domain/orderConfirmation/dispatch.ts`
- `src/domain/orderConfirmation/enqueue.ts`
- `src/domain/orderConfirmation/legacyDispatch.ts`
- `src/domain/orderConfirmation/pdf.ts`
- `src/domain/orderConfirmation/readiness.ts`
- `src/domain/orderConfirmation/template.ts`
- `src/domain/orderConfirmation/worker.ts`
- `src/domain/orders/orderDispatchService.ts`
- `src/domain/orders/orderService.ts`
- `src/domain/payments/stripeReconciliationService.ts`
- `src/generated/prisma-client/browser.ts`
- `src/generated/prisma-client/client.ts`
- `src/generated/prisma-client/commonInputTypes.ts`
- `src/generated/prisma-client/internal/class.ts`
- `src/generated/prisma-client/internal/prismaNamespace.ts`
- `src/generated/prisma-client/internal/prismaNamespaceBrowser.ts`
- `src/generated/prisma-client/models.ts`
- `src/generated/prisma-client/models/CommercialInvoice.ts`
- `src/generated/prisma-client/models/Order.ts`
- `src/generated/prisma-client/models/OrderConfirmationJob.ts`
- `src/generated/prisma-client/models/OrderItem.ts`
- `src/generated/prisma-client/models/Shipment.ts`
- `src/index.ts`
- `src/routes/adminOrders.ts`
- `src/services/emailService.ts`


## PayPal verified capture confirmation (PP-1, #187)

Customer PayPal initiation remains disabled, including with credentials configured.
This change completes processing of existing PayPal payments only. The capture API,
verified capture webhook/replay and MANAGED read-only provider resolution converge
on `recordPayPalSuccess` under the Order lock. A completed capture must match the
persisted PayPal order and capture identity, GBP currency, Payment.amount and
Order.totalAmount. Stripe's reconciliation implementation is unchanged.

For PENDING orders with eligible reservation coverage, the shared
`confirmOrderInTransaction` converts reserved inventory, records WEBSITE_SALE and
marks MANAGED reservations CONSUMED. The same transaction then calls
`enqueueOrderConfirmation`; it does not introduce a second invoice/email pipeline.
The shared worker accepts successful capture-bound PayPal payments and retains the
existing source immutability, invoice numbering, PDF cache, deletion, sending
activation and SES acceptance safeguards. Missing historical shipping/product data
still blocks invoice delivery rather than fabricating financial data.

A fulfilment savepoint protects verified financial evidence in both LEGACY and
MANAGED modes: stock conversion failure rolls back all conversion writes, leaves
the order unconfirmed and reservation retained, and records a manual-inventory-
reconciliation diagnostic on the capture/webhook receipt. No invoice job is created.
There is no new automatic stock-remediation or retry policy. Already processed
receipts and successful API replay remain idempotent; operators must review retained
paid-but-unconfirmed exceptions through existing reconciliation procedures.

Late EXPIRED/CANCELLED/RETURNED success retains payment evidence and a diagnostic
without confirming, reacquiring inventory or creating an invoice job. Re-observation
of an already confirmed historical order does not automatically backfill an email.
No migration, provider webhook registration or production activation is required or
performed by this code change. PayPal timeout/release policy and additional webhook
security/events remain outside PP-1.
