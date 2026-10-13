import { randomUUID } from "node:crypto";
import { prisma } from "../../prisma/runtime.js";

/** Records a verified, settled MANUAL payment for an order so it is eligible for fulfilment. */
export async function recordVerifiedPayment(orderId: number) {
  const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId }, select: { totalAmount: true } });
  return prisma.payment.create({ data: {
    orderId, amount: order.totalAmount, provider: "MANUAL", providerReference: `test-paid-${randomUUID()}`,
    status: "SUCCEEDED", paidAt: new Date(),
  } });
}
