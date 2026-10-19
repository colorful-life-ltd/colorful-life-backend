import { inventoryOperation, inventoryOperationKey } from './inventoryOperationJournal.js';
import {unresolvedFbaDiscrepancies} from "./inventoryDiscrepancy.js";
import { prisma } from "../../prisma/runtime.js";
import {
  InventoryAdjustmentReason,
  InventoryAuditAction,
  InventoryMovementType,
  ListingCondition,
} from "../../generated/prisma-client/enums.js";

export type ConditionAdjustmentInput = {
  sourceProductListingId: number;
  targetProductListingId: number;
  quantity: number;
  reason: InventoryAdjustmentReason;
  reasonNote?: string;
  performedByUserId: number;
};

export type WriteOffInput = {
  sourceProductListingId: number;
  quantity: number;
  reason: InventoryAdjustmentReason;
  reasonNote?: string;
  performedByUserId: number;
};

export type StocktakeReconciliationInput = {
  productListingId: number;
  actualStock: number;
  reasonNote?: string;
  performedByUserId: number;
};

export class InvalidInventoryAdjustmentQuantityError extends Error {
  constructor() {
    super("Inventory adjustment quantity must be a positive integer");
    this.name = "InvalidInventoryAdjustmentQuantityError";
  }
}

export class InventoryListingNotFoundError extends Error {
  constructor(listingId: number) {
    super(`Product listing ${listingId} not found`);
    this.name = "InventoryListingNotFoundError";
  }
}

export class InventoryListingsMustDifferError extends Error {
  constructor() {
    super("Source and target product listings must be different");
    this.name = "InventoryListingsMustDifferError";
  }
}

export class InventoryListingsMustShareProductError extends Error {
  constructor() {
    super("Source and target product listings must belong to the same LEGO product");
    this.name = "InventoryListingsMustShareProductError";
  }
}

export class InvalidConditionAdjustmentError extends Error {
  constructor() {
    super("Used stock must be created as a new individually documented physical offer");
    this.name = "InvalidConditionAdjustmentError";
  }
}

export class InventoryInsufficientStockError extends Error {
  constructor(listingId: number) {
    super(`Insufficient stock for product listing ${listingId}`);
    this.name = "InventoryInsufficientStockError";
  }
}

export class InvalidInventoryAdjustmentReasonError extends Error {
  constructor() {
    super("Invalid inventory adjustment reason");
    this.name = "InvalidInventoryAdjustmentReasonError";
  }
}

export class InvalidStocktakeQuantityError extends Error {
  constructor() {
    super("Actual stock must be a non-negative 32-bit integer");
    this.name = "InvalidStocktakeQuantityError";
  }
}

export class StocktakeListingNotFoundError extends Error {
  constructor(listingId: number) {
    super(`Product listing ${listingId} not found`);
    this.name = "StocktakeListingNotFoundError";
  }
}

export class StocktakeBelowReservedStockError extends Error {
  constructor() {
    super("Actual stock cannot be less than reserved stock");
    this.name = "StocktakeBelowReservedStockError";
  }
}

function validateQuantity(quantity: number): void {
  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new InvalidInventoryAdjustmentQuantityError();
  }
}

function validateReason(reason: InventoryAdjustmentReason): void {
  if (!Object.values(InventoryAdjustmentReason).includes(reason)) {
    throw new InvalidInventoryAdjustmentReasonError();
  }
}

function normalizedReasonNote(reasonNote: string | undefined): string | undefined {
  const trimmed = reasonNote?.trim();
  return trimmed || undefined;
}

