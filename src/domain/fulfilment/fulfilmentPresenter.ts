import type { FulfilmentStage, ShippingCarrier, TrackingStatus, TrackingException } from "../../generated/prisma-client/enums.js";
import { resolveCarrierName, trackingLink } from "./carriers.js";
import { fulfilmentStage } from "./fulfilmentService.js";

export const customerShipmentSelect = {
  select: { sequence: true, carrier: true, carrierName: true, trackingNumber: true, dispatchedAt: true,
    trackingState: { select: { progress: true, lastEventAt: true, exception: true, exceptionAt: true,
      lastEvent: { select: { verified: true, status: true, source: true, disposition: true } },
      deliveredEvent: { select: { verified: true, status: true, source: true, disposition: true, deliveryConfirmed: true, deliveryAt: true, occurredAt: true, evidenceReference: true } },
    } },
  },
  orderBy: { sequence: "asc" as const },
};

type SafeEvidence = { verified: boolean; status: TrackingStatus; source: string; disposition: string };
type TrackingStateRow = { progress: TrackingStatus; lastEventAt: Date | null; exception: TrackingException | null; exceptionAt: Date | null;
  lastEvent: SafeEvidence | null;
  deliveredEvent: (SafeEvidence & { deliveryConfirmed: boolean; deliveryAt: Date | null; occurredAt: Date; evidenceReference: string | null }) | null;
};
function trusted(evidence: SafeEvidence | null) {
  return evidence?.verified && evidence.disposition === "APPLIED" && (evidence.source !== "TEST_FIXTURE" || process.env.NODE_ENV === "test");
}
function carrierProgress(shipment: ShipmentRow): "DISPATCHED" | "IN_TRANSIT" | "DELIVERED" {
  const state = shipment.trackingState;
  if (!state) return "DISPATCHED";
  const proof = state.deliveredEvent;
  if (state.progress === "DELIVERED" && trusted(proof) && proof?.status === "DELIVERED" && proof.deliveryConfirmed && proof.evidenceReference
    && proof.deliveryAt?.getTime() === proof.occurredAt.getTime()) return "DELIVERED";
  if (state.progress === "IN_TRANSIT" && trusted(state.lastEvent) && state.lastEvent?.status === "IN_TRANSIT") return "IN_TRANSIT";
  return "DISPATCHED";
}
type ShipmentRow = { trackingState?: TrackingStateRow | null; sequence: number; carrier: ShippingCarrier | null; carrierName: string; trackingNumber: string | null; dispatchedAt: Date };
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
  const baseStage = fulfilmentStage(order);
  let stage: FulfilmentStage | null = baseStage;
  if (baseStage === "DISPATCHED" && order.shipments.length) {
    const progress = order.shipments.map(carrierProgress);
    if (progress.every(value => value === "DELIVERED")) stage = "DELIVERED";
    else if (progress.some(value => value !== "DISPATCHED")) stage = "IN_TRANSIT";
  }
  const rows: ShipmentRow[] = order.shipments.length || !order.dispatchedAt || stage !== "DISPATCHED"
    ? order.shipments
    : [{ sequence: 1, carrier: resolveCarrierName(order.shippingCarrier), carrierName: order.shippingCarrier ?? "",
      trackingNumber: order.trackingNumber, dispatchedAt: order.dispatchedAt }];
  return {
    stage,
    preparingAt: order.preparingAt,
    dispatchedAt: baseStage === "DISPATCHED" ? order.dispatchedAt : null,
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
        ...(shipment.trackingState ? { tracking: { progress: carrierProgress(shipment), lastEventAt: shipment.trackingState.lastEventAt,
          exception: shipment.trackingState.exception, exceptionAt: shipment.trackingState.exceptionAt,
          deliveredAt: carrierProgress(shipment) === "DELIVERED" ? shipment.trackingState.deliveredEvent!.deliveryAt : null } } : {}),
      };
    }),
  };
}
