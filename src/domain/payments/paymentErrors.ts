export class PaymentNotFoundError extends Error {
  constructor(orderId: number) {
    super(`Order with id ${orderId} not found`)
    this.name = "PaymentNotFoundError"
  }
}

export class PaymentAlreadySucceededError extends Error {
  constructor(orderId: number) {
    super(`Payment for order ${orderId} has already succeeded`)
    this.name = "PaymentAlreadySucceededError"
  }
}

export class PaymentExpiredError extends Error {
  constructor(orderId: number) {
    super(`Payment for order ${orderId} cannot be created after its reservation expired`)
    this.name = "PaymentExpiredError"
  }
}

export class PaymentConflictError extends Error {
  constructor(orderId: number, conflictingOrderId: number) {
    super(
      `Payment providerReference belongs to a different order. Existing order id: ${conflictingOrderId}`
    )
    this.name = "PaymentConflictError"
  }
}

export class PaymentOrderCancelledError extends Error {
  constructor(orderId: number) {
    super(`Payment for cancelled order ${orderId} cannot be created`);
  }
}
