import { randomBytes } from "node:crypto";

export const BOOTSTRAP_AUTHORIZATION_TTL_MS = 5 * 60_000;
const MAX_PENDING_AUTHORIZATIONS = 100;

/** Process-local, volatile owner grants: restart invalidates every outstanding grant. */
export class BootstrapAuthorizationStore {
  constructor(private readonly clock: () => number = Date.now) {}
  private readonly grants = new Map<string, { expiresAt: number; ip: string }>();

  issue(ip: string, now = this.clock()): string | null {
    for (const [token, grant] of this.grants) if (grant.expiresAt <= now) this.grants.delete(token);
    if (this.grants.size >= MAX_PENDING_AUTHORIZATIONS) return null;
    const token = randomBytes(32).toString("base64url");
    this.grants.set(token, { expiresAt: now + BOOTSTRAP_AUTHORIZATION_TTL_MS, ip });
    return token;
  }

  consume(token: string, ip: string, now = this.clock()): boolean {
    const grant = this.grants.get(token);
    this.grants.delete(token);
    return Boolean(grant && grant.expiresAt > now && grant.ip === ip);
  }
}
