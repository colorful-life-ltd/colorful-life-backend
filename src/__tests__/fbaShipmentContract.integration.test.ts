import assert from "node:assert/strict";
import { after, before, it } from "node:test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import jwt from "jsonwebtoken";
import app from "../app.js";
import { config } from "../config/index.js";
import { prisma } from "../prisma/runtime.js";

// Provider side of the Backend-owned contracts/fba-shipments-v1.json, which the Admin pins and parses.
// Every real response must have exactly the fixture's structure: same keys, value types and nullness.
const contract = JSON.parse(readFileSync("contracts/fba-shipments-v1.json", "utf8"));
function sameShape(actual: unknown, expected: unknown, path = "$"): void {
  if (expected === null) return assert.equal(actual, null, `${path} must be null`);
  if (Array.isArray(expected)) {
    assert.ok(Array.isArray(actual), `${path} must be an array`);
    if (expected.length) { assert.ok(actual.length > 0, `${path} must not be empty`); actual.forEach((item, i) => sameShape(item, expected[0], `${path}[${i}]`)); }
    return;
  }
  if (typeof expected === "object") {
    assert.ok(actual !== null && typeof actual === "object" && !Array.isArray(actual), `${path} must be an object`);
    assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort(), `${path} keys`);
    for (const key of Object.keys(expected)) sameShape((actual as Record<string, unknown>)[key], (expected as Record<string, unknown>)[key], `${path}.${key}`);
    return;
  }
  assert.equal(typeof actual, typeof expected, `${path} type`);
}

