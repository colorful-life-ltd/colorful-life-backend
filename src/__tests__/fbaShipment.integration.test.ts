import assert from "node:assert/strict";
import { after, afterEach, before, it } from "node:test";
import { randomUUID } from "node:crypto";
import jwt from "jsonwebtoken";
import app from "../app.js";
import { config } from "../config/index.js";
import { prisma } from "../prisma/runtime.js";
import { DUPLICATE_WINDOW_HOURS, FbaShipmentError, recordFbaShipment, shipmentFingerprint } from "../domain/inventory/fbaShipmentService.js";
import { createOrder } from "../domain/orders/orderService.js";

// Synthetic fixtures only: random set numbers, never a real business listing.
let server: ReturnType<typeof app.listen>, base: string;
let admin: { id: number; token: string }, secondAdmin: { id: number; token: string }, customer: { id: number; token: string };
const productIds: number[] = [];
before(async () => {
  const make = async (role: "ADMIN" | "CUSTOMER") => {
    const user = await prisma.user.create({ data: { email: `${randomUUID()}@example.test`, passwordHash: "synthetic", role, emailVerified: true,
      addresses: { create: { recipientName: "Test", line1: "1 Test Road", city: "London", postcode: "SW1A 1AA", countryCode: "GB", isDefaultBilling: true } } } });
    return { id: user.id, token: jwt.sign({ id: user.id, role }, config.JWT_SECRET) };
  };
  admin = await make("ADMIN"); secondAdmin = await make("ADMIN"); customer = await make("CUSTOMER");
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>(r => server.once("listening", r));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  base = `http://127.0.0.1:${address.port}`;
});
afterEach(async () => {
  await prisma.order.deleteMany({ where: { userId: customer.id } });
  const listings = { listing: { legoProductId: { in: productIds } } };
  const shipmentIds = (await prisma.fbaOutbound.findMany({ where: { productListing: { legoProductId: { in: productIds } } }, select: { fbaShipmentId: true } }))
    .flatMap(row => row.fbaShipmentId ? [row.fbaShipmentId] : []);
  await prisma.fbaOutbound.deleteMany({ where: { movement: listings } });
  await prisma.inventoryMovement.deleteMany({ where: listings });
  await prisma.fbaShipment.deleteMany({ where: { id: { in: shipmentIds } } });
  await prisma.productListing.deleteMany({ where: { legoProductId: { in: productIds } } });
  await prisma.legoProduct.deleteMany({ where: { id: { in: productIds.splice(0) } } });
});
after(async () => {
  await prisma.fbaShipment.deleteMany({ where: { performedByUserId: { in: [admin.id, secondAdmin.id] } } });
  await prisma.address.deleteMany({ where: { userId: { in: [admin.id, secondAdmin.id, customer.id] } } });
  await prisma.user.deleteMany({ where: { id: { in: [admin.id, secondAdmin.id, customer.id] } } });
  await new Promise<void>(r => server.close(() => r()));
  await prisma.$disconnect();
});

