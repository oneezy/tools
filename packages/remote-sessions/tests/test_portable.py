"""Run with python -m unittest discover -s tests -p test_portable.py -v."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import remote_sessions as rs
import task_worktrees as wt

ENGINE = Path(rs.__file__)
FAKE = Path(__file__).with_name('fake_claude.py')


class PortableTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="remote test's ")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / 'projects'
        self.project = self.root / 'brain'
        self.project.mkdir(parents=True)
        self.config = Path(self.temp.name) / 'config'
        self.config.mkdir()
        self.native = self.config / 'fake-native.json'
        self.native.write_text(json.dumps(dict(Agents=[], Starts=0, Stops=0, Mode='normal')))
        wt.git(self.project, 'init', '-b', 'dev')
        wt.git(self.project, 'config', 'user.name', 'Fixture')
        wt.git(self.project, 'config', 'user.email', 'fixture@example.invalid')
        (self.project / '.gitignore').write_text('.claude/worktrees/\n')
        wt.git(self.project, 'add', '.')
        wt.git(self.project, 'commit', '-m', 'fixture')

    def options(self, *args):
        return rs.parser().parse_args([*args, '--root', str(self.root), '--config', str(self.config), '--claude', str(FAKE), '--only', 'brain'])

    def run_manager(self, *args):
        return rs.Manager(self.options(*args)).execute()

    def data(self):
        return json.loads(self.native.read_text())

    def change(self, **fields):
        data = self.data()
        data.update(fields)
        self.native.write_text(json.dumps(data))

    def new(self, name='fix-login'):
        return self.run_manager('start', '--task', name, '--issue', '2')[0]

    def test_readable_names_and_same_workspace_for_both_harnesses(self):
        first = self.run_manager('workspace', '--issue', '2', '--task', 'Fix login')[0]
        self.assertEqual(Path(first['WorkingDirectory']).name, 'brain-issue-2-fix-login')
        self.assertEqual(first['Branch'], 'codex/brain-issue-2-fix-login')
        again = self.run_manager('workspace', '--issue', '2', '--task', 'Fix login')[0]
        self.assertEqual(first['WorkingDirectory'], again['WorkingDirectory'])
        self.assertEqual(again['Operation'], 'reuse')
        self.assertEqual(first['Commands']['Codex'][2], first['WorkingDirectory'])
        self.assertEqual(first['Commands']['Claude'], ['claude', '--remote-control', first['Title']])

    def test_resume_stop_restart_preserve_uuid_options_and_dirty_files(self):
        first = self.new()
        folder = Path(first['WorkingDirectory'])
        (folder / 'unsaved.txt').write_text('keep')
        self.run_manager('start')
        self.assertEqual(self.data()['Starts'], 1)
        self.run_manager('stop', '--session-id', first['SessionId'])
        self.run_manager('stop', '--session-id', first['SessionId'])
        self.assertEqual(self.data()['Stops'], 1)
        resumed = self.run_manager('resume', '--session-id', first['SessionId'])[0]
        self.assertEqual(resumed['SessionId'], first['SessionId'])
        self.assertEqual(self.data()['LastArguments'], ['--bg', '--resume', first['SessionId']])
        self.assertEqual((folder / 'unsaved.txt').read_text(), 'keep')
        self.assertFalse(resumed['RemoteRegistered'])

    def test_plan_and_status_never_create_state_lock_or_worktree(self):
        before = sorted(str(p) for p in self.root.rglob('*'))
        self.run_manager('start', '--task', 'login', '--plan')
        self.run_manager('status')
        self.run_manager('workspace', '--pr', '20', '--plan')
        self.assertEqual(before, sorted(str(p) for p in self.root.rglob('*')))
        self.assertEqual(self.data()['Starts'], 0)

    def test_new_tasks_require_names(self):
        with self.assertRaisesRegex(ValueError, 'descriptive name'):
            self.run_manager('start')

    def test_history_hidden_and_not_bulk_selected(self):
        rows = [dict(Project='brain', SessionId='missing', Available=False), dict(Project='brain', SessionId='live', Available=True)]
        self.assertEqual([r['SessionId'] for r in rs.visible_rows(rows)], ['live'])
        self.assertEqual(len(rs.visible_rows(rows, True)), 2)
        self.assertFalse(rs.selectable(rows[0]))

    def test_external_interactive_session_never_adopted(self):
        first = self.new()
        data = self.data()
        a = data['Agents'][0]
        a.update(kind='interactive', status='idle', startedAt='external')
        a.pop('id')
        self.change(Agents=data['Agents'])
        self.assertFalse(self.run_manager('status')[0]['Managed'])
        self.run_manager('start')
        self.assertEqual(self.data()['Starts'], 1)
        with self.assertRaisesRegex(ValueError, 'another run'):
            self.run_manager('stop', '--session-id', first['SessionId'])

    def test_stop_rejects_reused_native_identity(self):
        self.new()
        data = self.data()
        data['Agents'][0]['startedAt'] = 'another-run'
        self.change(Agents=data['Agents'])
        with self.assertRaisesRegex(ValueError, 'another run'):
            self.run_manager('stop')
        self.assertEqual(self.data()['Stops'], 0)

    def test_bridge_registration_is_not_connection_claim(self):
        self.new()
        a = self.data()['Agents'][0]
        folder = self.config / 'sessions'
        folder.mkdir()
        file = folder / f"{a['pid']}.json"
        file.write_text(json.dumps(dict(pid=a['pid'], sessionId=a['sessionId'], bridgeSessionId='session_example')))
        status = self.run_manager('status')[0]
        self.assertTrue(status['RemoteRegistered'])
        self.assertIn('unverified', status['Connection'])
        file.write_text(json.dumps(dict(pid=a['pid'], sessionId='other', bridgeSessionId='session_wrong')))
        self.assertFalse(self.run_manager('status')[0]['RemoteRegistered'])

    def test_deleted_worktree_restores_original_branch_and_uuid(self):
        first = self.new()
        self.run_manager('stop')
        wt.git(self.project, 'worktree', 'remove', first['WorkingDirectory'])
        restored = self.run_manager('resume', '--session-id', first['SessionId'])[0]
        self.assertEqual(restored['SessionId'], first['SessionId'])
        self.assertEqual(restored['WorkingDirectory'], first['WorkingDirectory'])

    def test_failed_launch_retries_existing_named_worktree(self):
        self.change(Mode='launch-failure')
        with self.assertRaises(RuntimeError):
            self.new()
        trees = wt.worktrees(self.project)
        self.change(Mode='normal')
        self.new()
        self.assertEqual(trees, wt.worktrees(self.project))

    def test_launch_confirmation_failure_does_not_duplicate_or_adopt(self):
        self.change(Mode='launch-exit-failure')
        with self.assertRaises(RuntimeError):
            self.new()
        self.change(Mode='normal')
        self.new()
        self.assertEqual(self.data()['Starts'], 1)
        with self.assertRaisesRegex(ValueError, 'uncertain ownership'):
            self.run_manager('stop')

    def test_malformed_inventory_never_starts(self):
        self.change(Mode='malformed')
        with self.assertRaises(ValueError):
            self.new()
        self.assertEqual(self.data()['Starts'], 0)

    def test_incomplete_native_identity_fails_before_state_write(self):
        for kind in ('background', 'interactive'):
            self.change(Agents=[dict(sessionId='missing-identity', kind=kind, cwd=str(self.project))])
            with self.assertRaisesRegex(ValueError, 'incomplete agent record'):
                self.new()
            self.assertFalse((self.root / '.remote-sessions.json').exists())

    def test_missing_branch_creates_replacement_even_at_same_folder(self):
        first = self.new()
        self.run_manager('stop')
        wt.git(self.project, 'worktree', 'remove', first['WorkingDirectory'])
        state_file = self.root / '.remote-sessions.json'
        state = rs.read_json(state_file)
        state['Sessions'][first['SessionId']]['Branch'] = 'codex/no-longer-present'
        rs.write_json(state_file, state)
        replacement = self.run_manager('resume', '--session-id', first['SessionId'])[0]
        self.assertNotEqual(first['SessionId'], replacement['SessionId'])
        again = self.run_manager('resume', '--session-id', first['SessionId'])[0]
        self.assertEqual(again['SessionId'], replacement['SessionId'])
        self.assertEqual(self.data()['Starts'], 2)

    def test_nested_activity_and_saved_titles_do_not_break_continuity(self):
        first = self.new()
        history = next((self.config / 'projects').glob(f"*/{first['SessionId']}.jsonl"))
        with history.open('a') as file:
            file.write('\n' + json.dumps(dict(type='assistant', sessionId=first['SessionId'], cwd=str(Path(first['WorkingDirectory']) / 'nested'))))
            file.write('\n' + json.dumps(dict(type='ai-title', sessionId=first['SessionId'], aiTitle='Fix login')))
        saved = self.run_manager('sessions')[0]
        self.assertTrue(saved['Available'])
        self.assertEqual(saved['WorkingDirectory'], first['WorkingDirectory'])
        self.assertEqual(saved['Title'], 'Fix login')

    @unittest.skipUnless(os.name == 'nt', 'Windows compatibility launcher')
    def test_windows_cmd_propagates_failure(self):
        wrapper = ENGINE.with_name('remote-control.cmd')
        # No user-controlled strings go through cmd; these fixed help/error arguments
        # test the actual double-click entry point's exit status.
        result = subprocess.run(['cmd', '/c', str(wrapper), 'invalid-action'], capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('invalid choice', result.stderr)

    def test_shell_metacharacters_are_literal_arguments(self):
        name = "fix $(touch surprise); `echo nope` & quote's"
        first = self.run_manager('start', '--task', name)[0]
        self.assertIn(name, self.data()['LastArguments'][-1])
        self.assertEqual(Path(first['WorkingDirectory']).name, 'brain-fix-touch-surprise-echo-nope-quote-s')
        self.assertFalse((self.root / 'surprise').exists())

    def test_native_cli_process_entrypoint_and_legacy_aliases(self):
        result = subprocess.run([sys.executable, str(ENGINE), 'start', '-Root', str(self.root), '-Only', 'brain', '-Task', 'fix login', '-ClaudeConfigDirectory', str(self.config), '-ClaudeExecutable', str(FAKE), '-Json'], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(json.loads(result.stdout)), 1)

    def test_cross_process_lock_blocks_and_releases(self):
        code = 'from pathlib import Path; from remote_sessions import root_lock; import sys\nwith root_lock(Path(sys.argv[1]), .2): print("locked")'
        command = [sys.executable, '-c', code, str(self.root)]
        with rs.root_lock(self.root):
            result = subprocess.run(command, cwd=ENGINE.parent, capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('Another launcher', result.stderr)
        result = subprocess.run(command, cwd=ENGINE.parent, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_case_sensitive_linux_paths(self):
        if os.name != 'nt':
            self.assertFalse(wt.same('/tmp/Brain', '/tmp/brain'))

    def test_task_names_retain_repo_ticket_and_strip_path_traversal(self):
        self.assertEqual(wt.task_name('Brain', '../../Fix login', issue=2), 'brain-issue-2-fix-login')
        self.assertEqual(wt.task_name('Brain', None, pr=20), 'brain-pr-20')
        with self.assertRaises(ValueError):
            wt.task_name('Brain', '...')

    def test_picker_a_enter_twice_preserves_sessions(self):
        self.new('first')
        self.new('second')
        self.run_manager('stop')
        manager = rs.Manager(self.options('menu'))
        with patch.object(rs.sys.stdin, 'isatty', return_value=True), patch.object(rs, 'keypress', side_effect=['a', '\r', 'a', '\r', 'q']), patch('builtins.print'):
            rs.menu(manager)
        self.assertEqual(self.data()['Starts'], 4)
        self.assertEqual(len(self.data()['Agents']), 2)


if __name__ == '__main__':
    unittest.main()
