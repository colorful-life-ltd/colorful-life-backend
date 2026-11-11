import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const rehearsal=readFileSync('scripts/rehearse-database.py','utf8');
const runner=readFileSync('src/testing/runTests.ts','utf8');
test('disposable rehearsal proves the singleton then removes its index only from legacy app-test DB',()=>{
 assert.match(rehearsal,/dist\/__tests__\/adminBootstrap\.integration\.test\.js','dist\/__tests__\/operationalMetrics\.integration\.test\.js/);
 // Both singleton suites (HTTP/CLI first Admin and the private Production registration) run first, with the index.
 assert.match(runner,/const singletonFiles = \["adminBootstrap\.integration\.test\.js", "privateAdminBootstrap\.integration\.test\.js"\]/);
 assert.match(runner,/if \(hasBootstrap\) run\(\["--test", "--test-concurrency=1", \.\.\.singletonFiles\]\)/);
 assert.ok(runner.indexOf('...singletonFiles])')<runner.indexOf('DROP INDEX IF EXISTS'));
 assert.match(runner,/DROP INDEX IF EXISTS "User_single_admin_idx"/);
 assert.match(rehearsal,/TEST_DATABASE_URL=url/);
});
