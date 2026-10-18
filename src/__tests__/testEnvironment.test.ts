import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { parseAbuseLimits, stagingLimits } from "../config/paymentAbuse.js";
import { prepareTestEnvironment } from "../testing/testEnvironment.js";

const base = {
  DATABASE_URL: "postgresql://unused@127.0.0.1:1/colorful_life",
  TEST_DATABASE_URL: "postgresql://unused@127.0.0.1:1/colorful_life_test",
  JWT_SECRET: "synthetic-test-bootstrap-jwt",
};
const cwd = mkdtempSync(join(tmpdir(), "backend-test-environment-"));
after(() => rmSync(cwd, { recursive: true, force: true }));
const configUrl = new URL("../config/index.js", import.meta.url).href;

describe("isolated payment-abuse test environment (no database connections)", () => {
  it("provides a fresh shared synthetic key and finite budgets without changing database URLs", () => {
    const env: NodeJS.ProcessEnv = { ...base };
    assert.equal(prepareTestEnvironment(env).database, "colorful_life_test");
    assert.equal(env.NODE_ENV, "test");
    assert.match(env.PAYMENT_ABUSE_HMAC_SECRET!, /^[a-f0-9]{64}$/);
    const limits = parseAbuseLimits(env.PAYMENT_ABUSE_LIMITS_JSON);
    assert.deepEqual(Object.keys(limits), Object.keys(stagingLimits));
    for (const [capacity, seconds] of Object.values(limits)) {
      assert.equal(capacity, 1_000_000);
      assert.equal(seconds, 1);
    }
    assert.equal(env.DATABASE_URL, base.DATABASE_URL);
    assert.equal(env.TEST_DATABASE_URL, base.TEST_DATABASE_URL);
    const other: NodeJS.ProcessEnv = { ...base };
    prepareTestEnvironment(other);
    assert.notEqual(other.PAYMENT_ABUSE_HMAC_SECRET, env.PAYMENT_ABUSE_HMAC_SECRET);
  });

  it("isolates test settings from inherited secrets, proxy rules and provider/worker switches", () => {
    const env: NodeJS.ProcessEnv = {
      ...base, PAYMENT_ABUSE_HMAC_SECRET: "deployment-secret-must-not-be-reused",
      PAYMENT_ABUSE_LIMITS_JSON: "invalid inherited limits", CLIENT_IP_MODE: "proxy",
      TRUSTED_PROXY_CIDRS: "10.0.0.0/8", PAYMENT_STRIPE_INITIATION_ENABLED: "false",
      PAYMENT_PAYPAL_INITIATION_ENABLED: "false", PAYMENT_CHALLENGE_ENABLED: "true",
      PAYMENT_RESOLUTION_ENABLED: "true", REFUND_RECONCILIATION_ENABLED: "true",
      CARRIER_TRACKING_POLLING_ENABLED: "true", ORDER_CONFIRMATION_EMAIL_ENABLED: "true",
      DISPATCH_CONFIRMATION_EMAIL_ENABLED: "true",
    };
    prepareTestEnvironment(env);
    assert.notEqual(env.PAYMENT_ABUSE_HMAC_SECRET, "deployment-secret-must-not-be-reused");
    assert.equal(env.CLIENT_IP_MODE, "direct");
    assert.equal(env.TRUSTED_PROXY_CIDRS, "");
    assert.equal(env.PAYMENT_STRIPE_INITIATION_ENABLED, "true");
    assert.equal(env.PAYMENT_PAYPAL_INITIATION_ENABLED, "true");
    for (const key of ["PAYMENT_CHALLENGE_ENABLED", "PAYMENT_RESOLUTION_ENABLED", "REFUND_RECONCILIATION_ENABLED",
      "CARRIER_TRACKING_POLLING_ENABLED", "ORDER_CONFIRMATION_EMAIL_ENABLED", "DISPATCH_CONFIRMATION_EMAIL_ENABLED"]) {
      assert.equal(env[key], "false");
    }
  });

  for (const overrides of [
    { NODE_ENV: "production" }, { TEST_DATABASE_URL: base.DATABASE_URL }, { TEST_DATABASE_URL: "" },
  ]) it(`refuses unsafe bootstrap without changing the environment: ${JSON.stringify(overrides)}`, () => {
    const env: NodeJS.ProcessEnv = { ...base, ...overrides };
    const original = { ...env };
    assert.throws(() => prepareTestEnvironment(env), /Unsafe test database configuration/);
    assert.deepEqual(env, original);
  });

  it("boots config and HMAC admission in a clean test child and shares its key with subprocesses", () => {
    const env: NodeJS.ProcessEnv = { ...base };
    prepareTestEnvironment(env);
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import assert from 'node:assert/strict';
      const { config } = await import(${JSON.stringify(configUrl)});
      const { digest, limits } = await import(${JSON.stringify(new URL("../domain/security/paymentAbuse.js", import.meta.url).href)});
      assert.equal(config.DATABASE_URL, process.env.TEST_DATABASE_URL);
      assert.equal(config.PAYMENT_ABUSE_HMAC_SECRET, process.env.PAYMENT_ABUSE_HMAC_SECRET);
      assert.equal(config.PAYMENT_STRIPE_INITIATION_ENABLED, true);
      assert.equal(config.PAYMENT_PAYPAL_INITIATION_ENABLED, true);
      assert.match(digest('synthetic-subject'), /^[a-f0-9]{64}$/);
      assert.equal(limits().provider[0], 1000000);
      console.log('isolated-test-config-ready');
    `], { cwd, env, encoding: "utf8", timeout: 10_000 });
    assert.equal(child.status, 0, child.stderr);
    assert.match(child.stdout, /isolated-test-config-ready/);
    assert.ok(!(child.stdout + child.stderr).includes(env.PAYMENT_ABUSE_HMAC_SECRET!));
  });

  for (const mode of ["development", "production"]) {
    it(`${mode} startup still fails closed without an abuse secret outside the test launcher`, () => {
      const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
        await import(${JSON.stringify(configUrl)}); console.log('unexpected-config-ready');
      `], { cwd, env: { ...base, NODE_ENV: mode, CLIENT_IP_MODE: "direct" }, encoding: "utf8", timeout: 10_000 });
      assert.equal(child.status, 1);
      assert.match(child.stderr, /PAYMENT_ABUSE_HMAC_SECRET/);
      assert.doesNotMatch(child.stdout, /unexpected-config-ready/);
    });
  }

  it("production imports retain restrictive limits and disabled provider defaults", () => {
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import assert from 'node:assert/strict';
      const { config } = await import(${JSON.stringify(configUrl)});
      assert.equal(config.PAYMENT_STRIPE_INITIATION_ENABLED, false);
      assert.equal(config.PAYMENT_PAYPAL_INITIATION_ENABLED, false);
      assert.equal(config.PAYMENT_ABUSE_LIMITS_JSON, undefined);
      console.log('production-defaults-preserved');
    `], { cwd, env: { ...base, NODE_ENV: "production", CLIENT_IP_MODE: "direct",
      PAYMENT_ABUSE_HMAC_SECRET: "synthetic-production-validation-secret" }, encoding: "utf8", timeout: 10_000 });
    assert.equal(child.status, 0, child.stderr);
    assert.match(child.stdout, /production-defaults-preserved/);
  });
});
