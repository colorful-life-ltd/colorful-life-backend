import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';
import { describe, it } from 'node:test';
import {
  assertLocalDatabaseIdentity, disabledLocalFlags, guardLocalHandler, isAllowedLocalRequest,
  prepareLocalEnvironment, startLocalHttp, validateLocalDatabaseUrl, type LocalHttpDependencies,
} from '../localHttp.js';

const databaseUrl = 'postgresql://local:do-not-log@127.0.0.1:5432/colorful_life';
const identity = { database: 'colorful_life', system_identifier: '7668309425915929176', server_version: '18.4', read_only: 'on' };

describe('local database and process security', () => {
  for (const hostname of ['127.0.0.1', 'localhost', '[::1]', '172.27.32.1']) {
    it(`accepts approved local host ${hostname}`, () => {
      assert.equal(validateLocalDatabaseUrl(`postgresql://local:password@${hostname}:5432/colorful_life?schema=public`), `postgresql://local:password@${hostname}:5432/colorful_life?schema=public`);
    });
  }
  for (const value of [undefined, '', 'secret-invalid-url', 'postgresql://remote.example/colorful_life',
    'postgresql://127.0.0.1/colorful_life_migration_test', 'postgresql://127.0.0.1/colorful_life_test',
    'postgresql://127.0.0.1/production', 'postgresql://127.0.0.1:5433/colorful_life',
    'postgresql://127.0.0.1/colorful_life?host=production', 'postgresql://127.0.0.1/colorful_life?dbname=production',
    'postgresql://127.0.0.1/colorful_life?options=unsafe', 'postgresql://127.0.0.1/colorful_life?schema=private',
    'postgresql://127.0.0.1/colorful_life?schema=public&schema=public', 'postgresql://127.0.0.1/colorful_life#secret',
    'postgresql://127.0.0.1/colorful_life ', 'https://127.0.0.1/colorful_life',
    'postgresql://127.0.0.1.evil.test/colorful_life']) {
    it(`rejects unsafe database target ${value?.replace('secret', '[redacted]') ?? 'missing'}`, () => {
      assert.throws(() => validateLocalDatabaseUrl(value), error => error instanceof Error && error.message === 'Local HTTP safety checks failed. No API launch is permitted.');
    });
  }
  for (const wrong of [undefined, { ...identity, database: 'production' }, { ...identity, system_identifier: 'other' },
    { ...identity, server_version: '16.4' }, { ...identity, read_only: 'off' }]) {
    it(`rejects missing or wrong actual cluster identity ${JSON.stringify(wrong)}`, () => assert.throws(() => assertLocalDatabaseIdentity(wrong)));
  }
  it('accepts the actual approved cluster identity', () => assert.doesNotThrow(() => assertLocalDatabaseIdentity(identity)));
  it('creates a fresh process-only key and explicitly disables every activation flag', () => {
    const env = { DATABASE_URL: databaseUrl, PAYMENT_ABUSE_HMAC_SECRET: 'old-key', ...Object.fromEntries(disabledLocalFlags.map(flag => [flag, 'true'])) };
    const prepared = prepareLocalEnvironment(env);
    assert.deepEqual(prepared, { databaseUrl, port: 3000 });
    assert.ok(/^[0-9a-f]{64}$/.test(env.PAYMENT_ABUSE_HMAC_SECRET), 'Expected a 32-byte random hex key');
    const first = env.PAYMENT_ABUSE_HMAC_SECRET;
    prepareLocalEnvironment(env);
    assert.ok(env.PAYMENT_ABUSE_HMAC_SECRET !== first, 'Each launch needs a fresh key');
    assert.ok(disabledLocalFlags.every(flag => (env as NodeJS.ProcessEnv)[flag] === 'false'));
    assert.equal((env as NodeJS.ProcessEnv).CLIENT_IP_MODE, 'direct');
    assert.equal((env as NodeJS.ProcessEnv).TRUSTED_PROXY_CIDRS, '');
  });
  for (const extra of [{ NODE_ENV: 'production' }, { NODE_ENV: 'test' }, { NODE_ENV: 'staging' }, { NODE_TEST_CONTEXT: 'child-v8' },
    { PORT: '0' }, { PORT: '80' }, { PORT: '65536' }, { PORT: '3e3' }, { PORT: '' }]) {
    it(`fails closed for unsafe launch environment ${JSON.stringify(extra)}`, () => {
      assert.throws(() => prepareLocalEnvironment({ DATABASE_URL: databaseUrl, ...extra }));
    });
  }
});

