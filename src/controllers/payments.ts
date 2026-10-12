// Controller for payment HTTP endpoints.
// Implements the following routes:
//   POST   /orders/:orderId/payments  – create a new payment for an order
//   GET    /orders/:orderId/payments  – list all payments belonging to an order
//
// The controller follows the same conventions used throughout the project:
//   * ADMIN‑only access – check `req.user.role`
//   * Parameter validation – `orderId` must be a positive integer
//   * Request body validation – `CreatePaymentSchema` from the domain
//   * Error mapping – domain errors → appropriate HTTP status codes
//   * Successful POST → 201 with the created payment
//   * Successful GET  → 200 with an array of payments ordered newest‑first

import { Request, Response } from "express";
import { createPayment } from "../domain/payments/paymentService.js";
import { CreatePaymentSchema } from "../domain/payments/paymentValidator.js";
import { PaymentNotFoundError, PaymentConflictError, PaymentAlreadySucceededError, PaymentExpiredError, PaymentOrderCancelledError } from "../domain/payments/paymentErrors.js";
import { prisma } from "../prisma/runtime.js";
import { sendApiError } from "../utils/apiErrorResponse.js";

/**
 * POST /orders/:orderId/payments
 * Creates a new payment for the specified order.
 */
export const createPaymentHandler = async (req: Request, res: Response) => {
  // ADMIN only
  const userRole = (req.user as { role: string }).role;
  if (userRole !== "ADMIN") {
    return sendApiError(res, 403, "FORBIDDEN", "Forbidden: ADMIN only");
  }

  // Validate orderId
  const orderId = Number(req.params.orderId);
  if (!Number.isInteger(orderId) || orderId < 1) {
    return res.status(400).json({ error: "Invalid order id" });
  }

  // Validate request body
  const parseResult = CreatePaymentSchema.safeParse(req.body);
  if (!parseResult.success) {
    return res.status(400).json({ error: parseResult.error.format() });
  }

  try {
    const payment = await createPayment(orderId, parseResult.data);
    return res.status(201).json(payment);
  } catch (err: unknown) {
    if (err instanceof PaymentNotFoundError) {
      return res.status(404).json({ error: err.message });
    }
    if (err instanceof PaymentConflictError) {
      return res.status(409).json({ error: err.message });
    }
    if (err instanceof PaymentAlreadySucceededError) {
      return res.status(409).json({ error: err.message });
    }
    if (err instanceof PaymentExpiredError || err instanceof PaymentOrderCancelledError) {
      return res.status(409).json({ error: err.message });
    }
    console.error("Create payment error", err);
    return res.status(500).json({ error: "Internal server error" });
  }
};

/**
 * GET /orders/:orderId/payments
 * Lists all payments for the specified order.
 */
export const listPaymentsHandler = async (req: Request, res: Response) => {
  // ADMIN only
  const userRole = (req.user as { role: string }).role;
  if (userRole !== "ADMIN") {
    return sendApiError(res, 403, "FORBIDDEN", "Forbidden: ADMIN only");
  }

  // Validate orderId
  const orderId = Number(req.params.orderId);
  if (!Number.isInteger(orderId) || orderId < 1) {
    return res.status(400).json({ error: "Invalid order id" });
  }

  // Ensure order exists
  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (!order) {
    return res.status(404).json({ error: `Order with id ${orderId} not found` });
  }

  try {
    const payments = await prisma.payment.findMany({
      where: { orderId },
      orderBy: [
        { paidAt: "desc" },
        { createdAt: "desc" },
      ],
    });
    return res.json(payments);
  } catch (err: unknown) {
    console.error("List payments error", err);
    return res.status(500).json({ error: "Internal server error" });
  }
};
