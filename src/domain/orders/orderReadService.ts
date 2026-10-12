import { prisma } from "../../prisma/runtime.js";

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

export async function listCustomerOrders(userId: number) {
  return prisma.order.findMany({
    where: { userId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: orderReadSelect,
  });
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
  return { ...safeOrder, payment: payments[0] ?? null };
}

// Explicit projections keep provider references, idempotency keys and credentials private.
const adminOrderSummarySelect = {
  id: true, userId: true, status: true, totalAmount: true, createdAt: true,
  shippingCarrier: true, trackingNumber: true, dispatchedAt: true,
  user: { select: { id: true, firstName: true, lastName: true, email: true } },
  payments: { select: { status: true, currency: true, paidAt: true } },
} as const;

function projectAdminPayment<T extends { payments: Array<{ status: string; currency: string; paidAt: Date | null }> }>(order: T) {
  const { payments, ...safeOrder } = order;
  const payment = payments[0] ?? null;
  // All existing checkout and manual payment paths price orders in GBP.
  return { ...safeOrder, payment, paymentStatus: payment?.status ?? null, currency: payment?.currency ?? "GBP" };
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
    return { items: orders.map(projectAdminPayment), pagination: {
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
    },
  });
  return order ? projectAdminPayment(order) : null;
}
