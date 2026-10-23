import { completedSweep } from "../../operations/health.js";
import {logOperationalError} from "../../utils/operationalLog.js";
import type { Prisma } from "../../generated/prisma-client/client.js";
import { prisma } from "../../prisma/runtime.js";
import { CartReconciliationState as State } from "../../generated/prisma-client/enums.js";

export class CartQuantityAllocatedError extends Error {
  constructor(public readonly productListingId: number) {
    super(`Cart quantity for listing ${productListingId} is already associated with another order or has changed`);
  }
}

/** No User row lock: financial inventory movements acquire User FK locks. */
export async function lockCustomerCart(tx: Prisma.TransactionClient, userId: number) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`cart:${userId}`}, 0))`;
}

const attachedStates = [State.ACTIVE, State.CONSUME_PENDING, State.RELEASE_PENDING];
export async function allocatedQuantity(tx: Prisma.TransactionClient, cartItemId: number) {
  const result = await tx.orderCartAllocation.aggregate({
    where: { cartItemId, provenance: { state: { in: attachedStates } } },
    _sum: { visibleQuantity: true },
  });
  return result._sum.visibleQuantity ?? 0;
}

/** Caller holds customer cart lock. Reductions discard new intent first. */
export async function reduceAllocations(tx: Prisma.TransactionClient, cartItemId: number, target: number) {
  const allocations = await tx.orderCartAllocation.findMany({
    where: { cartItemId, provenance: { state: { in: attachedStates } } },
    orderBy: [{ orderId: "asc" }, { id: "asc" }],
  });
  let excess = Math.max(0, allocations.reduce((sum, a) => sum + a.visibleQuantity, 0) - target);
  for (const allocation of allocations) {
    const reduction = Math.min(excess, allocation.visibleQuantity);
    if (reduction) await tx.orderCartAllocation.update({ where: { id: allocation.id }, data: { visibleQuantity: { decrement: reduction } } });
    excess -= reduction;
  }
}

/** Creation owns customer cart and listing locks. Missing cart lines are direct-order lines. */
export async function prepareOrderCartAllocation(tx: Prisma.TransactionClient, userId: number, items: Array<{ productListingId: number; quantity: number }>) {
  const cart = await tx.cart.findUnique({ where: { userId }, include: { items: true } });
  if (!cart) return null;
  const allocations = [];
  for (const item of items) {
    const saved = cart.items.find((row) => row.productListingId === item.productListingId);
    if (!saved) continue;
    if (saved.quantity - await allocatedQuantity(tx, saved.id) < item.quantity) {
      throw new CartQuantityAllocatedError(item.productListingId);
    }
    allocations.push({ cartItemId: saved.id, productListingId: item.productListingId, quantity: item.quantity, visibleQuantity: item.quantity });
  }
  return allocations.length ? { cartId: cart.id, allocations } : null;
}

export async function allocateOrderCart(tx: Prisma.TransactionClient, orderId: number, plan: Awaited<ReturnType<typeof prepareOrderCartAllocation>>) {
  if (plan) await tx.orderCartProvenance.create({ data: { orderId, cartId: plan.cartId, allocations: { create: plan.allocations } } });
}

/** Financial transaction records only a durable task. Legacy orders are a no-op. */
export async function queueCartReconciliation(tx: Prisma.TransactionClient, orderId: number, consume: boolean) {
  await tx.orderCartProvenance.updateMany({
    where: { orderId, state: State.ACTIVE },
    data: { state: consume ? State.CONSUME_PENDING : State.RELEASE_PENDING },
  });
}

/** No Order or inventory locks. Caller must hold the customer cart advisory lock. */
export async function settleCartReconciliation(tx: Prisma.TransactionClient, userId: number) {
  const tasks = await tx.orderCartProvenance.findMany({
    where: { cart: { userId }, state: { in: [State.CONSUME_PENDING, State.RELEASE_PENDING] } },
    include: { allocations: true }, orderBy: { orderId: "asc" },
  });
  for (const task of tasks) {
    if (task.state === State.CONSUME_PENDING) {
      for (const allocation of task.allocations) {
        if (allocation.cartItemId === null || allocation.visibleQuantity === 0) continue;
        const row = await tx.cartItem.findFirst({ where: { id: allocation.cartItemId, cartId: task.cartId, productListingId: allocation.productListingId } });
        // Supported removal sets the FK to null. A non-null but mismatched
        // identity is corruption: retry after repair, never guess or mark done.
        if (!row) throw new Error("Cart provenance row identity inconsistency");
        if (row.quantity < allocation.visibleQuantity) throw new Error("Cart provenance quantity inconsistency");
        if (row.quantity === allocation.visibleQuantity) {
          await tx.cartItem.delete({ where: { id: row.id } });
        } else {
          await tx.cartItem.update({ where: { id: row.id }, data: { quantity: { decrement: allocation.visibleQuantity } } });
        }
      }
    }
    await tx.orderCartAllocation.updateMany({ where: { orderId: task.orderId }, data: { visibleQuantity: 0 } });
    await tx.orderCartProvenance.update({ where: { orderId: task.orderId }, data: {
      state: task.state === State.CONSUME_PENDING ? State.CONSUMED : State.RELEASED,
      completedAt: new Date(), lastError: null,
    } });
  }
}

/** Retryable durable work; never queries Stripe or historical orders. */
export async function reconcilePendingCarts() {
  let cursor = 0;
  while (true) {
    const tasks = await prisma.orderCartProvenance.findMany({
      where: { orderId: { gt: cursor }, state: { in: [State.CONSUME_PENDING, State.RELEASE_PENDING] } },
      select: { orderId: true, cart: { select: { userId: true } } }, orderBy: { orderId: "asc" }, take: 100,
    });
    if (tasks.length === 0) return;
    cursor = tasks[tasks.length - 1].orderId;
    for (const userId of new Set(tasks.map((task) => task.cart.userId))) {
      try {
        await prisma.$transaction(async (tx) => {
          await lockCustomerCart(tx, userId);
          await settleCartReconciliation(tx, userId);
        });
      } catch (error) {
        // Financial confirmation already committed; preserve pending work for retry.
        await prisma.orderCartProvenance.updateMany({
          where: { cart: { userId }, state: { in: [State.CONSUME_PENDING, State.RELEASE_PENDING] } },
          data: { lastError: error instanceof Error ? error.message : "Cart reconciliation failed" },
        });
      }
    }
  }
}

/** Polling is only scheduling, not a correctness lock; multiple instances are safe. */
export function startCartReconciliationWorker(intervalMs = 5_000) {
  let running = false, stopped=false;
  const tick = async () => {
    if (running || stopped) return;
    running = true;
    try { await reconcilePendingCarts(); completedSweep('cart'); }
    catch (error) { logOperationalError("Cart reconciliation worker failed; will retry", error); }
    finally { running = false; }
  };
  let pending:Promise<void>=Promise.resolve();
  const launch=()=>{if(!running&&!stopped)pending=tick();};
  const timer = setInterval(launch, intervalMs);
  timer.unref();
  launch();
  return async () => { stopped=true; clearInterval(timer); await pending; };
}
