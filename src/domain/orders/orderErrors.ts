import type { AvailabilityReason } from "../inventory/listingAvailability.js";

// Custom domain error classes for Order creation
// Follow the style used in the existing purchase error module

// -----------------------------------------------------------------------------
// Address related errors
// -----------------------------------------------------------------------------
export class NoDefaultBillingAddressError extends Error {
  constructor() {
    super("No default billing address found for the user");
    this.name = "NoDefaultBillingAddressError";
  }
}

export class MultipleDefaultBillingAddressesError extends Error {
  constructor() {
    super("Multiple default billing addresses found for the user");
    this.name = "MultipleDefaultBillingAddressesError";
  }
}

export class InvalidBillingAddressCountryError extends Error {
  constructor() {
    super("The default billing address country is not recognised. Please update your billing address");
    this.name = "InvalidBillingAddressCountryError";
  }
}

export class EmailVerificationRequiredError extends Error {
  constructor() {
    super("Email verification is required before creating an order");
    this.name = "EmailVerificationRequiredError";
  }
}

export class OrderUserNotFoundError extends Error {
  constructor() {
    super("User not found");
    this.name = "OrderUserNotFoundError";
  }
}

// -----------------------------------------------------------------------------
// Product listing related errors
// -----------------------------------------------------------------------------
export class ProductListingNotFoundError extends Error {
  constructor(public readonly productListingId: number) {
    super(`Product listing with id ${productListingId} does not exist`);
    this.name = "ProductListingNotFoundError";
  }
}

export class ProductListingInactiveError extends Error {
  constructor(public readonly productListingId: number, public readonly reason: AvailabilityReason = "LISTING_INACTIVE") {
    super(`Product listing with id ${productListingId} is inactive`);
    this.name = "ProductListingInactiveError";
  }
}

export class InsufficientAvailableStockError extends Error {
  constructor(public readonly productListingId: number, public readonly requestedQuantity: number, public readonly availableQuantity?: number) {
    super(`Insufficient available stock for product listing ${productListingId} (requested ${requestedQuantity})`);
    this.name = "InsufficientAvailableStockError";
  }
}

// -----------------------------------------------------------------------------
// Order item duplicate error
// -----------------------------------------------------------------------------
export class DuplicateProductListingError extends Error {
  constructor(productListingId: number) {
    super(`Duplicate product listing id ${productListingId} in order items`);
    this.name = "DuplicateProductListingError";
  }
}
