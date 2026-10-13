import type { ShippingCarrier } from "../../generated/prisma-client/enums.js";
import { resolveCarrierName, trackingLink } from "./carriers.js";
import { fulfilmentStage } from "./fulfilmentService.js";

export const customerShipmentSelect = {
  select: { sequence: true, carrier: true, carrierName: true, trackingNumber: true, dispatchedAt: true },
  orderBy: { sequence: "asc" as const },
};

type ShipmentRow = { sequence: number; carrier: ShippingCarrier | null; carrierName: string; trackingNumber: string | null; dispatchedAt: Date };
type FulfilmentSource = {
  status: string;
  preparingAt: Date | null;
  dispatchedAt: Date | null;
  shippingCarrier: string | null;
  trackingNumber: string | null;
  shipments: ShipmentRow[];
};

/**
 * Customer-safe fulfilment progress. Legacy dispatches recorded before
 * shipments existed are presented from the Order's shipping fields; links are
 * produced only from trusted carrier templates and validated numbers.
 */
export function presentFulfilment(order: FulfilmentSource) {
  const stage = fulfilmentStage(order);
  const rows: ShipmentRow[] = order.shipments.length || !order.dispatchedAt || stage !== "DISPATCHED"
    ? order.shipments
    : [{ sequence: 1, carrier: resolveCarrierName(order.shippingCarrier), carrierName: order.shippingCarrier ?? "",
      trackingNumber: order.trackingNumber, dispatchedAt: order.dispatchedAt }];
  return {
    stage,
    preparingAt: order.preparingAt,
    dispatchedAt: stage === "DISPATCHED" ? order.dispatchedAt : null,
    shipments: rows.map((shipment) => {
      const link = trackingLink(shipment.carrier, shipment.trackingNumber);
      return {
        sequence: shipment.sequence,
        carrier: shipment.carrier,
        carrierName: shipment.carrierName,
        trackingNumber: shipment.trackingNumber,
        dispatchedAt: shipment.dispatchedAt,
        trackingUrl: link?.url ?? null,
        trackingUrlIncludesNumber: link?.includesTrackingNumber ?? false,
      };
    }),
  };
}
