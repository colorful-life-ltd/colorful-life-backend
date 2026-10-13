import assert from "node:assert/strict";
import { it } from "node:test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { validateTestDatabase } from "../config/testDatabase.js";

const target = validateTestDatabase(process.env);
const name = "20261014120000_password_recovery_security";
const root = "prisma/migrations";
const migration = readFileSync(`${root}/${name}/migration.sql`, "utf8");
async function isolatedSchema() {
  const client = new pg.Client({ connectionString: target.url });
  await client.connect();
  const schema = `recovery_${randomUUID().replaceAll("-", "")}`;
  await client.query(`CREATE SCHEMA "${schema}"`);
  await client.query(`SET search_path TO "${schema}"`);
  // Minimal pre-migration User fixture. No existing public-schema data is touched.
  await client.query('CREATE TABLE "User" (id INTEGER PRIMARY KEY, "emailVerified" BOOLEAN NOT NULL)');
  await client.query('INSERT INTO "User" (id, "emailVerified") VALUES (1, true)');
  return { client, async close() {
    await client.query("ROLLBACK");
    await client.query(`DROP SCHEMA "${schema}" CASCADE`);
    await client.end();
  } };
}
it("applies the recovery migration atomically with nullable compatibility and real PostgreSQL constraints", async () => {
  const test = await isolatedSchema();
  const c = test.client;
  try {
    await c.query(migration);
    assert.deepEqual((await c.query('SELECT * FROM "User"')).rows, [{ id: 1, emailVerified: true, credentialVersion: null }]);
    const indexes = await c.query("SELECT indexname FROM pg_indexes WHERE schemaname=current_schema() AND tablename='PasswordRecoveryLimit'");
    assert.deepEqual(indexes.rows.map(row => row.indexname).sort(), ["PasswordRecoveryLimit_pkey", "PasswordRecoveryLimit_windowStartedAt_idx"].sort());
    await c.query("BEGIN");
    await c.query("SAVEPOINT bad_count");
    await assert.rejects(c.query('INSERT INTO "PasswordRecoveryLimit" VALUES ($1, now(), 0)', ["a"]), (e: unknown) => (e as { code: string }).code === "23514");
    await c.query("ROLLBACK TO SAVEPOINT bad_count");
    await c.query('INSERT INTO "PasswordRecoveryLimit" VALUES ($1, now(), 1)', ["a"]);
    await c.query("SAVEPOINT duplicate");
    await assert.rejects(c.query('INSERT INTO "PasswordRecoveryLimit" VALUES ($1, now(), 1)', ["a"]), (e: unknown) => (e as { code: string }).code === "23505");
    await c.query("ROLLBACK TO SAVEPOINT duplicate");
    await c.query("ROLLBACK");
  } finally { await test.close(); }
});
it("rolls back the new column and limiter table together on a migration failure", async () => {
  const test = await isolatedSchema();
  try {
    const injected = migration.replace(/COMMIT;\s*$/, () => "DO $$ BEGIN RAISE EXCEPTION 'recovery migration failure fixture'; END $$; COMMIT;");
    await assert.rejects(test.client.query(injected), (e: unknown) =>
      (e as { code: string; message: string }).code === "P0001" &&
      (e as { message: string }).message === "recovery migration failure fixture");
    await test.client.query("ROLLBACK");
    assert.deepEqual((await test.client.query('SELECT * FROM "User"')).rows, [{ id: 1, emailVerified: true }]);
    assert.equal((await test.client.query(`SELECT count(*)::integer AS n FROM information_schema.tables WHERE table_schema=current_schema() AND table_name='PasswordRecoveryLimit'`)).rows[0].n, 0);
  } finally { await test.close(); }
});
