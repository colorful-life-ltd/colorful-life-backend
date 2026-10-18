import type { Prisma } from '../../generated/prisma-client/client.js';
export class InventoryDiscrepancyError extends Error {
    constructor(readonly listingId: number) { super('INVENTORY_DISCREPANCY_REVIEW_REQUIRED'); }
}
/** Caller holds the listing lock. A physical shortage never authorizes reservation changes. */
export async function unresolvedFbaDiscrepancies(tx: Prisma.TransactionClient, listingId: number) {
    return tx.$queryRaw<Array<{
        id: number;
    }>> `SELECT f.id FROM "FbaOutbound" f WHERE f."productListingId"=${listingId} AND f.shortfall>0
  AND NOT EXISTS (SELECT 1 FROM "OperationalAudit" a WHERE a.kind='FBA_DISCREPANCY_RESOLVED' AND a."requestKey"='fba-resolved:'||f.id::text) ORDER BY f.id`;
}
export async function assertListingCommitmentAllowed(tx: Prisma.TransactionClient, listingId: number) {
    if ((await unresolvedFbaDiscrepancies(tx, listingId)).length)
        throw new InventoryDiscrepancyError(listingId);
}
