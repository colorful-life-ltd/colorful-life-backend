import { createHash } from 'node:crypto';
import { prisma } from '../../prisma/runtime.js';

export class OperatorIntentResolutionError extends Error {
  constructor(readonly code: 'ADMIN_REQUIRED' | 'ORDER_NOT_FOUND' | 'IDEMPOTENCY_CONFLICT' | 'INTENT_TARGET_MISMATCH', readonly status: 400 | 403 | 404 | 409) { super(code); }
}
export type IntentValue = string | number | boolean | null | string[];
/** Sorted-key JSON so Backend and Admin derive the same fingerprint for one payload. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
export const intentFingerprint = (operation: string, intent: Record<string, IntentValue>) =>
  createHash('sha256').update(canonicalJson({ operation, intent })).digest('hex');
const targets = ['orderId', 'productId', 'productListingId', 'receiptId'] as const;
export type OperatorIntentResolution = {
  operation: string; decision: 'APPLIED' | 'NOT_APPLIED'; note: string;
  /** The exact saved Admin payload that was investigated. Recorded, never executed. */
  intent: Record<string, IntentValue>;
  orderId?: number; productId?: number; productListingId?: number; receiptId?: number;
};
/** Records an operator's investigated outcome for an uncertain, non-replayable Admin
 * intent. Audit only: it never repeats, reverses or confirms the original operation. */
export async function recordOperatorIntentResolution(actorId: number, intentKey: string, input: OperatorIntentResolution) {
  // Targets are derived from the investigated payload, so they cannot describe a different intent.
  if (targets.some(k => (typeof input.intent[k] === 'number' ? input.intent[k] : undefined) !== input[k]))
    throw new OperatorIntentResolutionError('INTENT_TARGET_MISMATCH', 400);
  const fingerprint = intentFingerprint(input.operation, input.intent);
  const requestKey = `operator-intent:${intentKey}`;
  const hash = createHash('sha256').update(JSON.stringify({ actorId, ...input })).digest('hex');
  return prisma.$transaction(async tx => {
    const actor = await tx.user.findUnique({ where: { id: actorId }, select: { role: true, deletedAt: true } });
    if (!actor || actor.deletedAt || actor.role !== 'ADMIN') throw new OperatorIntentResolutionError('ADMIN_REQUIRED', 403);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${requestKey},0))`;
    const prior = await tx.operationalAudit.findUnique({ where: { requestKey } });
    if (prior) {
      if (prior.requestHash !== hash) throw new OperatorIntentResolutionError('IDEMPOTENCY_CONFLICT', 409);
      return { auditId: prior.id.toString(), replayed: true, intentFingerprint: fingerprint };
    }
    if (input.orderId !== undefined && !await tx.order.findUnique({ where: { id: input.orderId }, select: { id: true } }))
      throw new OperatorIntentResolutionError('ORDER_NOT_FOUND', 404);
    const audit = await tx.operationalAudit.create({ data: { kind: 'OPERATOR_INTENT_RESOLVED', actorId, orderId: input.orderId ?? null,
      requestKey, requestHash: hash, details: { ...input, note: input.note.trim(), intentFingerprint: fingerprint } } });
    return { auditId: audit.id.toString(), replayed: false, intentFingerprint: fingerprint };
  });
}
