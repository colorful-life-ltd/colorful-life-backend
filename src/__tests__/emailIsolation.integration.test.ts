import assert from 'node:assert/strict';
import { it, before } from 'node:test';
import { SESClient } from '@aws-sdk/client-ses';
import { randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import app from '../app.js';
import { config } from '../config/index.js';
import { prisma } from '../prisma/runtime.js';
// Public registration is closed by default; these tests exercise the signup flow explicitly.
before(() => { config.REGISTRATION_ENABLED = true; });
it('signup, resend, email change and password reset use the safe default without real SES', async () => {
  const original = SESClient.prototype.send; let sends = 0; let userId: number | undefined;
  (SESClient.prototype as any).send = async () => { sends++; throw new Error('Real SES invoked'); };
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(r => server.once('listening', r));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const post = (path: string, body: object, token?: string, method = 'POST') => fetch(url+path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  try {
    const email = `${randomUUID()}@example.test`;
    const signup = await post('/auth/signup', { email, password: 'Synthetic1!Password' }); assert.equal(signup.status, 201);
    const { token } = await signup.json(); userId = (jwt.verify(token, config.JWT_SECRET) as { id: number }).id;
    assert.ok(await prisma.emailVerificationToken.findUnique({ where: { userId } }));
    assert.equal((await post('/auth/resend-verification', {}, token)).status, 200);
    const changedEmail = `${randomUUID()}@example.test`;
    assert.equal((await post('/users/me/email', { email: changedEmail }, token, 'PATCH')).status, 200);
    assert.equal((await post('/auth/forgot-password', { email: changedEmail })).status, 200);
    assert.ok(await prisma.passwordResetToken.findUnique({ where: { userId } }));
    assert.equal(sends, 0);
  } finally {
    SESClient.prototype.send = original;
    if (userId) await prisma.user.delete({ where: { id: userId } });
    await new Promise<void>(r => server.close(() => r())); await prisma.$disconnect();
  }
});
