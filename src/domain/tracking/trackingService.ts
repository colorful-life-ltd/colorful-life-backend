import { prisma } from "../../prisma/runtime.js";
import type { Prisma } from "../../generated/prisma-client/client.js";
import { databaseNow } from "../payments/paymentResolutionService.js";
import { isValidTrackingNumber, normalizeTrackingNumber } from "../fulfilment/carriers.js";
import { eventFingerprint, evaluationKey, exceedsTrackingClockSkew, TrackingConflictError, TrackingEligibilityError, TrackingObservationSchema, type TrackingObservation } from "./trackingContract.js";

const rank = { DISPATCHED: 0, IN_TRANSIT: 1, DELIVERED: 2 } as const;
export async function lockTrackingShipment(tx: Prisma.TransactionClient, shipmentId: number) {
  const candidate = await tx.shipment.findUnique({ where: { id: shipmentId }, select: { orderId: true } });
  if (!candidate) throw new TrackingEligibilityError("Shipment not found");
  // Same non-key Order lock as Phase 1: compatible with refund Order FK key-share locks.
  await tx.$queryRaw`SELECT id FROM "Order" WHERE id=${candidate.orderId} FOR NO KEY UPDATE`;
  await tx.$queryRaw`SELECT id FROM "Shipment" WHERE id=${shipmentId} FOR UPDATE`;
  return tx.shipment.findUniqueOrThrow({ where: { id: shipmentId }, include: { order: true } });
}
export async function ingestTrackingObservationInTransaction(tx: Prisma.TransactionClient, shipmentId: number, input: TrackingObservation) {
  const observation = TrackingObservationSchema.parse(input);
  if (observation.source === "TEST_FIXTURE" && process.env.NODE_ENV !== "test") throw new TrackingEligibilityError("Test evidence is forbidden");
  const shipment = await lockTrackingShipment(tx, shipmentId);
  if (!shipment.order.dispatchedAt || !shipment.trackingNumber || !shipment.carrier || shipment.carrier === "OTHER"
    || !isValidTrackingNumber(shipment.carrier, normalizeTrackingNumber(shipment.trackingNumber))
    || shipment.carrier !== observation.carrier || normalizeTrackingNumber(shipment.trackingNumber) !== observation.trackingNumber) {
    throw new TrackingEligibilityError("Shipment/canonical observation identity mismatch");
  }
  const sync = await tx.shipmentTrackingSync.findUnique({ where: { shipmentId } });
  if (sync && sync.providerIdentity !== observation.providerIdentity) throw new TrackingEligibilityError("Tracking provider/account identity mismatch");
  const receivedAt = await databaseNow(tx);
  let state = await tx.shipmentTrackingState.findUnique({ where: { shipmentId } })
    ?? await tx.shipmentTrackingState.create({ data: { shipmentId } });
  let applied = 0, duplicates = 0, conflicts = 0;
  // Deterministic chronological processing; movement then exceptions then delivery for ties.
  const events = [...observation.events].sort((a,b) => a.occurredAt.getTime()-b.occurredAt.getTime()
    || ((a.status === "DELIVERED" ? 3 : a.status === "EXCEPTION" ? 2 : 1)-(b.status === "DELIVERED" ? 3 : b.status === "EXCEPTION" ? 2 : 1))
    || (a.providerEventId < b.providerEventId ? -1 : a.providerEventId > b.providerEventId ? 1 : 0));
  for (const event of events) {
    const fingerprint = eventFingerprint(observation.carrier, observation.providerIdentity, observation.trackingNumber, observation.source, observation.verified, event);
    const identity = { shipmentId, providerIdentity: observation.providerIdentity, providerEventId: event.providerEventId };
    const history = await tx.shipmentTrackingEvent.findMany({ where: identity, orderBy: { id: "asc" } });
    let evidence = await tx.shipmentCarrierEvidence.findUnique({ where: { shipmentId_providerIdentity_providerEventId: identity } });
    if (!evidence) {
      // Adopt original stable fields without rewriting a pre-remediation evaluation or its hash.
      const original = history[0] ?? event;
      evidence = await tx.shipmentCarrierEvidence.create({ data: { ...identity, carrier: observation.carrier,
        trackingNumber: observation.trackingNumber, occurredAt: original.occurredAt, providerStatus: original.providerStatus,
        deliveryAt: original.deliveryAt, evidenceReference: original.evidenceReference, receivedAt,
        fingerprint: eventFingerprint(observation.carrier, observation.providerIdentity, observation.trackingNumber,
          observation.source, observation.verified, original as typeof event) } });
    }
    if (evidence.fingerprint !== fingerprint) {
      const original = history[0];
      if (!original) throw new TrackingEligibilityError("Carrier evidence has no evaluation history");
      await persistTrackingConflictInTransaction(tx, new TrackingConflictError("Conflicting carrier event identity", {
        shipmentId, originalEventId: original.id, fingerprint, source: observation.source, verified: observation.verified,
        normalized: { providerEventId: event.providerEventId, occurredAt: event.occurredAt.toISOString(),
          status: event.status, exception: event.exception, providerStatus: event.providerStatus,
          deliveryConfirmed: event.deliveryConfirmed, deliveryAt: event.deliveryAt?.toISOString() ?? null,
          evidenceReference: event.evidenceReference } }));
      conflicts++; continue; // Independent events in this batch must still be evaluated.
    }
    const previous = history.at(-1);
    const retryable = previous?.disposition === "UNKNOWN" || previous?.disposition === "REJECTED"
      && ["UNVERIFIED", "FUTURE_EVENT", "MISSING_DELIVERY_CONFIRMATION"].includes(previous.reason ?? "");
    if (previous && (!retryable || history.some(row => row.disposition === "APPLIED"))) { duplicates++; continue; }
    let disposition: "APPLIED" | "REJECTED" | "STALE" | "UNKNOWN" = "APPLIED";
    let reason: string | null = null;
    const reject = (value: string) => { disposition = "REJECTED"; reason = value; };
    if (!observation.verified) reject("UNVERIFIED");
    else if (!["DISPATCHED","COMPLETED","RETURNED"].includes(shipment.order.status)) reject("ORDER_INELIGIBLE");
    else if (event.occurredAt < shipment.dispatchedAt) reject("BEFORE_DISPATCH");
    else if (exceedsTrackingClockSkew(event.occurredAt, receivedAt)) reject("FUTURE_EVENT");
    else if (event.status === "UNKNOWN") { disposition = "UNKNOWN"; reason = "UNKNOWN_PROVIDER_STATUS"; }
    else if (event.status === "DELIVERED" && (!event.deliveryConfirmed || !event.deliveryAt || event.deliveryAt.getTime() !== event.occurredAt.getTime() || !event.evidenceReference)) reject("MISSING_DELIVERY_CONFIRMATION");
    else if (state.progress === "DELIVERED") {
      const proof = state.deliveredEventId ? await tx.shipmentTrackingEvent.findUnique({ where: { id: state.deliveredEventId } }) : null;
      if (event.status === "DELIVERED" && (proof?.deliveryAt?.getTime() !== event.deliveryAt?.getTime() || proof?.evidenceReference !== event.evidenceReference)) reject("DELIVERY_CONFLICT");
      else { disposition = "STALE"; reason = "TERMINAL_PROGRESS"; }
    } else if (state.lastEventAt && event.occurredAt < state.lastEventAt
      || (event.status === "EXCEPTION" || event.status === "DELIVERED") && state.exceptionAt && event.occurredAt < state.exceptionAt
      || event.status !== "EXCEPTION" && rank[event.status] < rank[state.progress as keyof typeof rank]) {
      disposition = "STALE"; reason = "OLDER_OR_LOWER_PROGRESS";
    }
    const key = evaluationKey(observation.verified, event, disposition, reason);
    if (history.some(row => row.evaluationKey === key)) { duplicates++; continue; }
    const row = await tx.shipmentTrackingEvent.create({ data: { shipmentId, ...event,
      carrier: observation.carrier, providerIdentity: observation.providerIdentity, trackingNumber: observation.trackingNumber,
      source: observation.source, verified: observation.verified, verifiedAt: observation.verified ? receivedAt : null,
      receivedAt, fingerprint, evidenceId: evidence.id, evaluationKey: key, disposition, reason } });
    if (disposition !== "APPLIED") continue;
    applied++;
    if (event.status === "EXCEPTION") {
      state = await tx.shipmentTrackingState.update({ where: { shipmentId }, data: { exception: event.exception, exceptionAt: event.occurredAt, version: { increment: 1 } } });
    } else if (event.status !== "UNKNOWN") {
      const clearException = !state.exceptionAt || event.occurredAt > state.exceptionAt || event.status === "DELIVERED" && event.occurredAt >= state.exceptionAt;
      state = await tx.shipmentTrackingState.update({ where: { shipmentId }, data: { progress: event.status, lastEventAt: event.occurredAt,
        lastEventId: row.id, ...(event.status === "DELIVERED" ? { deliveredEventId: row.id } : {}),
        ...(clearException ? { exception: null, exceptionAt: null } : {}), version: { increment: 1 } } });
    }
  }
  return { applied, duplicates, conflicts, received: events.length };
}
export async function ingestTrackingObservation(shipmentId: number, observation: TrackingObservation) {
  return prisma.$transaction(tx => ingestTrackingObservationInTransaction(tx, shipmentId, observation));
}

async function persistTrackingConflictInTransaction(tx: Prisma.TransactionClient, error: TrackingConflictError) {
  const evidence = error.evidence;
  if (!evidence) return;
  const original = await tx.shipmentTrackingEvent.findUniqueOrThrow({ where: { id: evidence.originalEventId } });
  if (original.shipmentId !== evidence.shipmentId) throw new TrackingEligibilityError("Conflict shipment mismatch");
  if (!await tx.shipmentTrackingConflict.findUnique({ where: { originalEventId_fingerprint: { originalEventId: original.id, fingerprint: evidence.fingerprint } } })) {
    await tx.shipmentTrackingConflict.create({ data: { originalEventId: original.id, fingerprint: evidence.fingerprint,
      source: evidence.source, verified: evidence.verified, normalized: evidence.normalized, receivedAt: await databaseNow(tx) } });
  }
}
export async function persistTrackingConflict(error: TrackingConflictError) {
  if (!error.evidence) return;
  await prisma.$transaction(async tx => {
    await lockTrackingShipment(tx, error.evidence!.shipmentId);
    await persistTrackingConflictInTransaction(tx, error);
  });
}
