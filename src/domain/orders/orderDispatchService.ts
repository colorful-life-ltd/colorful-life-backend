import { prisma } from "../../prisma/runtime.js";
import {
  OrderNotFoundError,
  OrderNotDispatchableError,
} from "./orderDispatchErrors.js";
import { dispatchLegacyOrder } from "../fulfilment/fulfilmentService.js";
import { FulfilmentOrderNotFoundError, FulfilmentTransitionError } from "../fulfilment/fulfilmentErrors.js";
import { resolveCarrierName } from "../fulfilment/carriers.js";

/**
 * Dispatch an order. Only a CONFIRMED order (including one marked Preparing)
 * whose payment is verified may be dispatched. This operation records shipping
 * details, one Shipment and an audit event, and updates the order status.
 *
 * @param orderId The order to dispatch.
 * @param actualShippingCost The actual cost paid by the seller.
 * @param shippingCarrier The carrier used for shipping (free text; mapped to a trusted carrier when unambiguous).
 * @param trackingNumber Optional tracking number.
 * @param performedByUserId The ADMIN performing the dispatch, for the audit trail.
 * @returns The updated order.
 * @throws OrderNotFoundError if the order does not exist.
 * @throws OrderNotDispatchableError if the order is not in CONFIRMED status.
 * @throws FulfilmentPaymentNotVerifiedError if the payment is not verified.
 */
export async function dispatchOrder(
  orderId: number,
  actualShippingCost: number,
  shippingCarrier: string,
  trackingNumber: string | undefined,
  performedByUserId: number,
): Promise<any> {
  return prisma.$transaction(async (tx) => {
    let result;
    try {
      result = await dispatchLegacyOrder(tx, performedByUserId, orderId, {
        carrier: resolveCarrierName(shippingCarrier),
        carrierName: shippingCarrier,
        trackingNumber: trackingNumber ?? null,
        actualShippingCost,
      });
    } catch (error) {
      if (error instanceof FulfilmentOrderNotFoundError) throw new OrderNotFoundError(orderId);
      if (error instanceof FulfilmentTransitionError) throw new OrderNotDispatchableError(orderId, "CONFIRMED");
      throw error;
    }
    if (!result.dispatched) throw new OrderNotDispatchableError(orderId, result.status);
    const order = await tx.order.findUnique({
      where: { id: orderId },
      include: { user: { select: { email: true } } },
    });
    if (!order) {
      throw new OrderNotFoundError(orderId);
    }
    return order;
  });
}
