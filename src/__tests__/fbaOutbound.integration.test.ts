import assert from "node:assert/strict";
import { before, after, afterEach, it } from "node:test";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import jwt from "jsonwebtoken";
import app from "../app.js";
import { config } from "../config/index.js";
import { prisma } from "../prisma/runtime.js";
import { recordFbaOutbound } from "../domain/inventory/fbaOutboundService.js";
import { createOrder } from "../domain/orders/orderService.js";

let server: ReturnType<typeof app.listen>, base: string;
let admin: { id: number; token: string }, customer: { id: number; token: string };
const productIds: number[] = [];
before(async () => {
  for (const role of ["ADMIN", "CUSTOMER"] as const) {
    const user = await prisma.user.create({ data: {
      email: `${randomUUID()}@example.test`, passwordHash: "synthetic", role, emailVerified: true,
      addresses: { create: { recipientName: "Test", line1: "1 Test Road", city: "London", postcode: "SW1A 1AA", countryCode: "GB", isDefaultBilling: true } },
    } });
    const identity = { id: user.id, token: jwt.sign({ id: user.id, role }, config.JWT_SECRET) };
    if (role === "ADMIN") admin = identity; else customer = identity;
  }
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>(r => server.once("listening", r));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  base = `http://127.0.0.1:${address.port}/inventory/fba-outbounds`;
});
afterEach(async () => {
  await prisma.order.deleteMany({ where: { userId: customer.id } });
  await prisma.fbaOutbound.deleteMany({ where: { movement: { listing: { legoProductId: { in: productIds } } } } });
  await prisma.inventoryMovement.deleteMany({ where: { listing: { legoProductId: { in: productIds } } } });
  await prisma.productListing.deleteMany({ where: { legoProductId: { in: productIds } } });
  await prisma.legoProduct.deleteMany({ where: { id: { in: productIds.splice(0) } } });
});
after(async () => {
  await prisma.address.deleteMany({ where: { userId: { in: [admin.id, customer.id] } } });
  await prisma.user.deleteMany({ where: { id: { in: [admin.id, customer.id] } } });
  await new Promise<void>(r => server.close(() => r()));
  await prisma.$disconnect();
});
async function listing(currentStock = 10, reservedStock = 0, used = false) {
  const product = await prisma.legoProduct.create({ data: { setNumber: randomUUID(), title: "Outbound fixture", theme: "TEST", ageRecommendation: "8+", pieceCount: 10 } });
  productIds.push(product.id);
  return prisma.productListing.create({ data: {
    legoProductId: product.id, condition: used ? "USED_LIKE_NEW" : "NEW", originalPrice: 10, currentStock, reservedStock,
    ...(used ? { usedLifecycle: "AVAILABLE", damageDescription: "Box damage", usedConditionPhotos: { create: { url: "https://example.test/condition.jpg", publicId: randomUUID(), sortOrder: 0 } } } : {}),
  } });
}
function input(id: number, quantity = 2) { return { productListingId: id, quantity, shipmentReference: "FBA-SHIP-123", note: "Sent from home to Amazon", idempotencyKey: randomUUID() }; }
function request(body: unknown, token: string | undefined = admin.token) {
  return fetch(base, { method: "POST", headers: { ...{ "Idempotency-Key": crypto.randomUUID() }, "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
}
async function stock(id: number) { const l = await prisma.productListing.findUniqueOrThrow({ where: { id } }); return [l.currentStock, l.reservedStock]; }
async function assertNoLedger(id: number) { assert.equal(await prisma.inventoryMovement.count({ where: { listingId: id } }), 0); }

it("records an auditable outbound and returns reserved/available quantities and retrievable result", async () => {
  const l = await listing(10, 3); const body = input(l.id, 4); const before = Date.now();
  const response = await request(body); assert.equal(response.status, 201); const result = await response.json();
  assert.deepEqual(result.inventory, { productListingId: l.id, currentStock: 6, reservedStock: 3, availableStock: 3 });
  assert.equal(result.replayed, false); assert.equal(result.outbound.shipmentReference, body.shipmentReference);
  assert.equal(result.outbound.note, body.note); assert.equal(result.outbound.quantity, 4);
  assert.equal(result.outbound.performedByUserId, admin.id); assert.ok(Date.parse(result.outbound.createdAt) >= before - 1000);
  assert.equal(result.outbound.movement.type, "FBA_OUTBOUND"); assert.equal(result.outbound.movement.quantityChange, -4);
  const read = await fetch(`${base}/${result.outbound.id}`, { headers: { ...{ "Idempotency-Key": crypto.randomUUID() }, Authorization: `Bearer ${admin.token}` } });
  assert.equal(read.status, 200); const audit = await read.json(); assert.deepEqual(audit.outbound, result.outbound);
  const history = await fetch(base.replace('/inventory/fba-outbounds', `/products/${l.id}/inventory-movements`), { headers: { ...{ "Idempotency-Key": crypto.randomUUID() }, Authorization: `Bearer ${admin.token}` } });
  assert.equal(history.status, 200);
  assert.deepEqual((await history.json()).movements[0].fbaOutbound, { id: result.outbound.id, shipmentReference: body.shipmentReference, idempotencyKey: body.idempotencyKey });
  assert.deepEqual(await stock(l.id), [6, 3]);
});
for (const quantity of [0, -1, 1.5, "2", null, 2_147_483_648]) it(`rejects invalid quantity ${quantity}`, async () => {
  const l = await listing(); const response = await request({ ...input(l.id), quantity });
  assert.equal(response.status, 400); assert.deepEqual(await stock(l.id), [10, 0]); await assertNoLedger(l.id);
});
it("requires bounded reference, note, key and listing and rejects actor spoofing", async () => {
  const l = await listing(); const body = input(l.id);
  for (const patch of [{ shipmentReference: " " }, { shipmentReference: "x".repeat(201) }, { note: "" }, { note: "\0" }, { idempotencyKey: "" }, { idempotencyKey: "space key" }, { productListingId: 0 }, { performedByUserId: customer.id }]) {
    assert.equal((await request({ ...body, ...patch })).status, 400);
  }
  await assertNoLedger(l.id); assert.deepEqual(await stock(l.id), [10, 0]);
});
it("records excess physical outbound and preserves website reservations with an explicit shortfall", async () => {
  const l=await listing(5,4);const response=await request(input(l.id,2));assert.equal(response.status,201);
  const result=await response.json();assert.equal(result.outbound.quantity,2);assert.equal(result.outbound.appliedQuantity,1);assert.equal(result.outbound.shortfall,1);
  assert.deepEqual(await stock(l.id),[4,4]);assert.equal((await request(input(l.id,1))).status,409);
});
it("records actual physical movement while preserving a real pending website reservation",async()=>{
  const l=await listing(3);await createOrder(customer.id,{shippingMethod:'STANDARD',items:[{productListingId:l.id,quantity:2}]});
  const response=await request(input(l.id,2));assert.equal(response.status,201);assert.equal((await response.json()).outbound.shortfall,1);
  assert.deepEqual(await stock(l.id),[2,2]);
});
it("serializes concurrent outbound operations without overselling", async () => {
  const l = await listing(3); const responses = await Promise.all([request(input(l.id, 2)), request(input(l.id, 2))]);
  assert.deepEqual(responses.map(r => r.status).sort(), [201, 409]); assert.deepEqual(await stock(l.id), [1, 0]);
  assert.equal(await prisma.inventoryMovement.count({ where: { listingId: l.id } }), 1);
});
it("serializes outbound against a website reservation for the final unit", async () => {
  const l = await listing(1);
  const results = await Promise.allSettled([
    recordFbaOutbound(input(l.id, 1), admin.id),
    createOrder(customer.id, { shippingMethod: "STANDARD", items: [{ productListingId: l.id, quantity: 1 }] }),
  ]);
  assert.equal(results[0].status,'fulfilled'); // physical fact must always be recorded
  const [physical,reserved]=await stock(l.id);assert.ok(reserved>=0&&physical>=reserved);assert.equal(physical-reserved,0);
  if(results[1].status==='fulfilled')assert.equal((results[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof recordFbaOutbound>>>).value.outbound.shortfall,1);
});
it("replays simultaneous identical keys exactly once, including when no available stock remains", async () => {
  const l = await listing(2); const body = input(l.id);
  const responses = await Promise.all([request(body), request(body)]);
  assert.deepEqual(responses.map(r => r.status).sort(), [200, 201]);
  const [a, b] = await Promise.all(responses.map(r => r.json())); assert.deepEqual(a.outbound, b.outbound);
  assert.deepEqual(await stock(l.id), [0, 0]); assert.equal(await prisma.inventoryMovement.count({ where: { listingId: l.id } }), 1);
});
it("persists replay across processes and returns the original inventory snapshot", async () => {
  const l = await listing(); const body = input(l.id); const first = await recordFbaOutbound(body, admin.id);
  await recordFbaOutbound({...input(l.id,1),shipmentReference:"FBA-SECOND-DISTINCT"}, admin.id);
  const moduleUrl = new URL("../domain/inventory/fbaOutboundService.js", import.meta.url).href;
  const prismaUrl = new URL("../prisma/runtime.js", import.meta.url).href;
  const script = `const {recordFbaOutbound}=await import(${JSON.stringify(moduleUrl)}); const {prisma}=await import(${JSON.stringify(prismaUrl)}); try {console.log(JSON.stringify(await recordFbaOutbound(JSON.parse(process.argv[1]), Number(process.argv[2]))));} finally {await prisma.$disconnect();}`;
  const { stdout } = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", script, JSON.stringify(body), String(admin.id)], { env: process.env });
  const retry = JSON.parse(stdout); assert.equal(retry.replayed, true); assert.equal(retry.outbound.id, first.outbound.id);
  assert.deepEqual(retry.inventory, first.inventory); assert.deepEqual(await stock(l.id), [7, 0]);
});
it("rejects conflicting listing, quantity, reference, note or actor on the same key", async () => {
  const l = await listing(); const other = await listing(); const body = input(l.id); await recordFbaOutbound(body, admin.id);
  for (const patch of [{ productListingId: other.id }, { quantity: 1 }, { shipmentReference: "OTHER" }, { note: "different" }]) {
    const response = await request({ ...body, ...patch }); assert.equal(response.status, 409); assert.equal((await response.json()).error.code, "IDEMPOTENCY_CONFLICT");
  }
  await assert.rejects(recordFbaOutbound(body, customer.id), { code: "IDEMPOTENCY_CONFLICT" });
  assert.deepEqual(await stock(l.id), [8, 0]); assert.deepEqual(await stock(other.id), [10, 0]);
});
it("rejects simultaneous conflicting submissions on the same key", async () => {
  const l = await listing(); const body = input(l.id);
  const responses = await Promise.all([request(body), request({ ...body, quantity: 3 })]);
  assert.deepEqual(responses.map(r => r.status).sort(), [201, 409]);
  assert.equal(await prisma.inventoryMovement.count({ where: { listingId: l.id } }), 1);
});
it("rolls back a failed movement insert and allows a safe retry", async () => {
  const l = await listing(); const body = input(l.id);
  await assert.rejects(recordFbaOutbound(body, 2_147_483_647)); // nonexistent actor: movement FK failure after deduction
  assert.deepEqual(await stock(l.id), [10, 0]); await assertNoLedger(l.id);
  assert.equal(await prisma.fbaOutbound.count({ where: { idempotencyKey: body.idempotencyKey } }), 0);
  assert.equal((await request(body)).status, 201);
});
it("rolls back stock and movement when outbound ledger persistence fails", async () => {
  const l = await listing(); const body = input(l.id);
  const failingDb = { $transaction: ((fn: (tx: unknown) => unknown) => prisma.$transaction(async tx => fn(new Proxy(tx, {
    get(target, property) {
      if (property === "fbaOutbound") return new Proxy(target.fbaOutbound, { get(delegate, key) { if (key === "create") return async () => { throw new Error("simulated ledger failure"); }; return Reflect.get(delegate, key); } });
      return Reflect.get(target, property);
    },
  })))) as typeof prisma.$transaction };
  await assert.rejects(recordFbaOutbound(body, admin.id, failingDb), /simulated ledger failure/);
  assert.deepEqual(await stock(l.id), [10, 0]); await assertNoLedger(l.id);
  assert.equal(await prisma.fbaOutbound.count({ where: { idempotencyKey: body.idempotencyKey } }), 0);
});
it("requires Admin authorization for creation and audit reads", async () => {
  const l = await listing(); const body = input(l.id);
  assert.equal((await request(body, "")).status, 401); assert.equal((await request(body, customer.token)).status, 403);
  assert.equal((await fetch(`${base}/1`)).status, 401);
  assert.equal((await fetch(`${base}/1`, { headers: { ...{ "Idempotency-Key": crypto.randomUUID() }, Authorization: `Bearer ${customer.token}` } })).status, 403);
  await assertNoLedger(l.id);
});
it("rejects missing listings and individually documented Used offers", async () => {
  assert.equal((await request(input(2_147_483_647))).status, 404);
  const l = await listing(1, 0, true); assert.equal((await request(input(l.id, 1))).status, 409);
  assert.deepEqual(await stock(l.id), [1, 0]); await assertNoLedger(l.id);
  for (const [id, expected] of [["bad", 400], ["2147483647", 404]] as const) {
    assert.equal((await fetch(`${base}/${id}`, { headers: { ...{ "Idempotency-Key": crypto.randomUUID() }, Authorization: `Bearer ${admin.token}` } })).status, expected);
  }
});
