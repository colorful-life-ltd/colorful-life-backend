import { constants, openSync, readFileSync, fstatSync, closeSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import pg from 'pg';
import { createHash } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { databaseUrl, databasePoolOptions } from '../src/config/database.ts';
import { validateTargetMarker, validateMigrationHistory } from './migration-contract.mjs';

const migrationName = '20261101120000_single_admin_bootstrap';
const migrationSha256 = '842c9ad5ced74c50a8a22c25350d4a2254d38abbe6b1536bddc2b0f58180b91b';
const identityPath = process.env.SANDBOX_IDENTITIES_FILE ?? '/run/colorful/sandbox-identities.json';
const localRehearsal = process.env.LOCAL_DATABASE_REHEARSAL === 'true';
let phase = 'configuration';

function readIdentities() {
  const fd = openSync(identityPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || (info.mode & 0o077) !== 0) throw new Error('Unsafe identity file');
    const value = JSON.parse(readFileSync(fd, 'utf8'));
    if (Object.keys(value).sort().join(',') !== 'MIGRATOR_PASSWORD,OWNER_PASSWORD,RUNTIME_PASSWORD' ||
      new Set(Object.values(value)).size !== 3 ||
      Object.values(value).some(v => typeof v !== 'string' || !/^[A-Za-z0-9]{32,}$/.test(v))) {
      throw new Error('Invalid identities');
    }
    return value;
  } finally { closeSync(fd); }
}

function expectedChecksums() {
  const migrations = readdirSync('prisma/migrations', { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => [entry.name, createHash('sha256').update(readFileSync(`prisma/migrations/${entry.name}/migration.sql`)).digest('hex')])
    .sort(([a], [b]) => a.localeCompare(b));
  if (migrations.at(-1)?.[0] !== migrationName || migrations.at(-1)?.[1] !== migrationSha256) throw new Error('Unexpected migration bundle');
  return Object.fromEntries(migrations);
}

async function verifyDatabase(env, checksums, before) {
  const client = new pg.Client({ ...databasePoolOptions(databaseUrl(env), env), options: '-c timezone=UTC -c default_transaction_read_only=on -c statement_timeout=30000 -c lock_timeout=1000' });
  let check = 'connect';
  try {
    await client.connect();
    check = 'identity';
    await client.query('BEGIN READ ONLY');
    const identity = (await client.query('SELECT current_database() AS name, host(inet_server_addr()) AS server, inet_server_port() AS port')).rows[0];
    if (identity.name !== 'colorful_life' || identity.server !== process.env.EXPECTED_DB_SERVER || Number(identity.port) !== Number(env.DB_PORT)) throw new Error('Sandbox database identity mismatch');
    check = 'environment marker';
    const marker = (await client.query('SELECT name,database_host FROM cl_operations.environment')).rows;
    validateTargetMarker(marker, env);
    check = 'migration history';
    const applied = (await client.query('SELECT migration_name,checksum,finished_at,rolled_back_at FROM public._prisma_migrations')).rows;
    check = 'migration checksum validation';
    const summary = validateMigrationHistory(applied, new Map(Object.entries(checksums)), true);
    if (before) {
      if (summary.applied === 74 && summary.pending.length === 1 && summary.pending[0] === migrationName) {
        check = 'existing Admin count';
        const adminCount = Number((await client.query('SELECT count(*) AS count FROM public."User" WHERE role = \'ADMIN\'')).rows[0].count);
        if (adminCount > 1) throw new Error('Sandbox contains duplicate Admin rows before migration');
        await client.query('ROLLBACK');
        return 'pending';
      }
      if (summary.applied === 75 && summary.pending.length === 0) {
        check = 'already-applied constraint verification';
        const index = (await client.query("SELECT i.indisunique AS is_unique, i.indisvalid AS is_valid, pg_get_expr(i.indpred,i.indrelid) AS predicate FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid WHERE c.relname='User_single_admin_idx' AND i.indrelid='public.\"User\"'::regclass")).rows[0];
        if (!index?.is_unique || !index?.is_valid || !index.predicate?.includes("'ADMIN'")) throw new Error('Applied migration has no valid unique Admin index');
        await client.query('ROLLBACK');
        return 'applied';
      }
      throw new Error('Unexpected Sandbox migration history');
    } else {
      check = 'constraint verification';
      if (summary.applied !== 75 || summary.pending.length !== 0) throw new Error('Migration history did not reach the expected baseline');
      const index = (await client.query("SELECT i.indisunique AS is_unique, i.indisvalid AS is_valid, pg_get_expr(i.indpred,i.indrelid) AS predicate FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid WHERE c.relname='User_single_admin_idx' AND i.indrelid='public.\"User\"'::regclass")).rows[0];
      if (!index?.is_unique || !index?.is_valid || !index.predicate?.includes("'ADMIN'")) throw new Error('Single-Admin database constraint is missing');
    }
    check = 'transaction cleanup';
    await client.query('ROLLBACK');
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' && /^[A-Z0-9]{5}$/.test(error.code) ? error.code : 'SAFE_CHECK';
    console.error(`Read-only ${before ? 'preflight' : 'postflight'} check failed at ${check} (${code}).`);
    throw error;
  } finally { await client.end(); }
}

function run(script, env) {
  const result = spawnSync(process.execPath, [script], { env, stdio: 'inherit' });
  if (result.error || result.status !== 0) throw new Error('Sandbox migration step failed');
}

async function main() {
  if (process.env.DEPLOYMENT_ENVIRONMENT !== 'staging' || process.env.DB_NAME !== 'colorful_life' ||
    (!localRehearsal && process.env.DB_HOST !== 'postgres') || !process.env.EXPECTED_DB_SERVER) throw new Error('Sandbox-only migration configuration required');
  phase = 'identity-file validation';
  const identities = readIdentities();
  const common = { ...process.env, DB_USER: 'cl_migrator', DB_PASSWORD: identities.MIGRATOR_PASSWORD };
  phase = 'migration bundle checksum validation';
  const checksums = expectedChecksums();
  phase = 'read-only Sandbox preflight';
  const state = await verifyDatabase(common, checksums, true);
  if (state === 'pending') {
    phase = 'approved migration execution';
    run('scripts/deploy-database.mjs', { ...common, MIGRATION_WRITES_APPROVED: 'true' });
  } else console.log('Migration 75 already applied with the expected constraint; no migration write issued.');
  phase = 'post-migration verification';
  await verifyDatabase(common, checksums, false);
  phase = 'runtime privilege verification';
  run('scripts/runtime-privilege-probes.mjs', { ...process.env, DB_USER: 'cl_runtime', DB_PASSWORD: identities.RUNTIME_PASSWORD });
  console.log('Sandbox Migration 75 verified; runtime privilege probes passed.');
}

main().catch(() => {
  console.error(`Sandbox migration stopped during ${phase}; no target details or credentials logged. Verify migration state before any retry.`);
  process.exitCode = 1;
});
