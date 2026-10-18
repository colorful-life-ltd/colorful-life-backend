import {isIP} from "node:net";
/** Pure startup validation: errors contain configuration names, never values. */
export function validateProduction(c: {
    JWT_SECRET: string;
    FRONTEND_URL: string;
    SES_FROM_EMAIL: string;
    PAYMENT_RESOLUTION_ENABLED: boolean;
    PAYPAL_BASE_URL: string;
    PAYMENT_PAYPAL_INITIATION_ENABLED: boolean;
    CORS_ALLOWED_ORIGINS: string;
    STRIPE_SECRET_KEY?: string;
    STRIPE_WEBHOOK_SECRET?: string;
    PAYMENT_STRIPE_INITIATION_ENABLED?: boolean;
    PAYPAL_CLIENT_ID?: string;
    PAYPAL_WEBHOOK_ID?: string;
}, env: NodeJS.ProcessEnv) {
    if (env.NODE_ENV !== 'production')
        return;
    const bad: string[] = [];
    if(!['staging','production'].includes(env.DEPLOYMENT_ENVIRONMENT??''))bad.push('DEPLOYMENT_ENVIRONMENT');
    const live=env.DEPLOYMENT_ENVIRONMENT!=='staging';
    const origin = (value: string) => {
        try {
            const u = new URL(value);
            return u.protocol === 'https:' && !u.username && !u.password && u.pathname === '/' && !u.search && !u.hash
                && u.hostname.includes('.') && !isIP(u.hostname) && !u.hostname.startsWith('[')
                && !/(^|[.-])(localhost|example|invalid|test|local|sandbox)([.-]|$)/.test(u.hostname);
        }
        catch {
            return false;
        }
    };
    if (Buffer.byteLength(c.JWT_SECRET) < 32 || new Set(c.JWT_SECRET).size<8 || /(secret|changeme|example|password)/i.test(c.JWT_SECRET))
        bad.push('JWT_SECRET');
    if (!origin(c.FRONTEND_URL))
        bad.push('FRONTEND_URL');
    if (env.PAYMENT_RESOLUTION_ENABLED !== 'true' || !c.PAYMENT_RESOLUTION_ENABLED)
        bad.push('PAYMENT_RESOLUTION_ENABLED');
    if (!env.CORS_ALLOWED_ORIGINS || !c.CORS_ALLOWED_ORIGINS.split(',').every(v => origin(v.trim())))
        bad.push('CORS_ALLOWED_ORIGINS');
    if (/@(example\.(com|org|net)|localhost|.*\.invalid)$/i.test(c.SES_FROM_EMAIL))
        bad.push('SES_FROM_EMAIL');
    if ((c.PAYMENT_PAYPAL_INITIATION_ENABLED || c.PAYPAL_CLIENT_ID || c.PAYPAL_WEBHOOK_ID) && !(live?['https://api-m.paypal.com','https://api.paypal.com']:['https://api-m.sandbox.paypal.com','https://api.sandbox.paypal.com']).includes(c.PAYPAL_BASE_URL))
        bad.push('PAYPAL_BASE_URL');
    if((c.STRIPE_SECRET_KEY&&!c.STRIPE_SECRET_KEY.startsWith(live?'sk_live_':'sk_test_')) || (c.PAYMENT_STRIPE_INITIATION_ENABLED&&(!c.STRIPE_SECRET_KEY||!c.STRIPE_WEBHOOK_SECRET)))bad.push('STRIPE_PROVIDER_CONFIGURATION');
    if (bad.length)
        throw new Error(`Unsafe production configuration: ${bad.join(', ')}`);
}
