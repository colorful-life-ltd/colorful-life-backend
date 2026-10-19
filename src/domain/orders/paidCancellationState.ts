import type { Prisma } from '../../generated/prisma-client/client.js';
/** Read under the Order lock. Immutable withdrawal closes only its referenced request. */
export async function activePaidCancellation(tx: Prisma.TransactionClient, orderId: number) {
  const [request] = await tx.$queryRaw<Array<{ id: bigint; actorId: number; details: { key: string; reason: string } }>>`
    SELECT r.id,r."actorId",r.details FROM "OperationalAudit" r
    WHERE r."orderId"=${orderId} AND r.kind='PAID_CANCELLATION_REQUESTED'
      AND NOT EXISTS (SELECT 1 FROM "OperationalAudit" w WHERE w."orderId"=r."orderId"
        AND w.kind='PAID_CANCELLATION_WITHDRAWN' AND w.details->>'requestId'=r.id::text)
    ORDER BY r.id DESC LIMIT 1`;
  return request ?? null;
}
