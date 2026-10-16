import { Decimal } from "@prisma/client/runtime/client";
import { z } from "zod";
import { deliverySchema } from "../orderConfirmation/contract.js";

export const shippingMethodSchema = z.enum(["STANDARD", "EXPRESS"]);
export type ShippingMethod = z.infer<typeof shippingMethodSchema>;
// This catalogue prices NEW orders only. Reads and payment retries use frozen order data.
const offers = {
  STANDARD: { method: "Standard Delivery", chargePence: 399, minWorkingDays: 3, maxWorkingDays: 5, estimatesFrom: "DISPATCH" as const },
  EXPRESS: { method: "Express Delivery", chargePence: 799, minWorkingDays: 1, maxWorkingDays: 3, estimatesFrom: "DISPATCH" as const },
} satisfies Record<ShippingMethod, z.infer<typeof deliverySchema>>;
export function resolveShipping(method: ShippingMethod): z.infer<typeof deliverySchema> {
  return { ...offers[shippingMethodSchema.parse(method)] };
}
export function shippingOptions() {
  return { currency: "GBP" as const, methods: shippingMethodSchema.options.map(code => ({ code, ...resolveShipping(code) })) };
}

/** No catalogue repricing or guessed free shipping for historical/inconsistent data. */
export function orderFinancials(order: {
  totalAmount: Decimal; confirmationDeliverySnapshot: unknown; orderItems: Array<{ lineTotal: Decimal }>;
}) {
  const subtotal = order.orderItems.reduce((sum, item) => sum.add(item.lineTotal), new Decimal(0));
  const parsed = deliverySchema.safeParse(order.confirmationDeliverySnapshot);
  const shipping = parsed.success && subtotal.add(new Decimal(parsed.data.chargePence).div(100)).equals(order.totalAmount)
    ? parsed.data : null;
  return {
    merchandiseSubtotal: subtotal.toFixed(2),
    shipping: shipping ? {
      // Identity derives from the frozen label, never from today's price/estimate catalogue.
      code: shipping.method === "Standard Delivery" ? "STANDARD" as const : shipping.method === "Express Delivery" ? "EXPRESS" as const : null,
      ...shipping,
    } : null,
    totalAmount: order.totalAmount.toFixed(2),
    currency: "GBP" as const,
  };
}
