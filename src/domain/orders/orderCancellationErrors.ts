// Domain error types for order cancellation flow.
// These mirror the style used in other domain modules.

export class OrderNotFoundError extends Error {
  constructor(orderId: number) {
    super(`Order with id ${orderId} not found or does not belong to user`);
    this.name = "OrderNotFoundError";
  }
}

export class OrderNotCancellableError extends Error {
  constructor(orderId: number, status: string) {
    super(`Order ${orderId} cannot be cancelled in its current status: ${status}`);
    this.name = "OrderNotCancellableError";
  }
}

export class InsufficientReservedStockError extends Error {
  constructor(productListingId: number, quantity: number) {
    super(`Insufficient reserved stock for product listing ${productListingId}: required ${quantity}`);
    this.name = "InsufficientReservedStockError";
  }
}

export class OrderCancellationPaymentError extends Error {
  constructor(public readonly paid: boolean) {
    super(paid ? "Paid orders cannot be seller-cancelled" : "Orders with an existing payment attempt cannot be seller-cancelled");
    this.name = "OrderCancellationPaymentError";
  }
}
