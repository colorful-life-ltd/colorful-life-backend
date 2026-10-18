import { Decimal } from "@prisma/client/runtime/client";
import { z } from "zod";

export const priceMessage = "Selling prices must be greater than £0 and use whole pennies. Leave the optional sale price empty to use the regular price.";

/** Check persisted Decimals as well as input, without rounding an invalid price into validity. */
export function isPositivePrice(value: unknown): boolean {
  if (typeof value !== "number" && typeof value !== "string" && !Decimal.isDecimal(value)) return false;
  try {
    const price = new Decimal(value as Decimal.Value);
    return price.isFinite() && price.gt(0) && price.decimalPlaces() <= 2;
  } catch { return false; }
}

export const positivePriceSchema = z.number().refine(isPositivePrice, priceMessage);
export const salePriceSchema = positivePriceSchema.nullable().optional();

export function hasValidListingPrices(listing: { originalPrice: unknown; salePrice?: unknown }): boolean {
  return isPositivePrice(listing.originalPrice) &&
    (listing.salePrice === undefined || listing.salePrice === null || isPositivePrice(listing.salePrice));
}

export class InvalidListingPriceError extends Error {
  constructor(public readonly productListingId: number) {
    super("This listing has an invalid selling price and cannot be purchased. Please contact support.");
  }
}