async function listing(currentStock = 10, reservedStock = 0, options: { used?: boolean; title?: string; setNumber?: string } = {}) {
  const product = await prisma.legoProduct.create({ data: { setNumber: options.setNumber ?? `T-${randomUUID()}`, title: options.title ?? "Shipment fixture", theme: "TEST", ageRecommendation: "8+", pieceCount: 10 } });
  productIds.push(product.id);
  return prisma.productListing.create({ data: {
    legoProductId: product.id, condition: options.used ? "USED_LIKE_NEW" : "NEW", originalPrice: 10, currentStock, reservedStock,
    ...(options.used ? { usedLifecycle: "AVAILABLE", damageDescription: "Box damage", usedConditionPhotos: { create: { url: "https://example.test/condition.jpg", publicId: randomUUID(), sortOrder: 0 } } } : {}),
  } });
}
const shipment = (items: Array<{ productListingId: number; quantity: number }>, extra: Record<string, unknown> = {}) => ({ idempotencyKey: randomUUID(), items, ...extra });
const post = (body: unknown, token: string | null = admin.token) => fetch(`${base}/inventory/fba-shipments`, {
  method: "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body),
});
const get = (path: string, token = admin.token) => fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${token}` } });
async function stock(id: number) { const l = await prisma.productListing.findUniqueOrThrow({ where: { id } }); return [l.currentStock, l.reservedStock]; }
const ledger = (ids: number[]) => prisma.inventoryMovement.count({ where: { listingId: { in: ids } } });
const REFERENCE = /^FBA-\d{8}-\d{4,}$/;

it("records a single-item shipment with a generated reference, ledger line and operator", async () => {
  const l = await listing(9, 0);
  const response = await post(shipment([{ productListingId: l.id, quantity: 1 }]));
  assert.equal(response.status, 201);
  const { shipment: s, replayed } = await response.json();
  assert.equal(replayed, false); assert.match(s.reference, REFERENCE);
  assert.equal(s.lineCount, 1); assert.equal(s.totalUnits, 1); assert.equal(s.performedByUserId, admin.id);
  assert.equal(s.note, null); assert.equal(s.externalReference, null);
  assert.deepEqual(await stock(l.id), [8, 0]);
  const [line] = s.lines;
  assert.equal(line.productListingId, l.id); assert.equal(line.quantity, 1); assert.equal(line.quantityChange, -1);
  assert.equal(line.currentStockAfter, 8); assert.equal(line.availableStockAfter, 8);
  const outbound = await prisma.fbaOutbound.findUniqueOrThrow({ where: { id: line.outboundId }, include: { movement: true } });
  assert.equal(outbound.fbaShipmentId, s.id); assert.equal(outbound.shipmentReference, s.reference); assert.equal(outbound.shortfall, 0);
  assert.equal(outbound.movement.type, "FBA_OUTBOUND"); assert.equal(outbound.movement.performedByUserId, admin.id);
  assert.match(outbound.movement.note, new RegExp(`^FBA shipment ${s.reference}$`));
});

it("records a multi-item shipment atomically and keeps the ledger consistent with stock", async () => {
  const a = await listing(10, 2), b = await listing(5, 0), c = await listing(3, 1);
  const body = shipment([{ productListingId: b.id, quantity: 5 }, { productListingId: a.id, quantity: 4 }, { productListingId: c.id, quantity: 2 }], { externalReference: "FBA15XYZ", note: "Pallet 1" });
  const response = await post(body);
  assert.equal(response.status, 201);
  const { shipment: s } = await response.json();
  assert.equal(s.lineCount, 3); assert.equal(s.totalUnits, 11); assert.equal(s.externalReference, "FBA15XYZ"); assert.equal(s.note, "Pallet 1");
  assert.deepEqual(s.lines.map((l: { productListingId: number }) => l.productListingId), [a.id, b.id, c.id].sort((x, y) => x - y));
  assert.deepEqual([await stock(a.id), await stock(b.id), await stock(c.id)], [[6, 2], [0, 0], [1, 1]]);
  const movements = await prisma.inventoryMovement.findMany({ where: { listingId: { in: [a.id, b.id, c.id] } }, include: { fbaOutbound: true } });
  assert.equal(movements.length, 3);
  assert.equal(movements.reduce((sum, m) => sum + m.quantityChange, 0), -11);
  for (const m of movements) {
    assert.equal(m.type, "FBA_OUTBOUND"); assert.equal(m.fbaOutbound?.fbaShipmentId, s.id);
    assert.equal(m.fbaOutbound?.appliedQuantity, -m.quantityChange); assert.match(m.note, /Amazon FBA15XYZ · Pallet 1$/);
  }
});

it("rejects duplicate listing rows instead of guessing how to merge them", async () => {
  const l = await listing();
  const response = await post(shipment([{ productListingId: l.id, quantity: 1 }, { productListingId: l.id, quantity: 2 }]));
  assert.equal(response.status, 400); assert.equal((await response.json()).error.code, "VALIDATION_ERROR");
  assert.deepEqual(await stock(l.id), [10, 0]); assert.equal(await ledger([l.id]), 0);
});

it("rejects the whole shipment when any line exceeds available stock and reports every short line", async () => {
  const ok = await listing(10, 0), short = await listing(2, 0), reserved = await listing(5, 4);
  const response = await post(shipment([{ productListingId: ok.id, quantity: 3 }, { productListingId: short.id, quantity: 3 }, { productListingId: reserved.id, quantity: 2 }]));
  assert.equal(response.status, 409);
  const { error } = await response.json();
  assert.equal(error.code, "INSUFFICIENT_AVAILABLE_STOCK");
  assert.deepEqual(error.items, [
    { productListingId: short.id, reason: "INSUFFICIENT_AVAILABLE_STOCK", availableQuantity: 2, requestedQuantity: 3 },
    { productListingId: reserved.id, reason: "INSUFFICIENT_AVAILABLE_STOCK", availableQuantity: 1, requestedQuantity: 2 },
  ].sort((x, y) => x.productListingId - y.productListingId));
  assert.deepEqual([await stock(ok.id), await stock(short.id), await stock(reserved.id)], [[10, 0], [2, 0], [5, 4]]);
  assert.equal(await ledger([ok.id, short.id, reserved.id]), 0);
});

it("never ships reserved website stock, even when current stock covers the quantity", async () => {
  const l = await listing(4, 4);
  const response = await post(shipment([{ productListingId: l.id, quantity: 1 }]));
  assert.equal(response.status, 409); assert.deepEqual(await stock(l.id), [4, 4]); assert.equal(await ledger([l.id]), 0);
  const exact = await listing(5, 3);
  assert.equal((await post(shipment([{ productListingId: exact.id, quantity: 2 }]))).status, 201);
  assert.deepEqual(await stock(exact.id), [3, 3]);
});

it("rejects Used offers and missing listings without deducting anything", async () => {
  const fine = await listing(), used = await listing(1, 0, { used: true });
  const usedResponse = await post(shipment([{ productListingId: fine.id, quantity: 1 }, { productListingId: used.id, quantity: 1 }]));
  assert.equal(usedResponse.status, 409); assert.equal((await usedResponse.json()).error.code, "USED_OFFER_NOT_SUPPORTED");
  const missing = await post(shipment([{ productListingId: fine.id, quantity: 1 }, { productListingId: 2_147_483_000, quantity: 1 }]));
  assert.equal(missing.status, 404);
  assert.deepEqual((await missing.json()).error.items, [{ productListingId: 2_147_483_000, reason: "LISTING_NOT_FOUND" }]);
  assert.deepEqual(await stock(fine.id), [10, 0]); assert.equal(await ledger([fine.id, used.id]), 0);
});

it("validates payloads strictly, including client-supplied references and actors", async () => {
  const l = await listing(); const good = shipment([{ productListingId: l.id, quantity: 1 }]);
  for (const body of [
    { ...good, items: [] }, { ...good, items: [{ productListingId: l.id, quantity: 0 }] }, { ...good, items: [{ productListingId: l.id, quantity: 1.5 }] },
    { ...good, items: [{ productListingId: l.id, quantity: "1" }] }, { ...good, idempotencyKey: "has space" }, { ...good, idempotencyKey: "x".repeat(101) },
    { ...good, reference: "FBA-20260101-0001" }, { ...good, performedByUserId: secondAdmin.id }, { ...good, note: "x".repeat(2001) },
    { ...good, externalReference: "bad\nref" }, { ...good, items: Array.from({ length: 101 }, (_, i) => ({ productListingId: i + 1, quantity: 1 })) },
  ]) assert.equal((await post(body)).status, 400, JSON.stringify(body).slice(0, 80));
  assert.equal((await post(good, customer.token)).status, 403);
  assert.equal((await post(good, null)).status, 401);
  assert.deepEqual(await stock(l.id), [10, 0]); assert.equal(await ledger([l.id]), 0);
  // Blank optional fields are treated as absent rather than stored.
  const blank = await post({ ...good, note: "  ", externalReference: "" });
  assert.equal(blank.status, 201); const { shipment: s } = await blank.json();
  assert.equal(s.note, null); assert.equal(s.externalReference, null);
});

it("replays an identical retry with the original reference and refuses a changed payload for the same key", async () => {
  const a = await listing(), b = await listing();
  const body = shipment([{ productListingId: a.id, quantity: 2 }, { productListingId: b.id, quantity: 1 }], { note: "Retry check" });
  const first = await post(body); assert.equal(first.status, 201); const original = (await first.json()).shipment;
  // Same items in a different order are the same request.
  const retry = await post({ ...body, items: [...body.items].reverse() }); assert.equal(retry.status, 200);
  const replay = await retry.json(); assert.equal(replay.replayed, true); assert.deepEqual(replay.shipment, original);
  assert.deepEqual([await stock(a.id), await stock(b.id)], [[8, 0], [9, 0]]); assert.equal(await ledger([a.id, b.id]), 2);
  for (const changed of [{ ...body, note: "Different" }, { ...body, items: [{ productListingId: a.id, quantity: 3 }, { productListingId: b.id, quantity: 1 }] }]) {
    const conflict = await post(changed); assert.equal(conflict.status, 409); assert.equal((await conflict.json()).error.code, "IDEMPOTENCY_CONFLICT");
  }
  // Another operator cannot claim the same key either.
  assert.equal((await post(body, secondAdmin.token)).status, 409);
  assert.deepEqual([await stock(a.id), await stock(b.id)], [[8, 0], [9, 0]]); assert.equal(await ledger([a.id, b.id]), 2);
});

it("deducts exactly once when the same shipment is submitted concurrently", async () => {
  const l = await listing(10, 0); const body = shipment([{ productListingId: l.id, quantity: 3 }]);
  const responses = await Promise.all(Array.from({ length: 6 }, () => post(body)));
  const statuses = responses.map(r => r.status).sort();
  assert.deepEqual(statuses, [200, 200, 200, 200, 200, 201]);
  const references = new Set(await Promise.all(responses.map(async r => (await r.json()).shipment.reference)));
  assert.equal(references.size, 1);
  assert.deepEqual(await stock(l.id), [7, 0]); assert.equal(await ledger([l.id]), 1);
});

it("never oversells when different shipments compete for the same limited stock", async () => {
  const l = await listing(5, 0);
  // Distinct Amazon IDs keep the recent-duplicate check out of this stock race.
  const responses = await Promise.all(Array.from({ length: 5 }, (_, i) => post(shipment([{ productListingId: l.id, quantity: 2 }], { externalReference: `RACE${i}-${randomUUID().slice(0, 8)}` }))));
  const statuses = responses.map(r => r.status).sort();
  assert.deepEqual(statuses, [201, 201, 409, 409, 409]);
  assert.ok((await Promise.all(responses.filter(r => r.status === 409).map(r => r.json()))).every(b => b.error.code === "INSUFFICIENT_AVAILABLE_STOCK"));
  assert.deepEqual(await stock(l.id), [1, 0]); assert.equal(await ledger([l.id]), 2);
});

it("rolls back every line, the header and the reference counter when a later line fails mid-transaction", async () => {
  const a = await listing(10, 0), b = await listing(10, 0);
  const key = randomUUID(), [low, high] = [a, b].sort((x, y) => x.id - y.id);
  // Occupy the second line's derived ledger key so its insert fails after the first line was written.
  const legacy = await prisma.inventoryMovement.create({ data: { listingId: high.id, quantityChange: -1, type: "FBA_OUTBOUND", note: "legacy fixture", performedByUserId: admin.id } });
  await prisma.productListing.update({ where: { id: high.id }, data: { currentStock: 9 } });
  await prisma.fbaOutbound.create({ data: { productListingId: high.id, movementId: legacy.id, idempotencyKey: `${key}:${high.id}`, requestHash: "0".repeat(64), shipmentReference: `LEGACY-${randomUUID()}`, actualQuantity: 1, appliedQuantity: 1, shortfall: 0, currentStockAfter: 9, reservedStockAfter: 0 } });
  const before = await prisma.fbaShipmentSequence.findMany();
  await assert.rejects(recordFbaShipment({ idempotencyKey: key, items: [{ productListingId: low.id, quantity: 2 }, { productListingId: high.id, quantity: 2 }] }, admin.id),
    (e: unknown) => e instanceof FbaShipmentError && e.status === 409 && e.code === "IDEMPOTENCY_CONFLICT");
  assert.deepEqual([await stock(low.id), await stock(high.id)], [[10, 0], [9, 0]]);
  assert.equal(await ledger([low.id]), 0); assert.equal(await ledger([high.id]), 1);
  assert.equal(await prisma.fbaShipment.count({ where: { idempotencyKey: key } }), 0);
  assert.deepEqual(await prisma.fbaShipmentSequence.findMany(), before);
});

it("allocates unique, consecutive references under concurrency and keeps them immutable", async () => {
  const listings = await Promise.all(Array.from({ length: 8 }, () => listing(3, 0)));
  const responses = await Promise.all(listings.map(l => post(shipment([{ productListingId: l.id, quantity: 1 }]))));
  assert.ok(responses.every(r => r.status === 201));
  const references = await Promise.all(responses.map(async r => (await r.json()).shipment.reference as string));
  assert.equal(new Set(references).size, 8);
  for (const reference of references) assert.match(reference, REFERENCE);
  const days = new Set(references.map(r => r.slice(4, 12)));
  if (days.size === 1) {
    const numbers = references.map(r => Number(r.slice(13))).sort((x, y) => x - y);
    assert.deepEqual(numbers, numbers.map((_, i) => numbers[0] + i));
  }
  const recorded = await prisma.fbaShipment.findFirstOrThrow({ where: { reference: references[0] } });
  await assert.rejects(prisma.$executeRaw`UPDATE "FbaShipment" SET reference = 'FBA-20000101-0001' WHERE id = ${recorded.id}`, /immutable/);
  await assert.rejects(prisma.$executeRaw`UPDATE "FbaOutbound" SET "fbaShipmentId" = NULL WHERE "fbaShipmentId" = ${recorded.id}`, /cannot change/);
  await assert.rejects(prisma.$executeRaw`INSERT INTO "FbaShipment" (reference,"idempotencyKey","requestHash","performedByUserId","lineCount","totalUnits") VALUES (${references[1]}, ${randomUUID()}, ${"0".repeat(64)}, ${admin.id}, 1, 1)`);
});

it("lists and reads recorded shipments for Admins only", async () => {
  const l = await listing();
  const created = (await (await post(shipment([{ productListingId: l.id, quantity: 1 }]))).json()).shipment;
  const page = await get("/inventory/fba-shipments?page=1&pageSize=5"); assert.equal(page.status, 200);
  const body = await page.json();
  assert.deepEqual(body.items[0], JSON.parse(JSON.stringify(created)));
  assert.equal(body.pagination.pageSize, 5);
  const one = await get(`/inventory/fba-shipments/${created.id}`); assert.equal(one.status, 200);
  assert.deepEqual((await one.json()).shipment, JSON.parse(JSON.stringify(created)));
  assert.equal((await get("/inventory/fba-shipments/2147483000")).status, 404);
  assert.equal((await get("/inventory/fba-shipments", customer.token)).status, 403);
  assert.equal((await get("/inventory/fba-shipments?pageSize=500")).status, 400);
});

it("searches Admin listings by set number or title, including inactive listings", async () => {
  const marker = randomUUID().slice(0, 8);
  const bySet = await listing(1, 0, { setNumber: `S${marker}-1` });
  const byTitle = await listing(1, 0, { title: `Shipment ${marker.toUpperCase()} title` });
  await prisma.productListing.update({ where: { id: byTitle.id }, data: { active: false } });
  await listing(1, 0);
  const response = await get(`/admin/product-listings?page=1&pageSize=20&q=${marker}`); assert.equal(response.status, 200);
  const { items, pagination } = await response.json();
  assert.deepEqual(items.map((i: { id: number }) => i.id).sort(), [bySet.id, byTitle.id].sort());
  assert.equal(pagination.totalItems, 2);
  assert.equal((await get(`/admin/product-listings?q=${"x".repeat(101)}`)).status, 400);
});

const amazon = () => `FBA${randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase()}`;

it("rejects a second shipment with the same Amazon reference, including case and spacing variants", async () => {
  const a = await listing(), b = await listing(); const ref = amazon();
  const first = await post(shipment([{ productListingId: a.id, quantity: 1 }], { externalReference: ` ${ref.slice(0, 5).toLowerCase()} ${ref.slice(5)} ` }));
  assert.equal(first.status, 201); const recorded = (await first.json()).shipment;
  assert.equal(recorded.externalReference, ref);
  const again = await post(shipment([{ productListingId: b.id, quantity: 2 }], { externalReference: ref.toLowerCase() }));
  assert.equal(again.status, 409);
  const { error } = await again.json();
  assert.equal(error.code, "DUPLICATE_FBA_SHIPMENT"); assert.match(error.message, new RegExp(recorded.reference));
  assert.deepEqual(error.duplicates.map((d: { shipmentId: number; reference: string; externalReference: string }) => [d.shipmentId, d.reference, d.externalReference]), [[recorded.id, recorded.reference, ref]]);
  // Acknowledgement can never override an Amazon reference.
  assert.equal((await post(shipment([{ productListingId: b.id, quantity: 2 }], { externalReference: ref, acknowledgedDuplicateShipmentIds: [recorded.id] }))).status, 400);
  assert.deepEqual([await stock(a.id), await stock(b.id)], [[9, 0], [10, 0]]); assert.equal(await ledger([b.id]), 0);
});

it("records exactly one of several concurrent shipments sharing an Amazon reference", async () => {
  const ref = amazon(); const listings = await Promise.all(Array.from({ length: 5 }, () => listing(5, 0)));
  const responses = await Promise.all(listings.map(l => post(shipment([{ productListingId: l.id, quantity: 1 }], { externalReference: ref }))));
  assert.deepEqual(responses.map(r => r.status).sort(), [201, 409, 409, 409, 409]);
  const codes = await Promise.all(responses.filter(r => r.status === 409).map(async r => (await r.json()).error.code));
  assert.ok(codes.every(c => c === "DUPLICATE_FBA_SHIPMENT"));
  assert.equal(await prisma.fbaShipment.count({ where: { externalReference: ref } }), 1);
  assert.equal(await ledger(listings.map(l => l.id)), 1);
});

it("allows the same listings and quantities under a different Amazon reference", async () => {
  const l = await listing(10, 0);
  for (const ref of [amazon(), amazon()]) assert.equal((await post(shipment([{ productListingId: l.id, quantity: 2 }], { externalReference: ref }))).status, 201);
  assert.deepEqual(await stock(l.id), [6, 0]); assert.equal(await ledger([l.id]), 2);
});

it("warns about a recent identical shipment without an Amazon reference and records it only after explicit acknowledgement", async () => {
  const a = await listing(10, 0), b = await listing(10, 0);
  const items = [{ productListingId: a.id, quantity: 2 }, { productListingId: b.id, quantity: 1 }];
  const first = (await (await post(shipment(items))).json()).shipment;
  const repeat = shipment([...items].reverse());
  const warned = await post(repeat); assert.equal(warned.status, 409);
  const { error } = await warned.json();
  assert.equal(error.code, "POSSIBLE_DUPLICATE_SHIPMENT");
  assert.equal(error.duplicates.length, 1); assert.equal(error.duplicates[0].reference, first.reference);
  assert.equal(error.duplicates[0].createdAt, first.createdAt);
  // Acknowledging some other shipment is not acknowledgement of this one.
  assert.equal((await post({ ...shipment(items), acknowledgedDuplicateShipmentIds: [first.id + 100000] })).status, 409);
  assert.deepEqual([await stock(a.id), await stock(b.id)], [[8, 0], [9, 0]]);
  const acknowledged = { ...shipment(items), acknowledgedDuplicateShipmentIds: [first.id] };
  const created = await post(acknowledged); assert.equal(created.status, 201);
  const second = (await created.json()).shipment;
  assert.deepEqual(second.acknowledgedDuplicateShipmentIds, [first.id]); assert.notEqual(second.reference, first.reference);
  assert.deepEqual([await stock(a.id), await stock(b.id)], [[6, 0], [8, 0]]);
  // The acknowledged shipment's own retry replays; it is not reported as a duplicate of itself.
  const retry = await post(acknowledged); assert.equal(retry.status, 200); assert.equal((await retry.json()).shipment.reference, second.reference);
  // A third repeat must acknowledge both earlier shipments.
  const third = await post({ ...shipment(items), acknowledgedDuplicateShipmentIds: [first.id] });
  assert.equal(third.status, 409); assert.deepEqual((await third.json()).error.duplicates.map((d: { shipmentId: number }) => d.shipmentId).sort(), [first.id, second.id].sort());
  assert.deepEqual([await stock(a.id), await stock(b.id)], [[6, 0], [8, 0]]);
});

it("does not block an identical replenishment after the duplicate window", async () => {
  const l = await listing(10, 0); const items = [{ productListingId: l.id, quantity: 1 }];
  // Historical shipments are inserted directly because recorded headers are immutable.
  await prisma.$executeRaw`INSERT INTO "FbaShipment" (reference,"idempotencyKey","requestHash","performedByUserId","lineCount","totalUnits","lineFingerprint","createdAt")
    VALUES (${`FBA-20000101-${String(Date.now()).slice(-6)}`}, ${randomUUID()}, ${"0".repeat(64)}, ${admin.id}, 1, 1, ${shipmentFingerprint(items)}, ${new Date(Date.now() - (DUPLICATE_WINDOW_HOURS + 1) * 3_600_000)})`;
  assert.equal((await post(shipment(items))).status, 201);
  await prisma.fbaShipment.deleteMany({ where: { reference: { startsWith: "FBA-20000101-" } } });
});

it("lets only one of several concurrent identical shipments without an Amazon reference through", async () => {
  const l = await listing(10, 0);
  const responses = await Promise.all(Array.from({ length: 4 }, () => post(shipment([{ productListingId: l.id, quantity: 1 }]))));
  assert.deepEqual(responses.map(r => r.status).sort(), [201, 409, 409, 409]);
  assert.ok((await Promise.all(responses.filter(r => r.status === 409).map(r => r.json()))).every(b => b.error.code === "POSSIBLE_DUPLICATE_SHIPMENT"));
  assert.deepEqual(await stock(l.id), [9, 0]); assert.equal(await ledger([l.id]), 1);
});

it("never consumes stock reserved by a concurrent website checkout", async () => {
  for (let round = 0; round < 5; round++) {
    const l = await listing(3, 0);
    const [order, outbound] = await Promise.allSettled([
      createOrder(customer.id, { shippingMethod: "STANDARD", items: [{ productListingId: l.id, quantity: 2 }] }),
      post(shipment([{ productListingId: l.id, quantity: 2 }], { externalReference: amazon() })),
    ]);
    const shipped = outbound.status === "fulfilled" && outbound.value.status === 201;
    const reservedOrder = order.status === "fulfilled";
    assert.ok(shipped !== reservedOrder, "exactly one of checkout and FBA can take 2 of 3 units");
    const [current, reserved] = await stock(l.id);
    assert.ok(reserved >= 0 && current >= reserved);
    assert.deepEqual([current, reserved], shipped ? [1, 0] : [3, 2]);
    assert.equal(await ledger([l.id]), shipped ? 1 : 0);
  }
});

it("rolls back a shipment whose transaction times out on a held listing lock, then records it once on retry", async () => {
  const l = await listing(5, 0); const body = shipment([{ productListingId: l.id, quantity: 2 }], { externalReference: amazon() });
  let release!: () => void; const held = new Promise<void>(r => { release = r; });
  let locked!: () => void; const acquired = new Promise<void>(r => { locked = r; });
  // Another session (e.g. a slow checkout) holds the row lock beyond the 5 s interactive transaction limit.
  const blocker = prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "ProductListing" WHERE id = ${l.id} FOR UPDATE`; locked(); await held;
  }, { timeout: 30_000, maxWait: 5_000 });
  await acquired;
  const timedOut = post(body);
  await new Promise(r => setTimeout(r, 6_500));
  release(); await blocker;
  const response = await timedOut;
  assert.equal(response.status, 500); assert.equal((await response.json()).error.code, "INTERNAL_SERVER_ERROR");
  assert.deepEqual(await stock(l.id), [5, 0]); assert.equal(await ledger([l.id]), 0);
  assert.equal(await prisma.fbaShipment.count({ where: { idempotencyKey: body.idempotencyKey } }), 0);
  const retry = await post(body); assert.equal(retry.status, 201);
  assert.equal((await post(body)).status, 200);
  assert.deepEqual(await stock(l.id), [3, 0]); assert.equal(await ledger([l.id]), 1);
});
