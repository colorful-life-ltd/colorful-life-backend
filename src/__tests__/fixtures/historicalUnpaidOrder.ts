import { prisma } from '../../prisma/runtime.js';
/** Seed the legacy state that production no longer permits creating through confirmation. */
export async function historicalUnpaidConfirmedFixture(orderId: number, actorId: number) {
    await prisma.$transaction(async (tx) => {
        const order = await tx.order.findUniqueOrThrow({ where: { id: orderId }, include: { orderItems: true } });
        await tx.order.update({ where: { id: orderId }, data: { status: 'CONFIRMED', reservationExpiresAt: null } });
        for (const item of order.orderItems) {
            const listing = await tx.productListing.findUniqueOrThrow({ where: { id: item.productListingId } });
            await tx.productListing.update({ where: { id: listing.id }, data: { currentStock: { decrement: item.quantity }, reservedStock: { decrement: item.quantity }, ...(listing.condition === 'USED_LIKE_NEW' ? { usedLifecycle: 'SOLD' } : {}) } });
            await tx.inventoryMovement.create({ data: { listingId: listing.id, quantityChange: -item.quantity, type: 'WEBSITE_SALE', performedByUserId: actorId, note: `Order ${orderId} sale` } });
        }
    });
}
