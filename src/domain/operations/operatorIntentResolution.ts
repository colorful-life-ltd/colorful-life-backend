import { createHash } from 'node:crypto';
import { prisma } from '../../prisma/runtime.js';

export class OperatorIntentResolutionError extends Error {
  constructor(readonly code: 'ADMIN_REQUIRED' | 'ORDER_NOT_FOUND' | 'IDEMPOTENCY_CONFLICT', readonly status: 403 | 404 | 409) { super(code); }
}
export type OperatorIntentResolution = {
  operation: string; decision: 'APPLIED' | 'NOT_APPLIED'; note: string;
  orderId?: number; productId?: number; productListingId?: number; receiptId?: number;
};
/** Records an operator's investigated outcome for an uncertain, non-replayable Admin
 * intent. Audit only: it never repeats, reverses or confirms the original operation. */
export async function recordOperatorIntentResolution(actorId: number, intentKey: string, input: OperatorIntentResolution) {
  const requestKey = `operator-intent:${intentKey}`;
  const hash = createHash('sha256').update(JSON.stringify({ actorId, ...input })).digest('hex');
  return prisma.$transaction(async tx => {
    const actor = await tx.user.findUnique({ where: { id: actorId }, select: { role: true, deletedAt: true } });
    if (!actor || actor.deletedAt || actor.role !== 'ADMIN') throw new OperatorIntentResolutionError('ADMIN_REQUIRED', 403);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${requestKey},0))`;
    const prior = await tx.operationalAudit.findUnique({ where: { requestKey } });
    if (prior) {
      if (prior.requestHash !== hash) throw new OperatorIntentResolutionError('IDEMPOTENCY_CONFLICT', 409);
      return { auditId: prior.id.toString(), replayed: true };
    }
    if (input.orderId !== undefined && !await tx.order.findUnique({ where: { id: input.orderId }, select: { id: true } }))
      throw new OperatorIntentResolutionError('ORDER_NOT_FOUND', 404);
    const audit = await tx.operationalAudit.create({ data: { kind: 'OPERATOR_INTENT_RESOLVED', actorId, orderId: input.orderId ?? null,
      requestKey, requestHash: hash, details: { ...input, note: input.note.trim() } } });
    return { auditId: audit.id.toString(), replayed: false };
  });
}
