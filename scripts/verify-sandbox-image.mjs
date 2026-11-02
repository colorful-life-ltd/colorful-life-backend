#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const SOURCE = 'https://github.com/colorful-life-ltd/colorful-life-backend';
const MIGRATIONS = {
  'prisma/migrations/20261029150000_return_management_v1/migration.sql': '67caf46e7c10618a810543a193307a616aae59aa7725fa95c2463b6ced1b0d1d',
  'prisma/migrations/20261101120000_single_admin_bootstrap/migration.sql': '842c9ad5ced74c50a8a22c25350d4a2254d38abbe6b1536bddc2b0f58180b91b',
};

export function verifySandboxImage({ kind, ref, revision, run = execFileSync }) {
  if (!['api', 'migration'].includes(kind)) throw new Error(`unsupported image kind: ${kind}`);
  if (!/^.+@sha256:[0-9a-f]{64}$/.test(ref)) throw new Error('image reference must be pinned by sha256 digest');
  if (!/^[0-9a-f]{40}$/.test(revision)) throw new Error('revision must be a full commit SHA');

  const raw = run('docker', ['image', 'inspect', '--format', '{{json .Config.Labels}}', ref], { encoding: 'utf8' }).trim();
  let labels;
  try { labels = JSON.parse(raw); } catch { throw new Error(`${kind} image labels are missing or invalid`); }
  if (labels?.['org.opencontainers.image.revision'] !== revision) {
    throw new Error(`${kind} image OCI revision does not match ${revision}`);
  }
  if (labels?.['org.opencontainers.image.source'] !== SOURCE) {
    throw new Error(`${kind} image OCI source does not match ${SOURCE}`);
  }

  if (kind === 'migration') {
    for (const [path, expected] of Object.entries(MIGRATIONS)) {
      const checkedOut = createHash('sha256').update(readFileSync(path)).digest('hex');
      if (checkedOut !== expected) throw new Error(`checked-out migration checksum is not approved (${path})`);
    }
    const paths = Object.keys(MIGRATIONS).map(path => `/app/${path}`);
    const output = run('docker', [
      'run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges', '--entrypoint', 'sha256sum', ref, ...paths,
    ], { encoding: 'utf8' }).trim();
    const actual = new Map(output.split('\n').map(line => {
      const match = /^([0-9a-f]{64})\s+(.+)$/.exec(line.trim());
      if (!match) throw new Error('migration image SQL checksum output is invalid');
      return [match[2].replace(/^\/app\//, ''), match[1]];
    }));
    if (actual.size !== Object.keys(MIGRATIONS).length || Object.entries(MIGRATIONS).some(([path, hash]) => actual.get(path) !== hash)) {
      throw new Error('migration image SQL checksum mismatch');
    }
  }
  return true;
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  try {
    const [, , kind, ref, revision] = process.argv;
    verifySandboxImage({ kind, ref, revision });
    console.log(`${kind} image provenance verified for ${revision}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'image provenance verification failed');
    process.exitCode = 1;
  }
}
