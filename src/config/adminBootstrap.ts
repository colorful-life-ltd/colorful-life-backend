/**
 * Exposure of the HTTP first-Administrator registration routes.
 *
 * - Production (`NODE_ENV=production`, any deployment other than staging): never exposed. The first
 *   Administrator is provisioned only by the owner-run CLI (`dist/scripts/bootstrapAdmin.js`), which
 *   promotes an existing verified customer with an audit reason and operator reference.
 * - Deployed staging/Sandbox: exposed only with an explicit `ADMIN_BOOTSTRAP_HTTP_ENABLED=true`.
 * - Local development and tests: exposed unless `ADMIN_BOOTSTRAP_HTTP_ENABLED=false`.
 *
 * Network restrictions (the owner-IP Nginx include) remain defence in depth, never the only control.
 */
export type AdminBootstrapEnvironment = { NODE_ENV?: string; DEPLOYMENT_ENVIRONMENT?: string; ADMIN_BOOTSTRAP_HTTP_ENABLED?: string };

export function httpAdminBootstrapEnabled(env: AdminBootstrapEnvironment): boolean {
  if (env.NODE_ENV !== "production") return env.ADMIN_BOOTSTRAP_HTTP_ENABLED !== "false";
  if (env.DEPLOYMENT_ENVIRONMENT !== "staging") return false;
  return env.ADMIN_BOOTSTRAP_HTTP_ENABLED === "true";
}
