import type { Prisma } from '../../generated/prisma-client/client.js';
export class InventoryOperationConflict extends Error {
  constructor(readonly code: 'INVALID_IDEMPOTENCY_KEY' | 'IDEMPOTENCY_CONFLICT') { super(code); }
}
export function inventoryOperationKey(value: string | undefined) {
  if (value !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) throw new InventoryOperationConflict('INVALID_IDEMPOTENCY_KEY');
  return value;
}
/** Optional for old callers; Admin sends a durable key. Receipt and movements
 * commit atomically. Replay returns the original HTTP JSON, never current stock. */
export async function inventoryOperation<T>(tx: Prisma.TransactionClient, key: string | undefined, input: object, work: () => Promise<T>): Promise<T> {
  if (!key) return work();
  inventoryOperationKey(key);
  const requestKey = `inventory-operation:${key}`;
  const fingerprint = JSON.stringify(input, Object.keys(input).sort());
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${requestKey},0))`;
  const [prior] = await tx.$queryRaw<Array<{ details: { fingerprint: string; result: T } }>>`SELECT details FROM "OperationalAudit" WHERE "requestKey"=${requestKey}`;
  if (prior) {
    if (prior.details.fingerprint !== fingerprint) throw new InventoryOperationConflict('IDEMPOTENCY_CONFLICT');
    return prior.details.result;
  }
  const result = await work();
  const actor = (input as { performedByUserId: number }).performedByUserId;
  await tx.$executeRaw`INSERT INTO "OperationalAudit" (kind,"actorId","requestKey",details)
    VALUES ('INVENTORY_OPERATION_RECORDED',${actor},${requestKey},${JSON.stringify({fingerprint,result})}::jsonb)`;
  return result;
}
