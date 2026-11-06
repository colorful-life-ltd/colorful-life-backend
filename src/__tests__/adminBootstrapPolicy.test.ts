import assert from "node:assert/strict";
import { it } from "node:test";
import { httpAdminBootstrapEnabled } from "../config/adminBootstrap.js";

const cases: Array<[string, Record<string, string | undefined>, boolean]> = [
  // Production never exposes HTTP registration, whatever is configured.
  ["production default", { NODE_ENV: "production", DEPLOYMENT_ENVIRONMENT: "production" }, false],
  ["production explicit opt-in is still refused", { NODE_ENV: "production", DEPLOYMENT_ENVIRONMENT: "production", ADMIN_BOOTSTRAP_HTTP_ENABLED: "true" }, false],
  ["production runtime without a deployment environment", { NODE_ENV: "production" }, false],
  ["production runtime with an unknown deployment environment", { NODE_ENV: "production", DEPLOYMENT_ENVIRONMENT: "sandbox", ADMIN_BOOTSTRAP_HTTP_ENABLED: "true" }, false],
  // Deployed staging/Sandbox requires an explicit opt-in.
  ["staging default", { NODE_ENV: "production", DEPLOYMENT_ENVIRONMENT: "staging" }, false],
  ["staging explicit opt-in", { NODE_ENV: "production", DEPLOYMENT_ENVIRONMENT: "staging", ADMIN_BOOTSTRAP_HTTP_ENABLED: "true" }, true],
  ["staging explicit opt-out", { NODE_ENV: "production", DEPLOYMENT_ENVIRONMENT: "staging", ADMIN_BOOTSTRAP_HTTP_ENABLED: "false" }, false],
  // Local development and tests keep the existing workflow.
  ["development default", { NODE_ENV: "development" }, true],
  ["test default", { NODE_ENV: "test" }, true],
  ["unset NODE_ENV", {}, true],
  ["development explicit opt-out", { NODE_ENV: "development", ADMIN_BOOTSTRAP_HTTP_ENABLED: "false" }, false],
];
for (const [name, env, expected] of cases)
  it(`HTTP first-Administrator registration: ${name} → ${expected ? "exposed" : "closed"}`, () => assert.equal(httpAdminBootstrapEnabled(env), expected));
