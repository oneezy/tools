"""Run with python -m unittest discover -s tests -p test_portable.py -v."""
import argparse
from datetime import datetime, timezone
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

    def new(self, name='fix-login', *extra):
        return self.run_manager('start', '--task', name, '--issue', '2', *extra)[0]

    def state_file(self):
        return self.root / '.remote-sessions.json'

    def reveal_slow_agents(self):
        data = self.data()
        for agent in data['Agents']:
            agent.pop('HiddenPolls', None)
        self.change(Mode='normal', Slow=False, Agents=data['Agents'])

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

    def test_session_live_in_another_app_is_view_only(self):
        first = self.new()
        data = self.data()
        a = data['Agents'][0]
        a.update(kind='interactive', status='idle', startedAt='external')
        a.pop('id')
        self.change(Agents=data['Agents'])
        self.assertFalse(self.run_manager('status')[0]['Stoppable'])
        self.run_manager('start')
        self.assertEqual(self.data()['Starts'], 1)
        with self.assertRaisesRegex(ValueError, 'view-only'):
            self.run_manager('stop', '--session-id', first['SessionId'])
        self.assertEqual(self.run_manager('stop'), [])
        self.assertEqual(self.data()['Stops'], 0)

    def test_background_session_started_elsewhere_is_stoppable(self):
        self.change(Agents=[dict(id='outside1', sessionId='5f1c0a52-4a57-4c1e-9a55-3c2d7c1b9e01', kind='background',
                                 state='idle', cwd=str(self.project), pid=4242, startedAt='elsewhere')])
        self.assertEqual([r['SessionId'] for r in self.run_manager('stop')], ['5f1c0a52-4a57-4c1e-9a55-3c2d7c1b9e01'])
        self.assertEqual(self.data()['Stops'], 1)

    def test_session_recorded_as_pending_is_stoppable(self):
        first = self.new()
        state = rs.read_json(self.state_file())
        state['Sessions'][first['SessionId']].update(Ownership='pending', StartedAt=None)
        rs.write_json(self.state_file(), state)
        result = self.run_manager('stop', '--session-id', first['SessionId'])[0]
        self.assertIn('stopped', result['Result'])
        self.assertEqual(self.data()['Stops'], 1)
        self.assertEqual(self.data()['Agents'][0]['state'], 'stopped')

    def test_resuming_a_stopped_session_continues_same_id_in_original_folder(self):
        first = self.new()
        self.run_manager('stop')
        resumed = self.run_manager('resume', '--session-id', first['SessionId'])[0]
        self.assertEqual(resumed['SessionId'], first['SessionId'])
        self.assertEqual(self.data()['LastArguments'][:3], ['--bg', '--resume', first['SessionId']])
        self.assertTrue(wt.same(self.data()['LastDirectory'], first['WorkingDirectory']))
        self.assertEqual(len(wt.worktrees(self.project)), 2)

    def test_slow_launch_is_not_an_error_and_ends_up_stoppable(self):
        first = self.new()
        self.run_manager('stop')
        self.change(Mode='slow', SlowPolls=50)
        resumed = self.run_manager('resume', '--session-id', first['SessionId'], '--launch-wait', '0')[0]
        self.assertEqual(resumed['SessionId'], first['SessionId'])
        self.assertIn('not listed yet', resumed['Result'])
        self.reveal_slow_agents()
        self.run_manager('stop', '--session-id', first['SessionId'])
        self.assertEqual(self.data()['Stops'], 2)

    def test_slow_new_task_launch_is_adopted_and_ends_up_stoppable(self):
        # Claude prints no session ID and lists the session only after the wait has ended.
        self.change(Mode='slow', SlowPolls=50, Quiet=True)
        launched = self.new('fix-login', '--launch-wait', '0')
        self.assertIn('not listed yet', launched['Result'])
        self.reveal_slow_agents()
        real = self.data()['Agents'][0]['sessionId']
        rows = self.run_manager('status')
        self.assertEqual([(r['SessionId'], r['Task'], r['Stoppable']) for r in rows], [(real, 'issue-2 fix-login', True)])
        again = self.run_manager('start')[0]
        self.assertEqual((again['SessionId'], again['Result']), (real, 'already running; not restarted'))
        self.assertEqual(list(rs.read_json(self.state_file())['Sessions']), [real])
        self.assertEqual(self.new()['SessionId'], real)
        self.assertEqual(self.data()['Starts'], 1)
        self.assertEqual([r['SessionId'] for r in self.run_manager('stop')], [real])
        self.assertEqual(self.data()['Stops'], 1)

    def test_slow_new_task_launch_reports_the_session_claude_printed(self):
        self.change(Mode='slow', SlowPolls=50)
        launched = self.new('fix-login', '--launch-wait', '0')
        real = self.data()['Agents'][0]['sessionId']
        self.assertEqual(launched['SessionId'], real)
        self.assertEqual(list(rs.read_json(self.state_file())['Sessions']), [real])

    def test_copied_launch_is_adopted_and_stoppable(self):
        first = self.new()
        self.run_manager('stop')
        self.change(Mode='copy')
        resumed = self.run_manager('resume', '--session-id', first['SessionId'])[0]
        copy = next(a['sessionId'] for a in self.data()['Agents'] if a['state'] != 'stopped')
        self.assertNotEqual(copy, first['SessionId'])
        self.assertEqual(resumed['SessionId'], copy)
        self.assertTrue(wt.same(resumed['WorkingDirectory'], first['WorkingDirectory']))
        self.assertEqual([r['SessionId'] for r in self.run_manager('status') if r['Running']], [copy])
        self.run_manager('stop', '--session-id', copy)
        self.assertEqual(self.data()['Stops'], 2)

    def test_slow_copied_resume_is_followed_and_stoppable_by_either_id(self):
        first = self.new()
        self.run_manager('stop')
        # Claude names both the requested conversation and its copy, and lists the copy only after the wait.
        self.change(Mode='copy', Slow=True, SlowPolls=50, EchoRequested=True)
        resumed = self.run_manager('resume', '--session-id', first['SessionId'], '--launch-wait', '0')[0]
        copy = next(a['sessionId'] for a in self.data()['Agents'] if a['sessionId'] != first['SessionId'])
        self.assertEqual(resumed['SessionId'], copy)
        self.reveal_slow_agents()
        self.assertEqual([r['SessionId'] for r in self.run_manager('stop', '--session-id', first['SessionId'])], [copy])
        self.assertEqual(self.data()['Stops'], 2)

    def test_unrelated_id_in_launch_output_is_repaired_once_the_session_appears(self):
        self.change(Mode='slow', SlowPolls=50, Quiet=True, Banner='Environment 5f1c0a52-4a57-4c1e-9a55-3c2d7c1b9e03 ready')
        self.new('fix-login', '--launch-wait', '0')
        self.reveal_slow_agents()
        real = self.data()['Agents'][0]['sessionId']
        self.assertEqual(self.run_manager('start')[0]['SessionId'], real)
        self.assertEqual(list(rs.read_json(self.state_file())['Sessions']), [real])
        self.assertEqual([r['SessionId'] for r in self.run_manager('stop')], [real])

    def test_failed_new_task_launch_adopts_only_a_conversation_that_began_after_it(self):
        self.change(Mode='launch-failure')
        with self.assertRaises(RuntimeError):
            self.new()
        folder = next(t['Path'] for t in wt.worktrees(self.project) if not wt.same(t['Path'], self.project))
        history = self.config / 'projects' / 'planted'
        history.mkdir(parents=True)

        def plant(id, timestamp):
            (history / f'{id}.jsonl').write_text(json.dumps(dict(type='user', sessionId=id, cwd=folder, timestamp=timestamp)))
            return next(r['Task'] for r in self.run_manager('status') if r['SessionId'] == id)

        self.assertNotEqual(plant('5f1c0a52-4a57-4c1e-9a55-3c2d7c1b9e04', '2020-01-01T00:00:00Z'), 'issue-2 fix-login')
        later = datetime.now(timezone.utc).isoformat()
        self.assertEqual(plant('5f1c0a52-4a57-4c1e-9a55-3c2d7c1b9e05', later), 'issue-2 fix-login')

    def test_stored_new_task_without_a_task_name_launches_in_its_own_folder(self):
        folder = self.run_manager('workspace', '--task', 'legacy')[0]['WorkingDirectory']
        id = '5f1c0a52-4a57-4c1e-9a55-3c2d7c1b9e06'
        rs.write_json(self.state_file(), dict(Version=2, Sessions={id: dict(Project='brain', WorkingDirectory=folder, NewSession=True)}))
        self.run_manager('start', '--session-id', id)
        self.assertTrue(wt.same(self.data()['LastDirectory'], folder))
        self.assertEqual(len(wt.worktrees(self.project)), 2)

    def test_displayed_branch_follows_the_folders_checkout(self):
        first = self.new()
        self.run_manager('stop')
        wt.git(first['WorkingDirectory'], 'switch', '-c', 'fix/2-renamed')
        self.assertEqual(self.run_manager('status')[0]['Branch'], 'fix/2-renamed')
        resumed = self.run_manager('resume', '--session-id', first['SessionId'])[0]
        self.assertEqual(resumed['Branch'], 'fix/2-renamed')
        again = self.run_manager('start', '--task', 'fix-login', '--issue', '2', '--branch', 'fix/2-renamed')[0]
        self.assertEqual(again['SessionId'], first['SessionId'])
        self.assertEqual(len(wt.worktrees(self.project)), 2)

    def test_launch_claude_runs_in_another_folder_is_never_adopted(self):
        self.change(Mode='wrong-directory')
        launched = self.new('fix-login', '--launch-wait', '0')
        elsewhere = self.data()['Agents'][0]['sessionId']
        self.assertIn('not listed yet', launched['Result'])
        self.assertNotEqual(launched['SessionId'], elsewhere)
        self.assertNotIn(elsewhere, rs.read_json(self.state_file())['Sessions'])
        self.assertFalse(any(r['Running'] for r in self.run_manager('status')))
        self.assertEqual(self.run_manager('stop'), [])

    def test_detached_folder_shows_no_stale_branch(self):
        first = self.new()
        self.run_manager('stop')
        wt.git(first['WorkingDirectory'], 'checkout', '--detach')
        self.assertIsNone(self.run_manager('status')[0]['Branch'])
        self.run_manager('resume', '--session-id', first['SessionId'])
        self.assertIsNone(rs.read_json(self.state_file())['Sessions'][first['SessionId']]['Branch'])

    def test_second_load_reparses_no_unchanged_transcript(self):
        first = self.new()
        history = next((self.config / 'projects').glob(f"*/{first['SessionId']}.jsonl"))
        with history.open('a') as file:
            file.write('\n' + json.dumps(dict(type='ai-title', sessionId=first['SessionId'], aiTitle='Fix login')))
        self.assertEqual(self.run_manager('sessions')[0]['Title'], 'Fix login')
        # Same size and modification time: a re-parse would reveal the new title, the cache must not.
        stat = history.stat()
        history.write_text(history.read_text().replace('Fix login', 'Fix lagin'))
        os.utime(history, ns=(stat.st_atime_ns, stat.st_mtime_ns))
        self.assertEqual(self.run_manager('sessions')[0]['Title'], 'Fix login')
        os.utime(history, ns=(stat.st_atime_ns, stat.st_mtime_ns + 1_000_000_000))
        self.assertEqual(self.run_manager('sessions')[0]['Title'], 'Fix lagin')

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

    def test_session_whose_folder_was_deleted_is_hidden_and_never_recreated(self):
        first = self.new()
        self.run_manager('stop')
        wt.git(self.project, 'worktree', 'remove', first['WorkingDirectory'])
        trees = wt.worktrees(self.project)
        self.assertNotIn(first['SessionId'], [r['SessionId'] for r in self.run_manager('status')])
        self.assertNotIn(first['SessionId'], [r['SessionId'] for r in self.run_manager('sessions')])
        with self.assertRaisesRegex(ValueError, 'folder'):
            self.run_manager('resume', '--session-id', first['SessionId'])
        with self.assertRaisesRegex(ValueError, 'no available task'):
            self.run_manager('start')
        with self.assertRaisesRegex(ValueError, 'folder'):
            self.new()
        self.assertFalse(Path(first['WorkingDirectory']).exists())
        self.assertEqual(trees, wt.worktrees(self.project))
        self.assertEqual(self.data()['Starts'], 1)

    def test_running_session_stays_listed_when_its_transcript_is_missing(self):
        first = self.new()
        history = next((self.config / 'projects').glob(f"*/{first['SessionId']}.jsonl"))
        history.rename(history.with_suffix('.parked'))
        rows = self.run_manager('status')
        self.assertEqual([(r['SessionId'], r['Running'], r['Stoppable']) for r in rows], [(first['SessionId'], True, True)])
        again = self.run_manager('resume', '--session-id', first['SessionId'])[0]
        self.assertEqual(again['Result'], 'already running; not restarted')
        self.assertEqual(self.data()['Starts'], 1)

    def test_new_task_folder_deleted_after_a_failed_launch_is_never_recreated(self):
        self.change(Mode='launch-failure')
        with self.assertRaises(RuntimeError):
            self.new()
        folder = next(t['Path'] for t in wt.worktrees(self.project) if not wt.same(t['Path'], self.project))
        wt.git(self.project, 'worktree', 'remove', folder)
        trees = wt.worktrees(self.project)
        self.change(Mode='normal')
        with self.assertRaisesRegex(ValueError, 'folder'):
            self.new()
        self.assertNotIn(folder, [r.get('WorkingDirectory') for r in self.run_manager('status')])
        self.assertFalse(Path(folder).exists())
        self.assertEqual(trees, wt.worktrees(self.project))
        self.assertEqual(self.data()['Starts'], 1)

    def test_stop_names_an_unknown_session_or_one_outside_the_selected_projects(self):
        with self.assertRaisesRegex(ValueError, 'not found'):
            self.run_manager('stop', '--session-id', '5f1c0a52-4a57-4c1e-9a55-3c2d7c1b9e01')
        (self.root / 'other').mkdir()
        self.change(Agents=[dict(id='outside1', sessionId='5f1c0a52-4a57-4c1e-9a55-3c2d7c1b9e02', kind='background',
                                 state='idle', cwd=str(self.root / 'other'), pid=4242, startedAt='elsewhere')])
        with self.assertRaisesRegex(ValueError, 'outside the selected projects'):
            self.run_manager('stop', '--session-id', '5f1c0a52-4a57-4c1e-9a55-3c2d7c1b9e02')
        self.assertEqual(self.data()['Stops'], 0)

    def test_failed_launch_retries_existing_named_worktree(self):
        self.change(Mode='launch-failure')
        with self.assertRaises(RuntimeError):
            self.new()
        trees = wt.worktrees(self.project)
        self.change(Mode='normal')
        self.new()
        self.assertEqual(trees, wt.worktrees(self.project))

    def test_launch_that_reports_failure_is_adopted_not_relaunched_and_stoppable(self):
        self.change(Mode='launch-exit-failure')
        with self.assertRaises(RuntimeError):
            self.new()
        self.change(Mode='normal')
        real = self.data()['Agents'][0]['sessionId']
        self.assertEqual(self.new()['SessionId'], real)
        self.assertEqual(self.data()['Starts'], 1)
        self.assertEqual(list(rs.read_json(self.state_file())['Sessions']), [real])
        self.run_manager('stop')
        self.assertEqual(self.data()['Stops'], 1)

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
        result = subprocess.run([sys.executable, str(ENGINE), 'start', '-Root', str(self.root), '-Only', 'brain', '-Task', 'fix login', '-ClaudeConfigDirectory', str(self.config), '-ClaudeExecutable', str(FAKE), '-LaunchWait', '5', '-Json'], capture_output=True, text=True)
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