export async function reconcileStocktake(input: StocktakeReconciliationInput, idempotencyKey?: string) {
  if (!Number.isInteger(input.actualStock) || input.actualStock < 0 || input.actualStock > 2_147_483_647) {
    throw new InvalidStocktakeQuantityError();
  }

  inventoryOperationKey(idempotencyKey);
  return prisma.$transaction(async (tx) => inventoryOperation(tx,idempotencyKey,{...input,operation: 'reconcileStocktake'},async () => {
    // Lock the listing before reading its authoritative stock. Other stock
    // mutations must acquire this row lock to update the same ProductListing.
    const rows = await tx.$queryRaw<Array<{ id: number; currentStock: number; reservedStock: number }>>`
      SELECT id, "currentStock", "reservedStock"
      FROM "ProductListing"
      WHERE id = ${input.productListingId}
      FOR UPDATE
    `;
    const listing = rows[0];
    if (!listing) throw new StocktakeListingNotFoundError(input.productListingId);
    const metadata = await tx.productListing.findUnique({ where: { id: listing.id }, select: { condition: true, usedLifecycle: true } });
    if (!metadata) throw new StocktakeListingNotFoundError(input.productListingId);
    if (metadata.condition === ListingCondition.USED_LIKE_NEW && (
      input.actualStock > 1 || (metadata.usedLifecycle !== "AVAILABLE" && input.actualStock !== 0)
    )) {
      throw new InvalidStocktakeQuantityError();
    }
    if (input.actualStock < listing.reservedStock) {
      throw new StocktakeBelowReservedStockError();
    }

    const discrepancies=await unresolvedFbaDiscrepancies(tx,listing.id);
    if(discrepancies.length){
      const actor=await tx.user.findUnique({where:{id:input.performedByUserId}});
      if(!actor||actor.deletedAt||actor.role!=='ADMIN'||!input.reasonNote||input.reasonNote.trim().length<10||input.reasonNote.length>2000)throw new InvalidInventoryAdjustmentReasonError();
      for(const row of discrepancies)await tx.$executeRaw`INSERT INTO "OperationalAudit" (kind,"actorId","requestKey",details) VALUES ('FBA_DISCREPANCY_RESOLVED',${input.performedByUserId},${`fba-resolved:${row.id}`},${JSON.stringify({outboundId:row.id,listingId:listing.id,actualStock:input.actualStock,reservedStock:listing.reservedStock,reason:input.reasonNote.trim()})}::jsonb)`;
    }
    const quantityChange = input.actualStock - listing.currentStock;
    if (quantityChange === 0) {
      return { listing: { id: listing.id, currentStock: listing.currentStock }, movement: null };
    }

    const updatedRows = await tx.$executeRaw`
      UPDATE "ProductListing"
      SET "currentStock" = ${input.actualStock},
          "usedLifecycle" = CASE WHEN "condition" = 'USED_LIKE_NEW' AND ${input.actualStock} = 0 THEN 'RETIRED'::"UsedOfferLifecycle" ELSE "usedLifecycle" END
      WHERE id = ${listing.id}
        AND "currentStock" = ${listing.currentStock}
        AND "reservedStock" <= ${input.actualStock}
    `;
    if (updatedRows === 0) {
      // Defensive guard in case the row is ever changed outside this lock path.
      throw new StocktakeBelowReservedStockError();
    }

    const movement = await tx.inventoryMovement.create({
      data: {
        listingId: listing.id,
        quantityChange,
        type: InventoryMovementType.MANUAL_ADJUSTMENT,
        note: normalizedReasonNote(input.reasonNote) ?? `Stocktake reconciliation to ${input.actualStock}`,
        performedByUserId: input.performedByUserId,
      },
    });

    return { listing: { id: listing.id, currentStock: input.actualStock }, movement };
  }));
}

export async function conditionAdjustInventory(input: ConditionAdjustmentInput) {
  validateQuantity(input.quantity);
  validateReason(input.reason);
  // Used stock is now a physical, individually documented offer. Callers must
  // use POST /inventory/condition-conversions to create a fresh offer.
  void input;
  throw new InvalidConditionAdjustmentError();
}

export async function writeOffInventory(input: WriteOffInput, idempotencyKey?: string) {
  validateQuantity(input.quantity);
  validateReason(input.reason);

  inventoryOperationKey(idempotencyKey);
  return prisma.$transaction(async (tx) => inventoryOperation(tx,idempotencyKey,{...input,operation: 'writeOffInventory'},async () => {
    const source = await tx.productListing.findUnique({
      where: { id: input.sourceProductListingId },
      select: { id: true, condition: true, usedLifecycle: true },
    });
    if (!source) throw new InventoryListingNotFoundError(input.sourceProductListingId);
    if (source.condition === ListingCondition.USED_LIKE_NEW && (source.usedLifecycle !== "AVAILABLE" || input.quantity !== 1)) {
      throw new InventoryInsufficientStockError(source.id);
    }

    const sourceUpdate = await tx.$executeRaw`
      UPDATE "ProductListing"
      SET "currentStock" = "currentStock" - ${input.quantity},
          "usedLifecycle" = CASE WHEN "condition" = 'USED_LIKE_NEW' AND "currentStock" - ${input.quantity} = 0 THEN 'RETIRED'::"UsedOfferLifecycle" ELSE "usedLifecycle" END
      WHERE id = ${source.id}
        AND "currentStock" >= ${input.quantity}
        AND "currentStock" - ${input.quantity} >= "reservedStock"
    `;
    if (sourceUpdate === 0) {
      throw new InventoryInsufficientStockError(source.id);
    }

    const movement = await tx.inventoryMovement.create({
      data: {
        listingId: source.id,
        quantityChange: -input.quantity,
        type: InventoryMovementType.WRITE_OFF,
        note: `Inventory write-off for listing ${source.id}`,
        performedByUserId: input.performedByUserId,
      },
    });
    const audit = await tx.inventoryAudit.create({
      data: {
        sourceProductListingId: source.id,
        targetProductListingId: null,
        action: InventoryAuditAction.WRITE_OFF,
        quantity: input.quantity,
        reason: input.reason,
        reasonNote: normalizedReasonNote(input.reasonNote),
        performedByUserId: input.performedByUserId,
      },
    });

    return { movement, audit };
  }));
}
