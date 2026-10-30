import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schemaProblems } from './return-compat-schema.mjs';

const good = { finishedMigrations: 74, targetApplied: true, returnCaseTable: true, returnSubmissionTable: true, submissionIdColumn: true };

test('exact schema 74 passes', () => {
  assert.deepEqual(schemaProblems(good), []);
});

test('wrong migration count or unfinished target fails', () => {
  for (const facts of [{ ...good, finishedMigrations: 73 }, { ...good, finishedMigrations: 75 }, { ...good, targetApplied: false }])
    assert.notDeepEqual(schemaProblems(facts), []);
  assert.notDeepEqual(schemaProblems(good, 75), []);
});

test('any missing return schema object fails', () => {
  for (const key of ['returnCaseTable', 'returnSubmissionTable', 'submissionIdColumn'])
    assert.notDeepEqual(schemaProblems({ ...good, [key]: false }), [], key);
});
