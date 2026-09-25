"""Run with python -m unittest discover -s tests -p test_portable.py -v."""
import argparse
from contextlib import redirect_stdout
from datetime import datetime, timezone
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import remote_sessions as rs
import task_worktrees as wt

ENGINE = Path(rs.__file__)
FAKE = Path(__file__).with_name('fake_claude.py')


# Cells each wide string takes in Windows Terminal, from what it draws: a joined emoji sequence is one glyph.
WIDE = {'👨‍👩‍👧': 2, '👍🏽': 2, '漢': 2, '字': 2, '🚀': 2, '📡': 2, '⚠️': 2, '❤️': 2,
        '🟢': 2, '🟡': 2, '🔵': 2, '🟣': 2, '⚪': 2, '⚫': 2, '🔴': 2, '✅': 2}


def cells(text):
    """Terminal cells a string takes, from the literal widths above; anything else takes one."""
    for wide in sorted(WIDE, key=len, reverse=True):
        text = text.replace(wide, '#' * WIDE[wide])
    return len(text)


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
        # The process snapshot the engine reads instead of this machine's; empty unless a test plants a chain.
        self.snapshot = Path(self.temp.name) / 'processes.json'
        self.snapshot.write_text('[]')
        wt.git(self.project, 'init', '-b', 'dev')
        wt.git(self.project, 'config', 'user.name', 'Fixture')
        wt.git(self.project, 'config', 'user.email', 'fixture@example.invalid')
        (self.project / '.gitignore').write_text('.claude/worktrees/\n')
        wt.git(self.project, 'add', '.')
        wt.git(self.project, 'commit', '-m', 'fixture')

    def options(self, *args, only=('brain',), real_processes=False):
        return rs.parser().parse_args([*args, '--root', str(self.root), '--config', str(self.config), '--claude', str(FAKE),
                                       '--desktop-sessions', str(self.desktop), *(['--only', *only] if only else []),
                                       *([] if real_processes else ['--processes', str(self.snapshot)])])

    @property
    def desktop(self):
        return Path(self.temp.name) / 'desktop-sessions'

    def transcript(self, id, cwd, *records, timestamp='2026-01-01T00:00:00Z'):
        """Plant a saved conversation, as Claude writes one under its config folder."""
        history = self.config / 'projects' / 'planted'
        history.mkdir(parents=True, exist_ok=True)
        lines = [dict(type='user', sessionId=id, cwd=str(cwd), timestamp=timestamp, **records[0])] if records else [
            dict(type='user', sessionId=id, cwd=str(cwd), timestamp=timestamp)]
        lines += [dict(sessionId=id, **record) for record in records[1:]]
        (history / f'{id}.jsonl').write_text('\n'.join(json.dumps(line) for line in lines))

    def live(self, id, cwd, kind='interactive', entrypoint=None, bridge=None, pid=None, **fields):
        """A session Claude lists as live, with the per-pid session file its process writes."""
        data = self.data()
        pid = pid or 7000 + len(data['Agents'])
        agent = dict(sessionId=id, kind=kind, cwd=str(cwd), pid=pid, **fields)
        if kind == 'background':
            agent.setdefault('id', id[:8])
            agent.setdefault('state', 'idle')
        else:
            agent.setdefault('status', 'idle')
        data['Agents'].append(agent)
        self.native.write_text(json.dumps(data))
        folder = self.config / 'sessions'
        folder.mkdir(exist_ok=True)
        record = dict(pid=pid, sessionId=id, cwd=str(cwd))
        if entrypoint:
            record['entrypoint'] = entrypoint
        if bridge:
            record['bridgeSessionId'] = bridge
        (folder / f'{pid}.json').write_text(json.dumps(record))

    def processes(self, *chain):
        """Plant a process snapshot: each entry is (pid, parent pid, image name[, full image path[, start time]])."""
        rows = [dict(zip(('pid', 'ppid', 'name', 'path', 'started'), entry)) for entry in chain]
        self.snapshot.write_text(json.dumps(rows))

    def pid_of(self, id):
        return next(a['pid'] for a in self.data()['Agents'] if a['sessionId'] == id)

    def desktop_session(self, id, cwd, archived=False, **fields):
        """An entry in the desktop app's own session store."""
        folder = self.desktop / 'account' / 'org'
        folder.mkdir(parents=True, exist_ok=True)
        (folder / f'local_{id}.json').write_text(json.dumps(dict(sessionId=f'local_{id}', cliSessionId=id, cwd=str(cwd), isArchived=archived, **fields)))

    def rows_by_id(self):
        return {r['SessionId']: r for r in self.run_manager('status')}

    def picker(self, keys, columns=140, only=('brain',)):
        """Drive the picker with scripted keypresses; return every screen it drew, as a terminal shows them."""
        output = io.StringIO()
        with patch.object(rs.sys.stdin, 'isatty', return_value=True), patch.object(rs, 'keypress', side_effect=keys), \
                patch.dict(os.environ, COLUMNS=str(columns), LINES='40'), redirect_stdout(output):
            rs.menu(rs.Manager(self.options('menu', only=only)))
        return output.getvalue().split('\033[2J\033[H')[1:]

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

    def test_resume_is_refused_on_a_session_live_in_another_surface(self):
        id = '5f1c0a52-4a57-4c1e-9a55-3c2d7c1b9e11'
        self.transcript(id, self.project)
        self.live(id, self.project, entrypoint='claude-vscode')
        self.assertTrue(self.rows_by_id()[id]['ViewOnly'])
        with self.assertRaisesRegex(ValueError, 'view-only'):
            self.run_manager('resume', '--session-id', id)
        with self.assertRaisesRegex(ValueError, 'view-only'):
            self.run_manager('stop', '--session-id', id)
        self.assertEqual((self.data()['Starts'], self.data()['Stops']), (0, 0))

    def test_picker_refuses_to_check_a_row_live_in_another_surface(self):
        id = '5f1c0a52-4a57-4c1e-9a55-3c2d7c1b9e12'
        self.transcript(id, self.project)
        self.live(id, self.project, entrypoint='claude-vscode')
        screens = self.picker([' ', 'a', '\r', 'x', 'q'])
        self.assertIn('view-only', screens[1])
        self.assertFalse(any('[x]' in screen for screen in screens))
        self.assertEqual((self.data()['Starts'], self.data()['Stops']), (0, 0))

    def test_picker_columns_stay_aligned_with_emoji(self):
        tree = Path(self.run_manager('workspace', '--task', 'aligned')[0]['WorkingDirectory'])
        working, stopped, vscode = (f'5f1c0a52-4a57-4c1e-9a55-3c2d7c1b9f{n:02d}' for n in range(1, 4))
        self.transcript(working, tree, dict(), dict(type='ai-title', aiTitle='Wide ⚠️ 漢字 ❤️ title 🚀 👨‍👩‍👧 👍🏽 end'))
        self.live(working, tree, kind='background', state='working', bridge='session_aligned')
        self.transcript(stopped, self.project)
        self.live(vscode, self.project, entrypoint='claude-vscode')
        (self.root / 'tools').mkdir()  # A project with no session yet shows its new-task placeholder.
        lines = self.picker(['q'], only=())[-1].splitlines()
        header = next(line for line in lines if 'SOURCE' in line)
        self.assertEqual([h for h in ('STATUS', 'REPO', 'TASK', 'SOURCE', 'BRANCH', 'LAST ACTIVE', 'REMOTE') if h in header],
                         ['STATUS', 'REPO', 'TASK', 'SOURCE', 'BRANCH', 'LAST ACTIVE', 'REMOTE'])
        rows = {circle: next(line for line in lines if circle in line) for circle in ('🟢', '🟣', '🔵', '⚪')}
        at = lambda line, text: cells(line[:line.index(text)])
        for circle, source, branch in (('🟢', 'Background', 'codex/brain-aligned'), ('🟣', 'VS Code ext', 'dev'), ('🔵', 'CLI', 'dev')):
            line = rows[circle]
            self.assertEqual(at(line, circle), at(header, 'STATUS'), line)
            self.assertEqual(at(line, source), at(header, 'SOURCE'), line)
            self.assertEqual(at(line, ' ' + branch) + 1, at(header, 'BRANCH'), line)
        self.assertEqual(at(rows['🟢'], '📡'), at(header, 'REMOTE'))
        self.assertEqual(at(rows['⚪'], '⚪'), at(header, 'STATUS'))
        self.assertEqual([line for line in lines if line.startswith(('> [', '  [')) and '📡' in line], [rows['🟢']])
        self.assertTrue(all(cells(line) < 140 for line in lines))

    def test_picker_detail_pane_shows_where_the_session_started_and_its_settings(self):
        tree = Path(self.run_manager('workspace', '--task', 'details')[0]['WorkingDirectory'])
        id = '5f1c0a52-4a57-4c1e-9a55-3c2d7c1b9f11'
        self.transcript(id, tree, dict(entrypoint='claude-desktop', version='2.1.7', permissionMode='acceptEdits'))
        self.live(id, tree, kind='background', state='idle', bridge='session_details')
        screen = self.picker(['q'])[-1]
        row = next(line for line in screen.splitlines() if '🟡' in line)
        self.assertIn('Background', row)
        detail = screen[screen.index(row) + len(row):]
        for text in (str(tree), 'https://claude.ai/code/session_details', id, 'acceptEdits', '2.1.7', 'Started: Desktop'):
            self.assertIn(text, detail)

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

    def test_every_surface_gets_its_source_label(self):
        ids = {label: f'5f1c0a52-4a57-4c1e-9a55-3c2d7c1b9a{n:02d}' for n, label in enumerate(
            ['CLI', 'VS Code ext', 'Desktop', 'Background', 'RC server', 'Web'])}
        for n, id in enumerate(ids.values()):
            if id != ids['Web']:
                self.transcript(id, self.project, dict(), dict(type='ai-title', aiTitle=f'chat-{n}'))
        self.live(ids['CLI'], self.project, entrypoint='cli')
        self.live(ids['VS Code ext'], self.project, entrypoint='claude-vscode')
        self.live(ids['Desktop'], self.project, entrypoint='claude-desktop')
        self.live(ids['Background'], self.project, kind='background', entrypoint='cli')
        self.live(ids['RC server'], self.project, entrypoint='sdk-cli')
        # A background session launched with --bg records entrypoint `cli`, as Claude 2.1.282 does.
        self.transcript(ids['Web'], self.project, dict(teleportedFrom='https://claude.ai/code/session_web'),
                        dict(type='ai-title', aiTitle='chat-5'), timestamp='2026-03-01T00:00:00Z')
        rows = self.rows_by_id()
        self.assertEqual({label: rows[id]['Source'] for label, id in ids.items()}, {label: label for label in ids})
        lines = self.picker(['q'])[-1].splitlines()
        shown = {label: next(line for line in lines if f'chat-{n} ' in line) for n, label in enumerate(ids)}
        for label, line in shown.items():
            self.assertIn(f' {label} ', line[line.index('chat-'):])

    def test_source_shows_what_runs_a_session_now_and_origin_where_it_started(self):
        id = '5f1c0a52-4a57-4c1e-9a55-3c2d7c1b9b01'
        self.transcript(id, self.project, dict(entrypoint='claude-desktop'))
        self.desktop_session(id, self.project)
        stopped = self.rows_by_id()[id]
        self.assertEqual((stopped['Source'], stopped['Origin']), ('Desktop', 'Desktop'))
        self.live(id, self.project, kind='background', entrypoint='cli')
        resumed = self.rows_by_id()[id]
        self.assertEqual((resumed['Source'], resumed['Origin']), ('Background', 'Desktop'))

    def test_stopped_session_says_where_it_started_even_when_launched_with_bg(self):
        task = self.new()
        self.run_manager('stop')
        id = lambda n: f'5f1c0a52-4a57-4c1e-9a55-3c2d7c1b9b{n:02d}'
        # Claude records entrypoint `cli` for a --bg launch too; its first record also says the session kind.
        self.transcript(id(2), self.project, dict(entrypoint='cli', sessionKind='bg'), timestamp='2026-02-03T00:00:00Z')
        self.transcript(id(3), self.project, dict(entrypoint='cli'), timestamp='2026-02-02T00:00:00Z')
        # A remote-control session later resumed in the background still started as RC server.
        self.transcript(id(4), self.project, dict(entrypoint='sdk-cli'), dict(type='user', entrypoint='cli', sessionKind='bg'),
                        timestamp='2026-02-01T00:00:00Z')
        rows = self.rows_by_id()
        self.assertEqual({key: (rows[key]['Origin'], rows[key]['Source']) for key in (task['SessionId'], id(2), id(3), id(4))}, {
            task['SessionId']: ('Background', 'Background'), id(2): ('Background', 'Background'),
            id(3): ('CLI', 'CLI'), id(4): ('RC server', 'RC server')})
        screen = self.picker(['q'])[-1]
        self.assertIn('Started: Background', screen)

    def test_cli_session_in_windows_terminal_shows_its_shell_in_source_and_the_chain_in_the_detail_pane(self):
        id = '5f1c0a52-4a57-4c1e-9a55-3c2d7c1b7a01'
        self.transcript(id, self.project, dict(), dict(type='ai-title', aiTitle='terminal chat'))
        self.live(id, self.project, entrypoint='cli')
        self.processes((self.pid_of(id), 300, 'claude.exe', r'C:\Users\J\.local\bin\claude.exe'),
                       (300, 200, 'pwsh.exe', r'C:\Program Files\PowerShell\7\pwsh.exe'),
                       (200, 100, 'WindowsTerminal.exe'), (100, 4, 'explorer.exe'))
        row = self.rows_by_id()[id]
        self.assertEqual((row['Source'], row['HostApp']), ('CLI · PowerShell', 'PowerShell in Windows Terminal'))
        screen = self.picker(['q'])[-1]
        line = next(line for line in screen.splitlines() if 'terminal chat' in line)
        self.assertIn(' CLI · PowerShell ', line)
        self.assertIn('Host app: PowerShell in Windows Terminal', screen[screen.index(line) + len(line):])

    def test_vscode_session_names_the_app_that_launched_vscode(self):
        id = '5f1c0a52-4a57-4c1e-9a55-3c2d7c1b7a02'
        self.transcript(id, self.project)
        self.live(id, self.project, entrypoint='claude-vscode')
        # The extension host and the main window are both Code.exe; the Codex app is ChatGPT.exe in its MSIX package.
        self.processes((self.pid_of(id), 1424, 'claude.exe', r'c:\Users\J\.vscode\extensions\anthropic.claude-code\claude.exe'),
                       (1424, 1700, 'Code.exe', r'C:\Users\J\AppData\Local\Programs\Microsoft VS Code\Code.exe'),
                       (1700, 1624, 'Code.exe', r'C:\Users\J\AppData\Local\Programs\Microsoft VS Code\Code.exe'),
                       (1624, 900, 'ChatGPT.exe', r'C:\Program Files\WindowsApps\OpenAI.Codex_26.917.9434.0_x64__2p2nqsd0c76g0\app\ChatGPT.exe'))
        row = self.rows_by_id()[id]
        self.assertEqual((row['Source'], row['HostApp']), ('VS Code ext', 'VS Code (launched from Codex app)'))

    def test_desktop_app_is_known_by_its_package_folder_not_its_process_name(self):
        desktop, cli = '5f1c0a52-4a57-4c1e-9a55-3c2d7c1b7a03', '5f1c0a52-4a57-4c1e-9a55-3c2d7c1b7a04'
        for id in (desktop, cli):
            self.transcript(id, self.project)
        self.live(desktop, self.project, entrypoint='claude-desktop')
        self.live(cli, self.project, entrypoint='cli')
        app = r'C:\Program Files\WindowsApps\Claude_2.9939.2.0_x64__pzs8sxrjxfjjc\app\claude.exe'
        # Both sessions have a parent named claude.exe; only the one in the desktop app's package is the desktop app.
        self.processes((self.pid_of(desktop), 2300, 'claude.exe', r'C:\Users\J\AppData\Roaming\Claude\claude-code\claude.exe'),
                       (2300, 650, 'claude.exe', app), (650, 600, 'sihost.exe'),
                       (self.pid_of(cli), 2400, 'claude.exe', r'C:\Users\J\.local\bin\claude.exe'),
                       (2400, 2500, 'cmd.exe', r'C:\WINDOWS\system32\cmd.exe'))
        rows = self.rows_by_id()
        self.assertEqual({id: (rows[id]['Source'], rows[id]['HostApp']) for id in (desktop, cli)},
                         {desktop: ('Desktop', 'Desktop app'), cli: ('CLI · cmd', 'cmd')})

    def test_background_session_is_hosted_by_the_claude_daemon_not_the_terminal_that_started_it(self):
        id = '5f1c0a52-4a57-4c1e-9a55-3c2d7c1b7a05'
        self.transcript(id, self.project, dict(), dict(type='ai-title', aiTitle='daemon chat'))
        self.live(id, self.project, kind='background', entrypoint='cli')
        binary = r'C:\Users\J\.local\bin\claude.exe'
        # The daemon was started from a PowerShell tab, which does not host the session.
        self.processes((self.pid_of(id), 1935, 'claude.exe', binary), (1935, 2080, 'claude.exe', binary),
                       (2080, 300, 'claude.exe', binary), (300, 200, 'pwsh.exe'), (200, 100, 'WindowsTerminal.exe'))
        row = self.rows_by_id()[id]
        self.assertEqual((row['Source'], row['HostApp']), ('Background', 'Claude daemon'))
        self.assertIn('Host app: Claude daemon', self.picker(['q'])[-1])

    def test_a_parent_pid_reused_by_a_later_process_is_not_the_host(self):
        id = '5f1c0a52-4a57-4c1e-9a55-3c2d7c1b7a06'
        self.transcript(id, self.project)
        self.live(id, self.project, entrypoint='cli')
        # The shell that started the session exited; Windows gave its PID to a VS Code window opened afterwards.
        self.processes((self.pid_of(id), 300, 'claude.exe', None, 5000), (300, 100, 'Code.exe', None, 9000),
                       (100, 4, 'WindowsTerminal.exe', None, 1000))
        row = self.rows_by_id()[id]
        self.assertEqual((row['Source'], row['HostApp']), ('CLI', None))
        # A parent this user cannot open has no start time to compare; a session's host app is always one it can open.
        self.processes((self.pid_of(id), 300, 'claude.exe', None, 5000), (300, 100, 'pwsh.exe', None, None))
        row = self.rows_by_id()[id]
        self.assertEqual((row['Source'], row['HostApp']), ('CLI', None))

    def test_the_detail_pane_names_every_host_app_in_the_chain(self):
        id = '5f1c0a52-4a57-4c1e-9a55-3c2d7c1b7a09'
        self.transcript(id, self.project)
        self.live(id, self.project, entrypoint='cli')
        # PowerShell started from cmd in a Windows Terminal tab, and the terminal launched from the Codex app.
        self.processes((self.pid_of(id), 300, 'claude.exe'), (300, 250, 'pwsh.exe'), (250, 200, 'cmd.exe'),
                       (200, 150, 'WindowsTerminal.exe'), (150, 100, 'explorer.exe'),
                       (100, 50, 'ChatGPT.exe', r'C:\Program Files\WindowsApps\OpenAI.Codex_26.917.9434.0_x64__2p2nqsd0c76g0\app\ChatGPT.exe'))
        row = self.rows_by_id()[id]
        self.assertEqual((row['Source'], row['HostApp']),
                         ('CLI · PowerShell', 'PowerShell in cmd in Windows Terminal (launched from Codex app)'))

    def test_an_80_column_terminal_fits_every_table_line_and_a_wide_one_shows_the_whole_source(self):
        id = '5f1c0a52-4a57-4c1e-9a55-3c2d7c1b7a0a'
        self.transcript(id, self.project, dict(), dict(type='ai-title', aiTitle='a rather long title for a narrow terminal'))
        self.live(id, self.project, entrypoint='sdk-cli')
        self.processes((self.pid_of(id), 200, 'claude.exe'), (200, 100, 'WindowsTerminal.exe'))
        self.assertEqual(self.rows_by_id()[id]['Source'], 'RC server · Windows Terminal')
        for columns in (80, 100):
            lines = self.picker(['q'], columns=columns)[-1].splitlines()
            table = [line for line in lines if 'SOURCE' in line or line.startswith(('> [', '  ['))]
            self.assertTrue(table)
            self.assertEqual([line for line in table if cells(line) > columns - 1], [], columns)
        wide = self.picker(['q'], columns=140)[-1]
        self.assertIn(' RC server · Windows Terminal ', next(line for line in wide.splitlines() if 'rather long' in line))

    def test_the_linux_process_list_skips_stat_files_it_cannot_parse(self):
        proc = Path(self.temp.name) / 'proc'
        for name, stat in (('1', '1 (systemd) S 0 1 1 0 -1 4194560 0 0 0 0 0 0 0 0 20 0 1 0 5 0'),
                           ('42', '42 (tmux: server) S 1 42 42 0 -1 4194560 0 0 0 0 0 0 0 0 20 0 1 0 900 0'),
                           ('43', ''), ('44', '44 (bash) S'), ('45', '45 (zsh) S x 45 45 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 7 0'),
                           ('self', '1 (not a pid) S 0')):
            (proc / name).mkdir(parents=True)
            (proc / name / 'stat').write_text(stat)
        (proc / '46').mkdir()  # A process that exited between the listing and the read.
        processes = rs.proc_processes(str(proc))
        self.assertEqual({pid: (p['name'], p['ppid'], p['started']) for pid, p in processes.items()},
                         {1: ('systemd', 0, 5), 42: ('tmux: server', 1, 900)})

    def test_a_session_missing_from_the_snapshot_keeps_its_surface_label(self):
        id = '5f1c0a52-4a57-4c1e-9a55-3c2d7c1b7a07'
        self.transcript(id, self.project)
        self.live(id, self.project, entrypoint='cli')
        self.processes((1, 1, 'System'), (300, 200, 'pwsh.exe'))  # A PID loop, and no entry for the session's process.
        row = self.rows_by_id()[id]
        self.assertEqual((row['Source'], row['HostApp']), ('CLI', None))
        self.assertNotIn('Host app:', self.picker(['q'])[-1])

    def shell_child(self):
        """A real process running under a shell (cmd on Windows, sh elsewhere), as a terminal session runs under one.
        Returns the child's PID and the shell's host label; the child exits once the test ends."""
        code = "print(__import__('os').getpid(),flush=True);__import__('sys').stdin.read()"
        command = (['cmd', '/d', '/c', sys.executable, '-c', code] if os.name == 'nt' else
                   ['sh', '-c', '"$0" -c "$1"; :', sys.executable, code])
        child = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
        self.addCleanup(child.stdout.close)
        self.addCleanup(child.wait, 30)
        self.addCleanup(child.stdin.close)
        return int(child.stdout.readline()), 'cmd' if os.name == 'nt' else 'sh'

    @unittest.skipUnless(os.name == 'nt' or Path('/proc/self/stat').exists(), 'process snapshot reads Windows or /proc')
    def test_real_process_snapshot_finds_the_shell_a_session_runs_under(self):
        id = '5f1c0a52-4a57-4c1e-9a55-3c2d7c1b7a08'
        self.transcript(id, self.project)
        pid, shell = self.shell_child()
        self.live(id, self.project, entrypoint='cli', pid=pid)
        rows = {r['SessionId']: r for r in rs.Manager(self.options('status', real_processes=True)).execute()}
        self.assertEqual(rows[id]['Source'], f'CLI · {shell}')

    @unittest.skipUnless(os.name == 'nt' or Path('/proc/self/stat').exists(), 'process snapshot reads Windows or /proc')
    def test_snapshot_and_walk_of_every_process_stay_under_50_ms(self):
        def once():
            began = time.perf_counter()
            processes = rs.process_snapshot()
            for pid in processes:
                rs.host_app_of(pid, processes)
            return time.perf_counter() - began, processes
        # The ticket's budget is for this machine. The best of a few runs keeps another suite sharing the machine from
        # deciding the result, and REMOTE_SESSIONS_SNAPSHOT_BUDGET_MS widens it on a slower or loaded host (CI, WSL).
        # No command times the snapshot alone, so this one test calls the engine's snapshot and walk directly.
        budget = float(os.environ.get('REMOTE_SESSIONS_SNAPSHOT_BUDGET_MS') or 50) / 1000
        elapsed, processes = min((once() for _ in range(5)), key=lambda run: run[0])
        self.assertIn(os.getpid(), processes)  # A real snapshot, not an empty one that returns at once.
        self.assertLess(elapsed, budget)

    def test_archived_desktop_session_the_picker_tracks_stays_hidden_and_never_resumes(self):
        task = self.new()
        self.run_manager('stop')
        self.desktop_session(task['SessionId'], task['WorkingDirectory'], archived=True)
        self.assertNotIn(task['SessionId'], self.rows_by_id())
        with self.assertRaisesRegex(ValueError, 'archived'):
            self.run_manager('resume', '--session-id', task['SessionId'])
        with self.assertRaisesRegex(ValueError, 'no available task'):
            self.run_manager('start')
        self.assertEqual(self.data()['Starts'], 1)

    def test_every_status_row_carries_the_same_fields(self):
        saved, bare = '5f1c0a52-4a57-4c1e-9a55-3c2d7c1b9b21', '5f1c0a52-4a57-4c1e-9a55-3c2d7c1b9b22'
        tracked = self.new()
        history = next((self.config / 'projects').glob(f"*/{tracked['SessionId']}.jsonl"))
        history.rename(history.with_suffix('.parked'))  # Tracked by the picker, transcript not saved yet.
        self.transcript(saved, self.project)
        self.live(bare, self.project, kind='background', state='working')  # Live, transcript not saved yet.
        rows = self.rows_by_id()
        self.assertEqual({key: sorted(rows[key]) for key in (tracked['SessionId'], bare)},
                         {key: sorted(rows[saved]) for key in (tracked['SessionId'], bare)})

    def test_each_state_maps_to_its_circle_and_remote_shows_only_a_registered_bridge(self):
        tree = Path(self.run_manager('workspace', '--task', 'circles')[0]['WorkingDirectory'])
        other = Path(self.run_manager('workspace', '--task', 'older')[0]['WorkingDirectory'])
        clash = Path(self.run_manager('workspace', '--task', 'clash')[0]['WorkingDirectory'])
        id = lambda n: f'5f1c0a52-4a57-4c1e-9a55-3c2d7c1b9c{n:02d}'
        self.transcript(id(1), tree)
        self.live(id(1), tree, kind='background', state='working', bridge='session_working')
        self.live(id(2), self.project, kind='background', state='idle')
        self.live(id(3), self.project, entrypoint='claude-vscode', status='busy', bridge='session_vscode')
        self.transcript(id(4), other, timestamp='2026-02-01T00:00:00Z')
        self.transcript(id(5), other, timestamp='2025-12-01T00:00:00Z')
        self.transcript(id(6), clash, dict(), dict(type='assistant', cwd=str(tree)), dict(type='user', cwd=str(clash)))
        rows = self.rows_by_id()
        self.assertEqual({n: (rows[id(n)]['Circle'], rows[id(n)]['Remote']) for n in range(1, 7)}, {
            1: ('🟢', '📡'), 2: ('🟡', ''), 3: ('🟣', '📡'), 4: ('🔵', ''), 5: ('⚫', ''), 6: ('🔴', '')})

    def test_background_states_map_to_their_circles_even_once_the_process_ends(self):
        id = lambda n: f'5f1c0a52-4a57-4c1e-9a55-3c2d7c1b8a{n:02d}'
        self.transcript(id(1), self.project)
        self.live(id(1), self.project, kind='background', state='failed')
        self.live(id(2), self.project, kind='background', state='failed')  # Failed before Claude saved a transcript.
        data = self.data()
        data['Agents'][-1]['pid'] = None
        self.change(Agents=data['Agents'])
        self.live(id(3), self.project, kind='background', state='blocked', status='idle')  # Waiting on Justin's reply.
        self.live(id(4), self.project, kind='background', state='done', status='idle')  # Finished its turn; process alive.
        self.live(id(5), self.project, kind='background', state='error')
        data = self.data()
        for agent in data['Agents']:
            agent['id'] = agent['sessionId'][-8:]  # Claude's short agent IDs are distinct.
        self.change(Agents=data['Agents'])
        rows = self.rows_by_id()
        self.assertEqual({n: (rows[id(n)]['Circle'], rows[id(n)]['Stoppable']) for n in range(1, 6)}, {
            1: ('🔴', False), 2: ('🔴', False), 3: ('🟡', True), 4: ('🟡', True), 5: ('🔴', True)})
        self.assertEqual(sorted(r['SessionId'] for r in self.run_manager('stop')), [id(3), id(4), id(5)])

    def test_worktree_whose_checkout_is_missing_is_history_not_an_error(self):
        ghost = self.project / '.claude' / 'worktrees' / 'brain-ghost'
        ghost.mkdir(parents=True)
        id = '5f1c0a52-4a57-4c1e-9a55-3c2d7c1b8b01'
        self.transcript(id, ghost)
        row = self.rows_by_id()[id]
        self.assertEqual((row['Circle'], row['Available']), ('⚫', False))

    def test_unreadable_session_file_leaves_the_session_listed_without_registration(self):
        id = '5f1c0a52-4a57-4c1e-9a55-3c2d7c1b8b02'
        self.transcript(id, self.project)
        self.live(id, self.project, kind='background', bridge='session_locked')
        pid_file = self.config / 'sessions' / f"{self.data()['Agents'][0]['pid']}.json"
        pid_file.unlink()
        pid_file.mkdir()  # Opening it fails with an OSError, as a locked file does on Windows.
        row = self.rows_by_id()[id]
        self.assertEqual((row['Circle'], row['Remote'], row['Stoppable']), ('🟡', '', True))

    def test_second_load_reparses_no_unchanged_desktop_store_file(self):
        id = '5f1c0a52-4a57-4c1e-9a55-3c2d7c1b8b03'
        self.transcript(id, self.project)
        self.desktop_session(id, self.project, title='Desktop title')
        self.assertEqual(self.rows_by_id()[id]['Title'], 'Desktop title')
        entry = next(self.desktop.rglob(f'local_{id}.json'))
        stat = entry.stat()
        entry.write_text(entry.read_text().replace('Desktop title', 'Desktop tutle'))
        os.utime(entry, ns=(stat.st_atime_ns, stat.st_mtime_ns))
        self.assertEqual(self.rows_by_id()[id]['Title'], 'Desktop title')
        os.utime(entry, ns=(stat.st_atime_ns, stat.st_mtime_ns + 1_000_000_000))
        self.assertEqual(self.rows_by_id()[id]['Title'], 'Desktop tutle')

    def test_archived_desktop_sessions_are_not_listed(self):
        kept, archived = '5f1c0a52-4a57-4c1e-9a55-3c2d7c1b9d01', '5f1c0a52-4a57-4c1e-9a55-3c2d7c1b9d02'
        for id in (kept, archived):
            self.transcript(id, self.project)
        self.desktop_session(kept, self.project, title='Kept chat')
        self.desktop_session(archived, self.project, archived=True)
        self.assertEqual([(r['SessionId'], r['Task']) for r in self.run_manager('status')], [(kept, 'Kept chat')])
        self.assertEqual([r['SessionId'] for r in self.run_manager('sessions')], [kept])

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
