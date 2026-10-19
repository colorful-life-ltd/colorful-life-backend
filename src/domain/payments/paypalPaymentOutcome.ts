import { config } from "../../config/index.js";
import { confirmOrderInTransaction } from "../orders/orderConfirmationService.js";
import { enqueueOrderConfirmation } from "../orderConfirmation/enqueue.js";
import { recordManagedSuccess } from "./paymentResolutionService.js";
import type { Order, Prisma } from "../../generated/prisma-client/client.js";
import { OrderStatus, PaymentStatus } from "../../generated/prisma-client/enums.js";

export const PAYPAL_INVENTORY_RECONCILIATION_DIAGNOSTIC = "Captured payment requires manual inventory reconciliation; financial success retained";

/** Caller holds the Order row lock and has reread and validated the Payment. */
export async function recordPayPalSuccess(tx: Prisma.TransactionClient, payment: Prisma.PaymentGetPayload<{ include: { order: true } }>, captureId: string, now: Date) {
  await recordManagedSuccess(tx, payment, payment.providerReference, captureId);
  const updated = await tx.payment.update({ where: { id: payment.id }, data: {
    status: PaymentStatus.SUCCEEDED, paidAt: payment.paidAt ?? now, providerCaptureReference: captureId,
  } });
  if (payment.order.status !== OrderStatus.PENDING) {
    return { payment: updated, processingError: payPalLateSuccessDiagnostic(payment.order, now) };
  }
  const resolution = await tx.paymentResolution.findUnique({ where: { orderId: payment.orderId } });
  if ((resolution && (resolution.historical || resolution.quarantineReason || !resolution.reservationDisposition))
    || (config.PAYMENT_RESOLUTION_ENABLED && !resolution)) {
    return { payment: updated, processingError: "Captured payment with historical or incomplete reservation coverage requires manual reconciliation" };
  }
  // Financial evidence survives a failed inventory conversion in either mode.
  // Only fulfilment is rolled back; no invoice job is created on this path.
  await tx.$executeRaw`SAVEPOINT verified_paypal_fulfillment`;
  try {
    await confirmOrderInTransaction(tx, payment.order.userId, payment.orderId);
    await tx.$executeRaw`RELEASE SAVEPOINT verified_paypal_fulfillment`;
  } catch {
    await tx.$executeRaw`ROLLBACK TO SAVEPOINT verified_paypal_fulfillment`;
    await tx.$executeRaw`RELEASE SAVEPOINT verified_paypal_fulfillment`;
    return { payment: updated, processingError: PAYPAL_INVENTORY_RECONCILIATION_DIAGNOSTIC };
  }
  // Capture only the transition, never backfill on historical re-observation.
  await enqueueOrderConfirmation(tx, payment.orderId);
  return { payment: updated, processingError: null };
}

export function payPalLateSuccessDiagnostic(order: Pick<Order, "status" | "reservationExpiresAt">, now: Date): string | null {
  if (order.status === OrderStatus.CANCELLED) return "Captured payment for cancelled order requires refund/reconciliation";
  if (order.status === OrderStatus.RETURNED) return "Captured payment for returned order requires refund/reconciliation";
  if (order.status === OrderStatus.EXPIRED) return "Captured payment for expired order requires refund/reconciliation";
  // An elapsed deadline does not imply inventory was released: #154 retains it.
  if (order.reservationExpiresAt && order.reservationExpiresAt <= now) return "Captured payment after reservation deadline requires reconciliation; order may retain inventory";
  return null;
}
