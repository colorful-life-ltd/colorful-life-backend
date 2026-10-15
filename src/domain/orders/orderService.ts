import { readCustomerPaymentWindow, type CustomerPaymentWindow } from "../payments/customerPaymentWindow.js";
import type { Prisma } from "../../generated/prisma-client/client.js";
import { listingAvailability } from "../inventory/listingAvailability.js";
import { config } from "../../config/index.js";
import { initializePaymentResolution, databaseNow } from "../payments/paymentResolutionService.js";
import { lockCustomerCart, settleCartReconciliation, prepareOrderCartAllocation, allocateOrderCart } from "../cart/cartProvenanceService.js";
import { createHash } from "node:crypto";
// Order creation service. Implements the domain rules for creating a
// customer order without touching the database outside a single Prisma
// transaction. The service is intentionally lightweight and returns the
// persisted order (with its items) as returned by Prisma.

import { prisma } from "../../prisma/runtime.js";
import { Decimal } from "@prisma/client/runtime/client";
import type { CreateOrderInput } from "./orderValidator.js";
import {
  NoDefaultBillingAddressError,
  MultipleDefaultBillingAddressesError,
  ProductListingInactiveError,
  ProductListingNotFoundError,
  DuplicateProductListingError,
  InsufficientAvailableStockError,
  EmailVerificationRequiredError,
  OrderUserNotFoundError,
} from "./orderErrors.js";
import { OrderStatus } from "../../generated/prisma-client/enums.js";
import { expireOrderReservation } from "./orderExpiryService.js";

export class OrderIdempotencyMismatchError extends Error {
  constructor() { super("Idempotency key was already used with a different order request"); }
}

export class InvalidOrderIdempotencyKeyError extends Error {
  constructor() { super("Idempotency-Key must contain 1–128 printable ASCII characters without spaces"); }
}

function requestHash(input: CreateOrderInput) {
  const address = input.deliveryAddress;
  // Hash validated client intent, independent of prices and mutable saved addresses.
  return createHash("sha256").update(JSON.stringify({
    items: [...input.items].sort((a, b) => a.productListingId - b.productListingId)
      .map(({ productListingId, quantity }) => ({ productListingId, quantity })),
    deliveryAddress: address ? {
      recipientName: address.recipientName, line1: address.line1, line2: address.line2 ?? null,
      city: address.city, county: address.county ?? null, postcode: address.postcode,
      countryCode: address.countryCode, phone: address.phone ?? null,
    } : null,
  })).digest("hex");
}

/**
 * Creates a new order for the supplied user.
 *
 * @param userId The authenticated user's id.
 * @param input   The validated order payload.
 * @returns The created Order record with its OrderItems.
 */
