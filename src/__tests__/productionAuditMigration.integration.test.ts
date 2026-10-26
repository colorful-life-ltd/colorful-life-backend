import assert from 'node:assert/strict';
import { it } from 'node:test';
import { Client } from 'pg';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { config } from '../config/index.js';
it('audit migration is transactional, preserves history and installs immutable audit guards', async () => {
    const client = new Client({ connectionString: config.DATABASE_URL });
    await client.connect();
    const schema = 'audit_' + randomUUID().replaceAll('-', '');
    const name = '20261025120000_production_audit';
    const sql = (id: string) => readFileSync(`prisma/migrations/${id}/migration.sql`, 'utf8');
    try {
        await client.query(`CREATE SCHEMA "${schema}"`);
        await client.query(`SET search_path TO "${schema}"`);
        for (const id of readdirSync('prisma/migrations').filter(v => v !== 'migration_lock.toml' && v < name).sort())
            await client.query(sql(id));
        const broken = sql(name).replace(/COMMIT;\s*$/, "DO $$ BEGIN RAISE EXCEPTION 'injected failure'; END $$; COMMIT;");
        await assert.rejects(client.query(broken));
        await client.query('ROLLBACK');
        assert.equal((await client.query(`SELECT to_regclass('"OperationalAudit"') AS name`)).rows[0].name, null);
        assert.equal((await client.query(`SELECT count(*)::int n FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='Refund' AND column_name='reviewRevision'`)).rows[0].n, 0);
        await client.query(sql(name));
        await client.query(`INSERT INTO "OperationalAudit" (kind,details) VALUES ('TEST','{}')`);
        await assert.rejects(client.query(`UPDATE "OperationalAudit" SET kind='tampered'`));
        await assert.rejects(client.query(`DELETE FROM "OperationalAudit"`));
        assert.equal((await client.query('SELECT count(*)::int n FROM "Refund"')).rows[0].n, 0);
    }
    finally {
        await client.query('ROLLBACK');
        await client.query(`DROP SCHEMA "${schema}" CASCADE`);
        await client.end();
    }
});
it('first-admin bootstrap serializes contenders, requires verification and revokes old sessions', async () => {
    const { PrismaPg } = await import('@prisma/adapter-pg');
    const { PrismaClient } = await import('../generated/prisma-client/client.js');
    const { bootstrapFirstAdmin } = await import('../domain/auth/adminBootstrap.js');
    const client = new Client({ connectionString: config.DATABASE_URL });
    await client.connect();
    const schema = 'bootstrap_' + randomUUID().replaceAll('-', '');
    let db: InstanceType<typeof PrismaClient> | undefined;
    try {
        await client.query(`CREATE SCHEMA "${schema}"`);
        await client.query(`SET search_path TO "${schema}"`);
        for (const id of readdirSync('prisma/migrations').filter(v => v !== 'migration_lock.toml').sort())
            await client.query(readFileSync(`prisma/migrations/${id}/migration.sql`, 'utf8'));
        db = new PrismaClient({ adapter: new PrismaPg({ connectionString: config.DATABASE_URL, options: `-c search_path=${schema}` }, { schema }) });
        const pending = await db.user.create({ data: { email: 'pending@example.test', passwordHash: 'synthetic' } });
        await assert.rejects(bootstrapFirstAdmin(pending.id, 'Approved first administrator', 'synthetic-operator', db));
        const a = await db.user.create({ data: { email: 'a@example.test', passwordHash: 'synthetic', emailVerified: true } });
        const b = await db.user.create({ data: { email: 'b@example.test', passwordHash: 'synthetic', emailVerified: true } });
        for (const user of [a, b])
            await db.refreshSession.create({ data: { userId: user.id, refreshTokenHash: randomUUID(), expiresAt: new Date(Date.now() + 3600000) } });
        const results = await Promise.allSettled([bootstrapFirstAdmin(a.id, 'Approved first administrator', 'synthetic-operator', db), bootstrapFirstAdmin(b.id, 'Approved first administrator', 'synthetic-operator', db)]);
        assert.equal(results.filter(v => v.status === 'fulfilled').length, 1);
        assert.equal(await db.user.count({ where: { role: 'ADMIN' } }), 1);
        const admin = await db.user.findFirstOrThrow({ where: { role: 'ADMIN' } });
        assert.ok(admin.credentialVersion);
        assert.equal(await db.refreshSession.count({ where: { userId: admin.id, revokedAt: null } }), 0);
        assert.equal(await db.operationalAudit.count({ where: { kind: 'FIRST_ADMIN_BOOTSTRAP' } }), 1);
        const { demoteAdmin } = await import('../domain/auth/adminBootstrap.js');
        // Temporary access ends with rotated credentials, revoked sessions and an immutable audit record.
        const promotedVersion = admin.credentialVersion;
        await db.refreshSession.create({ data: { userId: admin.id, refreshTokenHash: randomUUID(), expiresAt: new Date(Date.now() + 3600000) } });
        await assert.rejects(demoteAdmin(admin.id, 'short', 'synthetic-operator', db));
        await assert.rejects(demoteAdmin(admin.id, 'Sandbox refund testing complete', 'op', db));
        const demotions = await Promise.allSettled([demoteAdmin(admin.id, 'Sandbox refund testing complete', 'synthetic-operator', db), demoteAdmin(admin.id, 'Sandbox refund testing complete', 'synthetic-operator', db)]);
        assert.equal(demotions.filter(v => v.status === 'fulfilled').length, 1);
        const demoted = await db.user.findUniqueOrThrow({ where: { id: admin.id } });
        assert.equal(demoted.role, 'CUSTOMER');
        assert.ok(demoted.credentialVersion && demoted.credentialVersion !== promotedVersion);
        assert.equal(await db.refreshSession.count({ where: { userId: admin.id, revokedAt: null } }), 0);
        assert.equal(await db.operationalAudit.count({ where: { kind: 'ADMIN_DEMOTED', actorId: admin.id } }), 1);
        const other = results[0].status === 'fulfilled' ? b : a;
        await assert.rejects(demoteAdmin(other.id, 'Sandbox refund testing complete', 'synthetic-operator', db));
        await assert.rejects(db.$executeRaw`DELETE FROM "OperationalAudit" WHERE kind='ADMIN_DEMOTED'`);
        // With no active administrator left, a later approved bootstrap is possible again.
        await bootstrapFirstAdmin(admin.id, 'Approved first administrator', 'synthetic-operator', db);
        assert.equal((await db.user.findUniqueOrThrow({ where: { id: admin.id } })).role, 'ADMIN');
    }
    finally {
        await db?.$disconnect();
        await client.query('ROLLBACK');
        await client.query(`DROP SCHEMA "${schema}" CASCADE`);
        await client.end();
    }
});
