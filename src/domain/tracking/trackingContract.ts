import { z } from "zod";
import { createHash } from "node:crypto";
import type { ShippingCarrier } from "../../generated/prisma-client/enums.js";
import { normalizeTrackingNumber } from "../fulfilment/carriers.js";

const shortText = (max: number) => z.string().min(1).max(max).refine(value => value.trim().length > 0 && !/[\x00-\x1f\x7f]/.test(value));
export const CanonicalTrackingEventSchema = z.object({
  providerEventId: shortText(128),
  occurredAt: z.date().refine(value => Number.isFinite(value.getTime())),
  status: z.enum(["UNKNOWN", "DISPATCHED", "IN_TRANSIT", "DELIVERED", "EXCEPTION"]),
  exception: z.enum(["DELIVERY_ATTEMPT_FAILED", "ADDRESS_ISSUE", "DELAY", "DAMAGED", "RETURN_TO_SENDER", "UNKNOWN"]).nullable().default(null),
  providerStatus: shortText(128),
  deliveryConfirmed: z.boolean().default(false),
  deliveryAt: z.date().nullable().default(null),
  evidenceReference: shortText(128).nullable().default(null),
}).strict().refine(event => (event.status === "EXCEPTION") === (event.exception !== null), "Exception status/code must agree");
export const TrackingObservationSchema = z.object({
  carrier: z.enum(["ROYAL_MAIL", "EVRI", "DPD", "OTHER"]),
  providerIdentity: shortText(80),
  trackingNumber: shortText(100).transform(normalizeTrackingNumber),
  source: z.enum(["AUTHENTICATED_API", "VERIFIED_WEBHOOK", "TEST_FIXTURE"]),
  verified: z.boolean(),
  events: z.array(CanonicalTrackingEventSchema).max(100),
}).strict();
export type TrackingObservation = z.input<typeof TrackingObservationSchema>;
export type CanonicalTrackingEvent = z.output<typeof CanonicalTrackingEventSchema>;
export class TrackingConflictError extends Error {
  constructor(message: string, public readonly evidence?: { shipmentId: number; originalEventId: number; fingerprint: string;
    source: "AUTHENTICATED_API" | "VERIFIED_WEBHOOK" | "TEST_FIXTURE"; verified: boolean; normalized: Record<string,string|boolean|null> }) { super(message); }
}
export class TrackingEligibilityError extends Error {}
export class TrackingProviderError extends Error {
  constructor(public readonly code: "TEMPORARY" | "PERMANENT" | "RATE_LIMITED" | "TIMEOUT" | "ABORTED" | "INVALID_EVIDENCE") {
    super(`Carrier tracking ${code.toLowerCase()}`);
  }
}
export type TrackingRequest = { shipmentId: number; carrier: ShippingCarrier; trackingNumber: string };
/** Server-trusted code only. No HTTP ingestion endpoint accepts evidence or verified flags. */
export interface CarrierTrackingAdapter {
  readonly carrier: ShippingCarrier;
  readonly providerIdentity: string;
  readonly mode: "REAL" | "TEST";
  isAvailable(): boolean;
  track(request: TrackingRequest, signal: AbortSignal): Promise<TrackingObservation>;
}
export function eventFingerprint(carrier: ShippingCarrier, providerIdentity: string, trackingNumber: string,
  source: string, verified: boolean, event: CanonicalTrackingEvent) {
  return createHash("sha256").update(JSON.stringify({ carrier, providerIdentity, trackingNumber,
    providerEventId: event.providerEventId, occurredAt: event.occurredAt.toISOString(),
    providerStatus: event.providerStatus, deliveryAt: event.deliveryAt?.toISOString() ?? null,
    evidenceReference: event.evidenceReference })).digest("hex");
}
/** For carriers without stable IDs: adapter may derive a deterministic identity from immutable normalized fields. */
export function derivedProviderEventId(parts: readonly string[]) {
  return `derived:${createHash("sha256").update(JSON.stringify(parts)).digest("hex")}`;
}

/** Mappings must come from a reviewed provider contract; no real-carrier status guesses are built in. */
export function normalizeProviderStatus(code: string, reviewedMapping: ReadonlyMap<string, CanonicalTrackingEvent["status"]>) {
  return reviewedMapping.get(code) ?? "UNKNOWN";
}

/** Five seconds of carrier clock skew; timestamps beyond this remain retryably rejected. */
export const TRACKING_CLOCK_SKEW_MS = 5_000;
export function exceedsTrackingClockSkew(occurredAt: Date, receivedAt: Date) {
  return occurredAt.getTime() > receivedAt.getTime() + TRACKING_CLOCK_SKEW_MS;
}
export function evaluationKey(verified: boolean, event: CanonicalTrackingEvent, disposition: string, reason: string | null) {
  return createHash("sha256").update(JSON.stringify({verified, status:event.status, exception:event.exception,
    deliveryConfirmed:event.deliveryConfirmed, disposition, reason})).digest("hex");
}
