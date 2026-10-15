export type AvailabilityStatus = "AVAILABLE" | "INSUFFICIENT_STOCK" | "OUT_OF_STOCK" | "UNAVAILABLE";
export type AvailabilityReason = "PRODUCT_UNPUBLISHED" | "LISTING_INACTIVE" | "USED_OFFER_UNAVAILABLE"
  | "OUT_OF_STOCK" | "INSUFFICIENT_STOCK" | "CART_QUANTITY_ALLOCATED" | "INVENTORY_RESERVATION_CONFLICT";

export interface ListingAvailability {
  status: AvailabilityStatus;
  reason: AvailabilityReason | null;
  availableQuantity: number;
}

interface LiveListing {
  active: boolean;
  condition: string;
  usedLifecycle: string | null;
  currentStock: number;
  reservedStock: number;
  legoProduct: { isPublished: boolean };
}

/** A projection only: never reserves stock, releases holds or edits shopping intent. */
export function listingAvailability(listing: LiveListing, requestedQuantity: number): ListingAvailability {
  if (!listing.legoProduct.isPublished) return { status: "UNAVAILABLE", reason: "PRODUCT_UNPUBLISHED", availableQuantity: 0 };
  if (!listing.active) return { status: "UNAVAILABLE", reason: "LISTING_INACTIVE", availableQuantity: 0 };
  if (listing.condition === "USED_LIKE_NEW" && listing.usedLifecycle !== "AVAILABLE") {
    return { status: "UNAVAILABLE", reason: "USED_OFFER_UNAVAILABLE", availableQuantity: 0 };
  }
  const availableQuantity = Math.max(0, listing.currentStock - listing.reservedStock);
  if (availableQuantity === 0) return { status: "OUT_OF_STOCK", reason: "OUT_OF_STOCK", availableQuantity };
  if (requestedQuantity > availableQuantity) return { status: "INSUFFICIENT_STOCK", reason: "INSUFFICIENT_STOCK", availableQuantity };
  return { status: "AVAILABLE", reason: null, availableQuantity };
}
