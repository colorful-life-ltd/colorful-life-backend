import { hasValidListingPrices, InvalidListingPriceError } from "../products/listingPrice.js";
import { listingAvailability } from "../inventory/listingAvailability.js";
import { prisma } from "../../prisma/runtime.js";
import { lockCustomerCart, settleCartReconciliation, allocatedQuantity, reduceAllocations } from "./cartProvenanceService.js";
import { CartReconciliationState as State } from "../../generated/prisma-client/enums.js";
import { Prisma } from "../../generated/prisma-client/client.js";
import { CartItemNotFoundError, InsufficientAvailableStockError, ProductListingInactiveError, ProductListingNotFoundError } from "./cartErrors.js";

const listingSelect = {
  id: true, legoProductId: true, condition: true, originalPrice: true, salePrice: true,
  currentStock: true, reservedStock: true, active: true, usedLifecycle: true, damageDescription: true,
  legoProduct: { include: { productImages: {
    select: { id: true, url: true, publicId: true, altText: true, sortOrder: true },
    orderBy: [{ sortOrder: "asc" as const }, { id: "asc" as const }],
  } } },
  usedConditionPhotos: { orderBy: { sortOrder: "asc" as const } },
};

const cartInclude = { items: { include: {
  productListing: { select: listingSelect },
  orderAllocations: { where: { provenance: { state: { in: [State.ACTIVE, State.CONSUME_PENDING, State.RELEASE_PENDING] } } }, select: { visibleQuantity: true } },
}, orderBy: { id: "asc" as const } } };

function present(cart: any) {
  return { ...cart, items: cart.items.map(({ orderAllocations, ...item }: any) => {
    const allocatedQuantity = orderAllocations.reduce((sum: number, row: { visibleQuantity: number }) => sum + row.visibleQuantity, 0);
    const unallocatedQuantity = item.quantity - allocatedQuantity;
    const availability = hasValidListingPrices(item.productListing)
      ? listingAvailability(item.productListing, unallocatedQuantity)
      : { status: "UNAVAILABLE" as const, reason: "INVALID_PRICE" as const, availableQuantity: 0 };
    // Existing order allocations are never counted as stock available to a new order.
    if (unallocatedQuantity <= 0 && availability.status !== "UNAVAILABLE") {
      availability.status = "UNAVAILABLE";
      availability.reason = "CART_QUANTITY_ALLOCATED";
    }
    return { ...item, allocatedQuantity, unallocatedQuantity, availability,
      productListing: { ...item.productListing, availableStock: Math.max(0, item.productListing.currentStock - item.productListing.reservedStock), effectivePrice: item.productListing.salePrice ?? item.productListing.originalPrice } };
  }) };
}

export async function getCart(userId: number) {
  // Preserve lazy cart creation; projection reads a consistent quantity/provenance
  // snapshot, with no hidden reconciliation or shopping-intent mutation.
  await prisma.cart.upsert({ where: { userId }, create: { userId }, update: {} });
  return present(await prisma.$transaction((tx) => tx.cart.findUniqueOrThrow({ where: { userId }, include: cartInclude }),
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead }));
}

async function validateListing(productListingId: number, quantity: number, db: typeof prisma | Prisma.TransactionClient = prisma) {
  const listing = await db.productListing.findUnique({ where: { id: productListingId }, select: listingSelect });
  if (!listing) throw new ProductListingNotFoundError(productListingId);
  if (!hasValidListingPrices(listing)) throw new InvalidListingPriceError(productListingId);
  // An unpublished product is private, so none of its offers can be bought.
  if (!listing.active || !listing.legoProduct.isPublished) throw new ProductListingInactiveError(productListingId);
  if (listing.condition === "USED_LIKE_NEW" && listing.usedLifecycle !== "AVAILABLE") {
    throw new InsufficientAvailableStockError(productListingId, 0, quantity);
  }
  const availableStock = listing.currentStock - listing.reservedStock;
  if (quantity > availableStock) throw new InsufficientAvailableStockError(productListingId, availableStock, quantity);
  return listing;
}

