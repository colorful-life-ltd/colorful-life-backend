import type { ShippingCarrier } from "../../generated/prisma-client/enums.js";

type CarrierDefinition = {
  name: string;
  /** Lower-case free-text names that identify this carrier on legacy dispatches. */
  aliases: readonly string[];
  /** Normalised tracking number format accepted for this carrier. */
  trackingPattern: RegExp;
  /** Official tracking page. Only templates verified to accept the number embed it. */
  trackingUrl: (trackingNumber: string) => { url: string; includesTrackingNumber: boolean };
};

/**
 * Trusted carrier mappings. Tracking links are only ever built from these
 * templates with a validated, URL-encoded tracking number; user-supplied URLs
 * are never accepted or stored.
 */
export const CARRIERS: Record<ShippingCarrier, CarrierDefinition> = {
  ROYAL_MAIL: {
    name: "Royal Mail",
    aliases: ["royal mail", "royalmail"],
    // UPU S10 numbers issued by Royal Mail, e.g. AB123456789GB.
    trackingPattern: /^[A-Z]{2}\d{9}GB$/,
    trackingUrl: (number) => ({
      url: `https://www.royalmail.com/track-your-item#/tracking-results/${encodeURIComponent(number)}`,
      includesTrackingNumber: true,
    }),
  },
  EVRI: {
    name: "Evri",
    aliases: ["evri", "hermes"],
    trackingPattern: /^[A-Z0-9]{16}$/,
    // No verified deep-link template: link to the official tracking page.
    trackingUrl: () => ({ url: "https://www.evri.com/track-a-parcel", includesTrackingNumber: false }),
  },
  DPD: {
    name: "DPD",
    aliases: ["dpd", "dpd uk"],
    trackingPattern: /^\d{14}$/,
    trackingUrl: () => ({ url: "https://www.dpd.co.uk/", includesTrackingNumber: false }),
  },
  OTHER: {
    name: "Other carrier",
    aliases: [],
    trackingPattern: /^[A-Z0-9]{6,40}$/,
    trackingUrl: () => { throw new Error("OTHER carrier has no trusted tracking page"); },
  },
};

export const TRUSTED_CARRIERS = Object.keys(CARRIERS) as ShippingCarrier[];

/** Uppercase and remove spaces and hyphens, which carriers print for readability. */
export function normalizeTrackingNumber(value: string) {
  return value.trim().replace(/[\s-]+/g, "").toUpperCase();
}

export function isValidTrackingNumber(carrier: ShippingCarrier, normalized: string) {
  return CARRIERS[carrier].trackingPattern.test(normalized);
}

/** Maps a legacy free-text carrier name to a trusted carrier, if it is unambiguous. */
export function resolveCarrierName(name: string | null | undefined): ShippingCarrier | null {
  const key = name?.trim().toLowerCase().replace(/\s+/g, " ");
  if (!key) return null;
  return TRUSTED_CARRIERS.find((code) => CARRIERS[code].aliases.includes(key)) ?? null;
}

/**
 * Customer-facing tracking link. Returns null unless the carrier is trusted,
 * has an official page, and the stored number is valid for that carrier, so
 * historical free-text data can never produce a link to an arbitrary site.
 */
export function trackingLink(carrier: ShippingCarrier | null, trackingNumber: string | null) {
  if (!carrier || carrier === "OTHER" || !trackingNumber) return null;
  const normalized = normalizeTrackingNumber(trackingNumber);
  if (!isValidTrackingNumber(carrier, normalized)) return null;
  return CARRIERS[carrier].trackingUrl(normalized);
}
