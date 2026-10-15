import assert from "node:assert/strict";
import { after, afterEach, before, it } from "node:test";
import { randomUUID } from "node:crypto";
import jwt from "jsonwebtoken";
import app from "../app.js";
import { config } from "../config/index.js";
import { prisma } from "../prisma/runtime.js";
import { addCartItem, getCart, updateCartItem } from "../domain/cart/cartService.js";
import { createOrder } from "../domain/orders/orderService.js";
import { cancelOrder } from "../domain/orders/orderCancellationService.js";
import { confirmOrder } from "../domain/orders/orderConfirmationService.js";
import { reconcilePendingCarts } from "../domain/cart/cartProvenanceService.js";

const users: number[] = [], listings: number[] = [], products: number[] = [];
const resolutionEnabled = config.PAYMENT_RESOLUTION_ENABLED;
let server: ReturnType<typeof app.listen>, base: string;
before(async () => {
  server = app.listen(0);
  await new Promise<void>(resolve => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterEach(async () => {
  config.PAYMENT_RESOLUTION_ENABLED = resolutionEnabled;
  await prisma.order.deleteMany({ where: { userId: { in: users } } });
  await prisma.cart.deleteMany({ where: { userId: { in: users } } });
  await prisma.inventoryMovement.deleteMany({ where: { listingId: { in: listings } } });
  // Terminal Used offers are deliberately immutable. Match the existing Used-offer
  // test cleanup, but keep trigger changes and deletion in one rollback-safe transaction.
  await prisma.$transaction(async tx => {
    await tx.$executeRawUnsafe('ALTER TABLE "UsedConditionPhoto" DISABLE TRIGGER "UsedConditionPhoto_terminal_immutable"');
    await tx.$executeRawUnsafe('ALTER TABLE "ProductListing" DISABLE TRIGGER "ProductListing_used_lifecycle_guard"');
    await tx.productListing.deleteMany({ where: { id: { in: listings } } });
    await tx.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE");
    await tx.$executeRawUnsafe('ALTER TABLE "ProductListing" ENABLE TRIGGER "ProductListing_used_lifecycle_guard"');
    await tx.$executeRawUnsafe('ALTER TABLE "UsedConditionPhoto" ENABLE TRIGGER "UsedConditionPhoto_terminal_immutable"');
  });
  await prisma.legoProduct.deleteMany({ where: { id: { in: products } } });
  await prisma.user.deleteMany({ where: { id: { in: users } } });
  users.length = listings.length = products.length = 0;
});
after(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  await prisma.$disconnect();
});

async function customer() {
  const user = await prisma.user.create({ data: {
    email: `availability-${randomUUID()}@example.test`, passwordHash: "fixture", emailVerified: true,
    addresses: { create: { recipientName: "Fixture", line1: "Fixture", city: "London", postcode: "T1", countryCode: "GB", isDefaultBilling: true } },
  } });
  users.push(user.id);
  return { id: user.id, token: jwt.sign({ id: user.id, role: "CUSTOMER" }, config.JWT_SECRET) };
}
async function offer(stock = 5, used = false) {
  const product = await prisma.legoProduct.create({ data: {
    setNumber: randomUUID(), title: "Availability fixture", theme: "TEST", ageRecommendation: "8+", pieceCount: 1,
  } });
  products.push(product.id);
  const listing = await prisma.productListing.create({ data: {
    legoProductId: product.id, condition: used ? "USED_LIKE_NEW" : "NEW",
    currentStock: used ? 1 : stock, originalPrice: 12, salePrice: 10,
    ...(used ? { usedLifecycle: "AVAILABLE", damageDescription: "Fixture wear",
      usedConditionPhotos: { create: { url: "https://example.test/condition.jpg", publicId: randomUUID(), sortOrder: 0 } } } : {}),
  } });
  listings.push(listing.id);
  return listing;
}
type Customer = Awaited<ReturnType<typeof customer>>;
function http(user: Customer, path: string, method = "GET", body?: unknown) {
  return fetch(`${base}${path}`, { method, headers: { Authorization: `Bearer ${user.token}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
function checkout(user: Customer, lines: Array<{ productListingId: number; quantity: number }>) {
  return http(user, "/orders", "POST", { items: lines });
}
async function savedRows(user: Customer) {
  return prisma.cartItem.findMany({ where: { cart: { userId: user.id } }, orderBy: { id: "asc" } });
}
async function fail(user: Customer, listingId: number, quantity: number, code: string, reason = code, availableQuantity = 0) {
  const response = await checkout(user, [{ productListingId: listingId, quantity }]);
  assert.equal(response.status, 409);
  const { error } = await response.json();
  assert.equal(error.code, code);
  assert.equal(error.productListingId, listingId);
  assert.equal(error.reason, reason);
  assert.equal(error.availableQuantity, availableQuantity);
  assert.equal(typeof error.message, "string");
  assert.equal(await prisma.order.count({ where: { userId: user.id } }), 0);
}

for (const state of ["sold-out", "reserved-out", "insufficient", "unpublished", "inactive", "used-sold", "used-retired"] as const) {
  it(`projects ${state} from live data, preserves intent, rejects checkout with actionable 409 and permits removal`, async () => {
    const user = await customer(), used = state.startsWith("used-"), listing = await offer(5, used);
    const quantity = used ? 1 : 3;
    const added = await http(user, "/cart/items", "POST", { productListingId: listing.id, quantity });
    assert.equal(added.status, 200);
    assert.deepEqual((await added.json()).items[0].availability, { status: "AVAILABLE", reason: null, availableQuantity: used ? 1 : 5 });
    const rows = await savedRows(user);
    let status = "UNAVAILABLE", reason = "", availableQuantity = 0, code = "LISTING_UNAVAILABLE";
    if (state === "sold-out" || state === "reserved-out") {
      await prisma.productListing.update({ where: { id: listing.id }, data: state === "sold-out" ? { currentStock: 0 } : { reservedStock: 5 } });
      status = code = reason = "OUT_OF_STOCK";
    } else if (state === "insufficient") {
      await prisma.productListing.update({ where: { id: listing.id }, data: { reservedStock: 3 } });
      status = code = reason = "INSUFFICIENT_STOCK"; availableQuantity = 2;
    } else if (state === "unpublished") {
      await prisma.legoProduct.update({ where: { id: listing.legoProductId }, data: { isPublished: false } });
      reason = "PRODUCT_UNPUBLISHED";
    } else if (state === "inactive") {
      await prisma.productListing.update({ where: { id: listing.id }, data: { active: false } });
      reason = "LISTING_INACTIVE";
    } else {
      await prisma.productListing.update({ where: { id: listing.id }, data: { currentStock: 0, usedLifecycle: state === "used-sold" ? "SOLD" : "RETIRED" } });
      reason = "USED_OFFER_UNAVAILABLE";
    }
    const stockBefore = await prisma.productListing.findUniqueOrThrow({ where: { id: listing.id } });
    for (let repeat = 0; repeat < 2; repeat++) {
      const response = await http(user, "/cart");
      assert.equal(response.status, 200);
      const item = (await response.json()).items[0];
      assert.equal(item.productListingId, listing.id);
      assert.equal(item.quantity, quantity);
      assert.deepEqual(item.availability, { status, reason, availableQuantity });
      assert.equal(item.allocatedQuantity, 0); assert.equal(item.unallocatedQuantity, quantity);
    }
    await fail(user, listing.id, quantity, code, reason, availableQuantity);
    assert.deepEqual(await savedRows(user), rows);
    assert.deepEqual(await prisma.productListing.findUniqueOrThrow({ where: { id: listing.id } }), stockBefore);
    const removed = await http(user, `/cart/items/${listing.id}`, "DELETE");
    assert.equal(removed.status, 200);
    assert.deepEqual((await removed.json()).items, []);
    assert.deepEqual(await prisma.productListing.findUniqueOrThrow({ where: { id: listing.id } }), stockBefore);
  });
}

it("uses deterministic publication, active, Used lifecycle, zero-stock, insufficient-stock precedence", async () => {
  const user = await customer(), listing = await offer(1, true);
  await addCartItem(user.id, listing.id, 1);
  await prisma.productListing.update({ where: { id: listing.id }, data: { currentStock: 0, usedLifecycle: "RETIRED", active: false } });
  await prisma.legoProduct.update({ where: { id: listing.legoProductId }, data: { isPublished: false } });
  assert.equal((await getCart(user.id)).items[0].availability.reason, "PRODUCT_UNPUBLISHED");
  await prisma.legoProduct.update({ where: { id: listing.legoProductId }, data: { isPublished: true } });
  assert.equal((await getCart(user.id)).items[0].availability.reason, "LISTING_INACTIVE");
  await prisma.productListing.update({ where: { id: listing.id }, data: { active: true } });
  assert.equal((await getCart(user.id)).items[0].availability.reason, "USED_OFFER_UNAVAILABLE");
  await fail(user, listing.id, 1, "LISTING_UNAVAILABLE", "USED_OFFER_UNAVAILABLE");
});

it("restocking, republishing and reactivation restore availability without modifying the row or quantity", async () => {
  const user = await customer(), listing = await offer();
  await addCartItem(user.id, listing.id, 3);
  const rows = await savedRows(user);
  await prisma.productListing.update({ where: { id: listing.id }, data: { currentStock: 0, active: false } });
  await prisma.legoProduct.update({ where: { id: listing.legoProductId }, data: { isPublished: false } });
  assert.equal((await getCart(user.id)).items[0].availability.status, "UNAVAILABLE");
  await prisma.productListing.update({ where: { id: listing.id }, data: { currentStock: 2, active: true } });
  await prisma.legoProduct.update({ where: { id: listing.legoProductId }, data: { isPublished: true } });
  assert.deepEqual((await getCart(user.id)).items[0].availability, { status: "INSUFFICIENT_STOCK", reason: "INSUFFICIENT_STOCK", availableQuantity: 2 });
  await prisma.productListing.update({ where: { id: listing.id }, data: { currentStock: 3 } });
  assert.deepEqual((await getCart(user.id)).items[0].availability, { status: "AVAILABLE", reason: null, availableQuantity: 3 });
  assert.deepEqual(await savedRows(user), rows);
});

it("customer reduction resolves insufficient stock and PATCH returns the additive contract", async () => {
  const user = await customer(), listing = await offer();
  await addCartItem(user.id, listing.id, 3);
  await prisma.productListing.update({ where: { id: listing.id }, data: { reservedStock: 3 } });
  const response = await http(user, `/cart/items/${listing.id}`, "PATCH", { quantity: 2 });
  assert.equal(response.status, 200);
  const item = (await response.json()).items[0];
  assert.equal(item.quantity, 2);
  assert.deepEqual(item.availability, { status: "AVAILABLE", reason: null, availableQuantity: 2 });
  assert.equal((await prisma.productListing.findUniqueOrThrow({ where: { id: listing.id } })).reservedStock, 3);
});

for (const invalid of ["stock", "unpublished", "inactive"] as const) it(`mixed checkout with ${invalid} line leaves no partial order, reservation or provenance`, async () => {
  const user = await customer(), valid = await offer(), bad = await offer();
  await addCartItem(user.id, valid.id, 2); await addCartItem(user.id, bad.id, 2);
  if (invalid === "stock") await prisma.productListing.update({ where: { id: bad.id }, data: { currentStock: 1 } });
  if (invalid === "unpublished") await prisma.legoProduct.update({ where: { id: bad.legoProductId }, data: { isPublished: false } });
  if (invalid === "inactive") await prisma.productListing.update({ where: { id: bad.id }, data: { active: false } });
  const rows = await savedRows(user);
  const stock = await prisma.productListing.findMany({ where: { id: { in: [valid.id, bad.id] } }, orderBy: { id: "asc" } });
  const response = await checkout(user, [{ productListingId: valid.id, quantity: 2 }, { productListingId: bad.id, quantity: 2 }]);
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error.productListingId, bad.id);
  assert.equal(await prisma.order.count({ where: { userId: user.id } }), 0);
  assert.equal(await prisma.orderCartProvenance.count({ where: { cart: { userId: user.id } } }), 0);
  assert.deepEqual(await savedRows(user), rows);
  assert.deepEqual(await prisma.productListing.findMany({ where: { id: { in: [valid.id, bad.id] } }, orderBy: { id: "asc" } }), stock);
});

it("allows a submitted subset despite unrelated unavailable cart entries and preserves server prices", async () => {
  const user = await customer(), valid = await offer(), bad = await offer();
  await addCartItem(user.id, valid.id, 3); await addCartItem(user.id, bad.id, 2);
  await prisma.productListing.update({ where: { id: bad.id }, data: { active: false } });
  const response = await checkout(user, [{ productListingId: valid.id, quantity: 1 }]);
  assert.equal(response.status, 201);
  const body = await response.json();
  assert.equal(body.orderItems.length, 1);
  assert.equal(body.orderItems[0].unitPrice, "10"); assert.equal(body.totalAmount, "10");
  assert.equal((await savedRows(user)).length, 2);
  const fresh = await offer();
  // A direct-order line absent from the saved cart retains the same contract.
  assert.equal((await checkout(user, [{ productListingId: fresh.id, quantity: 1 }])).status, 201);
});

for (const managed of [false, true]) it(`${managed ? "managed" : "legacy"} pending allocations do not double-count stock or permit a second claim`, async () => {
  config.PAYMENT_RESOLUTION_ENABLED = managed;
  const user = await customer(), listing = await offer(2);
  await addCartItem(user.id, listing.id, 1);
  const order = await createOrder(user.id, { items: [{ productListingId: listing.id, quantity: 1 }] });
  let item = (await getCart(user.id)).items[0];
  assert.equal(item.quantity, 1); assert.equal(item.allocatedQuantity, 1); assert.equal(item.unallocatedQuantity, 0);
  assert.deepEqual(item.availability, { status: "UNAVAILABLE", reason: "CART_QUANTITY_ALLOCATED", availableQuantity: 1 });
  const blocked = await checkout(user, [{ productListingId: listing.id, quantity: 1 }]);
  assert.equal(blocked.status, 409);
  assert.equal((await blocked.json()).error.code, "CART_QUANTITY_UNAVAILABLE");
  await addCartItem(user.id, listing.id, 1);
  const rows = await savedRows(user);
  item = (await getCart(user.id)).items[0];
  assert.equal(item.quantity, 2); assert.equal(item.allocatedQuantity, 1); assert.equal(item.unallocatedQuantity, 1);
  assert.deepEqual(item.availability, { status: "AVAILABLE", reason: null, availableQuantity: 1 });
  assert.deepEqual(await savedRows(user), rows);
  // Total quantity exceeds free stock; PATCH still validates only unallocated intent.
  await updateCartItem(user.id, listing.id, 2);
  await cancelOrder(user.id, order.id, "CHANGED_MIND");
  // GET does not settle queued release work.
  assert.equal((await getCart(user.id)).items[0].allocatedQuantity, 1);
  await reconcilePendingCarts();
  item = (await getCart(user.id)).items[0];
  assert.equal(item.quantity, 2); assert.equal(item.allocatedQuantity, 0);
  assert.deepEqual(item.availability, { status: "AVAILABLE", reason: null, availableQuantity: 2 });
});

it("fully allocated final-unit cart stays visible and a new checkout retains the provenance conflict", async () => {
  const user = await customer(), listing = await offer(1);
  await addCartItem(user.id, listing.id, 1);
  await createOrder(user.id, { items: [{ productListingId: listing.id, quantity: 1 }] });
  const item = (await getCart(user.id)).items[0];
  assert.deepEqual(item.availability, { status: "UNAVAILABLE", reason: "CART_QUANTITY_ALLOCATED", availableQuantity: 0 });
  const response = await checkout(user, [{ productListingId: listing.id, quantity: 1 }]);
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error.code, "CART_QUANTITY_UNAVAILABLE");
  assert.equal(await prisma.order.count({ where: { userId: user.id } }), 1);
});

it("confirmation reconciliation still consumes only allocated quantity and preserves later additions", async () => {
  const user = await customer(), listing = await offer(3);
  await addCartItem(user.id, listing.id, 1);
  const order = await createOrder(user.id, { items: [{ productListingId: listing.id, quantity: 1 }] });
  await addCartItem(user.id, listing.id, 1);
  await confirmOrder(user.id, order.id);
  const before = await savedRows(user);
  let item = (await getCart(user.id)).items[0];
  assert.equal(item.allocatedQuantity, 1); assert.equal(item.unallocatedQuantity, 1);
  assert.deepEqual(item.availability, { status: "AVAILABLE", reason: null, availableQuantity: 2 });
  assert.deepEqual(await savedRows(user), before);
  await reconcilePendingCarts();
  item = (await getCart(user.id)).items[0];
  assert.equal(item.quantity, 1); assert.equal(item.allocatedQuantity, 0);
  assert.equal(item.availability.status, "AVAILABLE");
});

it("missing submitted listing returns a stable listing-specific 409", async () => {
  const user = await customer(), listing = await offer();
  await prisma.productListing.delete({ where: { id: listing.id } });
  await fail(user, listing.id, 1, "LISTING_UNAVAILABLE", "LISTING_NOT_FOUND");
});

it("two customers genuinely competing behind a listing lock cannot reserve the same final unit", async () => {
  const one = await customer(), two = await customer(), listing = await offer(1);
  await addCartItem(one.id, listing.id, 1); await addCartItem(two.id, listing.id, 1);
  let ready!: (pid: number) => void, release!: () => void;
  const started = new Promise<number>(resolve => { ready = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const held = prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "ProductListing" WHERE id=${listing.id} FOR UPDATE`;
    const [row] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
    ready(row.pid); await gate;
  }, { timeout: 15000 });
  const pid = await started;
  const results = [one, two].map(user => checkout(user, [{ productListingId: listing.id, quantity: 1 }]));
  try {
    const deadline = Date.now() + 3000;
    let queued = false;
    while (Date.now() < deadline) {
      const [row] = await prisma.$queryRaw<Array<{ n: number }>>`
        WITH RECURSIVE waiting(pid) AS (
          SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND ${pid}=ANY(pg_blocking_pids(pid))
          UNION SELECT a.pid FROM pg_stat_activity a JOIN waiting w ON w.pid=ANY(pg_blocking_pids(a.pid))
          WHERE a.datname=current_database()
        ) SELECT count(*)::int AS n FROM waiting`;
      if (row.n >= 2) { queued = true; break; }
      await new Promise<void>(resolve => setTimeout(resolve, 10));
    }
    assert.ok(queued, "Both independent customers must reach the actual inventory lock");
  } finally { release(); await held; }
  const responses = await Promise.all(results), bodies = await Promise.all(responses.map(response => response.json()));
  assert.deepEqual(responses.map(response => response.status).sort(), [201, 409]);
  const rejected = bodies[responses.findIndex(response => response.status === 409)];
  assert.equal(rejected.error.code, "OUT_OF_STOCK"); assert.equal(rejected.error.productListingId, listing.id);
  assert.equal(await prisma.order.count({ where: { userId: { in: [one.id, two.id] } } }), 1);
  const stock = await prisma.productListing.findUniqueOrThrow({ where: { id: listing.id } });
  assert.equal(stock.currentStock, 1); assert.equal(stock.reservedStock, 1);
  const winner = responses[0].status === 201 ? one : two, loser = winner.id === one.id ? two : one;
  assert.equal((await getCart(winner.id)).items[0].availability.reason, "CART_QUANTITY_ALLOCATED");
  assert.equal((await getCart(loser.id)).items[0].availability.status, "OUT_OF_STOCK");
});

it("clamps historically over-reserved stock to a nonnegative out-of-stock projection", async () => {
  const user = await customer(), listing = await offer();
  await addCartItem(user.id, listing.id, 1);
  await prisma.productListing.update({ where: { id: listing.id }, data: { currentStock: 1, reservedStock: 2 } });
  assert.deepEqual((await getCart(user.id)).items[0].availability,
    { status: "OUT_OF_STOCK", reason: "OUT_OF_STOCK", availableQuantity: 0 });
  await fail(user, listing.id, 1, "OUT_OF_STOCK");
});

it("managed reservation coverage mismatch remains fail-closed with an actionable conflict", async () => {
  config.PAYMENT_RESOLUTION_ENABLED = true;
  const owner = await customer(), buyer = await customer(), listing = await offer(3);
  const held = await createOrder(owner.id, { items: [{ productListingId: listing.id, quantity: 1 }] });
  // Simulate historical coverage corruption; never auto-repair it during checkout.
  await prisma.productListing.update({ where: { id: listing.id }, data: { reservedStock: 0 } });
  await addCartItem(buyer.id, listing.id, 1);
  assert.equal((await getCart(buyer.id)).items[0].availability.status, "AVAILABLE");
  const before = await prisma.productListing.findUniqueOrThrow({ where: { id: listing.id } });
  const rows = await savedRows(buyer);
  await fail(buyer, listing.id, 1, "LISTING_UNAVAILABLE", "INVENTORY_RESERVATION_CONFLICT");
  assert.deepEqual(await prisma.productListing.findUniqueOrThrow({ where: { id: listing.id } }), before);
  assert.deepEqual(await savedRows(buyer), rows);
  assert.equal((await prisma.paymentResolution.findUniqueOrThrow({ where: { orderId: held.id } })).reservationDisposition, "HELD");
});
