import type { ApiErrorCode } from "../../utils/apiErrorResponse.js";
import { createHash } from "node:crypto";
import { z } from "zod";
import { prisma } from "../../prisma/runtime.js";
import { Prisma } from "../../generated/prisma-client/client.js";

const identifier = z.number().int().positive().max(2_147_483_647);
const optionalText = (max: number) => z.preprocess(
  value => typeof value === "string" && value.trim() === "" ? undefined : value,
  z.string().trim().min(1).max(max).regex(/^[^\u0000\u007f]*$/).optional(),
);
export const MAX_SHIPMENT_LINES = 100;
// Identical shipments without an Amazon ID inside this window need explicit operator acknowledgement.
export const DUPLICATE_WINDOW_HOURS = 72;
/** Amazon shipment IDs compare without whitespace or case, e.g. "fba 15abc" == "FBA15ABC". */
export const normalizeExternalReference = (value: string) => value.replace(/\s+/g, "").toUpperCase();
export const FbaShipmentSchema = z.object({
  // Line keys are derived as `${idempotencyKey}:${productListingId}` within the 128-character ledger key.
  idempotencyKey: z.string().min(1).max(100).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
  items: z.array(z.object({ productListingId: identifier, quantity: identifier }).strict()).min(1).max(MAX_SHIPMENT_LINES),
  externalReference: optionalText(200).refine(v => v === undefined || !/[\u0000-\u001f]/.test(v)).transform(v => v === undefined ? undefined : normalizeExternalReference(v)),
  note: optionalText(2000),
  acknowledgedDuplicateShipmentIds: z.array(identifier).max(20).optional(),
}).strict().superRefine((value, context) => {
  const acknowledged = value.acknowledgedDuplicateShipmentIds ?? [];
  if (new Set(acknowledged).size !== acknowledged.length) context.addIssue({ code: "custom", path: ["acknowledgedDuplicateShipmentIds"], message: "Acknowledge each earlier shipment once." });
  // An Amazon shipment ID is never overridden by acknowledgement; it must be unique.
  if (acknowledged.length && value.externalReference !== undefined) context.addIssue({ code: "custom", path: ["acknowledgedDuplicateShipmentIds"], message: "Acknowledgement applies only to shipments without an Amazon reference." });
  const seen = new Set<number>();
  for (const [index, item] of value.items.entries()) {
    if (seen.has(item.productListingId)) context.addIssue({ code: "custom", path: ["items", index, "productListingId"], message: "Each listing may appear once; combine quantities into one line." });
    seen.add(item.productListingId);
  }
});
export type FbaShipmentInput = z.input<typeof FbaShipmentSchema>;

export interface ShipmentLineProblem { productListingId: number; reason: string; availableQuantity?: number; requestedQuantity?: number }
export interface DuplicateShipment { shipmentId: number; reference: string; externalReference: string | null; createdAt: Date }
export class FbaShipmentError extends Error {
  constructor(readonly status: number, readonly code: ApiErrorCode, message: string, readonly items: ShipmentLineProblem[] = [], readonly duplicates: DuplicateShipment[] = []) { super(message); }
}

const shipmentInclude = {
  lines: {
    orderBy: { productListingId: "asc" },
    include: { movement: true, productListing: { select: { id: true, condition: true, legoProduct: { select: { id: true, setNumber: true, title: true } } } } },
  },
} satisfies Prisma.FbaShipmentInclude;
type ShipmentRecord = Prisma.FbaShipmentGetPayload<{ include: typeof shipmentInclude }>;

function present(record: ShipmentRecord) {
  return {
    id: record.id, reference: record.reference, externalReference: record.externalReference, note: record.note,
    idempotencyKey: record.idempotencyKey, performedByUserId: record.performedByUserId, createdAt: record.createdAt,
    lineCount: record.lineCount, totalUnits: record.totalUnits, acknowledgedDuplicateShipmentIds: record.acknowledgedDuplicateShipmentIds,
    lines: record.lines.map(line => ({
      outboundId: line.id, movementId: line.movementId, productListingId: line.productListingId,
      productId: line.productListing.legoProduct.id, setNumber: line.productListing.legoProduct.setNumber,
      title: line.productListing.legoProduct.title, condition: line.productListing.condition,
      quantity: line.appliedQuantity, quantityChange: line.movement.quantityChange,
      currentStockAfter: line.currentStockAfter, reservedStockAfter: line.reservedStockAfter,
      availableStockAfter: line.currentStockAfter - line.reservedStockAfter,
    })),
  };
}

function canonical(input: z.output<typeof FbaShipmentSchema>, performedByUserId: number) {
  const items = [...input.items].sort((a, b) => a.productListingId - b.productListingId);
  const acknowledged = [...(input.acknowledgedDuplicateShipmentIds ?? [])].sort((a, b) => a - b);
  return JSON.stringify({ items, externalReference: input.externalReference ?? null, note: input.note ?? null, acknowledged, performedByUserId });
}
export const shipmentFingerprint = (items: Array<{ productListingId: number; quantity: number }>) =>
  createHash("sha256").update(items.map(i => `${i.productListingId}:${i.quantity}`).join(",")).digest("hex");
