import { Decimal } from "@prisma/client/runtime/client";
import { OrderStatus, PaymentProvider, PaymentStatus } from "../../generated/prisma-client/enums.js";
import { prisma } from "../../prisma/runtime.js";

export type PayPalWebhookEvent = {
  id: string;
  eventType: string;
  captureId?: string;
  paypalOrderId?: string;
  amount?: string;
  currency?: string;
  orderId?: string;
};

export async function reconcilePayPalWebhookEvent(event: PayPalWebhookEvent): Promise<{ duplicate: boolean; handled: boolean }> {
  try {
    return await prisma.$transaction(async (tx) => {
      const receipt = await tx.paymentWebhookEvent.create({ data: { provider: PaymentProvider.PAYPAL, providerEventId: event.id, eventType: event.eventType } });
      const captureEvents = ["PAYMENT.CAPTURE.COMPLETED", "PAYMENT.CAPTURE.PENDING", "PAYMENT.CAPTURE.DENIED", "PAYMENT.CAPTURE.REFUNDED"];
      if (!captureEvents.includes(event.eventType)) {
        await tx.paymentWebhookEvent.update({ where: { id: receipt.id }, data: { processedAt: new Date() } });
        return { duplicate: false, handled: false };
      }
      const byCapture = event.captureId ? await tx.payment.findFirst({ where: { provider: PaymentProvider.PAYPAL, providerCaptureReference: event.captureId }, include: { order: true } }) : null;
      const payment = byCapture ?? (event.paypalOrderId ? await tx.payment.findFirst({ where: { provider: PaymentProvider.PAYPAL, providerReference: event.paypalOrderId }, include: { order: true } }) : null);
      if (!payment) {
        await tx.paymentWebhookEvent.update({ where: { id: receipt.id }, data: { processedAt: new Date(), processingError: "Unknown PayPal payment or capture" } });
        return { duplicate: false, handled: false };
      }
      if (event.eventType === "PAYMENT.CAPTURE.REFUNDED") {
        await tx.paymentWebhookEvent.update({ where: { id: receipt.id }, data: { processedAt: new Date() } });
        return { duplicate: false, handled: true };
      }
      if (event.eventType === "PAYMENT.CAPTURE.COMPLETED") {
        const expected = new Decimal(payment.amount).toFixed(2);
        if (!event.captureId || event.paypalOrderId !== payment.providerReference || event.currency?.toUpperCase() !== "GBP" || event.amount !== expected) {
          await tx.paymentWebhookEvent.update({ where: { id: receipt.id }, data: { processedAt: new Date(), processingError: "PayPal capture amount, currency, or identity mismatch" } });
          return { duplicate: false, handled: false };
        }
        const now = new Date();
        await tx.payment.update({ where: { id: payment.id }, data: { status: PaymentStatus.SUCCEEDED, paidAt: payment.paidAt ?? now, providerCaptureReference: event.captureId } });
        const expired = payment.order.status === OrderStatus.EXPIRED || (payment.order.reservationExpiresAt && payment.order.reservationExpiresAt <= now);
        await tx.paymentWebhookEvent.update({ where: { id: receipt.id }, data: { processedAt: now, processingError: payment.order.status === OrderStatus.CANCELLED ? "Captured payment for cancelled order requires refund/reconciliation" : expired ? "Captured payment for expired order requires refund/reconciliation" : null } });
        return { duplicate: false, handled: true };
      }
      if (payment.status !== PaymentStatus.SUCCEEDED) await tx.payment.update({ where: { id: payment.id }, data: { status: event.eventType === "PAYMENT.CAPTURE.DENIED" ? PaymentStatus.FAILED : PaymentStatus.PROCESSING } });
      await tx.paymentWebhookEvent.update({ where: { id: receipt.id }, data: { processedAt: new Date() } });
      return { duplicate: false, handled: true };
    });
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "P2002") return { duplicate: true, handled: true };
    throw error;
  }
}
