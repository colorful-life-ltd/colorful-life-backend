import assert from 'node:assert/strict';
import { it } from 'node:test';
import { validateProduction } from '../config/production.js';
import { DeliveryAddressSchema } from '../domain/orders/orderValidator.js';
const valid = { JWT_SECRET: 'a09e462f543750f8a1774512f9926a3c49265a850924163f8092620956ade87e9', FRONTEND_URL: 'https://shop.colorful-life.co.uk', SES_FROM_EMAIL: 'support@colorful-life.co.uk', PAYMENT_RESOLUTION_ENABLED: true, PAYPAL_BASE_URL: 'https://api-m.paypal.com', PAYMENT_PAYPAL_INITIATION_ENABLED: false, CORS_ALLOWED_ORIGINS: 'https://shop.colorful-life.co.uk' };
const env = { NODE_ENV: 'production', DEPLOYMENT_ENVIRONMENT:'production', PAYMENT_RESOLUTION_ENABLED: 'true', CORS_ALLOWED_ORIGINS: valid.CORS_ALLOWED_ORIGINS };
it('accepts explicit safe production configuration with initiation default off', () => assert.doesNotThrow(() => validateProduction(valid, env)));
for (const [key, value] of Object.entries({ JWT_SECRET: 'weak-do-not-print', FRONTEND_URL: 'http://localhost:5173', SES_FROM_EMAIL: 'noreply@example.com', PAYMENT_RESOLUTION_ENABLED: false, CORS_ALLOWED_ORIGINS: 'https://example.com' }))
    it(`production fails closed for ${key} without exposing its value`, () => assert.throws(() => validateProduction({ ...valid, [key]: value }, env), (e: unknown) => e instanceof Error && e.message.includes(key) && !e.message.includes(String(value))));
it('production requires explicit managed mode even if parsed config were true', () => assert.throws(() => validateProduction(valid, { ...env, PAYMENT_RESOLUTION_ENABLED: undefined }), /PAYMENT_RESOLUTION_ENABLED/));
it('production rejects sandbox when PayPal initiation is enabled', () => assert.throws(() => validateProduction({ ...valid, PAYMENT_PAYPAL_INITIATION_ENABLED: true, PAYPAL_BASE_URL: 'https://api-m.sandbox.paypal.com' }, env), /PAYPAL_BASE_URL/));
it('development retains localhost compatibility', () => assert.doesNotThrow(() => validateProduction({ ...valid, JWT_SECRET: 'dev', FRONTEND_URL: 'http://localhost:5173' }, { NODE_ENV: 'development' })));
for (const countryCode of ['US', 'FR', 'XX'])
    it(`delivery rejects ${countryCode}`, () => assert.equal(DeliveryAddressSchema.safeParse({ recipientName: 'Test', line1: 'Test', city: 'Test', postcode: 'SW1A 1AA', countryCode }).success, false));
it('GB normalization remains compatible', () => assert.equal(DeliveryAddressSchema.parse({ recipientName: 'Test', line1: 'Test', city: 'Test', postcode: 'SW1A 1AA', countryCode: 'gb' }).countryCode, 'GB'));

it('requires an explicit deployment environment',()=>assert.throws(()=>validateProduction(valid,{...env,DEPLOYMENT_ENVIRONMENT:undefined}),/DEPLOYMENT_ENVIRONMENT/));
it('staging explicitly permits test providers under production runtime hardening',()=>assert.doesNotThrow(()=>validateProduction({...valid,STRIPE_SECRET_KEY:'sk_test_synthetic',STRIPE_WEBHOOK_SECRET:'whsec_synthetic',PAYMENT_STRIPE_INITIATION_ENABLED:true,PAYMENT_PAYPAL_INITIATION_ENABLED:true,PAYPAL_BASE_URL:'https://api-m.sandbox.paypal.com'},{...env,DEPLOYMENT_ENVIRONMENT:'staging'})));
it('staging rejects live payment credentials',()=>assert.throws(()=>validateProduction({...valid,STRIPE_SECRET_KEY:'sk_live_synthetic'},{...env,DEPLOYMENT_ENVIRONMENT:'staging'}),/STRIPE_PROVIDER_CONFIGURATION/));
it('production rejects test payment credentials even with initiation disabled',()=>assert.throws(()=>validateProduction({...valid,STRIPE_SECRET_KEY:'sk_test_synthetic'},env),/STRIPE_PROVIDER_CONFIGURATION/));
it('rejects trivially repeated long JWT secrets',()=>assert.throws(()=>validateProduction({...valid,JWT_SECRET:'a'.repeat(64)},env),/JWT_SECRET/));
