import { z } from "zod";
import { CARRIERS, TRUSTED_CARRIERS, isValidTrackingNumber, normalizeTrackingNumber } from "./carriers.js";
import type { ShippingCarrier } from "../../generated/prisma-client/enums.js";

/** POST /admin/orders/:orderId/fulfilment/preparing takes no fields. */
export const StartPreparingSchema = z.object({}).strict();

/**
 * POST /admin/orders/:orderId/fulfilment/dispatch. The carrier must be a
 * trusted code; tracking numbers are normalised and validated per carrier.
 * carrierName is only accepted (and required) for OTHER. No URLs are accepted.
 */
export const DispatchShipmentSchema = z
  .object({
    carrier: z.enum(TRUSTED_CARRIERS as [ShippingCarrier, ...ShippingCarrier[]]),
    carrierName: z.string().trim().min(1).max(100).optional(),
    trackingNumber: z.string().max(100),
    actualShippingCost: z.number().nonnegative().max(100000),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.carrier === "OTHER" && !value.carrierName) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["carrierName"], message: "carrierName is required for OTHER" });
    }
    if (value.carrier !== "OTHER" && value.carrierName !== undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["carrierName"], message: "carrierName is only accepted for OTHER" });
    }
    if (!isValidTrackingNumber(value.carrier, normalizeTrackingNumber(value.trackingNumber))) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["trackingNumber"], message: `Invalid tracking number for ${value.carrier}` });
    }
  })
  .transform((value) => ({
    carrier: value.carrier,
    carrierName: value.carrier === "OTHER" ? value.carrierName! : CARRIERS[value.carrier].name,
    trackingNumber: normalizeTrackingNumber(value.trackingNumber),
    actualShippingCost: value.actualShippingCost,
  }));