type CreatedOrder = Prisma.OrderGetPayload<{ include: { orderItems: true } }>;
export function createOrder(userId: number, input: CreateOrderInput, idempotencyKey: string | undefined, includePaymentWindow: true): Promise<CreatedOrder & { paymentWindow: CustomerPaymentWindow }>;
export function createOrder(userId: number, input: CreateOrderInput, idempotencyKey?: string): Promise<CreatedOrder>;
export async function createOrder(
  userId: number,
  input: CreateOrderInput,
  idempotencyKey?: string,
  includePaymentWindow = false,
){
  const present = async (tx: Prisma.TransactionClient, order: CreatedOrder) => includePaymentWindow
    ? { ...order, paymentWindow: await readCustomerPaymentWindow(tx, userId, order.id) } : order;
  if (idempotencyKey !== undefined && !/^[\x21-\x7e]{1,128}$/.test(idempotencyKey)) {
    throw new InvalidOrderIdempotencyKeyError();
  }
  const hash = idempotencyKey === undefined ? undefined : requestHash(input);
  // --- 1. Check for duplicate product listings in the request payload
  const listingIdsSet = new Set<number>();
  for (const item of input.items) {
    if (listingIdsSet.has(item.productListingId)) {
      throw new DuplicateProductListingError(item.productListingId);
    }
    listingIdsSet.add(item.productListingId);
  }

  const now = new Date();
  // Reject unverified users before lazy expiry discovery can perform any
  // reservation side effects. The transaction below repeats this check to
  // preserve the domain-level current-state invariant at persistence time.
  const currentUser = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, emailVerified: true },
  });
  if (!currentUser) throw new OrderUserNotFoundError();
  if (!currentUser.emailVerified) throw new EmailVerificationRequiredError();

  if (idempotencyKey !== undefined) {
    const existing = await prisma.order.findUnique({
      where: { userId_creationIdempotencyKey: { userId, creationIdempotencyKey: idempotencyKey } },
      include: { orderItems: true },
    });
    if (existing) {
      if (existing.creationRequestHash !== hash) throw new OrderIdempotencyMismatchError();
      if (!includePaymentWindow) return existing;
      // An idempotent replay creates no reservation. Read its current response in
      // one snapshot; fresh creations project before their transaction commits.
      return prisma.$transaction(async tx => present(tx, await tx.order.findUniqueOrThrow({
        where: { id: existing.id, userId }, include: { orderItems: true },
      })), { isolationLevel: "RepeatableRead" });
    }
  }

  const requestedListingIds = Array.from(listingIdsSet);
  const expiredCandidates = await prisma.order.findMany({
    where: {
      status: OrderStatus.PENDING,
      reservationExpiresAt: { not: null, lte: now },
      orderItems: { some: { productListingId: { in: requestedListingIds } } },
    },
    select: { id: true },
  });

  // Expiry owns the eligibility, locking, payment protection, and release
  // rules. A candidate can become ineligible between discovery and processing;
  // expireOrderReservation treats that as a normal no-op.
  for (const candidate of expiredCandidates) {
    await expireOrderReservation(candidate.id, now);
  }

  // --- 2. Perform all authoritative reads/writes in one transaction
  return prisma.$transaction(async (tx) => {
    const user = await tx.user.findUnique({
      where: { id: userId },
      select: { id: true, emailVerified: true },
    });
    if (!user) throw new OrderUserNotFoundError();
    if (!user.emailVerified) throw new EmailVerificationRequiredError();

    if (idempotencyKey !== undefined) {
      // Transaction-scoped PostgreSQL lock serializes same-customer/key attempts
      // across processes. The unique index is a second durable safeguard.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`order-create:${userId}:${idempotencyKey}`}, 0))`;
      const existing = await tx.order.findUnique({
        where: { userId_creationIdempotencyKey: { userId, creationIdempotencyKey: idempotencyKey } },
        include: { orderItems: true },
      });
      if (existing) {
        if (existing.creationRequestHash !== hash) throw new OrderIdempotencyMismatchError();
        return present(tx, existing);
      }
    }

    // No existing Order locks are acquired while this customer cart lock is held.
    // Stock locks precede task/allocation writes, matching confirmation ordering.
    await lockCustomerCart(tx, userId);
    for (const listingId of [...listingIdsSet].sort((a, b) => a - b)) {
      await tx.$queryRaw`SELECT id FROM "ProductListing" WHERE id = ${listingId} FOR UPDATE`;
    }
    await settleCartReconciliation(tx, userId);

    // 2a. Billing address
    const defaultBillingAddrs = await tx.address.findMany({
      where: { userId, isDefaultBilling: true },
      select: {
        recipientName: true,
        line1: true,
        line2: true,
        city: true,
        county: true,
        postcode: true,
        countryCode: true,
        phone: true,
      },
    });

    if (defaultBillingAddrs.length === 0) {
      throw new NoDefaultBillingAddressError();
    }
    if (defaultBillingAddrs.length > 1) {
      throw new MultipleDefaultBillingAddressesError();
    }
    const billing = defaultBillingAddrs[0];

    // 2b. Delivery snapshot – use billing if not provided
    const delivery = input.deliveryAddress ?? billing;

    // 2c. Load product listings for requested ids
    const distinctIds = Array.from(listingIdsSet);
    const listings = await tx.productListing.findMany({
      where: { id: { in: distinctIds } },
      include: { usedConditionPhotos: { orderBy: { sortOrder: "asc" } }, legoProduct: { select: { isPublished: true } } },
    });

    // Validate existence
    if (listings.length !== distinctIds.length) {
      const foundIds = new Set(listings.map((l) => l.id));
      const missingId = distinctIds.find((id) => !foundIds.has(id));
      throw new ProductListingNotFoundError(missingId!);
    }
    // Validate active status; offers of unpublished products are not purchasable.
    for (const l of listings) {
      const availability = listingAvailability(l, 1);
      if (availability.status === "UNAVAILABLE") {
        throw new ProductListingInactiveError(l.id, availability.reason!);
      }
    }
    const listingMap = new Map<number, typeof listings[0]>();
    listings.forEach((l) => listingMap.set(l.id, l));

    // 2d. Calculate prices and totals
    let totalAmount = new Decimal(0);
    const orderItemCreateData = input.items.map((item) => {
      const listing = listingMap.get(item.productListingId)!;
      const unitPrice = listing.salePrice ?? listing.originalPrice;
      const lineTotal = unitPrice.mul(item.quantity);
      totalAmount = totalAmount.add(lineTotal);
      return {
        productListingId: item.productListingId,
        quantity: item.quantity,
        unitPrice,
        lineTotal,
        conditionSnapshot: listing.condition,
        damageDescriptionSnapshot: listing.condition === "USED_LIKE_NEW" ? listing.damageDescription : null,
        conditionPhotoSnapshot: listing.condition === "USED_LIKE_NEW" ? listing.usedConditionPhotos.map((photo) => ({ id: photo.id, url: photo.url, publicId: photo.publicId, sortOrder: photo.sortOrder })) : undefined,
      };
    });

    // Give already-owned cart quantity its stable conflict before attempting a
    // second stock reservation. The customer lock protects the plan until commit.
    const cartAllocation = await prepareOrderCartAllocation(tx, userId, input.items);
    const createdAt = config.PAYMENT_RESOLUTION_ENABLED ? await databaseNow(tx) : now;
    for (const item of orderItemCreateData) {
      const availability = listingAvailability(listingMap.get(item.productListingId)!, item.quantity);
      if (availability.status !== "AVAILABLE") {
        throw new InsufficientAvailableStockError(item.productListingId, item.quantity, availability.availableQuantity);
      }
      const reservationResult = await tx.$executeRaw`
        UPDATE "ProductListing"
        SET "reservedStock" = "reservedStock" + ${item.quantity}
        WHERE id = ${item.productListingId}
          AND ("condition" = 'NEW' OR ("condition" = 'USED_LIKE_NEW' AND "usedLifecycle" = 'AVAILABLE'))
          AND "reservedStock" <= "currentStock" - ${item.quantity}
          AND (${!config.PAYMENT_RESOLUTION_ENABLED} OR "reservedStock" >= (
            SELECT COALESCE(SUM(oi.quantity), 0) FROM "OrderItem" oi
            JOIN "PaymentResolution" r ON r."orderId" = oi."orderId"
            WHERE oi."productListingId" = ${item.productListingId} AND r."reservationDisposition" = 'HELD'
          ))
      `;
      if (reservationResult === 0) {
        throw new InsufficientAvailableStockError(item.productListingId, item.quantity, availability.availableQuantity);
      }
    }

    // 2e. Persist the order with items
    const order = await tx.order.create({
      data: {
        userId,
        creationIdempotencyKey: idempotencyKey,
        creationRequestHash: hash,
        billingRecipientName: billing.recipientName,
        billingLine1: billing.line1,
        billingLine2: billing.line2 ?? undefined,
        billingCity: billing.city,
        billingCounty: billing.county ?? undefined,
        billingPostcode: billing.postcode,
        billingCountryCode: billing.countryCode,
        billingPhone: billing.phone ?? undefined,
        deliveryRecipientName: delivery.recipientName,
        deliveryLine1: delivery.line1,
        deliveryLine2: delivery.line2 ?? undefined,
        deliveryCity: delivery.city,
        deliveryCounty: delivery.county ?? undefined,
        deliveryPostcode: delivery.postcode,
        deliveryCountryCode: delivery.countryCode,
        deliveryPhone: delivery.phone ?? undefined,
        totalAmount,
        createdAt,
        reservationExpiresAt: new Date(createdAt.getTime() + 30 * 60 * 1000),
        orderItems: {
          create: orderItemCreateData,
        },
      },
      include: { orderItems: true },
    });
    await initializePaymentResolution(tx, order);
    await allocateOrderCart(tx, order.id, cartAllocation);
    return present(tx, order);
  });
}
