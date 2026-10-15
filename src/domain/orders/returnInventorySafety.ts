import type { Prisma } from "../../generated/prisma-client/client.js";

export class OrderReturnEligibilityError extends Error {
  constructor() { super("Order inventory is not eligible for return: deduction evidence is missing, conflicting or already reversed"); this.name = "OrderReturnEligibilityError"; }
}
export class OrderCancellationReturnConflictError extends Error {
  constructor() { super("Orders with active or completed returns cannot be cancelled"); this.name = "OrderCancellationReturnConflictError"; }
}

/** Serialize all return mutations with confirmation, cancellation, expiry and fulfilment. */
export async function lockReturnScope(tx: Prisma.TransactionClient, orderId: number, returnId?: number) {
  await tx.$queryRaw`SELECT id FROM "Order" WHERE id=${orderId} FOR NO KEY UPDATE`;
  if (returnId !== undefined) {
    await tx.$queryRaw`SELECT oi.id FROM "OrderItem" oi JOIN "OrderReturn" r ON r."orderItemId"=oi.id
      WHERE oi."orderId"=${orderId} AND r.id=${returnId} FOR UPDATE OF oi`;
    await tx.$queryRaw`SELECT r.id FROM "OrderReturn" r JOIN "OrderItem" oi ON oi.id=r."orderItemId"
      WHERE oi."orderId"=${orderId} AND r.id=${returnId} FOR UPDATE OF r`;
  }
}

/** Caller holds Order first. Include historical active returns even when their counters are missing. */
export async function hasBlockingOrderReturns(tx: Prisma.TransactionClient, orderId: number) {
  return !!await tx.orderItem.findFirst({ where: { orderId, OR: [
    { returnedQuantity: { not: 0 } }, { reservedReturnQuantity: { not: 0 } },
    { returns: { some: { status: { notIn: ["CANCELLED", "REJECTED"] } } } },
  ] }, select: { id: true } });
}

// Bounded per-process FIFO suppression: retain at most 1,000 orders for up to an hour.
// Other workers/restarts may emit again; no customer data or historical free text is logged.
const blockedReservationWarnings = new Map<number, number>();
export async function warnBlockedReturnReservation(tx: Prisma.TransactionClient, orderId: number, source: "EXPIRY" | "MANAGED_RELEASE") {
  const now = Date.now();
  for (const [id, expires] of blockedReservationWarnings) {
    if (expires <= now) blockedReservationWarnings.delete(id);
  }
  if (blockedReservationWarnings.has(orderId)) return;
  const order = await tx.order.findUnique({ where: { id: orderId }, select: { status: true } });
  if (order?.status !== "PENDING" || blockedReservationWarnings.has(orderId)) return;
  // Check capacity after the awaited read so concurrent calls also respect the bound.
  // Evict the oldest retained warning; an unseen affected order must always be visible.
  if (blockedReservationWarnings.size >= 1000) {
    blockedReservationWarnings.delete(blockedReservationWarnings.keys().next().value!);
  }
  blockedReservationWarnings.set(orderId, now + 60 * 60 * 1000);
  console.warn({
    event: "ORDER_RESERVATION_RELEASE_BLOCKED",
    orderId,
    source,
    reason: "CONFLICTING_HISTORICAL_RETURN_RECORDS_OR_COUNTERS",
  });
}

/** Exact writer-generated evidence; a paid/status flag alone never proves stock deduction. */
export async function assertReturnInventoryEligible(tx: Prisma.TransactionClient, orderId: number, orderItemId: number) {
  const order = await tx.order.findUnique({ where: { id: orderId }, include: { orderItems: { include: { returns: true } }, paymentResolution: true } });
  const item = order?.orderItems.find(i => i.id === orderItemId);
  if (!order || !item || !["CONFIRMED", "DISPATCHED", "COMPLETED", "RETURNED"].includes(order.status) || order.cancelledAt
    || order.paymentResolution?.reservationDisposition === "HELD" || order.paymentResolution?.reservationDisposition === "RELEASED") throw new OrderReturnEligibilityError();
  const peers = order.orderItems.filter(i => i.productListingId === item.productListingId);
  if (peers.some(i => i.quantity <= 0 || i.returnedQuantity < 0 || i.reservedReturnQuantity < 0 || i.returnedQuantity + i.reservedReturnQuantity > i.quantity)) throw new OrderReturnEligibilityError();
  // Missing or contradictory historical quantity bookkeeping is not reconstructed here.
  for (const peer of peers) {
    const completed = peer.returns.filter(r => r.status === "COMPLETED").reduce((n, r) => n + r.quantity, 0);
    const reserved = peer.returns.filter(r => !["COMPLETED", "CANCELLED", "REJECTED"].includes(r.status)).reduce((n, r) => n + r.quantity, 0);
    if (completed !== peer.returnedQuantity || reserved !== peer.reservedReturnQuantity) throw new OrderReturnEligibilityError();
  }
  const history = peers.flatMap(i => i.returns);
  if (history.some(r => r.quantity <= 0 || r.restockQuantity < 0 || r.restockQuantity > r.quantity)) throw new OrderReturnEligibilityError();
  if (history.length) {
    const returnNotes = history.map(r => `Completed order return ${r.id}`);
    const restorations = await tx.inventoryMovement.findMany({ where: {
      listingId: item.productListingId, type: "ORDER_RETURN", note: { in: returnNotes },
    }, select: { note: true, listingId: true, quantityChange: true } });
    // A scoped read alone would hide wrong-listing or duplicate historical evidence.
    if (await tx.inventoryMovement.findFirst({ where: {
      listingId: { not: item.productListingId }, type: "ORDER_RETURN", note: { in: returnNotes },
    }, select: { id: true } })) throw new OrderReturnEligibilityError();
    for (const returned of history) {
      const movements = restorations.filter(m => m.note === `Completed order return ${returned.id}`);
      const expected = returned.status === "COMPLETED" && returned.restockQuantity > 0;
      if (expected ? movements.length !== 1 || movements[0].listingId !== item.productListingId || movements[0].quantityChange !== returned.restockQuantity : movements.length !== 0) throw new OrderReturnEligibilityError();
    }
  }
  const sales = await tx.inventoryMovement.findMany({ where: { listingId: item.productListingId, type: "WEBSITE_SALE", note: `Order ${orderId} sale` }, select: { quantityChange: true } });
  const purchased = peers.reduce((n, i) => n + i.quantity, 0);
  if (sales.length !== peers.length || sales.some(m => m.quantityChange >= 0) || -sales.reduce((n, m) => n + m.quantityChange, 0) !== purchased) throw new OrderReturnEligibilityError();
  // This must remain order-wide: even a reversal on another listing is contradictory.
  // Any exact cancellation reversal for this order is contradictory, even if its status was later edited.
  if (await tx.inventoryMovement.findFirst({ where: { type: "ORDER_CANCELLATION_RETURN", note: `Order ${orderId} cancellation return` }, select: { id: true } })) throw new OrderReturnEligibilityError();
}
