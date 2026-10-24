import { z } from "zod";

// -----------------------------------------------------------------------------
// Zod schemas for the manual purchase request body.
// The schema mirrors the fields required by the existing normalisation
// logic.  Optional dates are accepted as ISO‑8601 strings – they are parsed
// into Date objects later in the service.
// -----------------------------------------------------------------------------

// Optional ISO 8601 date string (YYYY‑MM‑DD or full ISO) – validated by
// attempting to parse with Date.parse.  Undefined is allowed.
const OptionalISODateString = z
  .string()
  .refine((s) => !isNaN(Date.parse(s)), {
    message: "Invalid ISO date string",
  })
  .optional();

// Individual purchase item – mirrors NormalizedPurchaseItem.
export const PurchaseItemSchema = z.object({
  sourceDescription: z.string().min(1, { message: "sourceDescription is required" }),
  quantity: z.number().int().positive({ message: "quantity must be a positive integer" }),
  originalGrossUnitCost: z
    .number()
    .int()
    .nonnegative({ message: "originalGrossUnitCost must be non‑negative" }),
  originalGrossLineTotal: z
    .number()
    .int()
    .nonnegative({ message: "originalGrossLineTotal must be non‑negative" }),
  externalProductId: z.string().optional(),
  productListingId: z.number().int().positive().optional(),
  sourceSetNumber: z.string().optional(),
  sourceLineNumber: z.number().int().positive().optional(),
});

// Top‑level manual purchase request.
export const ManualPurchaseSchema = z.object({
  sourceOrderReference: z.string().min(1, { message: "sourceOrderReference is required" }),
  sourceOrderDate: OptionalISODateString,
  merchantName: z.string().optional(),
  sourceInvoiceReference: z.string().optional(),
  sourceDocumentDate: OptionalISODateString,
  originalGrossMerchandiseTotal: z
    .number()
    .int()
    .nonnegative({ message: "originalGrossMerchandiseTotal must be non‑negative" }),
  shippingTotal: z.number().int().nonnegative().optional(),
  discountTotal: z.number().int().nonnegative().optional(),
  finalTotalPaid: z
    .number()
    .int()
    .nonnegative({ message: "finalTotalPaid must be non‑negative" }),
  items: z.array(PurchaseItemSchema).max(500, { message: "at most 500 purchase items are supported" }).min(1, { message: "items array must contain at least one item" }),
});

// Export the inferred TypeScript type for convenience.
export type ManualPurchaseInput = z.infer<typeof ManualPurchaseSchema>;
