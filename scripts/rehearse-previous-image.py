#!/usr/bin/env python3
"""Rollback compatibility rehearsal: the ACTUAL previous release build and Prisma client against
this revision's migrated schema. Creates only an owned temporary PostgreSQL cluster and an owned
copy of the previous source; never accepts an existing database URL.

PREVIOUS is the release this revision must stay rollback-compatible with. Update it (with review)
when the deployed rollback baseline changes.
"""
import argparse, os, shutil, socket, subprocess, sys, tempfile, time
from pathlib import Path

PREVIOUS = '9bc87575c0bdf62957f47be94b0e1cc62e5414b2'  # main after #234: last release before PayPal removal
# Previous-image tests exercising Stripe payment webhooks, refund webhooks and Worker metrics/readiness.
FOCUSED = ['adminBootstrap.integration',  # runs first, as in a full run (single-Admin index fixture)
  'stripeWebhookSandbox.integration', 'stripeReconciliation', 'stripeReconciliationVisibility.integration',
  'stripePaymentHttp.integration', 'stripePaymentRecovery.integration',
  'stripeRefundWebhook', 'stripeRefundWebhookSandbox.integration', 'refundProviderSafety.integration',
  'refund.integration', 'refundReviewFulfilment.integration',
  'operationalMetrics.integration', 'workerHealth', 'productionAudit.integration']

parser = argparse.ArgumentParser()
parser.add_argument('--previous', default=PREVIOUS)
parser.add_argument('--full-previous-suite', action='store_true', help='run every previous-image test, not only the focused set')
parser.add_argument('--apply-contract', action='store_true', help='NEGATIVE CONTROL: also apply prisma/contract/remove_paypal.sql; the previous image is expected to FAIL')
args = parser.parse_args()
root = Path(__file__).resolve().parents[1]
pg = Path('/usr/lib/postgresql/16/bin')
if not (pg / 'initdb').is_file(): raise RuntimeError('PostgreSQL16 binaries required')
owned = Path(tempfile.mkdtemp(prefix='colorful-previous-image-'))
base_env = {k: v for k, v in os.environ.items() if not k.startswith(('DB_', 'DATABASE_', 'TEST_DATABASE_', 'PG', 'AWS_', 'STRIPE_', 'NODE_'))}

def run(command, cwd, env=None):
    print('RUN ' + ' '.join(command), flush=True)
    subprocess.run(command, cwd=cwd, env={**base_env, **(env or {})}, check=True)

started = False
try:
    # 1. Exact previous source and its own locked dependencies, built from scratch.
    if subprocess.run(['git', 'cat-file', '-e', args.previous + '^{commit}'], cwd=root).returncode:
        run(['git', 'fetch', '--no-tags', '--depth=1', 'origin', args.previous], root)
    previous = owned / 'previous'; previous.mkdir()
    archive = subprocess.run(['git', 'archive', args.previous], cwd=root, check=True, capture_output=True).stdout
    subprocess.run(['tar', '-x', '-C', str(previous)], input=archive, check=True)
    run(['npm', 'ci', '--no-audit', '--no-fund'], previous)
    run(['npm', 'run', 'generate:client'], previous, {'DATABASE_URL': 'postgresql://unused:unused@127.0.0.1/unused'})
    run(['npm', 'run', 'build'], previous)
    if not (root / 'dist/testing/runTests.js').is_file(): run(['npm', 'run', 'build'], root)

    # 2. Owned disposable cluster, migrated by THIS revision (the post-migration schema).
    with socket.socket() as s: s.bind(('127.0.0.1', 0)); port = s.getsockname()[1]
    run([str(pg / 'initdb'), '-D', str(owned / 'data'), '-U', 'rehearsal', '-A', 'trust', '--no-locale'], owned)
    run([str(pg / 'pg_ctl'), '-D', str(owned / 'data'), '-l', str(owned / 'postgres.log'), '-w', '-o', f'-h 127.0.0.1 -p {port} -k {owned}', 'start'], owned)
    started = True
    for name in ['colorful_life_test', 'unused_normal']:
        run([str(pg / 'createdb'), '-h', '127.0.0.1', '-p', str(port), '-U', 'rehearsal', name], owned)
    test_env = {'NODE_ENV': 'test', 'JWT_SECRET': 'synthetic-ci-only-not-production', 'STRIPE_SECRET_KEY': 'sk_test_synthetic',
                'DATABASE_URL': f'postgresql://rehearsal@127.0.0.1:{port}/unused_normal',
                'TEST_DATABASE_URL': f'postgresql://rehearsal@127.0.0.1:{port}/colorful_life_test'}
    run(['node', 'dist/testing/runTests.js', 'prepare'], root, test_env)
    if args.apply_contract:
        run([str(pg / 'psql'), '-h', '127.0.0.1', '-p', str(port), '-U', 'rehearsal', '-d', 'colorful_life_test', '-v', 'ON_ERROR_STOP=1', '-f', str(root / 'prisma/contract/remove_paypal.sql')], owned)

    # 3. The previous build's own runner and Prisma client against that schema. Its migrate
    #    deploy sees only already-applied migrations; nothing is rolled back or re-created.
    files = [] if args.full_previous_suite else [f'dist/__tests__/{name}.test.js' for name in FOCUSED]
    run(['node', 'dist/testing/runTests.js', 'run', *files], previous, test_env)
    print(f'PREVIOUS IMAGE {args.previous[:12]} ON THIS REVISION SCHEMA: PASS ({"full suite" if args.full_previous_suite else "focused Stripe/refund webhook and Worker metrics/readiness tests"})', flush=True)
finally:
    if started: subprocess.run([str(pg / 'pg_ctl'), '-D', str(owned / 'data'), '-m', 'fast', '-w', 'stop'], cwd=owned)
    shutil.rmtree(previous if 'previous' in dir() and isinstance(previous, Path) else owned / 'none', ignore_errors=True)
    print(f'Owned disposable cluster stopped; evidence: {owned}', flush=True)