let server: ReturnType<typeof app.listen>, base = "", token = "", adminId = 0;
const marker = `CONTRACT${randomUUID().slice(0, 6).toUpperCase()}`, productIds: number[] = [];
let one = 0, two = 0;
before(async () => {
  server = app.listen(0, "127.0.0.1"); await new Promise<void>(r => server.once("listening", r));
  const address = server.address(); assert.ok(address && typeof address !== "string"); base = `http://127.0.0.1:${address.port}`;
  const admin = await prisma.user.create({ data: { email: `${randomUUID()}@contract.test`, passwordHash: "synthetic", role: "ADMIN", emailVerified: true } });
  adminId = admin.id; token = jwt.sign({ id: admin.id, role: "ADMIN" }, config.JWT_SECRET);
  for (const [i, stock] of [[1, 10], [2, 3]] as const) {
    const product = await prisma.legoProduct.create({ data: { setNumber: `${marker}-${i}`, title: `${marker} contract set ${i}`, theme: "TEST", ageRecommendation: "8+", pieceCount: 1 } });
    productIds.push(product.id);
    const listing = await prisma.productListing.create({ data: { legoProductId: product.id, condition: "NEW", originalPrice: 10, currentStock: stock } });
    if (i === 1) one = listing.id; else two = listing.id;
  }
});
after(async () => {
  const listings = { productListing: { legoProductId: { in: productIds } } };
  const shipmentIds = (await prisma.fbaOutbound.findMany({ where: listings, select: { fbaShipmentId: true } })).flatMap(r => r.fbaShipmentId ? [r.fbaShipmentId] : []);
  await prisma.fbaOutbound.deleteMany({ where: listings });
  await prisma.inventoryMovement.deleteMany({ where: { listing: { legoProductId: { in: productIds } } } });
  await prisma.fbaShipment.deleteMany({ where: { id: { in: shipmentIds } } });
  await prisma.productListing.deleteMany({ where: { legoProductId: { in: productIds } } });
  await prisma.legoProduct.deleteMany({ where: { id: { in: productIds } } });
  await prisma.user.delete({ where: { id: adminId } });
  await new Promise<void>(r => server.close(() => r())); await prisma.$disconnect();
});
const call = (path: string, body?: unknown) => fetch(`${base}${path}`, body === undefined
  ? { headers: { Authorization: `Bearer ${token}` } }
  : { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
async function stock() {
  const rows = await prisma.productListing.findMany({ where: { id: { in: [one, two] } }, orderBy: { id: "asc" }, select: { currentStock: true, reservedStock: true } });
  return rows.map(r => [r.currentStock, r.reservedStock]);
}
const movements = () => prisma.inventoryMovement.findMany({ where: { listingId: { in: [one, two] } }, include: { fbaOutbound: true } });
let created: { id: number; reference: string; externalReference: string } | null = null;

it("matches the request fixture accepted by the Admin", () => {
  sameShape({ idempotencyKey: "k", items: [{ productListingId: 1, quantity: 1 }], externalReference: "R", note: "N" }, contract.shipmentRequest);
});

it("finds listings by set number and by title", async () => {
  for (const q of [`${marker}-1`.toLowerCase(), `${marker} contract set`]) {
    const response = await call(`/admin/product-listings?page=1&pageSize=20&q=${encodeURIComponent(q)}`);
    assert.equal(response.status, 200);
    const ids = (await response.json()).items.map((i: { id: number }) => i.id).sort((a: number, b: number) => a - b);
    assert.deepEqual(ids, q.endsWith("-1") ? [one] : [one, two].sort((a, b) => a - b));
  }
});

it("records a multi-item shipment in the contract shape with matching stock and ledger", async () => {
  const response = await call("/inventory/fba-shipments", { ...contract.shipmentRequest, idempotencyKey: randomUUID(), externalReference: ` ${marker.toLowerCase()} 1 `, items: [{ productListingId: one, quantity: 2 }, { productListingId: two, quantity: 1 }] });
  assert.equal(response.status, 201);
  const body = await response.json(); sameShape(body, contract.shipmentCreated);
  created = body.shipment; assert.equal(body.shipment.externalReference, `${marker}1`);
  assert.deepEqual(await stock(), [[8, 0], [2, 0]]);
  const ledger = await movements();
  assert.equal(ledger.length, 2);
  for (const m of ledger) { assert.equal(m.type, "FBA_OUTBOUND"); assert.equal(m.performedByUserId, adminId); assert.equal(m.fbaOutbound?.fbaShipmentId, body.shipment.id); assert.equal(m.fbaOutbound?.appliedQuantity, -m.quantityChange); }
});

it("refuses a duplicate Amazon reference with the contract duplicate details", async () => {
  assert.ok(created);
  const response = await call("/inventory/fba-shipments", { idempotencyKey: randomUUID(), items: [{ productListingId: one, quantity: 1 }], externalReference: created.externalReference.toLowerCase() });
  assert.equal(response.status, 409);
  const body = await response.json(); sameShape(body, contract.duplicateReferenceError);
  assert.equal(body.error.code, "DUPLICATE_FBA_SHIPMENT"); assert.equal(body.error.duplicates[0].shipmentId, created.id);
  assert.deepEqual(await stock(), [[8, 0], [2, 0]]);
});

it("warns about a recent identical shipment and records it after acknowledgement", async () => {
  const items = [{ productListingId: one, quantity: 1 }];
  const firstResponse = await call("/inventory/fba-shipments", { idempotencyKey: randomUUID(), items });
  assert.equal(firstResponse.status, 201); const first = (await firstResponse.json()).shipment;
  const warned = await call("/inventory/fba-shipments", { idempotencyKey: randomUUID(), items });
  assert.equal(warned.status, 409);
  const warning = await warned.json(); sameShape(warning, contract.possibleDuplicateError);
  assert.equal(warning.error.duplicates[0].shipmentId, first.id); assert.equal(warning.error.duplicates[0].createdAt, first.createdAt);
  const acknowledged = await call("/inventory/fba-shipments", { idempotencyKey: randomUUID(), items, acknowledgedDuplicateShipmentIds: [first.id] });
  assert.equal(acknowledged.status, 201);
  const body = await acknowledged.json(); sameShape(body, contract.acknowledgedShipment);
  assert.deepEqual(body.shipment.acknowledgedDuplicateShipmentIds, [first.id]);
  assert.deepEqual(await stock(), [[6, 0], [2, 0]]);
});

it("rejects the whole shipment when one line is short, in the contract shape", async () => {
  const response = await call("/inventory/fba-shipments", { idempotencyKey: randomUUID(), items: [{ productListingId: one, quantity: 1 }, { productListingId: two, quantity: 5 }], externalReference: `${marker}SHORT` });
  assert.equal(response.status, 409);
  const body = await response.json(); sameShape(body, contract.insufficientStockError);
  assert.deepEqual(body.error.items, [{ productListingId: two, reason: "INSUFFICIENT_AVAILABLE_STOCK", availableQuantity: 2, requestedQuantity: 5 }]);
  assert.deepEqual(await stock(), [[6, 0], [2, 0]]);
});

it("replays a committed shipment whose response was lost, without deducting again", async () => {
  const request = { idempotencyKey: randomUUID(), items: [{ productListingId: two, quantity: 1 }], externalReference: `${marker}LOST`, note: "Lost response retry" };
  // The first response is discarded, as if the connection dropped after commit.
  const lost = await call("/inventory/fba-shipments", request); assert.equal(lost.status, 201); const original = (await lost.json()).shipment;
  const replay = await call("/inventory/fba-shipments", request);
  assert.equal(replay.status, 200);
  const body = await replay.json(); sameShape(body, { ...contract.shipmentCreated, replayed: true });
  assert.equal(body.replayed, true); assert.deepEqual(body.shipment, original);
  assert.deepEqual(await stock(), [[6, 0], [1, 0]]);
  assert.equal((await movements()).length, 5);
});

it("returns shipment history in the contract page shape", async () => {
  const response = await call("/inventory/fba-shipments?page=1&pageSize=10");
  assert.equal(response.status, 200);
  const page = await response.json();
  // Shipments without an Amazon ID or note legitimately carry nulls (see acknowledgedShipment);
  // compare the page envelope through the shipment that has both.
  assert.ok(created);
  const withBoth = page.items.filter((s: { id: number }) => s.id === created!.id);
  assert.equal(withBoth.length, 1); sameShape({ ...page, items: withBoth }, contract.shipmentPage);
  const single = await call(`/inventory/fba-shipments/${created.id}`); assert.equal(single.status, 200);
  sameShape(await single.json(), { shipment: contract.shipmentCreated.shipment });
});
