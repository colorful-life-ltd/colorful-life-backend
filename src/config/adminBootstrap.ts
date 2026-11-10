/**
 * Exposure of the HTTP first-Administrator registration routes.
 *
 * - Production (`NODE_ENV=production`, any deployment other than staging): `private`. The routes answer
 *   only direct loopback requests (the owner's SSM tunnel), never anything forwarded by a proxy, and
 *   only inside a short window the owner opens from the host as root (`bootstrapAdmin --arm-registration`).
 *   `ADMIN_BOOTSTRAP_HTTP_ENABLED=false` closes them entirely. General `open` registration is never
 *   available in Production.
 * - Deployed staging/Sandbox: `open` only with an explicit `ADMIN_BOOTSTRAP_HTTP_ENABLED=true`.
 * - Local development and tests: `open` unless `ADMIN_BOOTSTRAP_HTTP_ENABLED=false`.
 *
 * Network restrictions (the owner-IP Nginx include) remain defence in depth, never the only control.
 */
export type AdminBootstrapEnvironment = { NODE_ENV?: string; DEPLOYMENT_ENVIRONMENT?: string; ADMIN_BOOTSTRAP_HTTP_ENABLED?: string };
export type AdminBootstrapMode = "open" | "private" | "closed";

export function adminBootstrapMode(env: AdminBootstrapEnvironment): AdminBootstrapMode {
  if (env.NODE_ENV !== "production") return env.ADMIN_BOOTSTRAP_HTTP_ENABLED !== "false" ? "open" : "closed";
  if (env.DEPLOYMENT_ENVIRONMENT === "staging") return env.ADMIN_BOOTSTRAP_HTTP_ENABLED === "true" ? "open" : "closed";
  return env.ADMIN_BOOTSTRAP_HTTP_ENABLED === "false" ? "closed" : "private";
}

/** Whether general (unarmed, any-origin) HTTP registration is exposed. Never true in Production. */
export function httpAdminBootstrapEnabled(env: AdminBootstrapEnvironment): boolean {
  return adminBootstrapMode(env) === "open";
}
