import { z } from 'zod';
import { config, emailConfigurationLoadedAt } from '../../config/index.js';
import { prisma } from '../../prisma/runtime.js';
import type { Prisma } from '../../generated/prisma-client/client.js';
import { businessSchema } from './contract.js';
import { loadInvoiceFont } from './pdf.js';
import { checkSesReadiness } from './delivery.js';

/** Required even when sending is disabled: payment/dispatch transactions write durable tasks. */
export async function assertEmailSchemaReady(db: Prisma.TransactionClient = prisma) {
  try {
    await db.$queryRaw`SELECT j.id, j.type, j."deliveryRoute", j."backlogApprovedAt", j."eventKey", j."shipmentId", j."brandSnapshot", j.source, j."claimGeneration", j."sendStartedAt", i.snapshot, i."pdfBytes", o."confirmationDeliverySnapshot", oi."invoiceDescriptionSnapshot", oi."invoiceSetNumberSnapshot"
      FROM "OrderConfirmationJob" j LEFT JOIN "CommercialInvoice" i ON false LEFT JOIN "Order" o ON false LEFT JOIN "OrderItem" oi ON false LIMIT 0`;
    const [row] = await db.$queryRaw<Array<{ ready: boolean }>>`SELECT to_regclass('commercial_invoice_number_seq') IS NOT NULL
      AND to_regclass('confirmation_one_per_order') IS NOT NULL
      AND to_regclass('\"OrderConfirmationJob_eventKey_key\"') IS NOT NULL
      AND to_regclass('\"OrderConfirmationJob_shipmentId_key\"') IS NOT NULL
      AND (SELECT count(*)=2 FROM pg_constraint WHERE conrelid='\"OrderConfirmationJob\"'::regclass AND conname IN ('confirmation_source_order_identity','email_delivery_route') AND convalidated)
      AND (SELECT count(*)=2 FROM pg_trigger WHERE tgrelid IN ('"OrderConfirmationJob"'::regclass, '"CommercialInvoice"'::regclass)
        AND tgname IN ('confirmation_source_immutable','commercial_invoice_immutable') AND tgenabled IN ('O','A')) AS ready`;
    if (!row?.ready) throw new Error('Schema incomplete');
  } catch { throw new Error('Transactional email schema not ready: apply and verify Issue #180 migrations before starting this release'); }
}
export type EmailType = 'ORDER_CONFIRMATION' | 'DISPATCH_CONFIRMATION';
export const emailEnabled = (type: EmailType) => type === 'ORDER_CONFIRMATION' ? config.ORDER_CONFIRMATION_EMAIL_ENABLED : config.DISPATCH_CONFIRMATION_EMAIL_ENABLED;
export class EmailActivationCutoffError extends Error {
  constructor(type: EmailType, future: boolean) {
    super(`${type} email worker paused: activation cutoff ${future ? 'was future-dated at configuration load' : 'is missing or invalid'}; correct configuration and restart; queued jobs retained`);
  }
}
export function activationCutoff(type: EmailType) {
  const cutoff = type === 'ORDER_CONFIRMATION' ? config.ORDER_CONFIRMATION_EMAIL_ACTIVE_FROM : config.DISPATCH_CONFIRMATION_EMAIL_ACTIVE_FROM;
  if (!z.string().datetime().safeParse(cutoff).success) throw new EmailActivationCutoffError(type, false);
  if (Date.parse(cutoff!) > emailConfigurationLoadedAt) throw new EmailActivationCutoffError(type, true);
  return new Date(cutoff!);
}

export function approvedEmailConfiguration(type: EmailType = 'ORDER_CONFIRMATION') {
  activationCutoff(type);
  let value: unknown;
  try { value = JSON.parse(config.ORDER_CONFIRMATION_BUSINESS_JSON ?? 'null'); } catch { throw new Error('Approved email business configuration required'); }
  const parsed = businessSchema.safeParse(value);
  if (!parsed.success) throw new Error('Approved email business configuration required');
  if (type === 'ORDER_CONFIRMATION') loadInvoiceFont();
  return parsed.data;
}
/** Schema is fatal; provider readiness is deliberately handled asynchronously by workers. */
export async function assertEmailStartupReady() { await assertEmailSchemaReady(); }
export async function checkEmailProviderReady(type: EmailType) {
  const business = approvedEmailConfiguration(type);
  await checkSesReadiness(business.fromEmail);
}
/** One bounded probe per retry interval. Failure pauses work without throwing into API startup. */
export function createEmailReadinessTick(options: {
  enabled: () => boolean; probe: () => Promise<void>; run: () => Promise<unknown>;
  warn?: (message: string) => void; now?: () => number; retryMs?: number; timeoutMs?: number;
}) {
  let nextProbe = 0, ready = false, running = false;
  const now = options.now ?? Date.now;
  return async () => {
    if (running || !options.enabled()) return;
    running = true;
    try {
      if (now() >= nextProbe) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([options.probe(), new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('Readiness timeout')), options.timeoutMs ?? 10_000);
          })]);
          ready = true;
        } catch (error) { ready = false; (options.warn ?? console.warn)(error instanceof EmailActivationCutoffError ? error.message : 'Transactional email worker paused: readiness unavailable; durable jobs retained'); }
        finally { if (timer) clearTimeout(timer); nextProbe = now() + (options.retryMs ?? 30_000); }
      }
      if (ready) await options.run();
    } catch {
      ready = false; nextProbe = now() + (options.retryMs ?? 30_000);
      (options.warn ?? console.warn)('Transactional email worker paused: delivery unavailable; durable jobs retained');
    } finally { running = false; }
  };
}
