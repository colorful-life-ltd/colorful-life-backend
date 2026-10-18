import assert from "node:assert/strict";
import { after, afterEach, before, describe, it } from "node:test";
import type { Server } from "node:http";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { randomUUID } from "node:crypto";
import app from "../app.js";
import { config } from "../config/index.js";
import { prisma } from "../prisma/runtime.js";

let server: Server; let baseUrl = ""; const ids: number[] = [];
before(async () => { server = app.listen(0); await new Promise<void>((resolve) => server.once("listening", resolve)); baseUrl = `http://localhost:${(server.address() as { port: number }).port}`; });
after(async () => { await prisma.$disconnect(); server.close(); });
afterEach(async () => { if (ids.length) { await prisma.user.deleteMany({ where: { id: { in: ids } } }); ids.length = 0; } });
async function makeUser(role: "CUSTOMER" | "ADMIN" = "CUSTOMER", emailVerified = false) { const u = await prisma.user.create({ data: { email: `${randomUUID()}@example.com`, passwordHash: await bcrypt.hash("Abcdef1!", 4), role, emailVerified, firstName: "A", lastName: "B", phone: "07000000000", addresses: { create: { recipientName: "A B", line1: "1 Main Street", city: "London", postcode: "SW1A 1AA", countryCode: "GB" } } } }); ids.push(u.id); return u; }
function auth(id: number, role: string) { return jwt.sign({ id, role }, config.JWT_SECRET, { expiresIn: "1h" }); }
describe("DELETE /users/me", () => {
  it("requires authentication", async () => { assert.equal((await fetch(`${baseUrl}/users/me`, { method: "DELETE" })).status, 401); });
  it("tombstones a customer and returns 204 without a body", async () => { const u = await makeUser(); const response = await fetch(`${baseUrl}/users/me`, { method: "DELETE", body:JSON.stringify({password:"Abcdef1!"}), headers: { "Content-Type":"application/json", Authorization: `Bearer ${auth(u.id, u.role)}` } }); assert.equal(response.status, 204); assert.equal(await response.text(), ""); const stored = await prisma.user.findUnique({ where: { id: u.id } }); assert.ok(stored?.deletedAt); assert.notEqual(stored.email, u.email); assert.equal(await prisma.address.count({ where: { userId: u.id } }), 0); });
  it("allows unverified customers, rejects Admins, and rejects the old JWT afterward", async () => { const u = await makeUser(); const jwtToken = auth(u.id, u.role); assert.equal((await fetch(`${baseUrl}/users/me`, { method: "DELETE", body:JSON.stringify({password:"Abcdef1!"}), headers: { "Content-Type":"application/json", Authorization: `Bearer ${jwtToken}` } })).status, 204); assert.equal((await fetch(`${baseUrl}/users/me`, { method: "DELETE", body:JSON.stringify({password:"Abcdef1!"}), headers: { "Content-Type":"application/json", Authorization: `Bearer ${jwtToken}` } })).status, 401); const admin = await makeUser("ADMIN"); const before = await prisma.user.findUnique({ where: { id: admin.id } }); const denied = await fetch(`${baseUrl}/users/me`, { method: "DELETE", body:JSON.stringify({password:"Abcdef1!"}), headers: { "Content-Type":"application/json", Authorization: `Bearer ${auth(admin.id, admin.role)}` } }); assert.equal(denied.status, 403); assert.deepEqual(await prisma.user.findUnique({ where: { id: admin.id } }), before); });
});
