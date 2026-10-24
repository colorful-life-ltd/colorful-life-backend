import { config } from "../../config/index.js";
/** Explicit staging and Sandbox app only: unset environment never enables initiation. */
export function paypalSandboxAvailable() {
  return process.env.DEPLOYMENT_ENVIRONMENT === "staging" &&
    ["https://api-m.sandbox.paypal.com", "https://api.sandbox.paypal.com"].includes(config.PAYPAL_BASE_URL) &&
    !!config.PAYPAL_CLIENT_ID && !!config.PAYPAL_CLIENT_SECRET;
}
