import { z } from "zod";
import { shippingMethodSchema } from "./shipping.js";

// -----------------------------------------------------------------------------
// Delivery address validation
// -----------------------------------------------------------------------------
export const DeliveryAddressSchema = z.object({
  recipientName: z
    .string()
    .trim()
    .min(1, { message: "recipientName cannot be empty" }),
  line1: z
    .string()
    .trim()
    .min(1, { message: "line1 cannot be empty" }),
  line2: z.string().optional(),
  city: z
    .string()
    .trim()
    .min(1, { message: "city cannot be empty" }),
  county: z.string().optional(),
  postcode: z
    .string()
    .trim()
    .min(1, { message: "postcode cannot be empty" }),
  countryCode: z
    .string()
    .trim()
    .length(2, { message: "countryCode must be exactly 2 characters" }),
  phone: z.string().optional(),
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
    .min(1, { message: "at least one order item is required" }),
  deliveryAddress: DeliveryAddressSchema.optional(),
}).strict();

// Export the inferred input type for use in services
export type CreateOrderInput = z.infer<typeof CreateOrderSchema>;