const allowed: Array<[string, string]> = [
  ['POST', '/auth/login'], ['POST', '/auth/refresh'], ['POST', '/auth/logout'],
  ['GET', '/health'], ['GET', '/profile'], ['GET', '/products?page=1&pageSize=100'],
  ['GET', '/admin/product-listings?page=1&pageSize=50'], ['GET', '/admin/products?q=LEGO%20set&page=1&pageSize=20'],
  ['GET', '/admin/products/product-availability'], ['GET', '/admin/categories'],
  ['GET', '/admin/categories/11/product-availability'], ['GET', '/products/by-product/41/images'],
  ['GET', '/admin/orders?page=1&pageSize=20'], ['GET', '/admin/orders/41'],
];
const blocked: Array<[string, string]> = [
  ['POST', '/auth/signup'], ['POST', '/auth/resend-verification'], ['POST', '/auth/forgot-password'],
  ['POST', '/auth/reset-password'], ['POST', '/auth/verify-email'], ['PATCH', '/users/me'],
  ['POST', '/orders/41/fulfilment/dispatch'], ['POST', '/admin/orders/41/fulfilment/dispatch'],
  ['POST', '/admin/orders/41/fulfilment/preparing'], ['POST', '/orders/41/seller-cancel'],
  ['POST', '/orders/41/payments/stripe'], ['POST', '/orders/41/payments/paypal'],
  ['POST', '/payments/stripe/webhook'], ['POST', '/payments/paypal/webhook'], ['POST', '/orders/41/refunds'],
  ['POST', '/admin/payment-security/orders/41/review'], ['POST', '/products/41/inventory-adjustments'],
  ['POST', '/products'], ['POST', '/products/by-product/41/images'], ['PUT', '/products/by-product/41/catalogue-artwork'],
  ['DELETE', '/products/by-product/41/images/2'], ['PATCH', '/admin/products/41'], ['POST', '/purchases/manual'],
  ['GET', '/cart'], ['GET', '/orders/41/payments/paypal'], ['GET', '/purchases'],
  ['HEAD', '/admin/orders'], ['OPTIONS', '/auth/login'], ['GET', '//admin/orders'], ['GET', 'http://127.0.0.1:3000/admin/orders'],
  ['GET', '/admin/orders/../payment-security'], ['GET', '/admin/%6frders'], ['GET', '/admin/orders%2f41'],
  ['GET', '/admin/orders\\41'], ['GET', '/admin/orders;dispatch'], ['GET', '/admin/orders/41/'],
  ['GET', '/admin/orders#x'], ['GET', '/admin/orders?page=1&page=2'], ['GET', '/admin/orders?redirect=evil'],
  ['GET', '/admin/orders/41?anything=x'], ['POST', '/auth/login?next=x'], ['GET', '/admin/orders\n'],
  ['GET', '/admin/orders/0'], ['GET', '/admin/orders/-1'], ['get', '/admin/orders'], ['GET', '/health?' + 'x'.repeat(4096)],
];

function request(method: string, url: string, remoteAddress = '127.0.0.1', headers: Record<string, string | undefined> = {}) {
  return { method, url, socket: { remoteAddress }, headers: { host: '127.0.0.1:3000', ...headers } } as IncomingMessage;
}
function response() {
  const res = { statusCode: 200, body: '', headers: {} as Record<string, string>,
    setHeader(name: string, value: string) { this.headers[name] = value; }, end(body: string) { this.body = body; } };
  return res;
}
describe('deny-by-default gateway, before the real app', () => {
  for (const [method, url] of allowed) it(`allows required ${method} ${url}`, () => {
    let reached = 0;
    const handler = guardLocalHandler(() => { reached++; }, 3000);
    handler(request(method, url), response() as unknown as ServerResponse);
    assert.equal(reached, 1);
  });
  for (const [method, url] of blocked) it(`blocks ${method} ${url.replaceAll('\n', '[newline]')} before any app/body/auth handler`, () => {
    let reached = 0;
    const handler = guardLocalHandler(() => { reached++; throw new Error('Unsafe handler reached'); }, 3000);
    const res = response();
    handler(request(method, url), res as unknown as ServerResponse);
    assert.equal(reached, 0);
    assert.equal(res.statusCode, 403);
    assert.equal(JSON.parse(res.body).error.code, 'LOCAL_SMOKE_FORBIDDEN');
    assert.equal(res.headers['Cache-Control'], 'no-store');
  });
  for (const headers of [{ host: 'evil.example:3000' }, { host: '127.0.0.1:4000' }, { 'x-http-method-override': 'POST' },
    { 'x-method-override': 'DELETE' }, { 'x-original-url': '/payments' }, { 'x-rewrite-url': '/payments' }]) {
    it(`rejects rebinding/override headers ${JSON.stringify(headers)}`, () => {
      const handler = guardLocalHandler(() => assert.fail('Handler must not run'), 3000);
      const res = response(); handler(request('GET', '/health', '127.0.0.1', headers), res as unknown as ServerResponse);
      assert.equal(res.statusCode, 403);
    });
  }
  it('ignores spoofed forwarded headers when the actual peer is not loopback', () => {
    const res = response(); guardLocalHandler(() => assert.fail('Handler must not run'), 3000)(request('GET', '/health', '192.0.2.1', { 'x-forwarded-for': '127.0.0.1' }), res as unknown as ServerResponse);
    assert.equal(res.statusCode, 403);
  });
  it('rejects missing methods/targets and allows only mapped loopback when applicable', () => {
    assert.equal(isAllowedLocalRequest(undefined, '/health'), false);
    assert.equal(isAllowedLocalRequest('GET', undefined), false);
    let calls = 0; guardLocalHandler(() => { calls++; }, 3000)(request('GET', '/health', '::ffff:127.0.0.1'), response() as unknown as ServerResponse);
    assert.equal(calls, 1);
  });
});

