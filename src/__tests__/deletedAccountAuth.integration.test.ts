import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { randomUUID } from "node:crypto";
import { authMiddleware, setAuthenticatedUserLookupForTests } from "../middleware/auth.js";
import { config } from "../config/index.js";
import { prisma } from "../prisma/runtime.js";
import { createOrReplaceEmailVerificationToken, verifyEmailVerificationToken } from "../domain/auth/emailVerificationService.js";
import { createOrReplacePasswordResetToken, resetPassword } from "../domain/auth/passwordResetService.js";
import { forgotPassword, login, resendVerification } from "../controllers/authController.js";
import { setPasswordResetEmailSenderForTests, setVerificationEmailSenderForTests } from "../services/emailService.js";

const ids: number[] = [];
const restores: Array<() => void> = [];
let restoreReset: (() => void) | undefined;
let restoreVerification: (() => void) | undefined;

afterEach(async () => {
  while (restores.length) restores.pop()!();
  restoreReset?.(); restoreReset = undefined;
  restoreVerification?.(); restoreVerification = undefined;
  if (ids.length) await prisma.user.deleteMany({ where: { id: { in: ids } } });
  ids.length = 0;
});

async function makeUser(role: "CUSTOMER" | "ADMIN" = "CUSTOMER", emailVerified = false) {
  const user = await prisma.user.create({ data: { email: `${randomUUID()}@example.com`, passwordHash: await bcrypt.hash("Abcdef1!", 4), role, emailVerified } });
  ids.push(user.id); return user;
}
function tokenFor(user: { id: number; role: string }) { return jwt.sign({ id: user.id, role: user.role }, config.JWT_SECRET, { expiresIn: "1h" }); }
function responseMock() {
  let statusCode = 200; let body: unknown;
  return { res: { status(code: number) { statusCode = code; return this; }, json(value: unknown) { body = value; return this; } } as any, result: () => ({ statusCode, body }) };
}
function authRequest(jwtToken?: string) { return { headers: jwtToken ? { authorization: `Bearer ${jwtToken}` } : {} } as any; }

describe("deleted-account authentication regressions", () => {
  it("rejects old customer JWTs and JWTs for missing Users", async () => {
    const user = await makeUser(); const oldJwt = tokenFor(user);
    await prisma.user.update({ where: { id: user.id }, data: { deletedAt: new Date() } });
    const denied = responseMock(); let reached = false;
    await authMiddleware(authRequest(oldJwt), denied.res, (() => { reached = true; }) as any);
    assert.deepEqual(denied.result(), { statusCode: 401, body: { error: { code: "SESSION_INVALID", message: "Invalid or expired token" } } }); assert.equal(reached, false);
    const missing = await makeUser(); const missingJwt = tokenFor(missing);
    await prisma.user.delete({ where: { id: missing.id } }); ids.splice(ids.indexOf(missing.id), 1);
    const missingResponse = responseMock(); await authMiddleware(authRequest(missingJwt), missingResponse.res, (() => { reached = true; }) as any);
    assert.deepEqual(missingResponse.result(), { statusCode: 401, body: { error: { code: "SESSION_INVALID", message: "Invalid or expired token" } } }); assert.equal(reached, false);
  });

  it("rejects a tombstoned Admin JWT through shared authentication", async () => {
    const user = await makeUser("ADMIN"); const jwtToken = tokenFor(user);
    await prisma.user.update({ where: { id: user.id }, data: { deletedAt: new Date() } });
    const result = responseMock(); await authMiddleware(authRequest(jwtToken), result.res, (() => { throw new Error("must not continue"); }) as any);
    assert.deepEqual(result.result(), { statusCode: 401, body: { error: { code: "SESSION_INVALID", message: "Invalid or expired token" } } });
  });

  it("returns an internal server error when the authenticated-user database lookup fails", async () => {
    restores.push(setAuthenticatedUserLookupForTests(async () => { throw new Error("database unavailable"); }));
    const validShapeToken = tokenFor({ id: 987654321, role: "CUSTOMER" });
    const result = responseMock(); let reached = false;
    await authMiddleware(authRequest(validShapeToken), result.res, (() => { reached = true; }) as any);
    assert.deepEqual(result.result(), { statusCode: 500, body: { error: { code: "INTERNAL_SERVER_ERROR", message: "Internal server error" } } });
    assert.equal(reached, false);
  });

  it("keeps active login working but blocks tombstoned login and keeps forgot-password generic", async () => {
    const user = await makeUser("CUSTOMER", true); const activeLogin = responseMock();
    await login({ body: { email: user.email, password: "Abcdef1!" } } as any, activeLogin.res); assert.equal(activeLogin.result().statusCode, 200);
    await prisma.user.update({ where: { id: user.id }, data: { deletedAt: new Date() } });
    restoreReset = setPasswordResetEmailSenderForTests(async () => { throw new Error("must not send"); });
    const deletedLogin = responseMock(); await login({ body: { email: user.email, password: "Abcdef1!" } } as any, deletedLogin.res);
    const forgot = responseMock(); await forgotPassword({ body: { email: user.email } } as any, forgot.res);
    assert.equal(deletedLogin.result().statusCode, 401); assert.deepEqual(forgot.result(), { statusCode: 200, body: { message: "If an account exists, a password reset email has been sent" } });
    assert.equal(await prisma.passwordResetToken.count({ where: { userId: user.id } }), 0);
  });

  it("rejects reset and verification tokens belonging to tombstoned users", async () => {
    const resetUser = await makeUser(); const reset = await createOrReplacePasswordResetToken(resetUser.id);
    await prisma.user.update({ where: { id: resetUser.id }, data: { deletedAt: new Date() } }); await assert.rejects(() => resetPassword(reset.rawToken, "NewPassword1!"));
    assert.notEqual((await prisma.user.findUnique({ where: { id: resetUser.id } }))?.deletedAt, null);
    const verifyUser = await makeUser(); const verification = await createOrReplaceEmailVerificationToken(verifyUser.id);
    await prisma.user.update({ where: { id: verifyUser.id }, data: { deletedAt: new Date() } }); await assert.rejects(() => verifyEmailVerificationToken(verification.rawToken!, "VerifiedPass1!"));
    const state = await prisma.user.findUnique({ where: { id: verifyUser.id } }); assert.equal(state?.emailVerified, false); assert.notEqual(state?.deletedAt, null);
  });

  it("does not resend verification to a tombstoned user", async () => {
    const user = await makeUser(); await prisma.user.update({ where: { id: user.id }, data: { deletedAt: new Date() } });
    let sends = 0; restoreVerification = setVerificationEmailSenderForTests(async () => { sends++; }); const result = responseMock();
    await resendVerification({ body: { email: user.email } } as any, result.res);
    assert.deepEqual(result.result(), { statusCode: 200, body: { message: "If verification is needed, check your email for next steps." } });
    assert.equal(sends, 0); assert.equal(await prisma.emailVerificationToken.count({ where: { userId: user.id } }), 0);
  });
});
