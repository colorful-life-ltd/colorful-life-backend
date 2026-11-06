import contextlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('preflight', Path(__file__).with_name('sandbox-disposal-preflight.py'))
preflight = importlib.util.module_from_spec(spec)
spec.loader.exec_module(preflight)
CID = 'a' * 64
SID = '1234567890'


def inspection():
    return [{'Id': CID, 'Name': '/' + preflight.CONTAINER,
             'Config': {'Labels': {'com.docker.compose.project': preflight.PROJECT, 'com.docker.compose.service': 'postgres'}},
             'State': {'Running': True, 'Health': {'Status': 'healthy'}}}]


def output(extra=()):
    return '\n'.join(json.dumps(x) for x in [
        {'database': preflight.DATABASE, 'systemIdentifier': SID, 'readOnly': 'on'},
        *[{'table': t, 'rows': 10} for t in preflight.CATALOGUE],
        {'table': 'User', 'rows': 8}, {'table': 'Order', 'rows': 12},
        {'migration': '74', 'checksum': 'b' * 64, 'finished': True, 'rolledBack': False}, *extra])


class PreflightTests(unittest.TestCase):
    def test_current_test_rows_are_reported_without_claiming_clean(self):
        report = preflight.report(output(), SID, CID)
        self.assertEqual(report['decision'], 'KEEP_SANDBOX_OPERATIONAL')
        self.assertEqual(report['mode'], 'DRY_RUN_ONLY')
        self.assertIn({'table': 'Order', 'rows': 12}, report['tables'])

    def test_exact_healthy_sandbox_identity_required(self):
        for change in ('id', 'name', 'project', 'service', 'running', 'health'):
            with self.subTest(change=change):
                obj = inspection()
                if change == 'id': obj[0]['Id'] = 'b' * 64
                if change == 'name': obj[0]['Name'] = '/production-postgres'
                if change == 'project': obj[0]['Config']['Labels']['com.docker.compose.project'] = 'other'
                if change == 'service': obj[0]['Config']['Labels']['com.docker.compose.service'] = 'api'
                if change == 'running': obj[0]['State']['Running'] = False
                if change == 'health': del obj[0]['State']['Health']
                with self.assertRaises(ValueError): preflight.validate_container(obj, CID)

    def test_empty_duplicate_or_short_identity_rejected(self):
        for records, cid in (([], CID), (inspection() * 2, CID), (inspection(), CID[:12])):
            with self.assertRaises(ValueError): preflight.validate_container(records, cid)

    def test_database_identity_and_read_only_are_mandatory(self):
        for old, new in ((SID, '999'), (preflight.DATABASE, 'production'), ('"on"', '"off"')):
            with self.assertRaises(ValueError): preflight.report(output().replace(old, new), SID, CID)

    def test_incomplete_or_malformed_inventory_rejected(self):
        for data in ('', '{', '\n'.join(output().splitlines()[:-1]), output().replace('"rows": 10', '"rows": -1'),
                     output().replace('"finished": true', '"finished": false'), output().replace('"Category"', '"MissingCatalogue"'),
                     output(({'table': 'User', 'rows': 0},)), output(({'unexpected': 'partial'},))):
            with self.subTest(data=data[:20]), self.assertRaises((ValueError, KeyError)):
                preflight.report(data, SID, CID)

    def test_only_inspection_and_socket_read_only_queries_execute(self):
        commands = []
        def run(args):
            commands.append(args)
            return json.dumps(inspection()) if args[1] == 'inspect' else output()
        stream = io.StringIO()
        with patch.object(preflight, 'command', side_effect=run), contextlib.redirect_stdout(stream):
            preflight.main(['--expected-container-id', CID, '--expected-system-id', SID])
        self.assertEqual([c[1] for c in commands], ['inspect', 'exec', 'inspect'])
        sql = commands[1][-1]
        self.assertIn('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;', sql)
        self.assertTrue(sql.strip().endswith('ROLLBACK;'))
        self.assertEqual(commands[1][2:4], [CID, 'psql'])
        self.assertEqual(commands[1][commands[1].index('-h') + 1], '/var/run/postgresql')
        self.assertNotIn('CREATE ', sql)
        self.assertNotIn('DELETE ', sql)
        self.assertEqual(json.loads(stream.getvalue())['decision'], 'KEEP_SANDBOX_OPERATIONAL')

    def test_initial_query_or_final_inspection_failure_publishes_nothing(self):
        for fail_at in range(3):
            calls = []
            def run(args):
                calls.append(args)
                if len(calls) - 1 == fail_at: raise ValueError('inspection failed')
                return json.dumps(inspection()) if args[1] == 'inspect' else output()
            stream = io.StringIO()
            with patch.object(preflight, 'command', side_effect=run), contextlib.redirect_stdout(stream):
                with self.assertRaises(ValueError): preflight.main(['--expected-container-id', CID, '--expected-system-id', SID])
            self.assertEqual(stream.getvalue(), '')

    def test_changed_final_identity_publishes_nothing(self):
        changed = inspection(); changed[0]['Id'] = 'b' * 64
        stream = io.StringIO()
        with patch.object(preflight, 'command', side_effect=[json.dumps(inspection()), output(), json.dumps(changed)]), contextlib.redirect_stdout(stream):
            with self.assertRaises(ValueError): preflight.main(['--expected-container-id', CID, '--expected-system-id', SID])
        self.assertEqual(stream.getvalue(), '')

    def test_command_failure_does_not_expose_stderr(self):
        failure = subprocess.CompletedProcess([], 1, '', 'password=secret')
        with patch.object(preflight.subprocess, 'run', return_value=failure):
            with self.assertRaisesRegex(ValueError, '^Read-only Docker/PostgreSQL inspection failed$'):
                preflight.command(['docker', 'inspect'])

    def test_apply_or_database_url_arguments_are_not_supported(self):
        for arg in ('--apply', '--database-url'):
            with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                preflight.main(['--expected-container-id', CID, '--expected-system-id', SID, arg, 'anything'])


if __name__ == '__main__':
    unittest.main()
