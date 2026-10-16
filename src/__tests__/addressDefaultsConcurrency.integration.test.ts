import assert from "node:assert/strict";
import { after, afterEach, before, describe, it } from "node:test";
import { randomUUID } from "node:crypto";
import jwt from "jsonwebtoken";
import app from "../app.js";
import { config } from "../config/index.js";
import { prisma } from "../prisma/runtime.js";

const userIds: number[] = [];
let server: ReturnType<typeof app.listen>, url: string;
before(async () => {
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  url = `http://localhost:${(server.address() as { port: number }).port}`;
});
after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
});
afterEach(async () => {
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  userIds.length = 0;
});
async function customer() {
  const user = await prisma.user.create({ data: { email: `address-lock-${randomUUID()}@example.com`, passwordHash: "hash", emailVerified: true } });
  userIds.push(user.id);
  return { id: user.id, token: jwt.sign({ id: user.id, role: user.role }, config.JWT_SECRET, { expiresIn: "1h" }) };
}
type Customer = Awaited<ReturnType<typeof customer>>;
const address = (name: string) => ({ recipientName: name, line1: `${name} Street`, city: "London", postcode: "SW1A 1AA", country: "United Kingdom" });
function request(user: Customer, method: string, addressId?: number, body?: unknown) {
  return fetch(`${url}/users/me/addresses${addressId === undefined ? "" : `/${addressId}`}`, {
    method, headers: { Authorization: `Bearer ${user.token}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function create(user: Customer, name: string, defaults = {}) {
  const response = await request(user, "POST", undefined, { ...address(name), ...defaults });
  assert.equal(response.status, 201);
  return (await response.json()) as { id: number; isDefaultShipping: boolean; isDefaultBilling: boolean; country: string };
}
async function persisted(user: Customer) {
  return prisma.address.findMany({ where: { userId: user.id }, orderBy: { id: "asc" } });
}
async function defaults(user: Customer, addressCount: number) {
  const rows = await persisted(user);
  assert.equal(rows.length, addressCount);
  assert.equal(rows.filter((a) => a.isDefault).length, 1);
  assert.equal(rows.filter((a) => a.isDefaultBilling).length, 1);
  return { rows, shipping: rows.find((a) => a.isDefault)!, billing: rows.find((a) => a.isDefaultBilling)! };
}

/** Hold the real parent lock so HTTP mutations overlap rather than accidentally run sequentially. */
async function holdOwner(user: Customer) {
  let release!: () => void, started!: (pid: number) => void, failed!: (error: unknown) => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const ready = new Promise<number>((resolve, reject) => { started = resolve; failed = reject; });
  const transaction = prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${user.id} FOR UPDATE`;
    const [connection] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
    started(connection.pid);
    await gate;
  }, { timeout: 10_000 });
  void transaction.catch(failed);
  return { pid: await ready, release: async () => { release(); await transaction; } };
}

/** Follow indirect blockers too: PostgreSQL can queue a row waiter behind another waiter. */
async function waitForQueuedMutations(blockerPid: number, count: number) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const [result] = await prisma.$queryRaw<Array<{ count: number }>>`
      WITH RECURSIVE blocked AS (
        SELECT pid FROM pg_stat_activity
        WHERE datname = current_database() AND ${blockerPid} = ANY(pg_blocking_pids(pid))
        UNION
        SELECT a.pid FROM pg_stat_activity a JOIN blocked b ON b.pid = ANY(pg_blocking_pids(a.pid))
        WHERE a.datname = current_database()
      )
      SELECT count(*)::int AS count FROM blocked
    `;
    if (result.count >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`Expected ${count} simultaneous mutations queued behind the customer's database lock`);
}
async function concurrent(user: Customer, operations: Array<() => Promise<Response>>) {
  const held = await holdOwner(user);
  const requests = operations.map((operation) => operation());
  let observationError: unknown;
  try { await waitForQueuedMutations(held.pid, operations.length); }
  catch (error) { observationError = error; }
  finally { await held.release(); }
  const results = await Promise.all(requests);
  if (observationError) throw observationError;
  return results;
}

