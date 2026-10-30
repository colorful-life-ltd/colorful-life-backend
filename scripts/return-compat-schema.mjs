// Schema-74 facts required by the Return V1 compatibility rehearsal. Pure check plus a CLI;
// the CLI exits non-zero on any failure so CI evidence can never follow a failed assertion.
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

export const TARGET_MIGRATION = '20261029150000_return_management_v1';

/** Returns a list of problems; empty means the database is exactly the expected schema 74. */
export function schemaProblems(facts, expectedMigrations = 74) {
  const problems = [];
  if (facts.finishedMigrations !== expectedMigrations) problems.push(`expected ${expectedMigrations} finished migrations, found ${facts.finishedMigrations}`);
  if (facts.targetApplied !== true) problems.push(`${TARGET_MIGRATION} not finished`);
  if (facts.returnCaseTable !== true) problems.push('ReturnCase table missing');
  if (facts.returnSubmissionTable !== true) problems.push('ReturnSubmission table missing');
  if (facts.submissionIdColumn !== true) problems.push('OrderReturn.submissionId column missing');
  return problems;
}

async function readFacts(url, requireFrom) {
  const pg = createRequire(requireFrom)('pg');
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const one = async (sql, params = []) => (await client.query(sql, params)).rows[0];
    const m = await one('SELECT count(*)::int AS n, coalesce(bool_or(migration_name = $1), false) AS t FROM _prisma_migrations WHERE finished_at IS NOT NULL', [TARGET_MIGRATION]);
    const s = await one(`SELECT to_regclass('"ReturnCase"') IS NOT NULL AS c, to_regclass('"ReturnSubmission"') IS NOT NULL AS s,
      EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'OrderReturn' AND column_name = 'submissionId') AS col`);
    return { finishedMigrations: m.n, targetApplied: m.t, returnCaseTable: s.c, returnSubmissionTable: s.s, submissionIdColumn: s.col };
  } finally { await client.end(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const expected = Number(process.env.EXPECTED_MIGRATIONS ?? 74);
  const facts = await readFacts(process.env.TEST_DATABASE_URL, pathToFileURL(`${process.cwd()}/package.json`));
  const problems = schemaProblems(facts, expected);
  console.log(JSON.stringify({ ...facts, expectedMigrations: expected, problems }));
  if (problems.length) process.exit(1);
}
