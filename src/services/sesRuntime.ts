import { config } from "../config/index.js";
import { sesCredentialReadiness, sesSessionCredentialProvider, sesSessionSource, type EmailReadiness } from "./sesCredentials.js";

/**
 * Credentials for every SES client. `undefined` keeps the SDK default chain (existing
 * Sandbox/development behaviour: environment keys). With a session directory configured,
 * environment keys are never consulted for SES.
 */
export function configuredSesCredentials() {
  const source = sesSessionSource(config);
  return source ? sesSessionCredentialProvider(source) : undefined;
}

export type EmailFlow = "signup" | "account";
type ReadinessCheck = (flow: EmailFlow) => Promise<EmailReadiness>;

const configuredReadiness: ReadinessCheck = flow => sesCredentialReadiness(config, {
  production: process.env.NODE_ENV === "production",
  // A new registration must be verifiable; existing-account flows keep the current transport.
  requireVerifiableExpiry: flow === "signup",
});
let readiness: ReadinessCheck = configuredReadiness;

export function emailCredentialReadiness(flow: EmailFlow): Promise<EmailReadiness> {
  return readiness(flow);
}

export function setEmailCredentialReadinessForTests(check: ReadinessCheck): () => void {
  const previous = readiness;
  readiness = check;
  return () => { readiness = previous; };
}
