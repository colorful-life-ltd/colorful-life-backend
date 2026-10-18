import type { ApiErrorCode } from "../../utils/apiErrorResponse.js";
import { createHash } from "node:crypto";
import { z } from "zod";
import { prisma } from "../../prisma/runtime.js";
import type { Prisma } from "../../generated/prisma-client/client.js";

const identifier = z.number().int().positive().max(2_147_483_647);
export const FbaOutboundSchema = z.object({
  productListingId: identifier,
  quantity: identifier,
  shipmentReference: z.string().trim().min(1).max(200).regex(/^[^\u0000-\u001f\u007f]+$/),
  note: z.string().trim().min(1).max(2000).refine(value => !value.includes("\0")),
  idempotencyKey: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
}).strict();
export type FbaOutboundInput = z.infer<typeof FbaOutboundSchema>;
export class FbaOutboundError extends Error {
  constructor(readonly status: number, readonly code: ApiErrorCode, message: string) { super(message); }
}

type Outbound = Prisma.FbaOutboundGetPayload<{ include: { movement: true } }>;
function present(record: Outbound) {
  return {
    outbound: {
      id: record.id, productListingId: record.movement.listingId,
      quantity: -record.movement.quantityChange, shipmentReference: record.shipmentReference,
      note: record.movement.note, idempotencyKey: record.idempotencyKey,
      performedByUserId: record.movement.performedByUserId, createdAt: record.movement.createdAt,
      movement: record.movement,
    },
    inventory: {
      productListingId: record.movement.listingId,
      currentStock: record.currentStockAfter, reservedStock: record.reservedStockAfter,
      availableStock: record.currentStockAfter - record.reservedStockAfter,
    },
  };
}

/** Deduct only uncommitted local stock. Never interpret currentStock as a shelf count. */
export async function recordFbaOutbound(raw: FbaOutboundInput, performedByUserId: number, db: Pick<typeof prisma, "$transaction"> = prisma) {
  const input = FbaOutboundSchema.parse(raw);
  const requestHash = createHash("sha256").update(JSON.stringify({ ...input, performedByUserId })).digest("hex");
  return db.$transaction(async tx => {
    // Cross-process key serialization, followed by the durable unique constraint.
    // Always lock the key before the listing, matching every invocation here.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`fba-outbound:${input.idempotencyKey}`}, 0))`;
    const existing = await tx.fbaOutbound.findUnique({ where: { idempotencyKey: input.idempotencyKey }, include: { movement: true } });
    if (existing) {
      if (existing.requestHash !== requestHash) throw new FbaOutboundError(409, "IDEMPOTENCY_CONFLICT", "This idempotency key was used for different outbound details or an actor. Use a new key for a new shipment.");
      return { ...present(existing), replayed: true };
    }
    const listings = await tx.$queryRaw<Array<{ id: number; condition: string; currentStock: number; reservedStock: number }>>`
      SELECT id, condition, "currentStock", "reservedStock" FROM "ProductListing"
      WHERE id = ${input.productListingId} FOR UPDATE`;
    const listing = listings[0];
    if (!listing) throw new FbaOutboundError(404, "LISTING_NOT_FOUND", "Product listing not found.");
    if (listing.condition !== "NEW") throw new FbaOutboundError(409, "USED_OFFER_NOT_SUPPORTED", "Individually documented Used offers cannot be shipped through this operation.");
    // The guarded UPDATE shares the same row lock as checkout reservations.
    const updated = await tx.$executeRaw`
      UPDATE "ProductListing" SET "currentStock" = "currentStock" - ${input.quantity}
      WHERE id = ${listing.id} AND "reservedStock" >= 0
        AND "currentStock" - "reservedStock" >= ${input.quantity}`;
    if (updated !== 1) throw new FbaOutboundError(409, "INSUFFICIENT_AVAILABLE_STOCK", "Outbound quantity exceeds available local stock. Reserved website stock cannot be shipped to Amazon.");
    const movement = await tx.inventoryMovement.create({ data: {
      listingId: listing.id, quantityChange: -input.quantity, type: "FBA_OUTBOUND",
      note: input.note, performedByUserId,
    } });
    const record = await tx.fbaOutbound.create({ data: {
      movementId: movement.id, idempotencyKey: input.idempotencyKey, requestHash,
      shipmentReference: input.shipmentReference,
      currentStockAfter: listing.currentStock - input.quantity, reservedStockAfter: listing.reservedStock,
    }, include: { movement: true } });
    return { ...present(record), replayed: false };
  });
}

export async function getFbaOutbound(id: number) {
  const record = await prisma.fbaOutbound.findUnique({ where: { id }, include: { movement: true } });
  if (!record) throw new FbaOutboundError(404, "OUTBOUND_NOT_FOUND", "Outbound shipment record not found.");
  return present(record);
}
