import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { verifySandboxImage } from './verify-sandbox-image.mjs';

const revision = 'e207f698fb1c68c22abd9af2bf34dcf612530a5b';
const ref = `919693204623.dkr.ecr.eu-west-2.amazonaws.com/repo@sha256:${'a'.repeat(64)}`;
const source = 'https://github.com/colorful-life-ltd/colorful-life-backend';
const sql = readFileSync('prisma/migrations/20261029150000_return_management_v1/migration.sql');
const sqlHash = createHash('sha256').update(sql).digest('hex');

function fakeDocker({ imageRevision = revision, imageSource = source, embeddedHash = sqlHash } = {}) {
  const calls = [];
  const run = (_command, args) => {
    calls.push(args);
    if (args[0] === 'image') return JSON.stringify({
      'org.opencontainers.image.revision': imageRevision,
      'org.opencontainers.image.source': imageSource,
    });
    return `${embeddedHash}  /app/prisma/migrations/20261029150000_return_management_v1/migration.sql\n`;
  };
  return { run, calls };
}

test('accepts exact API digest with matching source and OCI revision', () => {
  const docker = fakeDocker();
  assert.equal(verifySandboxImage({ kind: 'api', ref, revision, run: docker.run }), true);
  assert.equal(docker.calls.length, 1);
});

test('rejects reused image with mismatched OCI revision or source', () => {
  for (const metadata of [{ imageRevision: '0'.repeat(40) }, { imageSource: 'https://example.invalid/repo' }]) {
    const docker = fakeDocker(metadata);
    assert.throws(() => verifySandboxImage({ kind: 'api', ref, revision, run: docker.run }), /OCI (revision|source) does not match/);
  }
});

test('checks embedded Migration 74 checksum in a network-disabled read-only container', () => {
  const docker = fakeDocker();
  assert.equal(verifySandboxImage({ kind: 'migration', ref, revision, run: docker.run }), true);
  assert.deepEqual(docker.calls[1].slice(0, 11), [
    'run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges', '--entrypoint', 'sh',
  ]);
  assert.match(docker.calls[1].at(-1), /sha256sum \/app\/prisma\/migrations\/20261029150000_return_management_v1\/migration\.sql/);
});

test('rejects migration image with altered embedded SQL', () => {
  const docker = fakeDocker({ embeddedHash: '0'.repeat(64) });
  assert.throws(() => verifySandboxImage({ kind: 'migration', ref, revision, run: docker.run }), /migration image SQL checksum mismatch/);
});

test('rejects mutable image references and incomplete identity', () => {
  const docker = fakeDocker();
  assert.throws(() => verifySandboxImage({ kind: 'api', ref: 'repo:tag', revision, run: docker.run }), /pinned by sha256 digest/);
  assert.throws(() => verifySandboxImage({ kind: 'api', ref, revision: 'short', run: docker.run }), /full commit SHA/);
});
