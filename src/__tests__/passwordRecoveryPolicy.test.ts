import assert from "node:assert/strict";
import { it } from "node:test";
import bcrypt from "bcrypt";
import { passwordSchema, signupSchema, resetPasswordSchema, loginSchema } from "../utils/authValidation.js";
import { recoveryClientIp } from "../utils/recoveryClientIp.js";

it("enforces 72 UTF-8 bytes consistently for new passwords, including Unicode", () => {
  for (const prefix of ["a".repeat(68), "é".repeat(34), "😀".repeat(17)]) {
    const boundary = prefix + "Aa1!";
    assert.equal(Buffer.byteLength(boundary), 72);
    assert.equal(passwordSchema.safeParse(boundary).success, true);
    for (const password of [boundary + "a", boundary + "é"]) {
      assert.equal(passwordSchema.safeParse(password).success, false);
      assert.equal(signupSchema.safeParse({ email: "test@example.test", password }).success, false);
      assert.equal(resetPasswordSchema.safeParse({ token: "token", newPassword: password }).success, false);
      assert.equal(loginSchema.safeParse({ email: "test@example.test", password }).success, true);
    }
  }
});
it("rejects distinct passwords whose bcrypt prefixes would otherwise be equivalent", async () => {
  const prefix = "Aa1!" + "a".repeat(68);
  const hash = await bcrypt.hash(prefix + "one", 4);
  assert.equal(await bcrypt.compare(prefix + "two", hash), true);
  assert.equal(passwordSchema.safeParse(prefix + "one").success, false);
  assert.equal(passwordSchema.safeParse(prefix + "two").success, false);
});
it("canonicalizes IPv4, mapped IPv6, and equivalent IPv6 /56 networks", () => {
  assert.equal(recoveryClientIp("192.0.2.1"), recoveryClientIp("::ffff:192.0.2.1"));
  assert.equal(recoveryClientIp("192.0.2.1"), recoveryClientIp("0:0:0:0:0:ffff:c000:201"));
  assert.equal(recoveryClientIp("2001:db8:1234:5600::1"), recoveryClientIp("2001:0db8:1234:56ff:ffff:ffff:ffff:ffff"));
  assert.notEqual(recoveryClientIp("2001:db8:1234:5600::1"), recoveryClientIp("2001:db8:1234:5700::1"));
  assert.equal(recoveryClientIp("fe80::1%eth0"), recoveryClientIp("fe80::2%eth1"));
  for (const invalid of ["192.0.2.1:80", "spoofed", "", "127.1"]) assert.equal(recoveryClientIp(invalid), "unknown");
});
