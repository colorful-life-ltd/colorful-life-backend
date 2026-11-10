import assert from 'node:assert/strict';
import { it } from 'node:test';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { Readable } from 'node:stream';
import bcrypt from 'bcrypt';
import { Client } from 'pg';
import { config } from '../config/index.js';
import { bootstrapFirstAdmin, createFirstAdmin, FirstAdminCreateError } from '../domain/auth/adminBootstrap.js';
import { MAX_CREDENTIAL_INPUT_BYTES, runCreateFirstAdmin } from '../domain/auth/firstAdminCli.js';

// Each scenario runs in its own schema with every committed migration, so User_single_admin_idx is
// present regardless of how the shared legacy test database was prepared.
async function isolatedDatabase() {
    const { PrismaPg } = await import('@prisma/adapter-pg');
    const { PrismaClient } = await import('../generated/prisma-client/client.js');
    const client = new Client({ connectionString: config.DATABASE_URL });
    await client.connect();
    const schema = 'first_admin_' + randomUUID().replaceAll('-', '');
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET search_path TO "${schema}"`);
    for (const id of readdirSync('prisma/migrations').filter(v => v !== 'migration_lock.toml').sort())
        await client.query(readFileSync(`prisma/migrations/${id}/migration.sql`, 'utf8'));
    const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: config.DATABASE_URL, options: `-c search_path=${schema}` }, { schema }) });
    return {
        db,
        async close() {
            await db.$disconnect();
            await client.query('ROLLBACK');
            await client.query(`DROP SCHEMA "${schema}" CASCADE`);
            await client.end();
        },
    };
}

const PASSWORD = 'Synthetic-0wner-Pa55!' + randomUUID().slice(0, 8);
const REASON = 'Approved first Production administrator';
const OPERATOR = 'owner/launch-2026-11';

async function cli(db: Parameters<typeof runCreateFirstAdmin>[0]['db'], args: string[], stdin: string, isTTY = false) {
    const out: string[] = [];
    const err: string[] = [];
    const input = Object.assign(Readable.from([Buffer.from(stdin)]), { isTTY });
    const code = await runCreateFirstAdmin({ args, input, stdout: line => out.push(line), stderr: line => err.push(line), db });
    return { code, output: [...out, ...err].join('\n') };
}

const rejectsWith = (promise: Promise<unknown>, code: string) =>
    assert.rejects(promise, (error: unknown) => error instanceof FirstAdminCreateError && error.code === code && !String(error.message).includes(PASSWORD));

it('creates exactly one verified ADMIN with a cost-12 hash and a secret-free audit, then refuses any further creation or promotion', async () => {
    const { db, close } = await isolatedDatabase();
    try {
        const created = await cli(db, [REASON, OPERATOR], ` Owner@Example.TEST\r\n${PASSWORD}\r\n`);
        assert.equal(created.code, 0, created.output);
        assert.doesNotMatch(created.output, new RegExp(PASSWORD));
        const admin = await db.user.findFirstOrThrow({ where: { role: 'ADMIN' } });
        assert.match(created.output, new RegExp(`user ID ${admin.id}\\b`));
        assert.equal(admin.email, 'owner@example.test');
        assert.equal(admin.emailVerified, true);
        assert.ok(admin.credentialVersion);
        assert.equal(bcrypt.getRounds(admin.passwordHash), 12);
        assert.equal(await bcrypt.compare(PASSWORD, admin.passwordHash), true);
        assert.equal(await db.refreshSession.count(), 0);
        const audits = await db.operationalAudit.findMany({ where: { kind: 'FIRST_ADMIN_BOOTSTRAP' } });
        assert.equal(audits.length, 1);
        assert.equal(audits[0].actorId, admin.id);
        assert.deepEqual(audits[0].details, { source: 'one-off-cli-create', emailVerification: 'owner-attested', reason: REASON, operatorReference: OPERATOR });
        const auditText = JSON.stringify(audits[0].details);
        assert.ok(!auditText.includes(PASSWORD) && !auditText.includes(admin.passwordHash) && !auditText.includes('$2b$'));

        const again = await cli(db, [REASON, OPERATOR], `second@example.test\n${PASSWORD}\n`);
        assert.equal(again.code, 1);
        assert.match(again.output, /an administrator already exists/);
        const customer = await db.user.create({ data: { email: 'verified@example.test', passwordHash: 'synthetic', emailVerified: true } });
        await assert.rejects(bootstrapFirstAdmin(customer.id, REASON, OPERATOR, db));
        // A soft-deleted Admin still occupies the singleton index, so creation stays refused.
        await db.user.update({ where: { id: admin.id }, data: { deletedAt: new Date() } });
        await rejectsWith(createFirstAdmin({ email: 'third@example.test', password: PASSWORD, reason: REASON, operatorReference: OPERATOR }, db), 'ADMIN_EXISTS');
        assert.equal(await db.user.count({ where: { role: 'ADMIN' } }), 1);
        assert.equal(await db.operationalAudit.count({ where: { kind: 'FIRST_ADMIN_BOOTSTRAP' } }), 1);
    }
    finally { await close(); }
});

it('refuses registered emails, weak passwords, unsafe audit fields and malformed input without writing or echoing secrets', async () => {
    const { db, close } = await isolatedDatabase();
    try {
        await db.user.create({ data: { email: 'taken@example.test', passwordHash: 'synthetic' } });
        await rejectsWith(createFirstAdmin({ email: 'TAKEN@example.test', password: PASSWORD, reason: REASON, operatorReference: OPERATOR }, db), 'EMAIL_IN_USE');

        const weak = ['Sh0rt!', 'nouppercase-1', 'NOLOWERCASE-1', 'NoDigits-here', 'NoSpecial123', 'Aa1!' + 'x'.repeat(70)];
        for (const password of weak) {
            const result = await cli(db, [REASON, OPERATOR], `owner@example.test\n${password}\n`);
            assert.equal(result.code, 1);
            assert.match(result.output, /password policy/);
            assert.ok(!result.output.includes(password));
        }
        const badEmail = await cli(db, [REASON, OPERATOR], `not-an-email\n${PASSWORD}\n`);
        assert.equal(badEmail.code, 1);
        assert.ok(!badEmail.output.includes(PASSWORD));

        for (const [reason, operator] of [['too short', OPERATOR], ['Approved\u0007first administrator', OPERATOR], [REASON, 'own'], [REASON, 'owner ref'], [REASON, '-leading-dash'], ['x'.repeat(501), OPERATOR]])
            await rejectsWith(createFirstAdmin({ email: 'owner@example.test', password: PASSWORD, reason, operatorReference: operator }, db), 'INVALID_AUDIT');

        // The password must come only from piped stdin: argv, terminals and ambiguous input are refused.
        const argv = await cli(db, [REASON, OPERATOR, PASSWORD], `owner@example.test\n${PASSWORD}\n`);
        assert.equal(argv.code, 1);
        assert.match(argv.output, /usage/);
        assert.ok(!argv.output.includes(PASSWORD));
        for (const [stdin, tty] of [[`owner@example.test\n${PASSWORD}\n`, true], [`owner@example.test\n${PASSWORD}\nextra\n`, false], [`owner@example.test\n`, false], ['', false], [`owner@example.test\n${'A1!a'.repeat(MAX_CREDENTIAL_INPUT_BYTES)}\n`, false]] as const) {
            const result = await cli(db, [REASON, OPERATOR], stdin, tty);
            assert.equal(result.code, 1);
            assert.match(result.output, /exactly two lines/);
            assert.ok(!result.output.includes(PASSWORD));
        }
        assert.equal(await db.user.count({ where: { role: 'ADMIN' } }), 0);
        assert.equal(await db.user.count(), 1);
        assert.equal(await db.operationalAudit.count(), 0);
    }
    finally { await close(); }
});

// Holds one first-Admin advisory lock from a separate session, so contenders genuinely overlap.
async function holdLock(key: string) {
    const holder = new Client({ connectionString: config.DATABASE_URL });
    await holder.connect();
    await holder.query('BEGIN');
    await holder.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [key]);
    let open = true;
    // Idempotent, so a failed assertion still releases the lock in `finally` instead of hanging cleanup.
    return async () => { if (!open) return; open = false; await holder.query('COMMIT'); await holder.end(); };
}
function track<T>(promise: Promise<T>) {
    const state = { settled: false };
    const settled = promise.then(value => { state.settled = true; return value; }, error => { state.settled = true; throw error; });
    settled.catch(() => undefined); // Observed later via allSettled/rejects; avoid an early unhandled-rejection report.
    return { state, settled };
}
const BLOCKED_MS = 1500; // Longer than the cost-12 hashes, so only the lock can keep contenders waiting.

it('serializes concurrent creations and promotion on the shared locks so exactly one ADMIN and one audit row result', async () => {
    const { db, close } = await isolatedDatabase();
    let release = async () => {};
    try {
        const customer = await db.user.create({ data: { email: 'customer@example.test', passwordHash: 'synthetic', emailVerified: true } });
        const create = (email: string) => createFirstAdmin({ email, password: PASSWORD, reason: REASON, operatorReference: OPERATOR }, db);

        // The promotion mode's lock: every contender (both modes) waits on it.
        release = await holdLock('first-admin-bootstrap');
        const contenders = [create('a@example.test'), create('b@example.test'), create('c@example.test'), bootstrapFirstAdmin(customer.id, REASON, OPERATOR, db)].map(p => track<unknown>(p));
        await new Promise(resolve => setTimeout(resolve, BLOCKED_MS));
        assert.ok(contenders.every(c => !c.state.settled), 'contenders must wait for the promotion lock');
        await release();
        const results = await Promise.allSettled(contenders.map(c => c.settled));
        assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
        for (const r of results.slice(0, 3))
            if (r.status === 'rejected') assert.ok(r.reason instanceof FirstAdminCreateError && r.reason.code === 'ADMIN_EXISTS');
        assert.equal(await db.user.count({ where: { role: 'ADMIN' } }), 1);
        assert.equal(await db.operationalAudit.count({ where: { kind: 'FIRST_ADMIN_BOOTSTRAP' } }), 1);

        // The HTTP registration route's lock: creation also waits on it before reading Admin state.
        release = await holdLock('colorful-life-single-admin-bootstrap');
        const late = track(create('d@example.test'));
        await new Promise(resolve => setTimeout(resolve, BLOCKED_MS));
        assert.equal(late.state.settled, false, 'creation must wait for the HTTP bootstrap lock');
        await release();
        await rejectsWith(late.settled, 'ADMIN_EXISTS');
        assert.equal(await db.user.count({ where: { role: 'ADMIN' } }), 1);
    }
    finally { await release(); await close(); }
});

function runScript(args: string[], stdin: string) {
    return new Promise<{ code: number | null; output: string }>((resolve, reject) => {
        const child = spawn(process.execPath, ['dist/scripts/bootstrapAdmin.js', ...args], { env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
        let output = '';
        child.stdout.on('data', chunk => { output += chunk; });
        child.stderr.on('data', chunk => { output += chunk; });
        child.on('error', reject);
        child.on('close', code => resolve({ code, output }));
        child.stdin.end(stdin);
    });
}

it('the compiled bootstrapAdmin entry point dispatches --create and keeps promotion mode unchanged', async () => {
    // Every case is refused during validation, before any database write.
    const argv = await runScript(['--create', REASON, OPERATOR, PASSWORD], '');
    assert.equal(argv.code, 1);
    assert.match(argv.output, /usage is bootstrapAdmin --create/);
    assert.ok(!argv.output.includes(PASSWORD));
    const weak = await runScript(['--create', REASON, OPERATOR], 'owner@example.test\nSh0rt!\n');
    assert.equal(weak.code, 1);
    assert.match(weak.output, /password policy/);
    assert.ok(!weak.output.includes('Sh0rt!'));
    const promotion = await runScript([], '');
    assert.equal(promotion.code, 1);
    assert.match(promotion.output, /require verified user ID, audit reason, operator reference and no existing active ADMIN/);
});
