import {customerLimits,normalizePostcode,validPostcode,validPhone} from "../../utils/customerInput.js";
import { z } from "zod";
import { shippingMethodSchema } from "./shipping.js";
import { normalizeCountryCode } from "../addresses/countryCode.js";

// -----------------------------------------------------------------------------
// Delivery address validation
// -----------------------------------------------------------------------------
export const DeliveryAddressSchema = z.object({
  recipientName: z
    .string()
    .trim()
    .min(1, { message: "recipientName cannot be empty" }).max(customerLimits.recipientName),
  line1: z
    .string()
    .trim()
    .min(1, { message: "line1 cannot be empty" }).max(customerLimits.line1),
  line2: z.string().trim().max(customerLimits.line2).optional(),
  city: z
    .string()
    .trim()
    .min(1, { message: "city cannot be empty" }).max(customerLimits.city),
  county: z.string().trim().max(customerLimits.county).optional(),
  postcode: z.string().transform(normalizePostcode).pipe(
    z.string().min(1, { message: "postcode cannot be empty" }).max(customerLimits.postcode).refine(validPostcode)),
  // Snapshots must hold an ISO code: commercial invoices reject anything else.
  countryCode: z
    .string()
    .trim()
    .transform((value, ctx) => {
      const code = value.length === 2 ? normalizeCountryCode(value) : null;
      if (code!=="GB") { ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Delivery is supported only in GB" }); return z.NEVER; }
      return code;
    }),
  phone: z.string().trim().max(customerLimits.phone).refine(validPhone).optional(),
});

// -----------------------------------------------------------------------------
// Order item validation
// -----------------------------------------------------------------------------
export const OrderItemSchema = z.object({
  productListingId: z
    .number()
    .int()
    .positive({ message: "productListingId must be a positive integer" }),
  quantity: z
    .number()
    .int()
    .positive({ message: "quantity must be a positive integer" }),
});

// -----------------------------------------------------------------------------
// Full order creation validation
// -----------------------------------------------------------------------------
export const CreateOrderSchema = z.object({
  shippingMethod: shippingMethodSchema,
  items: z
    .array(OrderItemSchema)
    .max(500, { message: "at most 500 order items are supported" })
    .min(1, { message: "at least one order item is required" }),
  deliveryAddress: DeliveryAddressSchema.optional(),
}).strict();

// Export the inferred input type for use in services
export type CreateOrderInput = z.infer<typeof CreateOrderSchema>;
