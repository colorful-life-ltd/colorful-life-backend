// Preloaded only by the automated test runner, including its worker subprocesses.
import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
const allowed = (host: string) => ['localhost', '127.0.0.1', '::1', '[::1]'].includes(host);
const blocked = () => new Error('External network disabled in automated tests; inject a provider fake');
for (const module of [http, https]) for (const name of ['request', 'get']) {
  const handlers = module as unknown as Record<string, (...args: any[]) => any>;
  const original = handlers[name];
  handlers[name] = function (...args: any[]) {
    const value = args[0];
    const host = typeof value === 'string' || value instanceof URL ? new URL(value).hostname
      : value?.hostname ?? value?.host ?? 'localhost';
    if (!allowed(host)) throw blocked();
    return original.apply(this, args);
  };
}
syncBuiltinESMExports();
const originalFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (!allowed(url.hostname)) return Promise.reject(blocked());
  return originalFetch(input, init);
};
