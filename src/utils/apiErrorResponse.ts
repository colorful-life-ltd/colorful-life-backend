import type { Response } from "express";

export type ApiErrorCode =
  | "ORDER_ALREADY_PAID"
  | "ORDER_PAYMENT_UNRESOLVED"
  | "CART_QUANTITY_UNAVAILABLE"
  | "STRIPE_RECOVERY_UNAVAILABLE"
  | "STRIPE_RECOVERY_MISMATCH"
  | "ORDER_IDEMPOTENCY_MISMATCH"
  | "INVALID_IDEMPOTENCY_KEY"
  | "ORDER_EXPIRED"
  | "ORDER_NOT_PAYABLE"
  | "PAYMENT_ALREADY_COMPLETED"
  | "AUTH_REQUIRED"
  | "SESSION_INVALID"
  | "FORBIDDEN"
  | "EMAIL_VERIFICATION_REQUIRED"
  | "INVALID_CREDENTIALS"
  | "INTERNAL_SERVER_ERROR"
  | "INVALID_SUPPLIER_KEY"
  | "PURCHASE_ANALYTICS_SUPPLIER_NOT_FOUND";

/** Sends a stable machine-readable API error envelope. */
export function sendApiError(res: Response, status: number, code: ApiErrorCode, message: string) {
  return res.status(status).json({ error: { code, message } });
}
