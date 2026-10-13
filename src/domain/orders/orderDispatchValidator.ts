import { z } from "zod";

// Validation schema for the dispatch order request body.
// Shipping cost is the actual cost paid by the seller.
export const DispatchOrderSchema = z
  .object({
    actualShippingCost: z.number().nonnegative(),
    shippingCarrier: z
      .string()
      .transform((s) => s.trim())
      .refine((s) => s.length > 0, { message: "Shipping carrier cannot be empty" })
      .refine((s) => s.length <= 100, { message: "Shipping carrier must be at most 100 characters" }),
    trackingNumber: z
      .string()
      .optional()
      .transform((s) => (s ? s.trim() || undefined : undefined))
      .refine((s) => s === undefined || s.length <= 100, { message: "Tracking number must be at most 100 characters" }),
  })
  .strict();
