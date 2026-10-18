import { assertNoFulfilmentHold } from "../security/paymentAbuse.js";
import { notifyLegacyDispatch } from "../orderConfirmation/legacyDispatch.js";
import { enqueueDispatchConfirmation } from "../orderConfirmation/dispatch.js";
import { Decimal } from "@prisma/client/runtime/client";
import type { Prisma } from "../../generated/prisma-client/client.js";
import { OrderStatus, type FulfilmentStage, type ShippingCarrier } from "../../generated/prisma-client/enums.js";
import { prisma } from "../../prisma/runtime.js";
import { databaseNow } from "../payments/paymentResolutionService.js";
import { CARRIERS } from "./carriers.js";
import {
  FulfilmentOrderNotFoundError,
  FulfilmentPaymentNotVerifiedError,
  FulfilmentTransitionError,
  OrderAlreadyDispatchedError,
} from "./fulfilmentErrors.js";

export type FulfilmentSource = "ADMIN_FULFILMENT_API" | "LEGACY_DISPATCH_API";

/**
 * Customer-facing fulfilment stage. Preparing is a sub-stage of CONFIRMED, so
 * cancellation, payment resolution and refund rules keyed on Order.status are
 * unchanged. Orders that were never dispatched never report DISPATCHED.
 */
export function fulfilmentStage(order: { status: string; preparingAt: Date | null; dispatchedAt: Date | null }): FulfilmentStage | null {
  if (order.status === OrderStatus.CONFIRMED) return order.preparingAt ? "PREPARING" : "CONFIRMED";
  const shipped = order.status === OrderStatus.DISPATCHED || order.status === OrderStatus.COMPLETED || order.status === OrderStatus.RETURNED;
  return shipped && order.dispatchedAt ? "DISPATCHED" : null;
}

/**
 * NO KEY UPDATE still excludes payment initiation, webhooks, recovery and other
 * fulfilment calls (FOR UPDATE / NO KEY UPDATE), but not the FOR KEY SHARE lock a
 * refund's Refund insert takes on Order while it holds the Payment lock. With
 * FOR UPDATE, fulfilment (Order -> Payment) and refund preparation
 * (Payment -> Order key share) deadlock. Fulfilment only updates non-key columns.
 */
