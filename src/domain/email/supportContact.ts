import { z } from 'zod';
import { config } from '../../config/index.js';
import type { LegalIdentity } from './brandEmail.js';

// The monitored support mailbox is owned by ORDER_CONFIRMATION_BUSINESS_JSON (single source of truth).
// Account emails only need the attested mailbox and company identity, so they do not depend on invoice-only fields being approved.
const supportSchema = z.object({ replyToEmail: z.string().email(), replyToMonitored: z.literal(true) }).passthrough();

const text = z.string().trim().min(1).max(500).refine(s => !/[\u0000-\u001f\u007f]/.test(s));
const identitySchema = z.object({ legalName: z.literal('Colorful Life Ltd'), registrationNumber: text, registeredAddress: z.array(text).min(2).max(8), registeredIn: text.optional() }).passthrough();
const parse = (raw: string | undefined) => { if (!raw) return null; try { return JSON.parse(raw) as unknown; } catch { return null; } };

/** Configured company identity for account-email disclosures, or null when not configured. */
export function approvedLegalIdentity(raw = config.ORDER_CONFIRMATION_BUSINESS_JSON): LegalIdentity | null {
  const parsed = identitySchema.safeParse(parse(raw));
  return parsed.success ? { legalName: parsed.data.legalName, registrationNumber: parsed.data.registrationNumber, registeredAddress: parsed.data.registeredAddress, ...(parsed.data.registeredIn ? { registeredIn: parsed.data.registeredIn } : {}) } : null;
}

/** Monitored Reply-To for account emails, or null when no attested mailbox is configured. */
export function approvedSupportReplyTo(raw = config.ORDER_CONFIRMATION_BUSINESS_JSON): string | null {
  const parsed = supportSchema.safeParse(parse(raw));
  return parsed.success ? parsed.data.replyToEmail : null;
}
