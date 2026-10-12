// src/domain/payments/paymentService.ts

import { prisma } from "../../prisma/runtime.js"
import { Decimal } from "@prisma/client/runtime/client"
import { CreatePaymentInput } from "./paymentValidator.js"
import {
  PaymentConflictError,
  PaymentAlreadySucceededError,
  PaymentNotFoundError,
  PaymentExpiredError,
  PaymentOrderCancelledError,
} from "./paymentErrors.js"
import { OrderStatus, PaymentProvider, PaymentStatus } from "../../generated/prisma-client/enums.js"

/**
 * Create a manual payment for an existing order.
 *
 * The service follows the exact semantics required for Issue #48 V1:
 *   • amount is taken from Order.totalAmount (must be > 0)
 *   • currency is fixed to "GBP"
 *   • provider is fixed to PaymentProvider.MANUAL
 *   • status is set to PaymentStatus.SUCCEEDED
 *   • paidAt is set to now()
 *   • The operation is idempotent per (provider, providerReference) per order.
 *   • A providerReference that belongs to a different order results in a
 *     PaymentConflictError.
 *   • The unique constraint on (provider, providerReference) guarantees
 *     concurrency safety.  In the rare case of a P2002 during the create
 *     step we recover outside the transaction.
 */
export async function createPayment(
  orderId: number,
  input: CreatePaymentInput
): Promise<
  Awaited<ReturnType<typeof prisma.payment.create>>
> {
  const { providerReference } = input

  let payment:
    | Awaited<ReturnType<typeof prisma.payment.create>>
    | Awaited<ReturnType<typeof prisma.payment.findFirst>>
  try {
    payment = await prisma.$transaction(async (tx) => {
      // Serialize payment decisions with expiry on the order row.
      const lockedOrders = await tx.$queryRaw<Array<{ id: number; status: OrderStatus; totalAmount: Decimal; reservationExpiresAt: Date | null }>>`
        SELECT id, status, "totalAmount", "reservationExpiresAt"
        FROM "Order"
        WHERE id = ${orderId}
        FOR UPDATE
      `
      const order = lockedOrders[0]
      if (!order) {
        throw new PaymentNotFoundError(orderId)
      }

      const amount = order.totalAmount
      if (amount.lte(new Decimal(0))) {
        throw new Error(`Order total amount must be positive`)
      }

      // Replay detection precedes the deadline check so an existing successful
      // payment remains idempotent after the reservation deadline.
      const existing = await tx.payment.findFirst({
        where: { provider: PaymentProvider.MANUAL, providerReference },
      })
      if (existing) {
        if (existing.orderId !== orderId) {
          throw new PaymentConflictError(orderId, existing.orderId)
        }
        return existing
      }

      if (order.status === OrderStatus.EXPIRED) {
        throw new PaymentExpiredError(orderId)
      }

      if (order.reservationExpiresAt !== null && order.reservationExpiresAt <= new Date()) {
        throw new PaymentExpiredError(orderId)
      }

      if (order.status === OrderStatus.CANCELLED) throw new PaymentOrderCancelledError(orderId)

      // 3️⃣ Create the new payment – let any P2002 bubble up to the outer catch
      return await tx.payment.create({
        data: {
          orderId,
          amount,
          currency: "GBP",
          provider: PaymentProvider.MANUAL,
          providerReference,
          status: PaymentStatus.SUCCEEDED,
          paidAt: new Date(),
        },
      })
    })
  } catch (err: unknown) {
    // Handle unique‑constraint violation that happened inside the transaction
    if (
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      (err as any).code === "P2002"
    ) {
      const conflict = await prisma.payment.findFirst({
        where: { provider: PaymentProvider.MANUAL, providerReference },
      })
      if (conflict && conflict.orderId !== orderId) {
        throw new PaymentConflictError(orderId, conflict.orderId)
      }
      if (conflict) {
        payment = conflict
      } else {
        const existingForOrder = await prisma.payment.findUnique({ where: { orderId } })
        if (existingForOrder) {
          throw new PaymentAlreadySucceededError(orderId)
        }
        throw err
      }
    } else {
      throw err
    }
  }
  return payment as Awaited<ReturnType<typeof prisma.payment.create>>
}