const duplicate = (s: { id: number; reference: string; externalReference: string | null; createdAt: Date }): DuplicateShipment =>
  ({ shipmentId: s.id, reference: s.reference, externalReference: s.externalReference, createdAt: s.createdAt });

/** Confirm one multi-listing shipment: every line is deducted, or nothing is. Retries replay the original result. */
export async function recordFbaShipment(raw: unknown, performedByUserId: number, db: Pick<typeof prisma, "$transaction"> = prisma) {
  const input = FbaShipmentSchema.parse(raw);
  const requestHash = createHash("sha256").update(canonical(input, performedByUserId)).digest("hex");
  const items = [...input.items].sort((a, b) => a.productListingId - b.productListingId);
  const lineFingerprint = shipmentFingerprint(items);
  try {
    return await db.$transaction(async tx => {
      // Serialize this key across processes before reading or locking anything else.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`fba-shipment:${input.idempotencyKey}`}, 0))`;
      const existing = await tx.fbaShipment.findUnique({ where: { idempotencyKey: input.idempotencyKey }, include: shipmentInclude });
      if (existing) {
        if (existing.requestHash !== requestHash) throw new FbaShipmentError(409, "IDEMPOTENCY_CONFLICT", "This shipment key was already used for different items, notes or another operator. Review the recorded shipment before starting a new one.");
        return { shipment: present(existing), replayed: true };
      }
      const actor = await tx.user.findUnique({ where: { id: performedByUserId } });
      if (!actor || actor.deletedAt || actor.role !== "ADMIN") throw new FbaShipmentError(403, "FORBIDDEN", "Active ADMIN required.");

      // Business-level duplicate protection runs after the key replay, so a retry of a committed
      // shipment always replays instead of being reported as its own duplicate.
      let acknowledgedDuplicateShipmentIds: number[] = [];
      if (input.externalReference !== undefined) {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`fba-shipment-external:${input.externalReference}`}, 0))`;
        const recorded = await tx.fbaShipment.findUnique({ where: { externalReference: input.externalReference } });
        if (recorded) throw new FbaShipmentError(409, "DUPLICATE_FBA_SHIPMENT", `Amazon shipment ${input.externalReference} is already recorded as ${recorded.reference}. Nothing was deducted. A correction to a recorded shipment needs an audited stock correction, not a second shipment.`, [], [duplicate(recorded)]);
      } else {
        // Serialize identical contents so two concurrent repeats cannot both pass the check.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`fba-shipment-lines:${lineFingerprint}`}, 0))`;
        const recent = await tx.fbaShipment.findMany({
          where: { lineFingerprint, createdAt: { gte: new Date(Date.now() - DUPLICATE_WINDOW_HOURS * 3_600_000) } },
          orderBy: { id: "desc" }, take: 20,
        });
        const acknowledged = new Set(input.acknowledgedDuplicateShipmentIds ?? []);
        if (recent.some(s => !acknowledged.has(s.id))) throw new FbaShipmentError(409, "POSSIBLE_DUPLICATE_SHIPMENT", `The same listings and quantities were shipped within the last ${DUPLICATE_WINDOW_HOURS} hours. Nothing was deducted. Confirm explicitly that this is a new physical shipment, or add its Amazon shipment ID.`, [], recent.map(duplicate));
        acknowledgedDuplicateShipmentIds = recent.map(s => s.id).sort((a, b) => a - b);
      }

      // Ascending row locks avoid deadlocks between concurrent shipments and share checkout's listing lock.
      const ids = items.map(item => item.productListingId);
      const locked = await tx.$queryRaw<Array<{ id: number; condition: string; currentStock: number; reservedStock: number }>>`
        SELECT id, condition, "currentStock", "reservedStock" FROM "ProductListing"
        WHERE id = ANY(${ids}::int[]) ORDER BY id FOR UPDATE`;
      const byId = new Map(locked.map(row => [row.id, row]));
      const missing = ids.filter(id => !byId.has(id));
      if (missing.length) throw new FbaShipmentError(404, "LISTING_NOT_FOUND", "One or more listings no longer exist. Remove them and review the shipment again.", missing.map(productListingId => ({ productListingId, reason: "LISTING_NOT_FOUND" })));
      const used = items.filter(item => byId.get(item.productListingId)!.condition !== "NEW");
      if (used.length) throw new FbaShipmentError(409, "USED_OFFER_NOT_SUPPORTED", "Individually documented Used offers cannot be shipped through this operation.", used.map(item => ({ productListingId: item.productListingId, reason: "USED_OFFER_NOT_SUPPORTED" })));
      const short = items.flatMap(item => {
        const row = byId.get(item.productListingId)!, available = Math.max(0, row.currentStock - row.reservedStock);
        return item.quantity > available ? [{ productListingId: item.productListingId, reason: "INSUFFICIENT_AVAILABLE_STOCK", availableQuantity: available, requestedQuantity: item.quantity }] : [];
      });
      if (short.length) throw new FbaShipmentError(409, "INSUFFICIENT_AVAILABLE_STOCK", "Some lines exceed available local stock. Reserved website stock cannot be shipped to Amazon. Nothing was deducted.", short);

      // Database-owned per-day counter: the row lock serializes allocation and the unique index is the backstop.
      const [sequence] = await tx.$queryRaw<Array<{ day: string; value: number }>>`
        INSERT INTO "FbaShipmentSequence" (day, "lastValue") VALUES ((now() AT TIME ZONE 'Europe/London')::date, 1)
        ON CONFLICT (day) DO UPDATE SET "lastValue" = "FbaShipmentSequence"."lastValue" + 1
        RETURNING to_char(day, 'YYYYMMDD') AS day, "lastValue" AS value`;
      const reference = `FBA-${sequence.day}-${String(sequence.value).padStart(4, "0")}`;
      const header = await tx.fbaShipment.create({ data: {
        reference, externalReference: input.externalReference ?? null, note: input.note ?? null,
        lineFingerprint, acknowledgedDuplicateShipmentIds,
        idempotencyKey: input.idempotencyKey, requestHash, performedByUserId,
        lineCount: items.length, totalUnits: items.reduce((sum, item) => sum + item.quantity, 0),
      } });
      const movementNote = [`FBA shipment ${reference}`, input.externalReference && `Amazon ${input.externalReference}`, input.note].filter(Boolean).join(" · ");
      for (const item of items) {
        const row = byId.get(item.productListingId)!;
        const updated = await tx.$executeRaw`
          UPDATE "ProductListing" SET "currentStock" = "currentStock" - ${item.quantity}
          WHERE id = ${row.id} AND "reservedStock" >= 0 AND "currentStock" - "reservedStock" >= ${item.quantity}`;
        if (updated !== 1) throw new FbaShipmentError(409, "INSUFFICIENT_AVAILABLE_STOCK", "Available stock changed during confirmation. Nothing was deducted.", [{ productListingId: row.id, reason: "INSUFFICIENT_AVAILABLE_STOCK", requestedQuantity: item.quantity }]);
        const movement = await tx.inventoryMovement.create({ data: { listingId: row.id, quantityChange: -item.quantity, type: "FBA_OUTBOUND", note: movementNote, performedByUserId } });
        await tx.fbaOutbound.create({ data: {
          fbaShipmentId: header.id, productListingId: row.id, movementId: movement.id,
          idempotencyKey: `${input.idempotencyKey}:${row.id}`, requestHash, shipmentReference: reference,
          actualQuantity: item.quantity, appliedQuantity: item.quantity, shortfall: 0,
          currentStockAfter: row.currentStock - item.quantity, reservedStockAfter: row.reservedStock,
        } });
      }
      const created = await tx.fbaShipment.findUniqueOrThrow({ where: { id: header.id }, include: shipmentInclude });
      return { shipment: present(created), replayed: false };
    });
  } catch (error) {
    // A ledger key collision is never resolved by retrying with the same key.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      // Backstop only: the external-reference lock normally reports duplicates before the unique index fires.
      if (JSON.stringify(error.meta ?? {}).includes("externalReference")) throw new FbaShipmentError(409, "DUPLICATE_FBA_SHIPMENT", "This Amazon shipment is already recorded. Nothing was deducted.");
      throw new FbaShipmentError(409, "IDEMPOTENCY_CONFLICT", "This shipment collides with an already recorded outbound. Review the outbound history before retrying.");
    }
    throw error;
  }
}

export const FbaShipmentPageSchema = z.object({
  page: z.preprocess(v => typeof v === "string" && /^\d+$/.test(v) ? Number(v) : v, z.number().int().positive().max(10_000)).default(1),
  pageSize: z.preprocess(v => typeof v === "string" && /^\d+$/.test(v) ? Number(v) : v, z.number().int().positive().max(50)).default(20),
}).strict();

export async function listFbaShipments(query: z.output<typeof FbaShipmentPageSchema>) {
  return prisma.$transaction(async tx => {
    const [totalItems, records] = await Promise.all([
      tx.fbaShipment.count(),
      tx.fbaShipment.findMany({ include: shipmentInclude, orderBy: { id: "desc" }, skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
    ]);
    return { items: records.map(present), pagination: { page: query.page, pageSize: query.pageSize, totalItems, totalPages: Math.ceil(totalItems / query.pageSize) } };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
}

export async function getFbaShipment(id: number) {
  const record = await prisma.fbaShipment.findUnique({ where: { id }, include: shipmentInclude });
  if (!record) throw new FbaShipmentError(404, "OUTBOUND_NOT_FOUND", "FBA shipment not found.");
  return { shipment: present(record) };
}
