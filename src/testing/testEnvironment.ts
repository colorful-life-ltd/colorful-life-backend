import { randomBytes } from "node:crypto";
import { stagingLimits } from "../config/paymentAbuse.js";
import { validateTestDatabase } from "../config/testDatabase.js";

/** Explicit test-runner setup, never imported by application startup. */
export function prepareTestEnvironment(env: NodeJS.ProcessEnv) {
  // Reject production and unsafe database targets before mutating any configuration.
  const target = validateTestDatabase(env);
  env.NODE_ENV = "test";
  // One synthetic key per run, inherited by every test worker and its subprocesses.
  env.PAYMENT_ABUSE_HMAC_SECRET = randomBytes(32).toString("hex");
  // Legacy fixture traffic shares a network identity. Keep enforcement active with
  // finite test budgets; abuse-specific tests explicitly restore restrictive limits.
  env.PAYMENT_ABUSE_LIMITS_JSON = JSON.stringify(Object.fromEntries(
    Object.keys(stagingLimits).map(name => [name, [1_000_000, 1]]),
  ));
  env.CLIENT_IP_MODE = "direct";
  env.TRUSTED_PROXY_CIDRS = "";
  // Provider initiation exercises injected clients; it must not inherit deployment flags.
  env.PAYMENT_STRIPE_INITIATION_ENABLED = "true";
  env.PAYMENT_PAYPAL_INITIATION_ENABLED = "true";
  for (const name of [
    "PAYMENT_CHALLENGE_ENABLED", "PAYMENT_RESOLUTION_ENABLED", "REFUND_RECONCILIATION_ENABLED",
    "CARRIER_TRACKING_POLLING_ENABLED", "ORDER_CONFIRMATION_EMAIL_ENABLED", "DISPATCH_CONFIRMATION_EMAIL_ENABLED",
  ]) env[name] = "false";
  return target;
}
