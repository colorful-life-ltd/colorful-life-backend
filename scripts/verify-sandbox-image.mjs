#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const SOURCE = 'https://github.com/colorful-life-ltd/colorful-life-backend';
const MIGRATION = 'prisma/migrations/20261029150000_return_management_v1/migration.sql';
const IMAGE_MIGRATION = `/app/${MIGRATION}`;
const EXPECTED_MIGRATION_SHA256 = '67caf46e7c10618a810543a193307a616aae59aa7725fa95c2463b6ced1b0d1d';

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
    const expected = createHash('sha256').update(readFileSync(MIGRATION)).digest('hex');
    if (expected !== EXPECTED_MIGRATION_SHA256) throw new Error(`checked-out Migration 74 checksum is not approved (expected ${EXPECTED_MIGRATION_SHA256})`);
    const output = run('docker', [
      'run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges', '--entrypoint', 'sh', ref, '-c',
      `sha256sum ${IMAGE_MIGRATION}`,
    ], { encoding: 'utf8' }).trim();
    const actual = /^([0-9a-f]{64})\s+\S+$/.exec(output)?.[1];
    if (actual !== expected) throw new Error(`migration image SQL checksum mismatch (expected ${expected})`);
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
