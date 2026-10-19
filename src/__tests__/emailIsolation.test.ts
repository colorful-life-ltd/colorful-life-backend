import assert from 'node:assert/strict';
import { afterEach, it } from 'node:test';
import { SESClient } from '@aws-sdk/client-ses';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir, devNull } from 'node:os';
import { join } from 'node:path';
import { config } from '../config/index.js';
import { prepareTestEnvironment } from '../testing/testEnvironment.js';
import { sendVerificationEmail, sendPasswordResetEmail, sendDispatchNotification, setVerificationEmailSenderForTests, setPasswordResetEmailSenderForTests } from '../services/emailService.js';
import { sesConfirmationTransport, checkSesReadiness, captureConfirmationTransport } from '../domain/orderConfirmation/delivery.js';

const originalSend = SESClient.prototype.send;
let calls = 0;
function spySes() { (SESClient.prototype as any).send = async () => { calls++; throw new Error('A real SES client must never be invoked'); }; }
afterEach(() => { SESClient.prototype.send = originalSend; calls = 0; });
it('default verification and password-reset sends never invoke SES in tests', async () => {
  spySes();
  await sendVerificationEmail({ recipientEmail: 'synthetic@example.test', verificationUrl: 'https://example.test/verify?token=fake' });
  await sendPasswordResetEmail({ recipientEmail: 'synthetic@example.test', resetUrl: 'https://example.test/reset?token=fake' });
  assert.equal(calls, 0);
});
it('explicit capture senders are deterministic and restoration returns to no-send, not SES', async () => {
  spySes(); const messages: object[] = [];
  const verification = { recipientEmail: 'synthetic@example.test', verificationUrl: 'https://example.test/verify?token=fake' };
  const reset = { recipientEmail: 'synthetic@example.test', resetUrl: 'https://example.test/reset?token=fake' };
  const restoreV = setVerificationEmailSenderForTests(async v => { messages.push(v); });
  const restoreP = setPasswordResetEmailSenderForTests(async v => { messages.push(v); });
  try { await sendVerificationEmail(verification); await sendPasswordResetEmail(reset); assert.deepEqual(messages, [verification, reset]); }
  finally { restoreV(); restoreP(); }
  await sendVerificationEmail(verification); await sendPasswordResetEmail(reset); assert.equal(calls, 0); assert.equal(messages.length, 2);
});
it('legacy dispatch and durable confirmation/dispatch refuse real delivery with both flags enabled', async () => {
  spySes(); const saved = [config.ORDER_CONFIRMATION_EMAIL_ENABLED, config.DISPATCH_CONFIRMATION_EMAIL_ENABLED];
  try {
    config.ORDER_CONFIRMATION_EMAIL_ENABLED = config.DISPATCH_CONFIRMATION_EMAIL_ENABLED = true;
    await assert.rejects(sendDispatchNotification({ customerEmail: 'synthetic@example.test', orderId: 1, shippingCarrier: 'Test', dispatchedAt: new Date('2026-01-01T00:00:00Z') }));
    await assert.rejects(sesConfirmationTransport.send(Buffer.from('synthetic MIME')));
    assert.equal(calls, 0);
    const capture = captureConfirmationTransport(); const bytes = Buffer.from('deterministic captured MIME'); await capture.transport.send(bytes);
    assert.deepEqual(capture.messages, [bytes]);
  } finally { [config.ORDER_CONFIRMATION_EMAIL_ENABLED, config.DISPATCH_CONFIRMATION_EMAIL_ENABLED] = saved; }
});
it('readiness refuses a real SDK client even when explicitly injected, without resolving credentials', async () => {
  spySes(); let resolutions = 0;
  const client = new SESClient({ region: 'eu-west-2', credentials: async () => { resolutions++; throw new Error('Must not resolve credentials'); } });
  try { await assert.rejects(checkSesReadiness('synthetic@example.test', client)); assert.equal(calls, 0); assert.equal(resolutions, 0); }
  finally { client.destroy(); }
});
it('test-process protection survives temporary NODE_ENV changes', async () => {
  spySes(); const previous = process.env.NODE_ENV;
  try { process.env.NODE_ENV = 'development'; await sendPasswordResetEmail({ recipientEmail: 'synthetic@example.test', resetUrl: 'https://example.test/reset' }); assert.equal(calls, 0); }
  finally { process.env.NODE_ENV = previous; }
});
it('runner neutralizes inherited credentials, profiles, web identity, ECS and IMDS without touching credential files', () => {
  const home = mkdtempSync(join(tmpdir(), 'email-isolation-'));
  try {
    mkdirSync(join(home, '.aws')); const file = join(home, '.aws', 'credentials'); const content = '[default]\naws_access_key_id=synthetic-file-key\naws_secret_access_key=synthetic-file-secret\n'; writeFileSync(file, content);
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: home, DATABASE_URL: 'postgresql://unused@127.0.0.1:1/development', TEST_DATABASE_URL: 'postgresql://unused@127.0.0.1:1/colorful_life_test',
      AWS_ACCESS_KEY_ID: 'synthetic-inherited-key', AWS_SECRET_ACCESS_KEY: 'synthetic-inherited-secret', AWS_PROFILE: 'synthetic-profile', AWS_SHARED_CREDENTIALS_FILE: file, AWS_CONFIG_FILE: file,
      AWS_WEB_IDENTITY_TOKEN_FILE: file, AWS_CONTAINER_CREDENTIALS_FULL_URI: 'http://169.254.170.2/credentials', AWS_EC2_METADATA_DISABLED: 'false', AWS_ROLE_ARN: 'synthetic-role' };
    prepareTestEnvironment(env);
    assert.equal(env.AWS_SHARED_CREDENTIALS_FILE, devNull); assert.equal(env.AWS_CONFIG_FILE, devNull); assert.equal(env.AWS_WEB_IDENTITY_TOKEN_FILE, devNull);
    assert.equal(env.AWS_EC2_METADATA_DISABLED, 'true'); assert.equal(env.AWS_PROFILE, ''); assert.equal(env.AWS_CONTAINER_CREDENTIALS_FULL_URI, '');
    assert.notEqual(env.AWS_ACCESS_KEY_ID, 'synthetic-inherited-key'); assert.notEqual(env.AWS_SECRET_ACCESS_KEY, 'synthetic-inherited-secret');
    const sesUrl = new URL('../../node_modules/@aws-sdk/client-ses/dist-cjs/index.js', import.meta.url).href;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict'; const {SESClient}=await import(${JSON.stringify(sesUrl)});
      const client=new SESClient({region:'eu-west-2'});const credentials=await client.config.credentials();
      assert.equal(credentials.accessKeyId,'test-no-send-access-key');client.destroy();
      const https=await import('node:https');assert.throws(()=>https.get('https://email.eu-west-2.amazonaws.com/'),/External network disabled/);
      await assert.rejects(fetch('https://api-m.paypal.com/'),/External network disabled/);
    `], { env, encoding: 'utf8', timeout: 10000 });
    assert.equal(child.status, 0, child.stderr); assert.equal(readFileSync(file, 'utf8'), content);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
it('a test-mode dotenv reload cannot restore AWS credentials or profiles', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'email-isolation-dotenv-'));
  try {
    writeFileSync(join(cwd, '.env'), 'AWS_ACCESS_KEY_ID=synthetic-dotenv-key\nAWS_SECRET_ACCESS_KEY=synthetic-dotenv-secret\nAWS_PROFILE=synthetic-profile\n');
    const configUrl = new URL('../config/index.js', import.meta.url).href;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';await import(${JSON.stringify(configUrl)});
      assert.equal(process.env.AWS_ACCESS_KEY_ID,'test-no-send-access-key');assert.equal(process.env.AWS_PROFILE,'');
    `], { cwd, env: { PATH: process.env.PATH, HOME: cwd, NODE_ENV: 'test', DATABASE_URL: 'postgresql://unused@127.0.0.1:1/development', TEST_DATABASE_URL: 'postgresql://unused@127.0.0.1:1/colorful_life_test', JWT_SECRET: 'synthetic-jwt' }, encoding: 'utf8', timeout: 10000 });
    assert.equal(child.status, 0, child.stderr);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
