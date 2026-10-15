import assert from "node:assert/strict";
import { it } from "node:test";
import type { Prisma } from "../generated/prisma-client/client.js";
import { warnBlockedReturnReservation } from "../domain/orders/returnInventorySafety.js";

it("FIFO warning cache preserves new-order visibility beyond 1,000 orders and stays bounded", async t => {
  const warning = t.mock.method(console, "warn", () => {});
  const tx = {
    order: { findUnique: async () => ({ status: "PENDING" }) },
  } as unknown as Prisma.TransactionClient;
  // Observe the private cache without adding a production API solely for tests.
  const originalSet = Map.prototype.set;
  let cache: Map<number, number> | undefined;
  t.mock.method(Map.prototype, "set", function (this: Map<number, number>, key: number, value: number) {
    if (key === -1) cache = this;
    return originalSet.call(this, key, value);
  });
  const now = Date.now();
  t.mock.method(Date, "now", () => now);
  await warnBlockedReturnReservation(tx, -1, "EXPIRY");
  for (let i = 0; i < 5; i++) await warnBlockedReturnReservation(tx, -1, "MANAGED_RELEASE");
  assert.equal(warning.mock.callCount(), 1);

  for (let id = 2; id <= 1001; id++) {
    await warnBlockedReturnReservation(tx, -id, "EXPIRY");
    assert.ok(cache!.size <= 1000);
  }
  assert.equal(warning.mock.callCount(), 1001);
  assert.equal(cache!.size, 1000);
  assert.equal(cache!.has(-1), false);
  assert.equal(cache!.has(-2), true);
  assert.deepEqual(warning.mock.calls[1000].arguments, [{
    event: "ORDER_RESERVATION_RELEASE_BLOCKED",
    orderId: -1001,
    source: "EXPIRY",
    reason: "CONFLICTING_HISTORICAL_RETURN_RECORDS_OR_COUNTERS",
  }]);
  await warnBlockedReturnReservation(tx, -1001, "MANAGED_RELEASE");
  assert.equal(warning.mock.callCount(), 1001);

  // Evicted orders can warn again; reads of retained entries do not refresh FIFO order.
  await warnBlockedReturnReservation(tx, -2, "EXPIRY");
  await warnBlockedReturnReservation(tx, -1, "EXPIRY");
  assert.equal(warning.mock.callCount(), 1002);
  assert.equal(cache!.has(-2), false);
  assert.equal(cache!.size, 1000);

  // Concurrent status reads must not grow the cache or duplicate same-order warnings.
  await Promise.all(Array.from({ length: 100 }, (_, i) =>
    warnBlockedReturnReservation(tx, -2000 - i, "EXPIRY")));
  assert.equal(cache!.size, 1000);
  const count = warning.mock.callCount();
  await Promise.all(Array.from({ length: 10 }, () =>
    warnBlockedReturnReservation(tx, -3000, "EXPIRY")));
  assert.equal(warning.mock.callCount(), count + 1);
  assert.equal(cache!.size, 1000);
});