function fixture() {
  const events: string[] = [], logs: string[] = [], signals = new EventEmitter();
  let closeCalls = 0, disconnectCalls = 0;
  let receivedHandler: RequestListener | undefined;
  const deps: LocalHttpDependencies = {
    env: { DATABASE_URL: databaseUrl }, loadEnvironment: () => { events.push('environment'); },
    verifyDatabase: async () => { events.push('verify'); return identity; },
    loadApi: async () => { events.push('app'); return { handler: () => { events.push('request'); }, disconnect: async () => { disconnectCalls++; events.push('disconnect'); } }; },
    listen: async (handler, port, address) => {
      events.push('listen'); assert.equal(address, '127.0.0.1'); assert.equal(port, 3000); receivedHandler = handler;
      return { close: done => { closeCalls++; events.push('close'); queueMicrotask(done); }, closeIdleConnections: () => { events.push('idle'); }, closeAllConnections: () => { events.push('force'); } };
    },
    onSignal: (signal, handler) => { signals.on(signal, handler); return () => { signals.removeListener(signal, handler); }; },
    log: message => { logs.push(message); },
  };
  return { deps, events, logs, signals, get closeCalls() { return closeCalls; }, get disconnectCalls() { return disconnectCalls; }, get handler() { return receivedHandler!; } };
}
describe('startup ordering, secrets and shutdown without a real listener/database', () => {
  it('verifies target before loading the app or listening and logs no secret/URL', async () => {
    const f = fixture(); const running = await startLocalHttp(f.deps);
    assert.deepEqual(f.events, ['environment', 'verify', 'app', 'listen']);
    assert.ok(!f.logs.join('\n').includes(f.deps.env.PAYMENT_ABUSE_HMAC_SECRET!));
    assert.ok(!f.logs.join('\n').includes('do-not-log'));
    f.handler(request('POST', '/admin/orders/41/fulfilment/dispatch'), response() as unknown as ServerResponse);
    assert.ok(!f.events.includes('request'));
    await Promise.all([running.stop(), running.stop()]);
    assert.equal(f.closeCalls, 1); assert.equal(f.disconnectCalls, 1);
    assert.ok(f.events.indexOf('close') < f.events.indexOf('disconnect'));
    assert.equal(f.signals.listenerCount('SIGINT') + f.signals.listenerCount('SIGTERM'), 0);
  });
  for (const failure of ['environment', 'url', 'verify', 'identity', 'app', 'listen']) it(`fails closed on ${failure} without leaking errors`, async () => {
    const f = fixture();
    const fail = () => { throw new Error('do-not-log configuration or secret'); };
    if (failure === 'environment') f.deps.loadEnvironment = fail;
    if (failure === 'url') f.deps.env.DATABASE_URL = 'postgres://production/colorful_life';
    if (failure === 'verify') f.deps.verifyDatabase = fail;
    if (failure === 'identity') f.deps.verifyDatabase = async () => ({ ...identity, system_identifier: 'other' });
    if (failure === 'app') f.deps.loadApi = fail;
    if (failure === 'listen') f.deps.listen = fail;
    await assert.rejects(startLocalHttp(f.deps), error => error instanceof Error && error.message === 'Local HTTP safety checks failed. No API launch is permitted.');
    assert.equal(f.signals.listenerCount('SIGINT') + f.signals.listenerCount('SIGTERM'), 0);
    if (['environment', 'url', 'verify', 'identity'].includes(failure)) assert.ok(!f.events.includes('app'));
    if (failure === 'listen') assert.equal(f.disconnectCalls, 1);
    assert.equal(f.logs.length, 0);
  });
  for (const signal of ['SIGINT', 'SIGTERM']) it(`closes listener, idle connections and Prisma on ${signal}`, async () => {
    const f = fixture(); const running = await startLocalHttp(f.deps); f.signals.emit(signal);
    await running.stop(); assert.equal(f.closeCalls, 1); assert.equal(f.disconnectCalls, 1); assert.ok(f.events.includes('idle'));
  });
  it('disconnects Prisma even if listener shutdown fails, without exposing the underlying error', async () => {
    const f = fixture(); f.deps.listen = async () => ({ close: done => { queueMicrotask(() => done(new Error('do-not-log'))); }, closeIdleConnections() {}, closeAllConnections() {} });
    const running = await startLocalHttp(f.deps);
    await assert.rejects(running.stop(), /Local HTTP listener shutdown failed/); assert.equal(f.disconnectCalls, 1);
  });
  it('bounds shutdown and disconnects Prisma if connections do not drain', async t => {
    const f = fixture(); let forced = 0;
    f.deps.listen = async () => ({ close() {}, closeIdleConnections() {}, closeAllConnections() { forced++; } });
    t.mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const running = await startLocalHttp(f.deps);
      const stopped = running.stop();
      const rejected = assert.rejects(stopped, /shutdown timed out/);
      t.mock.timers.tick(5000);
      await rejected; assert.equal(forced, 1); assert.equal(f.disconnectCalls, 1);
    } finally { t.mock.timers.reset(); }
  });
  it('sanitizes synchronous listener errors and still disconnects', async () => {
    const f = fixture(); f.deps.listen = async () => ({ close() { throw new Error('do-not-log'); }, closeIdleConnections() {}, closeAllConnections() {} });
    const running = await startLocalHttp(f.deps);
    await assert.rejects(running.stop(), error => error instanceof Error && error.message === 'Local HTTP listener shutdown failed.');
    assert.equal(f.disconnectCalls, 1);
  });
  it('sanitizes Prisma disconnect errors as well as listener errors', async () => {
    const f = fixture(); f.deps.loadApi = async () => ({ handler() {}, disconnect: async () => { throw new Error('do-not-log'); } });
    const running = await startLocalHttp(f.deps);
    await assert.rejects(running.stop(), error => error instanceof Error && error.message === 'Local HTTP database shutdown failed.');
  });
  it('importing the real app cannot start workers, listen, or make outbound connections', () => {
    const code = `
      import 'dotenv/config'; import {randomBytes} from 'node:crypto'; import net from 'node:net';
      process.env.NODE_ENV='development'; delete process.env.NODE_TEST_CONTEXT;
      process.env.PAYMENT_ABUSE_HMAC_SECRET=randomBytes(32).toString('hex');
      process.env.CLIENT_IP_MODE='direct'; process.env.TRUSTED_PROXY_CIDRS='';
      for(const flag of ${JSON.stringify([...disabledLocalFlags])}) process.env[flag]='false';
      const refuse=()=>{throw Error('Unexpected worker, listener or outbound connection')};
      globalThis.setInterval=refuse; globalThis.fetch=refuse; net.Socket.prototype.connect=refuse; net.Server.prototype.listen=refuse;
      const {default:app}=await import(${JSON.stringify(new URL('../app.js', import.meta.url).href)});
      if(typeof app!=='function')throw Error('App not assembled');
      const {prisma}=await import(${JSON.stringify(new URL('../prisma/runtime.js', import.meta.url).href)}); await prisma.$disconnect();
      console.log('worker-free-import');`;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, DATABASE_URL: databaseUrl }, encoding: 'utf8', timeout: 10000 });
    assert.equal(child.status, 0, 'Guarded app import must succeed without side effects');
    assert.match(child.stdout, /worker-free-import/);
    assert.ok(!child.stdout.includes('do-not-log') && !child.stderr.includes('do-not-log'));
  });
  it('CLI rejects production before database access and emits only a sanitized failure', () => {
    const child = spawnSync(process.execPath, [new URL('../localHttp.js', import.meta.url).pathname], { env: { ...process.env, NODE_ENV: 'production', DATABASE_URL: databaseUrl }, encoding: 'utf8', timeout: 10000 });
    assert.equal(child.status, 1); assert.match(child.stderr, /Local HTTP startup refused/);
    assert.ok(!child.stderr.includes('do-not-log'));
  });
  it('has no dependency on the worker-starting entry point and no file-writing API', () => {
    const source = readFileSync('src/localHttp.ts', 'utf8');
    assert.ok(!/import\(['"]\.\/index\.js/.test(source));
    assert.ok(!/start\w+Worker\(/.test(source));
    assert.ok(!/writeFile|appendFile|setInterval/.test(source));
  });
});
