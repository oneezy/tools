"""Run with python -m unittest discover -s tests -p test_portable.py -v."""
import argparse
from contextlib import redirect_stdout
from datetime import datetime, timezone
import io
import json
import os
from pathlib import Path
import shutil
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
        wt.git(self.project, 'init', '-b', 'dev')
        wt.git(self.project, 'config', 'user.name', 'Fixture')
        wt.git(self.project, 'config', 'user.email', 'fixture@example.invalid')
        (self.project / '.gitignore').write_text('.claude/worktrees/\n')
        wt.git(self.project, 'add', '.')
        wt.git(self.project, 'commit', '-m', 'fixture')

    def options(self, *args, only=('brain',)):
        return rs.parser().parse_args([*args, '--root', str(self.root), '--config', str(self.config), '--claude', str(FAKE),
                                       '--desktop-sessions', str(self.desktop), *(['--only', *only] if only else [])])

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

    def live(self, id, cwd, kind='interactive', entrypoint=None, bridge=None, **fields):
        """A session Claude lists as live, with the per-pid session file its process writes."""
        data = self.data()
        pid = 7000 + len(data['Agents'])
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
        first = self.run_manager('workspace', '--type', 'fix', '--issue', '31', '--task', 'Picker speed')[0]
        self.assertEqual(Path(first['WorkingDirectory']).name, 'brain-fix-31-picker-speed')
        self.assertEqual(first['Branch'], 'fix/31-picker-speed')
        self.assertEqual(wt.git(first['WorkingDirectory'], 'branch', '--show-current').stdout.strip(), 'fix/31-picker-speed')
        again = self.run_manager('workspace', '--type', 'fix', '--issue', '31', '--task', 'Picker speed')[0]
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
        for circle, source, branch in (('🟢', 'Background', 'feature/aligned'), ('🟣', 'VS Code ext', 'dev'), ('🔵', 'CLI', 'dev')):
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
        self.assertEqual(Path(first['WorkingDirectory']).name, 'brain-feature-fix-touch-surprise-echo-nope-quote-s')
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

    def planned(self, *args):
        workspace = self.run_manager('workspace', *args, '--plan')[0]
        return Path(workspace['WorkingDirectory']).name, workspace['Branch']

    def test_task_names_use_the_given_branch_type_strip_path_traversal_and_never_use_codex(self):
        self.assertEqual(self.planned('--issue', '2', '--task', '../../Fix login'), ('brain-feature-2-fix-login', 'feature/2-fix-login'))
        self.assertEqual(self.planned('--type', 'fix', '--issue', '2', '--task', 'Login'), ('brain-fix-2-login', 'fix/2-login'))
        # The task is a description; it never supplies a branch type.
        self.assertEqual(self.planned('--task', 'fix-31-picker-speed'), ('brain-feature-fix-31-picker-speed', 'feature/fix-31-picker-speed'))
        self.assertEqual(self.planned('--type', 'docs', '--pr', '20'), ('brain-docs-20', 'docs/20'))
        with self.assertRaises(ValueError):
            self.planned('--task', '...')

    def test_an_explicit_branch_alone_names_the_folder_after_itself(self):
        self.assertEqual(self.planned('--branch', 'codex/foo'), ('brain-codex-foo', 'codex/foo'))
        self.assertEqual(self.planned('--branch', 'fix/31-speed'), ('brain-fix-31-speed', 'fix/31-speed'))

    def press_n(self, *answers):
        """Picker N answered with branch type, issue number and description, then Q."""
        manager = rs.Manager(self.options('menu'))
        replies = iter(answers)
        with patch.object(rs.sys.stdin, 'isatty', return_value=True), patch.object(rs, 'keypress', side_effect=['n', 'q']), \
                patch('builtins.input', side_effect=lambda prompt='': next(replies)), patch('builtins.print'):
            rs.menu(manager)

    def test_picker_n_prompts_for_type_issue_and_description_and_uses_the_hook_names(self):
        self.press_n('fix', '31', 'Picker speed')
        folder = self.project / '.claude' / 'worktrees' / 'brain-fix-31-picker-speed'
        self.assertEqual(wt.git(folder, 'branch', '--show-current').stdout.strip(), 'fix/31-picker-speed')
        self.assertTrue(wt.same(self.data()['LastDirectory'], folder))
        self.assertEqual(self.data()['Starts'], 1)

    def test_picker_n_and_the_cli_give_the_same_names_for_the_same_answers(self):
        self.press_n('', '', 'fix-31-picker-speed')
        folder = self.project / '.claude' / 'worktrees' / 'brain-feature-fix-31-picker-speed'
        self.assertEqual(wt.git(folder, 'branch', '--show-current').stdout.strip(), 'feature/fix-31-picker-speed')
        again = self.run_manager('workspace', '--task', 'fix-31-picker-speed')[0]
        self.assertEqual((again['Operation'], Path(again['WorkingDirectory'])), ('reuse', folder))

    def test_picker_n_with_a_blank_description_and_no_issue_cancels(self):
        self.press_n('', '', '')
        self.assertEqual(len(wt.worktrees(self.project)), 1)
        self.assertEqual(self.data()['Starts'], 0)

    def test_same_issue_and_description_with_another_branch_type_is_another_task(self):
        fix = self.run_manager('start', '--type', 'fix', '--issue', '31', '--task', 'speed')[0]
        docs = self.run_manager('start', '--type', 'docs', '--issue', '31', '--task', 'speed')[0]
        self.assertNotEqual(docs['SessionId'], fix['SessionId'])
        self.assertEqual(Path(docs['WorkingDirectory']).name, 'brain-docs-31-speed')
        self.assertEqual(wt.git(docs['WorkingDirectory'], 'branch', '--show-current').stdout.strip(), 'docs/31-speed')
        # The same branch spelled another way is the same task.
        again = self.run_manager('start', '--branch', 'fix/31-speed')[0]
        self.assertEqual(again['SessionId'], fix['SessionId'])
        self.assertEqual(len(wt.worktrees(self.project)), 3)

    def test_a_task_whose_branch_took_a_collision_suffix_is_found_by_the_branch_it_asked_for(self):
        stale = self.project / '.claude' / 'worktrees' / 'stale'
        wt.git(self.project, 'worktree', 'add', '-b', 'fix/31-speed', str(stale), 'dev')
        shutil.rmtree(stale)  # The stale registration keeps fix/31-speed from being checked out again.
        first = self.run_manager('start', '--type', 'fix', '--issue', '31', '--task', 'speed')[0]
        self.assertEqual(first['Branch'], 'fix/31-speed-2')
        again = self.run_manager('start', '--branch', 'fix/31-speed')[0]
        self.assertEqual(again['SessionId'], first['SessionId'])
        self.assertEqual(self.data()['Starts'], 1)

    def test_a_worktree_made_for_the_branch_after_planning_is_reused_not_duplicated(self):
        # Another process (the WorktreeCreate hook) wins the race between the picker's plan and its creation.
        for action, number in (('workspace', 31), ('start', 32)):
            with self.subTest(action=action):
                rival = self.project / '.claude' / 'worktrees' / f'rival-{number}'
                def rival_creates_it(project):
                    wt.git(project, 'worktree', 'add', '-b', f'fix/{number}-speed', str(rival), 'dev')
                with patch.object(wt, 'refresh_dev', side_effect=rival_creates_it):
                    result = self.run_manager(action, '--type', 'fix', '--issue', str(number), '--task', 'speed')[0]
                self.assertTrue(wt.same(result['WorkingDirectory'], rival))
                self.assertFalse((self.project / '.claude' / 'worktrees' / f'brain-fix-{number}-speed').exists())
        self.assertTrue(wt.same(self.data()['LastDirectory'], rival))

    def test_branch_type_alone_names_no_task(self):
        folder = self.run_manager('workspace', '--task', 'legacy')[0]['WorkingDirectory']
        id = '5f1c0a52-4a57-4c1e-9a55-3c2d7c1b9e06'
        rs.write_json(self.state_file(), dict(Version=2, Sessions={id: dict(Project='brain', WorkingDirectory=folder, NewSession=True)}))
        for action in ('start', 'workspace'):
            with self.assertRaisesRegex(ValueError, 'issue number or a description'):
                self.run_manager(action, '--type', 'fix')
        self.assertEqual(self.data()['Starts'], 0)

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
