export class FulfilmentOrderNotFoundError extends Error {
  constructor(orderId: number) {
    super(`Order with id ${orderId} not found`);
    this.name = "FulfilmentOrderNotFoundError";
  }
}

/** The requested fulfilment step is not a valid transition from the order's current state. */
export class FulfilmentTransitionError extends Error {
  constructor(orderId: number, from: string, to: string) {
    super(`Order ${orderId} cannot move from ${from} to ${to}`);
    this.name = "FulfilmentTransitionError";
  }
}

export type PaymentIneligibility =
  | "SECURITY_REVIEW_REQUIRED"
  | "NO_PAYMENT"
  | "PAYMENT_NOT_SUCCEEDED"
  | "PAYMENT_UNRESOLVED"
  | "REFUND_IN_PROGRESS"
  | "FULLY_REFUNDED";

/** The order's payment is not verified as successful and settled, so it must not be fulfilled. */
export class FulfilmentPaymentNotVerifiedError extends Error {
  constructor(orderId: number, public readonly reason: PaymentIneligibility) {
    super(`Order ${orderId} payment is not verified for fulfilment (${reason})`);
    this.name = "FulfilmentPaymentNotVerifiedError";
  }
}

/** A different shipment was already recorded; dispatch metadata is never overwritten. */
export class OrderAlreadyDispatchedError extends Error {
  constructor(orderId: number) {
    super(`Order ${orderId} has already been dispatched with different shipment details`);
    this.name = "OrderAlreadyDispatchedError";
  }
}