// Cart lock precedes listing locks. Listing locks precede any provenance writes.
export async function addCartItem(userId: number, productListingId: number, quantity: number) {
  const itemId = await prisma.$transaction(async (tx) => {
    await lockCustomerCart(tx, userId);
    await tx.$queryRaw`SELECT id FROM "ProductListing" WHERE id = ${productListingId} FOR UPDATE`;
    await settleCartReconciliation(tx, userId);
    const cart = await tx.cart.upsert({ where: { userId }, create: { userId }, update: {} });
    const existing = await tx.cartItem.findUnique({ where: { cartId_productListingId: { cartId: cart.id, productListingId } } });
    const allocated = existing ? await allocatedQuantity(tx, existing.id) : 0;
    const total = (existing?.quantity ?? 0) + quantity;
    await validateListing(productListingId, total - allocated, tx);
    const item = await tx.cartItem.upsert({
      where: { cartId_productListingId: { cartId: cart.id, productListingId } },
      create: { cartId: cart.id, productListingId, quantity }, update: { quantity: total },
    });
    return item.id;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
  return { ...await getCart(userId), itemId };
}

export async function updateCartItem(userId: number, productListingId: number, quantity: number) {
  await prisma.$transaction(async (tx) => {
    await lockCustomerCart(tx, userId);
    await tx.$queryRaw`SELECT id FROM "ProductListing" WHERE id = ${productListingId} FOR UPDATE`;
    const cart = await tx.cart.findUnique({ where: { userId }, select: { id: true } });
    if (!cart) throw new CartItemNotFoundError();
    const original = await tx.cartItem.findUnique({ where: { cartId_productListingId: { cartId: cart.id, productListingId } } });
    if (!original) throw new CartItemNotFoundError();
    await settleCartReconciliation(tx, userId);
    const existing = await tx.cartItem.findUnique({ where: { cartId_productListingId: { cartId: cart.id, productListingId } } });
    const allocated = existing ? await allocatedQuantity(tx, existing.id) : 0;
    await validateListing(productListingId, Math.max(0, quantity - allocated), tx);
    if (existing) {
      await reduceAllocations(tx, existing.id, quantity);
      await tx.cartItem.update({ where: { id: existing.id }, data: { quantity } });
    } else {
      // The confirmed allocation consumed the original row. This target is fresh
      // intent and must have a fresh row identity, never reattach old provenance.
      await tx.cartItem.create({ data: { cartId: cart.id, productListingId, quantity } });
    }
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
  return getCart(userId);
}

export async function removeCartItem(userId: number, productListingId: number) {
  await prisma.$transaction(async (tx) => {
    await lockCustomerCart(tx, userId);
    const cart = await tx.cart.findUnique({ where: { userId }, select: { id: true } });
    const original = cart ? await tx.cartItem.findUnique({ where: { cartId_productListingId: { cartId: cart.id, productListingId } } }) : null;
    if (!original) throw new CartItemNotFoundError();
    await settleCartReconciliation(tx, userId);
    const item = await tx.cartItem.findUnique({ where: { id: original.id } });
    if (item) {
      await reduceAllocations(tx, item.id, 0);
      await tx.cartItem.delete({ where: { id: item.id } });
    }
  });
  return getCart(userId);
}

export async function clearCart(userId: number) {
  await prisma.$transaction(async (tx) => {
    await lockCustomerCart(tx, userId);
    await settleCartReconciliation(tx, userId);
    const cart = await tx.cart.findUnique({ where: { userId }, include: { items: true } });
    if (!cart) return;
    for (const item of cart.items) await reduceAllocations(tx, item.id, 0);
    await tx.cartItem.deleteMany({ where: { cartId: cart.id } });
  });
  return getCart(userId);
}
