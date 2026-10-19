import { checkPaymentAdmission, journalNewPayment, recordManagedSuccess } from "./paymentResolutionService.js";
// src/domain/payments/paymentService.ts

import { prisma } from "../../prisma/runtime.js"
import { Decimal } from "@prisma/client/runtime/client"
import { CreatePaymentInput,CreatePaymentSchema } from "./paymentValidator.js"
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
export class ManualPaymentAuthorizationError extends Error {constructor(readonly code:string,readonly status:number){super(code);}}
export async function createPayment(
  orderId: number,
  input: CreatePaymentInput,
  actorId?: number
): Promise<
  Awaited<ReturnType<typeof prisma.payment.create>>
> {
  input=CreatePaymentSchema.parse(input);
  if(!actorId||!input.reason||!input.evidenceReference)throw new ManualPaymentAuthorizationError("MANUAL_PAYMENT_EVIDENCE_REQUIRED",400);
  const { providerReference } = input

  let payment:
    | Awaited<ReturnType<typeof prisma.payment.create>>
    | Awaited<ReturnType<typeof prisma.payment.findFirst>>
  try {
    payment = await prisma.$transaction(async (tx) => {
      const actor=await tx.user.findUnique({where:{id:actorId}});
      if(!actor||actor.deletedAt||actor.role!=="ADMIN")throw new ManualPaymentAuthorizationError("ADMIN_REQUIRED",403);
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
        const proof=await tx.$queryRaw<Array<{actorId:number;details:{reason:string;evidenceReference:string}}>>`SELECT "actorId",details FROM "OperationalAudit" WHERE kind='MANUAL_PAYMENT_RECORDED' AND "orderId"=${orderId}`;
        if(!proof.length||proof[0].actorId!==actorId||proof[0].details.reason!==input.reason||proof[0].details.evidenceReference!==input.evidenceReference)throw new ManualPaymentAuthorizationError('MANUAL_PAYMENT_REPLAY_CONFLICT',409);
        return existing
      }

      const managed = await checkPaymentAdmission(tx, orderId)
      if (order.status === OrderStatus.EXPIRED) {
        throw new PaymentExpiredError(orderId)
      }

      if (!managed && order.reservationExpiresAt !== null && order.reservationExpiresAt <= new Date()) {
        throw new PaymentExpiredError(orderId)
      }

      if (order.status === OrderStatus.CANCELLED) throw new PaymentOrderCancelledError(orderId)

      // 3️⃣ Create the new payment – let any P2002 bubble up to the outer catch
      const created = await tx.payment.create({
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
      await tx.$executeRaw`INSERT INTO "OperationalAudit" (kind,"actorId","orderId",details) VALUES ('MANUAL_PAYMENT_RECORDED',${actorId},${orderId},${JSON.stringify({reason:input.reason,evidenceReference:input.evidenceReference,providerReference})}::jsonb)`;
      await journalNewPayment(tx, created, "CONFIRM")
      await recordManagedSuccess(tx, created, created.providerReference)
      return created
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
