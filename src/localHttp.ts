/** Local PR #42 smoke launcher. Importing this module never starts the API or workers. */
import { randomBytes } from 'node:crypto';
import { createServer, type RequestListener } from 'node:http';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { config as loadDotenv } from 'dotenv';
import { Client } from 'pg';

const host = '127.0.0.1' as const;
// This deliberately pins the approved Windows development cluster, not any database with this name.
const clusterId = '7668309425915929176';
export const disabledLocalFlags = [
  'PAYMENT_STRIPE_INITIATION_ENABLED', 'PAYMENT_PAYPAL_INITIATION_ENABLED',
  'PAYMENT_RESOLUTION_ENABLED', 'REFUND_RECONCILIATION_ENABLED',
  'CARRIER_TRACKING_POLLING_ENABLED', 'ORDER_CONFIRMATION_EMAIL_ENABLED',
  'DISPATCH_CONFIRMATION_EMAIL_ENABLED', 'RETURN_AUTHORIZATION_EMAIL_ENABLED', 'PAYMENT_CHALLENGE_ENABLED',
] as const;
const refused = () => new Error('Local HTTP safety checks failed. No API launch is permitted.');

export function validateLocalDatabaseUrl(value: string | undefined): string {
  try {
    if (!value || !/^postgres(?:ql)?:\/\//.test(value) || /[\s\\#]/.test(value)) throw refused();
    const url = new URL(value);
    if (!['localhost', '127.0.0.1', '[::1]', '172.27.32.1'].includes(url.hostname) ||
      (url.port && url.port !== '5432') || url.pathname !== '/colorful_life') throw refused();
    const seen = new Set<string>();
    for (const [key, val] of url.searchParams) {
      if (seen.has(key) || !((key === 'schema' && val === 'public') ||
        (key === 'sslmode' && ['disable', 'require', 'verify-ca', 'verify-full'].includes(val)))) throw refused();
      seen.add(key);
    }
    return value;
  } catch { throw refused(); }
}

export function prepareLocalEnvironment(env: NodeJS.ProcessEnv): { databaseUrl: string; port: number } {
  if ((env.NODE_ENV && env.NODE_ENV !== 'development') || env.NODE_TEST_CONTEXT) throw refused();
  const databaseUrl = validateLocalDatabaseUrl(env.DATABASE_URL);
  const port = env.PORT === undefined ? 3000 : Number(env.PORT);
  if (!/^\d+$/.test(env.PORT ?? '3000') || !Number.isInteger(port) || port < 1024 || port > 65535) throw refused();
  env.NODE_ENV = 'development';
  env.PAYMENT_ABUSE_HMAC_SECRET = randomBytes(32).toString('hex');
  for (const flag of disabledLocalFlags) env[flag] = 'false';
  env.CLIENT_IP_MODE = 'direct';
  env.TRUSTED_PROXY_CIDRS = '';
  return { databaseUrl, port };
}

export interface LocalDatabaseIdentity {
  database: string; system_identifier: string; server_version: string; read_only: string;
}
export function assertLocalDatabaseIdentity(identity: LocalDatabaseIdentity | undefined): void {
  if (!identity || identity.database !== 'colorful_life' || identity.system_identifier !== clusterId ||
    !/^18\./.test(identity.server_version) || identity.read_only !== 'on') throw refused();
}

const reads: Array<[RegExp, readonly string[]]> = [
  [/^\/(health|profile)$/, []],
  [/^\/products$/, ['page', 'pageSize']],
  [/^\/admin\/product-listings$/, ['page', 'pageSize']],
  [/^\/admin\/products$/, ['q', 'page', 'pageSize']],
  [/^\/admin\/products\/product-availability$/, []],
  [/^\/admin\/categories$/, []],
  [/^\/admin\/categories\/[1-9]\d*\/product-availability$/, []],
  [/^\/products\/by-product\/[1-9]\d*\/images$/, []],
  [/^\/admin\/orders$/, ['page', 'pageSize']],
  [/^\/admin\/orders\/[1-9]\d*$/, []],
];

export function isAllowedLocalRequest(method: string | undefined, target: string | undefined): boolean {
  if (!target || target.length > 4096 || !target.startsWith('/') || /[\s\\#]/.test(target)) return false;
  const split = target.indexOf('?');
  const path = split < 0 ? target : target.slice(0, split);
  // Inspect the raw target: never normalize encoded separators, dot segments or absolute URLs into an allowlisted route.
  if (/[%;]/.test(path) || path.includes('//') || path.split('/').some(s => s === '.' || s === '..')) return false;
  if (method === 'POST') return split < 0 && /^\/auth\/(login|refresh|logout)$/.test(path);
  if (method !== 'GET') return false; // No implicit HEAD, OPTIONS, uploads, or method overrides.
  const rule = reads.find(([pattern]) => pattern.test(path));
  if (!rule) return false;
  const seen = new Set<string>();
  for (const [key] of new URLSearchParams(split < 0 ? '' : target.slice(split + 1))) {
    if (!rule[1].includes(key) || seen.has(key)) return false;
    seen.add(key);
  }
  return true;
}

export function guardLocalHandler(api: RequestListener, port: number): RequestListener {
  return (req, res) => {
    const remote = req.socket.remoteAddress;
    const authority = req.headers.host;
    const override = ['x-http-method-override', 'x-method-override', 'x-original-url', 'x-rewrite-url']
      .some(header => req.headers[header] !== undefined);
    if ((remote !== host && remote !== '::ffff:127.0.0.1') ||
      ![`${host}:${port}`, `localhost:${port}`].includes(authority ?? '') || override ||
      !isAllowedLocalRequest(req.method, req.url)) {
      res.statusCode = 403;
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-store');
      res.end(JSON.stringify({ error: { code: 'LOCAL_SMOKE_FORBIDDEN', message: 'This request is unavailable in local HTTP smoke mode.' } }));
      return; // Before Express, authentication, body parsing, storage, or any business handler.
    }
    api(req, res);
  };
}

interface LocalListener {
  close(callback: (error?: Error) => void): unknown;
  closeIdleConnections(): void;
  closeAllConnections(): void;
}
interface LocalApi { handler: RequestListener; disconnect(): Promise<void> }
export interface LocalHttpDependencies {
  env: NodeJS.ProcessEnv;
  loadEnvironment(): void;
  verifyDatabase(url: string): Promise<LocalDatabaseIdentity | undefined>;
  loadApi(url: string): Promise<LocalApi>;
  listen(handler: RequestListener, port: number, address: typeof host): Promise<LocalListener>;
  onSignal(signal: 'SIGINT' | 'SIGTERM', handler: () => void): () => void;
  log(message: string): void;
}

const defaults: LocalHttpDependencies = {
  env: process.env,
  loadEnvironment: () => { loadDotenv(); },
  async verifyDatabase(url) {
    const client = new Client({ connectionString: url, connectionTimeoutMillis: 5000,
      options: '-c default_transaction_read_only=on -c statement_timeout=5000',
      application_name: 'local_http_startup_read_only_guard' });
    try {
      await client.connect();
      return (await client.query<LocalDatabaseIdentity>(`SELECT current_database() AS database,
        (pg_control_system()).system_identifier::text AS system_identifier,
        current_setting('server_version') AS server_version,
        current_setting('transaction_read_only') AS read_only`)).rows[0];
    } finally { await client.end(); }
  },
  async loadApi(url) {
    // Import only after process-local settings and the actual cluster have been checked.
    const { config } = await import('./config/index.js');
    if (config.DATABASE_URL !== url || config.PAYMENT_ABUSE_HMAC_SECRET !== process.env.PAYMENT_ABUSE_HMAC_SECRET ||
      disabledLocalFlags.some(flag => config[flag] !== false) || config.TRUSTED_PROXY_CIDRS || config.CLIENT_IP_MODE !== 'direct') throw refused();
    const { default: app } = await import('./app.js');
    const { prisma } = await import('./prisma/runtime.js');
    return { handler: app, disconnect: () => prisma.$disconnect() };
  },
  listen(handler, port, address) {
    return new Promise((resolveReady, reject) => {
      const server = createServer(handler);
      server.requestTimeout = 15000;
      server.headersTimeout = 10000;
      server.once('error', reject);
      server.listen(port, address, () => {
        server.removeListener('error', reject);
        resolveReady(server);
      });
    });
  },
  onSignal(signal, handler) { process.on(signal, handler); return () => { process.removeListener(signal, handler); }; },
  log: message => { console.log(message); },
};

export async function startLocalHttp(overrides: Partial<LocalHttpDependencies> = {}) {
  const deps = { ...defaults, ...overrides };
  let api: LocalApi | undefined;
  let listener: LocalListener | undefined;
  const removeSignals: Array<() => void> = [];
  let stopping: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    if (stopping) return stopping;
    for (const remove of removeSignals.splice(0)) remove();
    stopping = (async () => {
      try {
        if (listener) await new Promise<void>((done, reject) => {
          const timer = setTimeout(() => {
            try { listener!.closeAllConnections(); } catch { /* Still report a sanitized shutdown failure. */ }
            reject(new Error('Local HTTP shutdown timed out.'));
          }, 5000);
          try {
            listener!.close(error => { clearTimeout(timer); error ? reject(new Error('Local HTTP listener shutdown failed.')) : done(); });
            listener!.closeIdleConnections();
          } catch { clearTimeout(timer); reject(new Error('Local HTTP listener shutdown failed.')); }
        });
      } finally {
        try { await api?.disconnect(); } catch { throw new Error('Local HTTP database shutdown failed.'); }
      }
    })();
    return stopping;
  };
  try {
    deps.loadEnvironment();
    const { databaseUrl, port } = prepareLocalEnvironment(deps.env);
    assertLocalDatabaseIdentity(await deps.verifyDatabase(databaseUrl));
    api = await deps.loadApi(databaseUrl);
    listener = await deps.listen(guardLocalHandler(api.handler, port), port, host);
    for (const signal of ['SIGINT', 'SIGTERM'] as const) removeSignals.push(deps.onSignal(signal, () => {
      void stop().catch(() => { process.exitCode = 1; deps.log('Local HTTP shutdown failed.'); });
    }));
    deps.log(`Local smoke API: http://${host}:${port}; authentication and allowlisted reads only; no workers.`);
    return { stop };
  } catch {
    try { await stop(); } catch { /* Never expose configuration, provider errors, or secrets. */ }
    throw refused();
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  void startLocalHttp().catch(() => { console.error('Local HTTP startup refused. Verify local database identity and safety configuration.'); process.exitCode = 1; });
}
