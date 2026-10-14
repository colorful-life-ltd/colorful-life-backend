import { prisma } from "../../prisma/runtime.js";
import { customerShipmentSelect, presentFulfilment } from "../fulfilment/fulfilmentPresenter.js";

const orderReadSelect = {
  id: true,
  status: true,
  totalAmount: true,
  createdAt: true,
  updatedAt: true,
  shippingCarrier: true,
  trackingNumber: true,
  dispatchedAt: true,
  completedAt: true,
  preparingAt: true,
  shipments: customerShipmentSelect,
  orderItems: {
    select: {
      id: true,
      quantity: true,
      unitPrice: true,
      lineTotal: true,
      conditionSnapshot: true,
      damageDescriptionSnapshot: true,
      conditionPhotoSnapshot: true,
      productListing: {
        select: {
          id: true,
          condition: true,
          legoProduct: { select: { id: true, setNumber: true, title: true } },
        },
      },
    },
  },
} as const;

export type CustomerOrder = Awaited<ReturnType<typeof getCustomerOrder>>;

/** Replaces raw fulfilment columns with the derived, link-safe fulfilment view. */
function withFulfilment<T extends Parameters<typeof presentFulfilment>[0]>(order: T) {
  const { shipments: _shipments, preparingAt: _preparingAt, ...rest } = order;
  return { ...rest, fulfilment: presentFulfilment(order) };
}

export async function listCustomerOrders(userId: number) {
  const orders = await prisma.order.findMany({
    where: { userId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: orderReadSelect,
  });
  return orders.map(withFulfilment);
}

export async function getCustomerOrder(userId: number, orderId: number) {
  const order = await prisma.order.findFirst({
    where: { id: orderId, userId },
    select: {
      ...orderReadSelect,
      reservationExpiresAt: true,
      billingRecipientName: true, billingLine1: true, billingLine2: true,
      billingCity: true, billingCounty: true, billingPostcode: true,
      billingCountryCode: true, billingPhone: true,
      deliveryRecipientName: true, deliveryLine1: true, deliveryLine2: true,
      deliveryCity: true, deliveryCounty: true, deliveryPostcode: true,
      deliveryCountryCode: true, deliveryPhone: true,
      payments: { select: { status: true, paidAt: true } },
    },
  });
  if (!order) return null;
  const { payments, ...safeOrder } = order;
  return { ...withFulfilment(safeOrder), payment: payments[0] ?? null };
}

// Explicit projections keep provider references, idempotency keys and credentials private.
const adminOrderSummarySelect = {
  id: true, userId: true, status: true, totalAmount: true, createdAt: true,
  shippingCarrier: true, trackingNumber: true, dispatchedAt: true, preparingAt: true, shipments: customerShipmentSelect,
  user: { select: { id: true, firstName: true, lastName: true, email: true } },
  payments: { select: { status: true, currency: true, paidAt: true } },
} as const;

function projectAdminPayment<T extends { payments: Array<{ status: string; currency: string; paidAt: Date | null }> }>(order: T) {
  const { payments, ...safeOrder } = order;
  const payment = payments[0] ?? null;
  // All existing checkout and manual payment paths price orders in GBP.
  return { ...safeOrder, payment, paymentStatus: payment?.status ?? null, currency: payment?.currency ?? "GBP" };
}

function withFulfilmentStage<T extends Parameters<typeof presentFulfilment>[0]>(order: T) {
  const { shipments: _shipments, ...safe } = order;
  return { ...safe, fulfilmentStage: presentFulfilment(order).stage };
}

export async function listAdminOrders(query: import("./adminOrderValidator.js").AdminOrderQuery) {
  return prisma.$transaction(async (tx) => {
    const [totalItems, orders] = await Promise.all([
      tx.order.count(),
      tx.order.findMany({
        select: adminOrderSummarySelect,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        skip: (query.page - 1) * query.pageSize, take: query.pageSize,
      }),
    ]);
    return { items: orders.map((order) => withFulfilmentStage(projectAdminPayment(order))), pagination: {
      page: query.page, pageSize: query.pageSize, totalItems, totalPages: Math.ceil(totalItems / query.pageSize),
    } };
  }, { isolationLevel: "RepeatableRead" });
}

export async function getAdminOrder(orderId: number) {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: {
      ...orderReadSelect, ...adminOrderSummarySelect,
      actualShippingCost: true, reservationExpiresAt: true,
      cancelledAt: true, cancelledBy: true, cancellationReason: true,
      deliveryRecipientName: true, deliveryLine1: true, deliveryLine2: true,
      deliveryCity: true, deliveryCounty: true, deliveryPostcode: true,
      deliveryCountryCode: true, deliveryPhone: true,
      orderItems: { ...orderReadSelect.orderItems, orderBy: { id: "asc" } },
      shipments: { ...customerShipmentSelect, select: { ...customerShipmentSelect.select, id: true, createdByUserId: true, createdAt: true } },
      fulfilmentEvents: {
        select: { id: true, action: true, fromStage: true, toStage: true, shipmentId: true, source: true, createdAt: true,
          performedByUser: { select: { id: true, email: true } } },
        orderBy: { id: "asc" },
      },
    },
  });
  if (!order) return null;
  const { shipments, fulfilmentEvents, ...rest } = projectAdminPayment(order);
  return { ...rest, fulfilmentStage: presentFulfilment(order).stage, fulfilment: presentFulfilment(order), shipments: shipments.map(({ trackingState: _internal, ...safe }) => safe), fulfilmentEvents };
}
