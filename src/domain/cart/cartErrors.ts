export class CartAccountUnavailableError extends Error {
  constructor() { super("Account unavailable"); this.name = "CartAccountUnavailableError"; }
}

export class CartItemNotFoundError extends Error {
  constructor() { super("Cart item not found"); this.name = "CartItemNotFoundError"; }
}

export class ProductListingNotFoundError extends Error {
  constructor(public readonly productListingId: number) { super(`Product listing ${productListingId} not found`); this.name = "ProductListingNotFoundError"; }
}

export class ProductListingInactiveError extends Error {
  constructor(public readonly productListingId: number) { super(`Product listing ${productListingId} is inactive`); this.name = "ProductListingInactiveError"; }
}

export class InsufficientAvailableStockError extends Error {
  constructor(public readonly productListingId: number, public readonly availableStock: number, public readonly requestedQuantity: number) { super(`Insufficient available stock for product listing ${productListingId}`); this.name = "InsufficientAvailableStockError"; }
}