async function lockOrder(tx: Prisma.TransactionClient, orderId: number) {
  await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${orderId} FOR NO KEY UPDATE`;
  const order = await tx.order.findUnique({ where: { id: orderId } });
  if (!order) throw new FulfilmentOrderNotFoundError(orderId);
  return order;
}

/**
 * Caller holds the Order row lock (see lockOrder), shared with payment initiation,
 * refund lifecycle/webhook writers and recovery. Lock Payment next, matching
 * refund lifecycle's Order -> Payment -> Refund order and excluding capacity-only
 * writers too. Review state is read after those locks, so a committed conflict
 * cannot be missed by a subsequent fulfilment transition.
 * Payment must be SUCCEEDED with paidAt, not fully refunded, with no refund in
 * flight or unresolved refund review. Orders managed by payment resolution (#156) must also be PAID; for
 * historical rows the verified payment record decides, matching managedResolution().
 */
export async function assertPaymentVerifiedForFulfilment(tx: Prisma.TransactionClient, orderId: number) {
  if (!await assertNoFulfilmentHold(tx, orderId)) throw new FulfilmentPaymentNotVerifiedError(orderId, "SECURITY_REVIEW_REQUIRED");
  await tx.$queryRaw`SELECT id FROM "Payment" WHERE "orderId" = ${orderId} FOR UPDATE`;
  const payment = await tx.payment.findUnique({ where: { orderId } });
  if (!payment) throw new FulfilmentPaymentNotVerifiedError(orderId, "NO_PAYMENT");
  if (payment.status !== "SUCCEEDED" || !payment.paidAt) throw new FulfilmentPaymentNotVerifiedError(orderId, "PAYMENT_NOT_SUCCEEDED");
  // Refund/webhook writers acquire the same Order -> Payment locks before
  // updating review state. Read after locking Payment so a committed conflict
  // cannot be missed; only refunds belonging to this payment can block it.
  if (await tx.refund.findFirst({ where: { paymentId: payment.id, reviewRequired: true }, select: { id: true } })) {
    throw new FulfilmentPaymentNotVerifiedError(orderId, "REFUND_REVIEW_REQUIRED");
  }
  if (payment.reservedRefundAmount.gt(0)) throw new FulfilmentPaymentNotVerifiedError(orderId, "REFUND_IN_PROGRESS");
  if (payment.refundedAmount.gte(payment.amount)) throw new FulfilmentPaymentNotVerifiedError(orderId, "FULLY_REFUNDED");
  const resolution = await tx.paymentResolution.findUnique({ where: { orderId } });
  if (resolution && !resolution.historical && (resolution.quarantineReason || resolution.state !== "PAID")) {
    throw new FulfilmentPaymentNotVerifiedError(orderId, "PAYMENT_UNRESOLVED");
  }
}

/** CONFIRMED -> PREPARING. Repeating it on a Preparing order is a no-op. */
export async function startPreparing(performedByUserId: number, orderId: number) {
  return prisma.$transaction(async (tx) => {
    const order = await lockOrder(tx, orderId);
    const stage = fulfilmentStage(order);
    if (stage === "PREPARING") return { changed: false };
    if (stage !== "CONFIRMED") throw new FulfilmentTransitionError(orderId, stage ?? order.status, "PREPARING");
    await assertPaymentVerifiedForFulfilment(tx, orderId);
    await tx.order.update({ where: { id: orderId }, data: { preparingAt: await databaseNow(tx) } });
    await tx.orderFulfilmentEvent.create({ data: {
      orderId, action: "PREPARING_STARTED", fromStage: "CONFIRMED", toStage: "PREPARING",
      performedByUserId, source: "ADMIN_FULFILMENT_API",
    } });
    return { changed: true };
  });
}

export type ShipmentInput = {
  /** Trusted carrier, or null when a legacy free-text carrier matched none. */
  carrier: ShippingCarrier | null;
  carrierName: string;
  trackingNumber: string | null;
  actualShippingCost: number;
};

async function recordDispatch(tx: Prisma.TransactionClient, performedByUserId: number, orderId: number, fromStage: FulfilmentStage, input: ShipmentInput, source: FulfilmentSource) {
  const dispatchedAt = await databaseNow(tx);
  const updated = await tx.order.updateMany({
    where: { id: orderId, status: OrderStatus.CONFIRMED },
    data: {
      status: OrderStatus.DISPATCHED,
      actualShippingCost: new Decimal(input.actualShippingCost),
      shippingCarrier: input.carrierName,
      trackingNumber: input.trackingNumber,
      dispatchedAt,
    },
  });
  if (updated.count !== 1) throw new FulfilmentTransitionError(orderId, fromStage, "DISPATCHED");
  // Phase 1: exactly one shipment; the unique (orderId, sequence) index backs this up.
  const shipment = await tx.shipment.create({ data: {
    orderId, sequence: 1, carrier: input.carrier, carrierName: input.carrierName,
    trackingNumber: input.trackingNumber, dispatchedAt, createdByUserId: performedByUserId,
  } });
  await tx.orderFulfilmentEvent.create({ data: {
    orderId, action: "DISPATCHED", fromStage, toStage: "DISPATCHED", shipmentId: shipment.id, performedByUserId, source,
  } });
  await enqueueDispatchConfirmation(tx, shipment.id);
}

/**
 * CONFIRMED or PREPARING -> DISPATCHED with one shipment. Dispatch time is
 * database time. Repeating the same carrier and tracking number is an
 * idempotent no-op; different details on a dispatched order are rejected.
 */
export async function dispatchShipment(performedByUserId: number, orderId: number, input: ShipmentInput & { carrier: ShippingCarrier }) {
  const result = await prisma.$transaction(async (tx) => {
    const order = await lockOrder(tx, orderId);
    if (order.dispatchedAt) {
      const existing = await tx.shipment.findUnique({ where: { orderId_sequence: { orderId, sequence: 1 } } });
      const same = existing && existing.carrier === input.carrier && existing.trackingNumber === input.trackingNumber
        && existing.carrierName === input.carrierName;
      if (same) return { changed: false };
      throw new OrderAlreadyDispatchedError(orderId);
    }
    const stage = fulfilmentStage(order);
    if (stage !== "CONFIRMED" && stage !== "PREPARING") throw new FulfilmentTransitionError(orderId, stage ?? order.status, "DISPATCHED");
    await assertPaymentVerifiedForFulfilment(tx, orderId);
    await recordDispatch(tx, performedByUserId, orderId, stage, input, "ADMIN_FULFILMENT_API");
    return { changed: true };
  });
  if (result.changed) await notifyLegacyDispatch(orderId);
  return result;
}

/**
 * Existing POST /orders/:orderId/dispatch semantics (any non-CONFIRMED order,
 * including a repeat, is rejected by the caller's existing error), now with
 * the same payment verification, shipment record and audit trail.
 */
export async function dispatchLegacyOrder(tx: Prisma.TransactionClient, performedByUserId: number, orderId: number, input: ShipmentInput) {
  const order = await lockOrder(tx, orderId);
  const stage = fulfilmentStage(order);
  if (order.status !== OrderStatus.CONFIRMED || !stage) return { dispatched: false as const, status: order.status };
  await assertPaymentVerifiedForFulfilment(tx, orderId);
  await recordDispatch(tx, performedByUserId, orderId, stage, input, "LEGACY_DISPATCH_API");
  return { dispatched: true as const, status: OrderStatus.DISPATCHED };
}

export const carrierDisplayName = (carrier: ShippingCarrier, otherName?: string) =>
  carrier === "OTHER" ? otherName! : CARRIERS[carrier].name;
