import assert from 'node:assert/strict';
import { afterEach, it } from 'node:test';
import { randomUUID } from 'node:crypto';
import { prisma } from '../prisma/runtime.js';
import { pruneSecurityState } from '../domain/security/paymentSecurityOperations.js';
import app from '../app.js';
import jwt from 'jsonwebtoken';
import { config } from '../config/index.js';

const users: number[] = [];
afterEach(async () => {
  await prisma.user.deleteMany({ where: { id: { in: users.splice(0) } } });
});

it('bounded expired-auth cleanup preserves unexpired records and is repeatable', async () => {
  const owner = await prisma.user.create({ data: { email: `${randomUUID()}@example.test`, passwordHash: 'synthetic' } });
  users.push(owner.id);
  const past = new Date(Date.now() - 60000), future = new Date(Date.now() + 86400000);
  await prisma.refreshSession.createMany({ data: Array.from({ length: 1001 }, () => ({ userId: owner.id, refreshTokenHash: randomUUID(), expiresAt: past })) });
  const active = await prisma.refreshSession.create({ data: { userId: owner.id, refreshTokenHash: randomUUID(), expiresAt: future } });
  await prisma.emailVerificationToken.create({ data: { userId: owner.id, tokenHash: randomUUID(), expiresAt: past } });
  const reset = await prisma.passwordResetToken.create({ data: { userId: owner.id, tokenHash: randomUUID(), expiresAt: future } });
  const first = await pruneSecurityState();
  assert.equal(first.refreshSessions, 1000);
  assert.equal(first.verificationTokens, 1);
  assert.equal(first.resetTokens, 0);
  assert.equal(await prisma.refreshSession.count({ where: { userId: owner.id, expiresAt: { lt: future } } }), 1);
  assert.equal((await pruneSecurityState()).refreshSessions, 1);
  const empty = await pruneSecurityState();
  assert.equal(empty.refreshSessions, 0);
  assert.equal(empty.verificationTokens, 0);
  assert.equal(empty.resetTokens, 0);
  assert.deepEqual(await prisma.refreshSession.findUnique({ where: { id: active.id } }), active);
  assert.deepEqual(await prisma.passwordResetToken.findUnique({ where: { id: reset.id } }), reset);
});

it('locked replacement tokens survive cleanup and expired reset tokens are removed', async () => {
  const owner = await prisma.user.create({ data: { email: `${randomUUID()}@example.test`, passwordHash: 'synthetic' } });
  users.push(owner.id);
  await prisma.emailVerificationToken.create({ data: { userId: owner.id, tokenHash: randomUUID(), expiresAt: new Date(Date.now() - 60000) } });
  await prisma.passwordResetToken.create({ data: { userId: owner.id, tokenHash: randomUUID(), expiresAt: new Date(Date.now() - 60000) } });
  await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "EmailVerificationToken" WHERE "userId"=${owner.id} FOR UPDATE`;
    const result = await pruneSecurityState();
    assert.equal(result.verificationTokens, 0);
    assert.equal(result.resetTokens, 1);
    await tx.emailVerificationToken.update({ where: { userId: owner.id }, data: { tokenHash: randomUUID(), expiresAt: new Date(Date.now() + 86400000) } });
  });
  assert.equal((await pruneSecurityState()).verificationTokens, 0);
  assert.equal(await prisma.emailVerificationToken.count({ where: { userId: owner.id } }), 1);
});

it('existing maintenance remains ADMIN-only and returns counts without identities', async () => {
  const customer = await prisma.user.create({ data: { email: `${randomUUID()}@example.test`, passwordHash: 'synthetic' } });
  const admin = await prisma.user.create({ data: { email: `${randomUUID()}@example.test`, passwordHash: 'synthetic', role: 'ADMIN' } });
  users.push(customer.id, admin.id);
  const server = app.listen(0);
  try {
    await new Promise<void>(resolve => server.once('listening', resolve));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/admin/payment-security/maintenance`;
    assert.equal((await fetch(url, { method: 'POST' })).status, 401);
    const headers = (id: number) => ({ Authorization: `Bearer ${jwt.sign({ id }, config.JWT_SECRET)}` });
    assert.equal((await fetch(url, { method: 'POST', headers: headers(customer.id) })).status, 403);
    const response = await fetch(url, { method: 'POST', headers: headers(admin.id) });
    assert.equal(response.status, 200);
    const counts = await response.json() as Record<string, unknown>;
    assert.deepEqual(Object.keys(counts).sort(), ['buckets', 'challenges', 'refreshSessions', 'resetTokens', 'verificationTokens']);
    assert.ok(Object.values(counts).every(value => typeof value === 'number' && value >= 0));
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