for (const mode of ['development', 'production']) it(`${mode} delivery behavior remains enabled with a mocked SES SDK`, () => {
  const sesUrl = new URL('../../node_modules/@aws-sdk/client-ses/dist-cjs/index.js', import.meta.url).href;
  const serviceUrl = new URL('../services/emailService.js', import.meta.url).href;
  const deliveryUrl = new URL('../domain/orderConfirmation/delivery.js', import.meta.url).href;
  const fixtureUrl = new URL('./fixtures/orderConfirmation.fixture.js', import.meta.url).href;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';const {SESClient}=await import(${JSON.stringify(sesUrl)});
    let sends=0;SESClient.prototype.send=async()=>{sends++;return {MessageId:'synthetic-accepted'}};
    const {businessFixture}=await import(${JSON.stringify(fixtureUrl)});process.env.ORDER_CONFIRMATION_BUSINESS_JSON=JSON.stringify(businessFixture);
    const service=await import(${JSON.stringify(serviceUrl)});
    await service.sendPasswordResetEmail({recipientEmail:'synthetic@example.test',resetUrl:'https://example.test/reset'});
    await service.sendVerificationEmail({recipientEmail:'synthetic@example.test',verificationUrl:'https://example.test/verify'});
    await service.sendDispatchNotification({customerEmail:'synthetic@example.test',orderId:1,shippingCarrier:'Test',dispatchedAt:new Date()});
    const {sesConfirmationTransport}=await import(${JSON.stringify(deliveryUrl)});await sesConfirmationTransport.send(Buffer.from('synthetic MIME'));
    assert.equal(sends,4);assert.equal(process.env.AWS_ACCESS_KEY_ID,'synthetic-development-key');
  `], { env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_OPTIONS: process.env.NODE_OPTIONS, NODE_ENV: mode, DEPLOYMENT_ENVIRONMENT:"production", DATABASE_URL: 'postgresql://unused@127.0.0.1:1/never_connect', JWT_SECRET: '5b369df5a36ac4799dda7a836f56bd752ee916c946b33346ae622e15c9f8578bb', FRONTEND_URL:'https://shop.colorful-life.co.uk', CORS_ALLOWED_ORIGINS:'https://shop.colorful-life.co.uk', PAYMENT_RESOLUTION_ENABLED:'true', SES_FROM_EMAIL:'no-reply@colorful-life.co.uk', CLIENT_IP_MODE: 'direct', PAYMENT_ABUSE_HMAC_SECRET: 'synthetic-shared-abuse-secret-at-least-32', ORDER_CONFIRMATION_EMAIL_ENABLED: 'true', AWS_ACCESS_KEY_ID: 'synthetic-development-key', AWS_SECRET_ACCESS_KEY: 'synthetic-development-secret' }, encoding: 'utf8', timeout: 10000 });
  assert.equal(child.status, 0, child.stderr);
});
