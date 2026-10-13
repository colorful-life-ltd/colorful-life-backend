import { recordManagedSuccess } from "./paymentResolutionService.js";
import type { Order, Payment, Prisma } from "../../generated/prisma-client/client.js";
import { OrderStatus, PaymentStatus } from "../../generated/prisma-client/enums.js";

/** Caller holds the Order row lock and has reread and validated the Payment. */
export async function recordPayPalSuccess(tx: Prisma.TransactionClient, payment: Payment, captureId: string, now: Date) {
  await recordManagedSuccess(tx, payment, payment.providerReference, captureId);
  return tx.payment.update({ where: { id: payment.id }, data: {
    status: PaymentStatus.SUCCEEDED, paidAt: payment.paidAt ?? now, providerCaptureReference: captureId,
  } });
}

export function payPalLateSuccessDiagnostic(order: Pick<Order, "status" | "reservationExpiresAt">, now: Date): string | null {
  if (order.status === OrderStatus.CANCELLED) return "Captured payment for cancelled order requires refund/reconciliation";
  if (order.status === OrderStatus.EXPIRED) return "Captured payment for expired order requires refund/reconciliation";
  // An elapsed deadline does not imply inventory was released: #154 retains it.
  if (order.reservationExpiresAt && order.reservationExpiresAt <= now) return "Captured payment after reservation deadline requires reconciliation; order may retain inventory";
  return null;
}
