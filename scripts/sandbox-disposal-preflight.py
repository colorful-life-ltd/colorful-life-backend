"""Read-only EC2 Sandbox inventory. Deliberately has no destruction/reset mode."""
import argparse
import json
import re
import subprocess
import sys
from datetime import datetime, timezone

CONTAINER = 'colorful-life-sandbox-postgres-1'
PROJECT = 'colorful-life-sandbox'
DATABASE = 'colorful_life'
# Required catalogue tables; their row counts are not an opening-inventory baseline.
CATALOGUE = ('Category', 'LegoProduct', 'ProductListing', 'ProductImage', 'UsedConditionPhoto')


def command(args):
    result = subprocess.run(args, capture_output=True, text=True, timeout=90, check=False)
    if result.returncode:
        # Neither command stderr nor connection/configuration secrets enter reports.
        raise ValueError('Read-only Docker/PostgreSQL inspection failed')
    return result.stdout


def validate_container(records, expected_id):
    if not re.fullmatch(r'[0-9a-f]{64}', expected_id):
        raise ValueError('Expected container ID must be a full immutable Docker ID')
    if not isinstance(records, list) or len(records) != 1:
        raise ValueError('Expected exactly one inspection record')
    obj = records[0]
    labels = obj.get('Config', {}).get('Labels', {}) or {}
    if (obj.get('Id') != expected_id or obj.get('Name') != '/' + CONTAINER
            or labels.get('com.docker.compose.project') != PROJECT
            or labels.get('com.docker.compose.service') != 'postgres'
            or not obj.get('State', {}).get('Running')
            or obj.get('State', {}).get('Health', {}).get('Status') != 'healthy'):
        raise ValueError('Sandbox container identity/health mismatch')
    return obj


def inventory_sql():
    # Explicit Unix socket inside the verified disposable Sandbox container;
    # no URL, host argument, AWS client, environment-based PGHOST or RDS access.
    # Count all application tables, including future transactional tables.
    return """
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout = '60s';
SET LOCAL lock_timeout = '2s';
SELECT json_build_object('database', current_database(),
  'systemIdentifier', (pg_control_system()).system_identifier::text,
  'readOnly', current_setting('transaction_read_only'));
SELECT json_build_object('table', tablename, 'rows',
  ((xpath('/row/n/text()', query_to_xml(format('SELECT count(*) AS n FROM public.%I', tablename), false, true, '')))[1])::text::bigint)
FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename;
SELECT json_build_object('migration', migration_name, 'checksum', checksum,
  'finished', finished_at IS NOT NULL, 'rolledBack', rolled_back_at IS NOT NULL)
FROM public._prisma_migrations ORDER BY migration_name, started_at;
ROLLBACK;
"""


def report(lines, expected_system_id, container_id):
    if not re.fullmatch(r'[0-9]{1,20}', expected_system_id):
        raise ValueError('Expected PostgreSQL system identifier is required')
    rows = [json.loads(line) for line in lines.splitlines() if line.strip()]
    if not rows or rows[0] != {'database': DATABASE, 'systemIdentifier': expected_system_id, 'readOnly': 'on'}:
        raise ValueError('Sandbox PostgreSQL identity/read-only assertion failed')
    tables = [row for row in rows[1:] if 'table' in row]
    migrations = [row for row in rows[1:] if 'migration' in row]
    if (not tables or not migrations or len(tables) + len(migrations) != len(rows) - 1
            or len({row['table'] for row in tables}) != len(tables)
            or any(type(row.get('rows')) is not int or row['rows'] < 0 for row in tables)
            or any(not row.get('finished') and not row.get('rolledBack') for row in migrations)
            or not set(CATALOGUE).issubset({row['table'] for row in tables})):
        raise ValueError('Incomplete table inventory or unfinished migration')
    return {
        'mode': 'DRY_RUN_ONLY', 'observedAt': datetime.now(timezone.utc).isoformat(),
        'target': {'container': CONTAINER, 'containerId': container_id, **rows[0]},
        'tables': tables, 'migrations': migrations,
        'decision': 'KEEP_SANDBOX_OPERATIONAL',
        'futureAction': 'Discard/recreate the entire verified Sandbox database after testing and separate owner approval',
        'productionAccess': 'NONE: Unix-socket inspection inside the verified Sandbox container only',
        'prerequisites': ['Return V1 and Stripe testing finished', 'Separate explicit owner destruction/recreation approval',
                          'Fresh verified Sandbox backup and recovery key custody',
                          'Approved catalogue-only snapshot supplied separately; never export Sandbox transactions to Production',
                          'Reviewed maintenance/recreation and acceptance plan bound to exact target identity'],
    }


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--expected-container-id', required=True)
    parser.add_argument('--expected-system-id', required=True)
    args = parser.parse_args(argv)
    validate_container(json.loads(command(['docker', 'inspect', '--type', 'container', CONTAINER])), args.expected_container_id)
    output = command(['docker', 'exec', args.expected_container_id, 'psql', '-X', '-qAt',
                      '-h', '/var/run/postgresql', '-U', 'cl_owner', '-d', DATABASE,
                      '-v', 'ON_ERROR_STOP=1', '-c', inventory_sql()])
    result = report(output, args.expected_system_id, args.expected_container_id)
    validate_container(json.loads(command(['docker', 'inspect', '--type', 'container', CONTAINER])), args.expected_container_id)
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    try:
        main()
    except (ValueError, KeyError, TypeError, subprocess.SubprocessError):
        print('FAIL: incomplete inspection or identity mismatch; no report accepted and no cleanup performed', file=sys.stderr)
        sys.exit(1)
