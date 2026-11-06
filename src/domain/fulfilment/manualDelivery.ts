import { z } from "zod";
import type { Prisma } from "../../generated/prisma-client/client.js";
import { OrderStatus } from "../../generated/prisma-client/enums.js";
import { prisma } from "../../prisma/runtime.js";
import { customerShipmentSelect, presentFulfilment } from "./fulfilmentPresenter.js";
import { lockOrder } from "./fulfilmentService.js";
import { FulfilmentTransitionError, OrderAlreadyDeliveredError } from "./fulfilmentErrors.js";

/**
 * Manual delivery confirmation (V1, no carrier integration). The operator checks the
 * carrier's tracking website and confirms delivery. The confirmation is an append-only
 * OperationalAudit row per shipment; Order.status stays DISPATCHED, so refund, return
 * and cancellation rules keyed on Order.status are unchanged. Carrier tracking state is
 * never written: delivery is presented from this audit row, not from carrier evidence.
 */
export const MANUAL_DELIVERY_KIND = "MANUAL_DELIVERY_CONFIRMED";
/** Unique OperationalAudit.requestKey: the database rejects a second confirmation for a shipment. */
export const manualDeliveryKey = (shipmentId: number) => `manual-delivery:shipment:${shipmentId}`;

/** POST /admin/orders/:orderId/fulfilment/delivered. The operator must assert the manual check. */
export const ConfirmDeliverySchema = z.object({ verifiedOnCarrierWebsite: z.literal(true) }).strict();

export type ManualDelivery = { shipmentId: number; confirmedAt: Date; actorId: number | null };
type Reader = Pick<Prisma.TransactionClient, "operationalAudit">;

export async function readManualDeliveries(client: Reader, orderIds: number[]): Promise<Map<number, ManualDelivery>> {
  const deliveries = new Map<number, ManualDelivery>();
  if (!orderIds.length) return deliveries;
  const rows = await client.operationalAudit.findMany({
    where: { orderId: { in: orderIds }, kind: MANUAL_DELIVERY_KIND },
    select: { actorId: true, requestKey: true, details: true, createdAt: true }, orderBy: { id: "asc" },
  });
  for (const row of rows) {
    const shipmentId = (row.details as { shipmentId?: unknown } | null)?.shipmentId;
    // Only rows written by confirmManualDelivery (matching unique key) are trusted.
    if (typeof shipmentId !== "number" || row.requestKey !== manualDeliveryKey(shipmentId) || deliveries.has(shipmentId)) continue;
    deliveries.set(shipmentId, { shipmentId, confirmedAt: row.createdAt, actorId: row.actorId });
  }
  return deliveries;
}

/** Adds manualDeliveredAt to each shipment row so presentFulfilment can report DELIVERED. */
type Delivered<O extends { shipments: Array<{ id: number }> }> = { [K in keyof O]: K extends "shipments" ? Array<O["shipments"][number] & { manualDeliveredAt: Date | null }> : O[K] };
export function withManualDeliveries<O extends { shipments: Array<{ id: number }> }>(order: O, deliveries: Map<number, ManualDelivery>): Delivered<O> {
  return { ...order, shipments: order.shipments.map(s => ({ ...s, manualDeliveredAt: deliveries.get(s.id)?.confirmedAt ?? null })) } as Delivered<O>;
}

/** DISPATCHED -> DELIVERED for every undelivered shipment, recording operator and database time. */
export async function confirmManualDelivery(performedByUserId: number, orderId: number) {
  return prisma.$transaction(async (tx) => {
    // Same non-key Order lock as dispatch: concurrent confirmations serialize here.
    const order = await lockOrder(tx, orderId);
    if (order.status !== OrderStatus.DISPATCHED || !order.dispatchedAt) {
      throw new FulfilmentTransitionError(orderId, order.status, "DELIVERED");
    }
    const shipments = await tx.shipment.findMany({ where: { orderId }, ...customerShipmentSelect,
      select: { ...customerShipmentSelect.select, id: true } });
    // Legacy dispatches without a Shipment row have no shipment reference to confirm.
    if (!shipments.length) throw new FulfilmentTransitionError(orderId, "DISPATCHED (no shipment record)", "DELIVERED");
    const delivered = withManualDeliveries({ ...order, shipments }, await readManualDeliveries(tx, [orderId]));
    const view = presentFulfilment(delivered);
    if (view.stage === "DELIVERED") throw new OrderAlreadyDeliveredError(orderId);
    const pending = delivered.shipments.filter((_s, i) => { const row = view.shipments[i]; return !(row && "tracking" in row && row.tracking.progress === "DELIVERED"); });
    for (const shipment of pending) {
      await tx.operationalAudit.create({ data: {
        kind: MANUAL_DELIVERY_KIND, actorId: performedByUserId, orderId, requestKey: manualDeliveryKey(shipment.id),
        details: { shipmentId: shipment.id, shipmentSequence: shipment.sequence, carrier: shipment.carrier,
          carrierName: shipment.carrierName, trackingNumber: shipment.trackingNumber,
          verification: "OPERATOR_CHECKED_CARRIER_TRACKING_WEBSITE", source: "ADMIN_FULFILMENT_API" },
      } });
    }
    return { changed: true, shipments: pending.length };
  });
}
