/** Report only the Stripe credential mode; never return or log the credential itself. */
export type StripeEnvironment = 'TEST' | 'LIVE' | 'UNKNOWN'

export function stripeEnvironment(secretKey: string | undefined): StripeEnvironment {
  if (secretKey?.startsWith('sk_test_') || secretKey?.startsWith('rk_test_')) return 'TEST'
  if (secretKey?.startsWith('sk_live_') || secretKey?.startsWith('rk_live_')) return 'LIVE'
  return 'UNKNOWN'
}