describe("per-customer address default serialization", { concurrency: 1 }, () => {
  it("serializes two first-address creates and persists exactly one of each default", async () => {
    const user = await customer();
    const responses = await concurrent(user, [
      () => request(user, "POST", undefined, { ...address("First contender"), isDefaultShipping: false, isDefaultBilling: false }),
      () => request(user, "POST", undefined, { ...address("Second contender"), isDefaultShipping: false, isDefaultBilling: false }),
    ]);
    assert.ok(responses.every((r) => r.status === 201));
    const state = await defaults(user, 2);
    assert.equal(state.shipping.id, state.billing.id);
    // The storefront submits "United Kingdom"; addresses persist the ISO code invoices require.
    assert.ok(state.rows.every((row) => row.countryCode === "GB"));
  });

  it("serializes concurrent creates requesting both default roles", async () => {
    const user = await customer(); await create(user, "Original");
    const responses = await concurrent(user, [
      () => request(user, "POST", undefined, { ...address("A"), isDefaultShipping: true, isDefaultBilling: true }),
      () => request(user, "POST", undefined, { ...address("B"), isDefaultShipping: true, isDefaultBilling: true }),
    ]);
    assert.ok(responses.every((r) => r.status === 201));
    const state = await defaults(user, 3); assert.equal(state.shipping.id, state.billing.id);
  });

  it("serializes concurrent delivery-default replacements", async () => {
    const user = await customer(); const first = await create(user, "Original");
    const a = await create(user, "A"), b = await create(user, "B");
    const responses = await concurrent(user, [
      () => request(user, "PATCH", a.id, { isDefaultShipping: true }),
      () => request(user, "PATCH", b.id, { isDefaultShipping: true }),
    ]);
    assert.ok(responses.every((r) => r.status === 200));
    const state = await defaults(user, 3);
    assert.ok([a.id, b.id].includes(state.shipping.id)); assert.equal(state.billing.id, first.id);
  });

  it("serializes concurrent billing-default replacements", async () => {
    const user = await customer(); const first = await create(user, "Original");
    const a = await create(user, "A"), b = await create(user, "B");
    const responses = await concurrent(user, [
      () => request(user, "PATCH", a.id, { isDefaultBilling: true }),
      () => request(user, "PATCH", b.id, { isDefaultBilling: true }),
    ]);
    assert.ok(responses.every((r) => r.status === 200));
    const state = await defaults(user, 3);
    assert.ok([a.id, b.id].includes(state.billing.id)); assert.equal(state.shipping.id, first.id);
  });

  it("preserves distinct delivery and billing addresses under concurrent replacement", async () => {
    const user = await customer(); await create(user, "Original");
    const delivery = await create(user, "Delivery"), billing = await create(user, "Billing");
    const responses = await concurrent(user, [
      () => request(user, "PATCH", delivery.id, { isDefaultShipping: true }),
      () => request(user, "PATCH", billing.id, { isDefaultBilling: true }),
    ]);
    assert.ok(responses.every((r) => r.status === 200));
    const state = await defaults(user, 3);
    assert.equal(state.shipping.id, delivery.id); assert.equal(state.billing.id, billing.id);
    assert.notEqual(state.shipping.id, state.billing.id);
  });

  it("preserves first-address defaults, sequential role replacement, edits and country representation", async () => {
    const user = await customer(); const first = await create(user, "First", { isDefaultShipping: false, isDefaultBilling: false });
    assert.equal(first.isDefaultShipping, true); assert.equal(first.isDefaultBilling, true);
    assert.equal(first.country, "GB"); await defaults(user, 1);
    const delivery = await create(user, "Delivery", { isDefaultShipping: true });
    let state = await defaults(user, 2); assert.equal(state.shipping.id, delivery.id); assert.equal(state.billing.id, first.id);
    const billing = await create(user, "Billing");
    assert.equal((await request(user, "PATCH", billing.id, { isDefaultBilling: true })).status, 200);
    assert.equal((await request(user, "PATCH", delivery.id, { city: "Cambridge" })).status, 200);
    state = await defaults(user, 3);
    assert.equal(state.shipping.id, delivery.id); assert.equal(state.shipping.city, "Cambridge");
    assert.equal(state.billing.id, billing.id); assert.equal(state.billing.countryCode, "GB");
    assert.equal((await request(user, "PATCH", first.id, { isDefaultShipping: true, isDefaultBilling: true })).status, 200);
    state = await defaults(user, 3); assert.equal(state.shipping.id, first.id); assert.equal(state.billing.id, first.id);
  });

  it("rejects a mixed valid/invalid default PATCH before any clearing or field edits commit", async () => {
    const user = await customer(); const billing = await create(user, "Billing");
    const delivery = await create(user, "Delivery", { isDefaultShipping: true });
    const before = await persisted(user);
    const response = await request(user, "PATCH", billing.id, { isDefaultShipping: true, isDefaultBilling: false, city: "Must not commit" });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "Cannot directly unset the default billing address" });
    assert.deepEqual(await persisted(user), before);
    const shippingError = await request(user, "PATCH", delivery.id, { isDefaultShipping: false, isDefaultBilling: true });
    assert.equal(shippingError.status, 400);
    assert.deepEqual(await shippingError.json(), { error: "Cannot directly unset the default shipping address" });
    assert.deepEqual(await persisted(user), before);
  });

  it("keeps defaults intact when one concurrent replacement is rejected", async () => {
    const user = await customer(); const original = await create(user, "Original");
    const other = await create(user, "Other");
    const responses = await concurrent(user, [
      () => request(user, "PATCH", original.id, { isDefaultShipping: true, isDefaultBilling: false }),
      () => request(user, "PATCH", other.id, { isDefaultShipping: true }),
    ]);
    assert.equal(responses[0].status, 400); assert.equal(responses[1].status, 200);
    const state = await defaults(user, 2); assert.equal(state.shipping.id, other.id); assert.equal(state.billing.id, original.id);
  });

  it("deletion promotes the lowest-ID survivor only for the deleted default roles", async () => {
    const user = await customer(); const first = await create(user, "First");
    const delivery = await create(user, "Delivery", { isDefaultShipping: true });
    const billing = await create(user, "Billing", { isDefaultBilling: true });
    const nonDefault = await create(user, "Non-default");
    assert.equal((await request(user, "DELETE", nonDefault.id)).status, 204);
    let state = await defaults(user, 3); assert.equal(state.shipping.id, delivery.id); assert.equal(state.billing.id, billing.id);
    assert.equal((await request(user, "DELETE", billing.id)).status, 204);
    state = await defaults(user, 2); assert.equal(state.shipping.id, delivery.id); assert.equal(state.billing.id, first.id);
    assert.equal((await request(user, "DELETE", delivery.id)).status, 204);
    state = await defaults(user, 1); assert.equal(state.shipping.id, first.id); assert.equal(state.billing.id, first.id);
    assert.equal((await request(user, "DELETE", first.id)).status, 204); assert.deepEqual(await persisted(user), []);
    const next = await create(user, "New first"); state = await defaults(user, 1);
    assert.equal(state.shipping.id, next.id); assert.equal(state.billing.id, next.id);
  });

  it("serializes two deletes so the surviving address retains both defaults", async () => {
    const user = await customer(); const first = await create(user, "First");
    const second = await create(user, "Second"), survivor = await create(user, "Survivor");
    const responses = await concurrent(user, [() => request(user, "DELETE", first.id), () => request(user, "DELETE", second.id)]);
    assert.ok(responses.every((r) => r.status === 204));
    const state = await defaults(user, 1); assert.equal(state.shipping.id, survivor.id); assert.equal(state.billing.id, survivor.id);
  });

  it("serializes deleting the last address against creating another first address", async () => {
    const user = await customer(); const first = await create(user, "First");
    const responses = await concurrent(user, [
      () => request(user, "DELETE", first.id),
      () => request(user, "POST", undefined, address("Survivor")),
    ]);
    assert.equal(responses[0].status, 204); assert.equal(responses[1].status, 201);
    const state = await defaults(user, 1); assert.equal(state.shipping.id, state.billing.id);
  });

  it("serializes deleting a default against replacing that role on another address", async () => {
    const user = await customer(); const original = await create(user, "Original");
    const billing = await create(user, "Billing", { isDefaultBilling: true });
    const delivery = await create(user, "Delivery");
    const responses = await concurrent(user, [
      () => request(user, "DELETE", original.id),
      () => request(user, "PATCH", delivery.id, { isDefaultShipping: true }),
    ]);
    assert.equal(responses[0].status, 204); assert.equal(responses[1].status, 200);
    const state = await defaults(user, 2); assert.equal(state.shipping.id, delivery.id); assert.equal(state.billing.id, billing.id);
  });

  it("does not let another customer edit, delete or replace an owner's defaults", async () => {
    const owner = await customer(), other = await customer(); const saved = await create(owner, "Owner");
    await create(other, "Other");
    const beforeOwner = await persisted(owner), beforeOther = await persisted(other);
    const responses = await concurrent(other, [
      () => request(other, "PATCH", saved.id, { isDefaultShipping: true, isDefaultBilling: true }),
      () => request(other, "DELETE", saved.id),
    ]);
    assert.ok(responses.every((r) => r.status === 404));
    assert.deepEqual(await persisted(owner), beforeOwner); assert.deepEqual(await persisted(other), beforeOther);
  });

  it("allows another customer's mutation to finish while this customer's lock is held", async () => {
    const a = await customer(), b = await customer(); const held = await holdOwner(a);
    const waiting = request(a, "POST", undefined, address("A"));
    let timer: ReturnType<typeof setTimeout> | undefined;
    let responseB: Response | undefined, error: unknown;
    let requestB: Promise<Response> | undefined;
    try {
      await waitForQueuedMutations(held.pid, 1);
      requestB = request(b, "POST", undefined, address("B"));
      responseB = await Promise.race([requestB, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Unrelated customer's mutation blocked on this customer's lock")), 2_000);
      })]);
      assert.equal(responseB.status, 201);
    } catch (reason) { error = reason; }
    finally { if (timer) clearTimeout(timer); await held.release(); }
    const [responseA] = await Promise.all([waiting, ...(requestB ? [requestB] : [])]);
    if (error) throw error;
    assert.equal(responseA.status, 201);
    const stateA = await defaults(a, 1), stateB = await defaults(b, 1);
    assert.equal(stateA.shipping.userId, a.id); assert.equal(stateB.shipping.userId, b.id);
    assert.notEqual(stateA.shipping.id, stateB.shipping.id);
  });
});
