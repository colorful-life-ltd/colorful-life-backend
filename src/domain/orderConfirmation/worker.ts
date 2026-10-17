import { isConfirmationPayment } from './verifiedPayment.js';
import { dispatchSchema } from './dispatch.js';
import { createHash, randomUUID } from 'node:crypto';
import type { InvoicePresentation } from './template.js';
import { activationCutoff, emailEnabled, createEmailReadinessTick, checkEmailProviderReady, type EmailType, approvedEmailConfiguration } from './readiness.js';
import { config } from '../../config/index.js';
import { prisma } from '../../prisma/runtime.js';
import type { OrderConfirmationJob, Prisma } from '../../generated/prisma-client/client.js';
import { businessSchema, invoiceSchema, purchaseSchema, type Invoice } from './contract.js';
import { composeConfirmation, composeDispatch, DeliveryRejected, sesConfirmationTransport, type ConfirmationTransport } from './delivery.js';
import { generateInvoicePdf, UnsupportedInvoiceText, InvoiceFontUnavailable } from './pdf.js';

const LEASE_MS = 120_000, MAX_ATTEMPTS = 8;
async function databaseNow(tx: Prisma.TransactionClient) { const [row] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`; return row.now; }
async function owns(tx: Prisma.TransactionClient, claim: OrderConfirmationJob) {
  await tx.$queryRaw`SELECT id FROM "OrderConfirmationJob" WHERE id=${claim.id} FOR UPDATE`;
  const job = await tx.orderConfirmationJob.findUniqueOrThrow({ where: { id: claim.id } });
  return job.state === 'PROCESSING' && job.claimOwner === claim.claimOwner && job.claimGeneration === claim.claimGeneration
    && job.leaseExpiresAt && job.leaseExpiresAt > await databaseNow(tx) ? job : null;
}
async function ineligibleReason(tx: Prisma.TransactionClient, claim: OrderConfirmationJob) {
  const order = await tx.order.findUniqueOrThrow({ where: { id: claim.orderId }, include: { payments: true, paymentResolution: true, user: { select: { deletedAt: true } } } });
  if (order.user.deletedAt) return 'ACCOUNT_DELETED';
  if (claim.type === 'DISPATCH_CONFIRMATION') {
    const parsed = dispatchSchema.safeParse(claim.source);
    if (!parsed.success) return 'DISPATCH_DATA_INVALID';
    if (order.cancelledAt || order.status !== 'DISPATCHED') return 'DISPATCH_SUPERSEDED_BY_ORDER_STATE';
    const p = parsed.data, shipment = await tx.shipment.findUnique({ where: { id: claim.shipmentId ?? -1 }, include: { events: { where: { action: 'DISPATCHED' } } } });
    return shipment && shipment.orderId === claim.orderId && shipment.id === p.shipmentId && shipment.events.length
      && shipment.sequence === p.sequence && shipment.dispatchedAt.toISOString() === p.dispatchedAt && shipment.carrier === p.carrier
      && shipment.carrierName === p.carrierName && (shipment.trackingNumber?.trim() || null) === p.trackingNumber ? null : 'SHIPMENT_DATA_CHANGED';
  }
  if (claim.type !== 'ORDER_CONFIRMATION') return 'UNSUPPORTED_EMAIL_TYPE';
  const source = purchaseSchema.safeParse(claim.source);
  if (!source.success) return 'PURCHASE_DATA_INVALID';
  const p = source.data;
  return !order.cancelledAt && ['CONFIRMED', 'DISPATCHED', 'COMPLETED'].includes(order.status)
    && (!order.paymentResolution || order.paymentResolution.reservationDisposition === 'CONSUMED')
    && order.payments.some(pay => pay.id === p.paymentId && isConfirmationPayment(pay) && pay.currency === 'GBP' && pay.amount.mul(100).equals(p.totalPence)) ? null : 'ORDER_INELIGIBLE';
}

async function settle(claim: OrderConfirmationJob, state: string, diagnostic: string | null = null, messageId?: string) {
  return prisma.$transaction(async tx => {
    if (!await owns(tx, claim)) return false;
    const now = await databaseNow(tx);
    await tx.orderConfirmationJob.update({ where: { id: claim.id }, data: { state, lastErrorCode: diagnostic,
      nextAttemptAt: new Date(now.getTime() + Math.min(3_600_000, 1000 * 2 ** claim.attempts)),
      claimOwner: null, leaseExpiresAt: null, sendStartedAt: null,
      ...(messageId ? { providerMessageId: messageId, sentAt: now } : {}),
    } });
    return true;
  });
}
async function claimNext(jobId: string | undefined, types: EmailType[]) {
  return prisma.$transaction(async tx => {
    const now = await databaseNow(tx);
    // Never automatically resend an expired claim that may have reached SES.
    await tx.orderConfirmationJob.updateMany({ where: { ...(jobId ? { id: jobId } : {}), state: 'PROCESSING', leaseExpiresAt: { lte: now }, sendStartedAt: { not: null } },
      data: { state: 'UNKNOWN', lastErrorCode: 'ACCEPTANCE_UNKNOWN', claimOwner: null, leaseExpiresAt: null } });
    const [row] = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM "OrderConfirmationJob"
      WHERE "deliveryRoute"='DURABLE' AND type=ANY(${types}::text[]) AND (${jobId ?? null}::text IS NULL OR id=${jobId ?? null}) AND ((state IN ('PENDING','RETRY') AND "nextAttemptAt"<=${now})
       OR (state='PROCESSING' AND "leaseExpiresAt"<=${now} AND "sendStartedAt" IS NULL))
      ORDER BY "nextAttemptAt", id FOR UPDATE SKIP LOCKED LIMIT 1`;
    if (!row) return null;
    const job = await tx.orderConfirmationJob.findUniqueOrThrow({ where: { id: row.id } });
    if (job.attempts >= MAX_ATTEMPTS) {
      await tx.orderConfirmationJob.update({ where: { id: row.id }, data: { state: 'FAILED', lastErrorCode: 'ATTEMPTS_EXHAUSTED', claimOwner: null, leaseExpiresAt: null } });
      return null;
    }
    return tx.orderConfirmationJob.update({ where: { id: row.id }, data: { state: 'PROCESSING', attempts: { increment: 1 }, claimOwner: randomUUID(), claimGeneration: { increment: 1 }, leaseExpiresAt: new Date(now.getTime() + LEASE_MS), sendStartedAt: null } });
  });
}
function configuredBusiness() {
  try { return JSON.parse(config.ORDER_CONFIRMATION_BUSINESS_JSON ?? 'null') as unknown; } catch { return null; }
}
async function ensureInvoice(claim: OrderConfirmationJob, business: unknown) {
  return prisma.$transaction(async tx => {
    // Preserve existing Order -> dependent-row lock ordering; no network I/O here.
    await tx.$queryRaw`SELECT id FROM "Order" WHERE id=${claim.orderId} FOR NO KEY UPDATE`;
    if (!await owns(tx, claim) || await ineligibleReason(tx, claim)) return null;
    const existing = await tx.commercialInvoice.findUnique({ where: { orderId: claim.orderId } });
    if (existing) return existing;
    const parsed = businessSchema.safeParse(business);
    if (!parsed.success) return null;
    const [seq] = await tx.$queryRaw<Array<{ number: bigint }>>`SELECT nextval('commercial_invoice_number_seq') AS number`;
    const snapshot = invoiceSchema.parse({ version: 1, invoiceNumber: `${parsed.data.invoicePrefix}-${seq.number.toString().padStart(parsed.data.numberDigits, '0')}`, issuedAt: (await databaseNow(tx)).toISOString(), purchase: claim.source, business: parsed.data });
    return tx.commercialInvoice.create({ data: { orderId: claim.orderId, invoiceNumber: snapshot.invoiceNumber, snapshot: snapshot as Prisma.InputJsonValue } });
  });
}
async function prepareMessage(claim: OrderConfirmationJob, business: unknown): Promise<{ message: Buffer; presentation?: InvoicePresentation } | null> {
  if (claim.type === 'DISPATCH_CONFIRMATION') {
    const brand = await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "Order" WHERE id=${claim.orderId} FOR NO KEY UPDATE`;
      const job = await owns(tx, claim);
      if (!job || await ineligibleReason(tx, claim)) return null;
      if (job.brandSnapshot) return businessSchema.parse(job.brandSnapshot);
      const parsed = businessSchema.safeParse(business); if (!parsed.success) return null;
      await tx.orderConfirmationJob.update({ where: { id: job.id }, data: { brandSnapshot: parsed.data as Prisma.InputJsonValue } });
      return parsed.data;
    });
    return brand ? { message: await composeDispatch(dispatchSchema.parse(claim.source), brand) } : null;
  }
  let invoice = await ensureInvoice(claim, business); if (!invoice) return null;
  const snapshot: Invoice = invoiceSchema.parse(invoice.snapshot);
  if (!invoice.pdfBytes) {
    const pdf = await generateInvoicePdf(snapshot), sha = createHash('sha256').update(pdf).digest('hex');
    await prisma.commercialInvoice.updateMany({ where: { id: invoice.id, pdfBytes: null }, data: { pdfBytes: new Uint8Array(pdf), pdfSha256: sha } });
    invoice = await prisma.commercialInvoice.findUniqueOrThrow({ where: { id: invoice.id } });
  }
  const pdf = Buffer.from(invoice.pdfBytes!);
  if (createHash('sha256').update(pdf).digest('hex') !== invoice.pdfSha256) throw new PdfIntegrityError();
  const order = await prisma.order.findUniqueOrThrow({ where: { id: claim.orderId }, select: { status: true } });
  if (!['CONFIRMED', 'DISPATCHED', 'COMPLETED'].includes(order.status)) return null;
  const presentation = order.status as InvoicePresentation;
  return { message: await composeConfirmation(snapshot, pdf, presentation), presentation };
}
class PdfIntegrityError extends Error {}

export type ConfirmationBatchOptions = { transport?: ConfirmationTransport; business?: unknown; limit?: number; jobId?: string; activeFrom?: Date; types?: EmailType[] };
/** Capture transports may run while production sending is off. No HTTP mutation endpoint is exposed. */
export async function runConfirmationBatch(options: ConfirmationBatchOptions = {}) {
  const transport = options.transport ?? sesConfirmationTransport;
  const allTypes: EmailType[] = ['ORDER_CONFIRMATION', 'DISPATCH_CONFIRMATION'];
  const types = (options.types ?? allTypes).filter(type => transport.kind === 'capture' || emailEnabled(type));
  if (!types.length || transport.kind === 'ses' && process.env.NODE_ENV === 'test') return { processed: 0, disabled: true };
  if (transport.kind === 'ses') for (const type of types) approvedEmailConfiguration(type);
  let processed = 0;
  for (let i = 0; i < Math.min(Math.max(options.limit ?? 10, 1), 25); i++) {
    const claim = await claimNext(options.jobId, types); if (!claim) break;
    processed++;
    let started = false;
    try {
      const parsed = (claim.type === 'DISPATCH_CONFIRMATION' ? dispatchSchema : purchaseSchema).safeParse(claim.source);
      if (!parsed.success) { await settle(claim, 'BLOCKED', claim.type === 'DISPATCH_CONFIRMATION' ? 'DISPATCH_DATA_INVALID' : 'PURCHASE_DATA_INVALID'); continue; }
      const activeFrom = transport.kind === 'capture' ? options.activeFrom ?? new Date(0) : activationCutoff(claim.type as EmailType);
      if (!Number.isFinite(activeFrom.getTime()) || activeFrom.getTime() > Date.now()) throw new Error('Invalid activation cutoff');
      if (claim.createdAt < activeFrom && !(claim.type === 'ORDER_CONFIRMATION' && claim.backlogApprovedAt)) { await settle(claim, claim.type === 'ORDER_CONFIRMATION' ? 'BLOCKED' : 'SUPPRESSED', 'BEFORE_ACTIVATION_CUTOFF'); continue; }
      const reason = await prisma.$transaction(tx => ineligibleReason(tx, claim));
      if (reason) { await settle(claim, 'SUPPRESSED', reason); continue; }
      const prepared = await prepareMessage(claim, options.business ?? configuredBusiness());
      if (!prepared) {
        const reason = await prisma.$transaction(tx => ineligibleReason(tx, claim));
        await settle(claim, reason ? 'SUPPRESSED' : 'BLOCKED', reason ?? 'BUSINESS_NOT_APPROVED');
        continue;
      }
      const maySend = await prisma.$transaction(async tx => {
        await tx.$queryRaw`SELECT id FROM "Order" WHERE id=${claim.orderId} FOR NO KEY UPDATE`;
        if (!await owns(tx, claim)) return 'CLAIM_LOST';
        const reason = await ineligibleReason(tx, claim); if (reason) return reason;
        if (prepared.presentation) {
          const order = await tx.order.findUniqueOrThrow({ where: { id: claim.orderId }, select: { status: true } });
          if (order.status !== prepared.presentation) return 'ORDER_PRESENTATION_CHANGED';
        }
        await tx.orderConfirmationJob.update({ where: { id: claim.id }, data: { sendStartedAt: await databaseNow(tx) } });
        return null;
      });
      if (maySend === 'CLAIM_LOST') continue;
      if (maySend) { await settle(claim, maySend === 'ORDER_PRESENTATION_CHANGED' ? 'RETRY' : 'SUPPRESSED', maySend); continue; }
      started = true;
      const result = await transport.send(prepared.message);
      if (!result.messageId) throw new Error('Provider acceptance unknown');
      await settle(claim, 'SENT', null, result.messageId);
    } catch (error) {
      // Never persist raw SDK/database exceptions or recipient/message contents.
      if (error instanceof PdfIntegrityError) await settle(claim, 'BLOCKED', 'PDF_INTEGRITY');
      else if (error instanceof InvoiceFontUnavailable) await settle(claim, 'BLOCKED', 'FONT_ASSET_UNAVAILABLE');
      else if (error instanceof UnsupportedInvoiceText) await settle(claim, 'BLOCKED', 'FONT_COVERAGE');
      else if (error instanceof DeliveryRejected) await settle(claim, error.retryable && claim.attempts < MAX_ATTEMPTS ? 'RETRY' : 'FAILED', error.diagnostic);
      else await settle(claim, started ? 'UNKNOWN' : claim.attempts < MAX_ATTEMPTS ? 'RETRY' : 'FAILED', started ? 'ACCEPTANCE_UNKNOWN' : 'PREPARATION_FAILED');
    }
  }
  return { processed, disabled: false };
}
/** Explicit operator action only. UNKNOWN requires acknowledgement of duplicate-email risk. */
export async function requeueConfirmation(jobId: string, acknowledgeUncertainAcceptance = false, approveInvoiceBacklog = false) {
  return prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "OrderConfirmationJob" WHERE id=${jobId} FOR UPDATE`;
    const job = await tx.orderConfirmationJob.findUniqueOrThrow({ where: { id: jobId } });
    if (approveInvoiceBacklog && job.type !== 'ORDER_CONFIRMATION') throw new Error('Invoice backlog approval applies only to invoices');
    const approvedBacklog = approveInvoiceBacklog && job.lastErrorCode === 'BEFORE_ACTIVATION_CUTOFF';
    const staleInvoice = job.type === 'ORDER_CONFIRMATION' && job.state === 'SUPPRESSED' && job.lastErrorCode === 'CONFIRMATION_SUPERSEDED_BY_DISPATCH';
    if (!staleInvoice && !approvedBacklog && !['BLOCKED', 'FAILED', 'UNKNOWN'].includes(job.state) || job.state === 'UNKNOWN' && !acknowledgeUncertainAcceptance) throw new Error('Explicit delivery review required');
    await tx.orderConfirmationJob.update({ where: { id: jobId }, data: { state: 'PENDING', nextAttemptAt: await databaseNow(tx), attempts: 0, lastErrorCode: null, sendStartedAt: null, ...(approveInvoiceBacklog ? { backlogApprovedAt: job.backlogApprovedAt ?? await databaseNow(tx) } : {}) } });
  });
}
export function startOrderConfirmationWorker(intervalMs = 5000) {
  let stopped = false;
  const pending = new Set<Promise<void>>();
  const types: EmailType[] = ['ORDER_CONFIRMATION', 'DISPATCH_CONFIRMATION'];
  const ticks = types.map(type => createEmailReadinessTick({
    enabled: () => !stopped && emailEnabled(type) && process.env.NODE_ENV !== 'test',
    probe: () => checkEmailProviderReady(type), run: () => runConfirmationBatch({ types: [type] }),
  }));
  const tick = () => { for (const run of ticks) { const task = run(); pending.add(task); void task.finally(() => pending.delete(task)); } };
  const timer = setInterval(tick, intervalMs); timer.unref(); tick();
  return async () => { stopped = true; clearInterval(timer); await Promise.all(pending); };
}
