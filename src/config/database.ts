import { readFileSync } from 'node:fs';
/** Pure environment assembly: values must never be included in diagnostics. */
export function databaseUrl(env: NodeJS.ProcessEnv): string | undefined {
  const fields = ['DB_HOST','DB_NAME','DB_USER','DB_PASSWORD'] as const;
  if (!fields.some(k => env[k] !== undefined)) return env.DATABASE_URL;
  if (env.DATABASE_URL || fields.some(k => !env[k])) throw new Error('Use exactly one complete database configuration');
  const host=env.DB_HOST!;
  if (!/^[a-zA-Z0-9.-]+$/.test(host)) throw new Error('Invalid DB_HOST');
  const url=new URL('postgresql://'+host);
  url.username=env.DB_USER!;url.password=env.DB_PASSWORD!;url.pathname='/'+env.DB_NAME!;
  const port=env.DB_PORT??'5432';if(!/^\d+$/.test(port)||Number(port)<1||Number(port)>65535)throw new Error('Invalid DB_PORT');
  url.port=port;return url.href;
}
export function databasePoolOptions(url: string, env: NodeJS.ProcessEnv) {
  const base={connectionString:url,options:'-c timezone=UTC',max:10,connectionTimeoutMillis:5000,idleTimeoutMillis:30000};
  if(env.NODE_ENV!=='production')return base;
  const parsed=new URL(url);
  if(!['postgres:','postgresql:'].includes(parsed.protocol) || !env.RDS_CA_FILE || !parsed.hostname || parsed.hostname==='localhost')throw new Error('Verified RDS TLS configuration required');
  for(const name of parsed.searchParams.keys())if(/^ssl/i.test(name))throw new Error('Database URL TLS overrides are forbidden');
  return {...base,ssl:{ca:readFileSync(env.RDS_CA_FILE,'utf8'),rejectUnauthorized:true,servername:parsed.hostname}};
}
/** Prisma 7 schema engine requires sslmode=require + sslaccept=strict + sslcert. */
export function migrationDatabaseUrl(env: NodeJS.ProcessEnv) {
  const raw=databaseUrl(env);if(!raw)throw new Error('Migration database configuration required');
  databasePoolOptions(raw,env);
  const url=new URL(raw);
  if(env.NODE_ENV==='production'){url.searchParams.set('sslmode','require');url.searchParams.set('sslaccept','strict');url.searchParams.set('sslcert',env.RDS_CA_FILE!);url.searchParams.set('options','-c lock_timeout=5000 -c statement_timeout=300000 -c timezone=UTC');}
  return url.href;
}
