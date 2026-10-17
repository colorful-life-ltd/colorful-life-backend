import { z } from 'zod';

// Burst allowance and continuous refill interval; staging values, not production policy.
export const stagingLimits = {
  signupNetwork: [5, 3600], loginNetwork: [30, 900], refreshSession: [30, 900],
  orderAccount: [5, 900], orderNetwork: [20, 900], activeReservations: [3, 1],
  paymentAccount: [5, 900], paymentAccountDay: [15, 86400], paymentNetwork: [20, 900], paymentNetworkDay: [60, 86400],
  paymentOrder: [5, 900], provider: [100, 900], requestAccount: [60, 900], requestNetwork: [120, 900],
  recoveryAccount: [60, 900], recoveryNetwork: [120, 900], recoveryOrder: [30, 900], challengeAfter: [3, 900],
} satisfies Record<string, [number, number]>;
const schema = z.record(z.tuple([z.number().int().min(1).max(1000000), z.number().int().min(1).max(604800)]));
export function parseAbuseLimits(value?: string): typeof stagingLimits {
  const supplied = value === undefined ? {} : schema.parse(JSON.parse(value));
  if (Object.keys(supplied).some(k => !Object.hasOwn(stagingLimits, k))) throw new Error('Unsupported abuse limit');
  return { ...stagingLimits, ...supplied };
}
/** Pure startup checks. Error text contains only configuration names, never their values. */
export function validateAbuseStartup(value: { PAYMENT_ABUSE_HMAC_SECRET?: string; PAYMENT_ABUSE_LIMITS_JSON?: string; CLIENT_IP_MODE?: string; TRUSTED_PROXY_CIDRS?: string }, nodeEnv?: string) {
  if (nodeEnv === 'test') return;
  if (!value.PAYMENT_ABUSE_HMAC_SECRET || value.PAYMENT_ABUSE_HMAC_SECRET.trim().length < 32) throw new Error('PAYMENT_ABUSE_HMAC_SECRET must be configured with at least 32 non-padding characters');
  try { parseAbuseLimits(value.PAYMENT_ABUSE_LIMITS_JSON); } catch { throw new Error('PAYMENT_ABUSE_LIMITS_JSON is invalid'); }
  const mode = value.CLIENT_IP_MODE;
  if (nodeEnv === 'production' && !mode) throw new Error('CLIENT_IP_MODE must explicitly select direct or proxy in production');
  if (mode === 'proxy' && !value.TRUSTED_PROXY_CIDRS?.trim()) throw new Error('TRUSTED_PROXY_CIDRS is required in proxy mode');
  if ((mode === 'direct' || !mode) && value.TRUSTED_PROXY_CIDRS?.trim()) throw new Error('CLIENT_IP_MODE=proxy is required when TRUSTED_PROXY_CIDRS is configured');
  if (value.TRUSTED_PROXY_CIDRS?.split(',').some(cidr => /\/0+$/.test(cidr.trim()))) throw new Error('TRUSTED_PROXY_CIDRS must not trust all addresses');
}
