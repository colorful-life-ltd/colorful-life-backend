import { Decimal } from "@prisma/client/runtime/client";
import { prisma } from "../../prisma/runtime.js";
type RefundTransaction = { $queryRaw: typeof prisma.$queryRaw; payment: typeof prisma.payment };

export class RefundCapacityInvalidAmountError extends Error {}
export class RefundCapacityExceededError extends Error {}
export class RefundCapacityNotReservedError extends Error {}

function parseAmount(value: Decimal | number): Decimal {
  const result = value instanceof Decimal ? value : new Decimal(value);
  if (result.lte(0) || !result.mul(100).isInteger()) throw new RefundCapacityInvalidAmountError();
  return result;
}

export async function reserveRefundCapacity(paymentId: number, requestedAmount: Decimal | number, tx?: RefundTransaction): Promise<void> {
  const requested = parseAmount(requestedAmount);
  const work = async (tx: RefundTransaction) => {
    const rows = await tx.$queryRaw<Array<{ id: number; amount: Decimal; refundedAmount: Decimal; reservedRefundAmount: Decimal }>>`SELECT "id", "amount", "refundedAmount", "reservedRefundAmount" FROM "Payment" WHERE "id" = ${paymentId} FOR UPDATE`;
    const payment = rows[0];
    if (!payment || new Decimal(payment.refundedAmount).add(payment.reservedRefundAmount).add(requested).gt(payment.amount)) throw new RefundCapacityExceededError();
    await tx.payment.update({ where: { id: paymentId }, data: { reservedRefundAmount: { increment: requested } } });
  };
  if (tx) await work(tx); else await prisma.$transaction(work);
}

async function moveReserved(paymentId: number, requestedAmount: Decimal | number, finalize: boolean, tx?: RefundTransaction): Promise<void> {
  const requested = parseAmount(requestedAmount);
  const work = async (tx: RefundTransaction) => {
    const rows = await tx.$queryRaw<Array<{ id: number; amount: Decimal; refundedAmount: Decimal; reservedRefundAmount: Decimal }>>`SELECT "id", "amount", "refundedAmount", "reservedRefundAmount" FROM "Payment" WHERE "id" = ${paymentId} FOR UPDATE`;
    const payment = rows[0];
    if (!payment || new Decimal(payment.reservedRefundAmount).lt(requested)) throw new RefundCapacityNotReservedError();
    if (finalize && new Decimal(payment.refundedAmount).add(requested).gt(payment.amount)) throw new RefundCapacityExceededError();
    await tx.payment.update({ where: { id: paymentId }, data: finalize ? { reservedRefundAmount: { decrement: requested }, refundedAmount: { increment: requested } } : { reservedRefundAmount: { decrement: requested } } });
  };
  if (tx) await work(tx); else await prisma.$transaction(work);
}

export const finalizeRefundCapacity = (paymentId: number, amount: Decimal | number, tx?: RefundTransaction) => moveReserved(paymentId, amount, true, tx);
export const releaseRefundCapacity = (paymentId: number, amount: Decimal | number, tx?: RefundTransaction) => moveReserved(paymentId, amount, false, tx);
