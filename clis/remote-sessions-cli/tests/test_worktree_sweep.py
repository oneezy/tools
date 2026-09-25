"""The cleanup sweep, driven from outside: its command line, the WorktreeCreate hook that starts it, and the picker rows
it flags. GitHub is a fake gh executable, Claude the fake claude; the repos, their origin and the worktrees are real Git."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest

HERE = Path(__file__).resolve().parent
SWEEP = HERE.parent / 'worktree_sweep.py'
HOOK = HERE.parent / 'worktree_hook.py'
FAKE_GH = HERE / 'fake_gh.py'
FAKE_CLAUDE = HERE / 'fake_claude.py'


def git(directory, *args):
    result = subprocess.run(['git', '-C', str(directory), *args], capture_output=True, text=True)
    if result.returncode:
        raise AssertionError(result.stderr)
    return result.stdout.strip()


class SweepFixture(unittest.TestCase):
    def setUp(self):
        # A background sweep may still be finishing when a test ends; its leftovers must not fail the test.
        temp = tempfile.TemporaryDirectory(prefix="sweep test's ", ignore_cleanup_errors=True)
        self.addCleanup(temp.cleanup)
        self.temp = Path(temp.name)
        self.config = self.temp / 'config'
        self.config.mkdir()
        (self.config / 'fake-native.json').write_text(json.dumps(dict(Agents=[], Starts=0, Stops=0, Mode='normal')))
        self.github = self.temp / 'fake-gh.json'
        self.github.write_text(json.dumps(dict(PullRequests=[], Issues={}, Calls=[])))
        self.env = dict(os.environ, CLAUDE_CONFIG_DIR=str(self.config), FAKE_GH_DATA=str(self.github),
                        REMOTE_SESSIONS_GH=str(FAKE_GH), REMOTE_SESSIONS_CLAUDE=str(FAKE_CLAUDE), PYTHONIOENCODING='utf-8')
        self.repo = self.make_repo('brain')

    def make_repo(self, name):
        """A main checkout on dev whose origin is a bare repo on disk."""
        origin = self.temp / f'{name}.git'
        git(self.temp, 'init', '-q', '--bare', '-b', 'dev', str(origin))
        repo = self.temp / 'projects' / name
        repo.mkdir(parents=True)
        git(repo, 'init', '-q', '-b', 'dev')
        git(repo, 'config', 'user.name', 'Fixture')
        git(repo, 'config', 'user.email', 'fixture@example.invalid')
        (repo / '.gitignore').write_text('.claude/worktrees/\nnode_modules/\n')
        git(repo, 'add', '.')
        git(repo, 'commit', '-q', '-m', 'fixture')
        git(repo, 'remote', 'add', 'origin', str(origin))
        git(repo, 'push', '-q', '-u', 'origin', 'dev')
        return repo

    def task(self, branch, repo=None, pushed=True):
        """A task worktree under .claude/worktrees with one commit of its own, pushed to origin unless told otherwise."""
        repo = repo or self.repo
        folder = repo / '.claude' / 'worktrees' / f"{repo.name}-{branch.replace('/', '-')}"
        git(repo, 'worktree', 'add', '-q', '-b', branch, str(folder), 'dev')
        (folder / 'work.txt').write_text(branch)
        git(folder, 'add', '.')
        git(folder, 'commit', '-q', '-m', f'work on {branch}')
        if pushed:
            git(folder, 'push', '-q', '-u', 'origin', branch)
        return folder

    def github_data(self):
        return json.loads(self.github.read_text(encoding='utf-8'))

    def set_github(self, **fields):
        data = self.github_data()
        data.update(fields)
        self.github.write_text(json.dumps(data), encoding='utf-8')

    def merged(self, folder, number, base='dev'):
        """GitHub records a merged PR from the folder's branch, whose head is the branch as it is now."""
        pulls = self.github_data()['PullRequests']
        pulls.append(dict(number=number, headRefName=git(folder, 'branch', '--show-current'), baseRefName=base, state='MERGED',
                          headRefOid=git(folder, 'rev-parse', 'HEAD')))
        self.set_github(PullRequests=pulls)

    def ticket(self, number, state='CLOSED'):
        issues = self.github_data()['Issues']
        issues[str(number)] = state
        self.set_github(Issues=issues)

    def sweep(self, repo=None, *keep):
        result = subprocess.run([sys.executable, str(SWEEP), str(repo or self.repo), *(a for k in keep for a in ('--keep', str(k))),
                                 '--json'], capture_output=True, text=True, encoding='utf-8', env=self.env)
        return result

    def swept(self, repo=None, *keep):
        result = self.sweep(repo, *keep)
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def branches(self, repo=None):
        return git(repo or self.repo, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/').split()

    def registered(self, folder, repo=None):
        listing = git(repo or self.repo, 'worktree', 'list', '--porcelain')
        return any(Path(line.removeprefix('worktree ')) == folder for line in listing.splitlines() if line.startswith('worktree '))

    def live(self, folder, kind):
        """A session Claude lists as live in the folder: a background one, or one open in another app."""
        data = json.loads((self.config / 'fake-native.json').read_text())
        agent = dict(sessionId=f'0000000{len(data["Agents"])}-0000-4000-8000-000000000000', kind=kind, cwd=str(folder),
                     pid=7000 + len(data['Agents']))
        if kind == 'background':
            agent.update(id=agent['sessionId'][:8], state='idle')
        else:
            agent.update(status='idle')
        data['Agents'].append(agent)
        (self.config / 'fake-native.json').write_text(json.dumps(data))

    def native(self):
        return json.loads((self.config / 'fake-native.json').read_text())


class SweepTests(SweepFixture):
    def test_merged_and_clean_worktree_is_removed_with_its_local_branch(self):
        folder = self.task('fix/31-picker-speed')
        self.merged(folder, 12)
        report = self.swept()
        self.assertFalse(folder.exists())
        self.assertFalse(self.registered(folder))
        self.assertNotIn('fix/31-picker-speed', self.branches())
        self.assertEqual([r['Branch'] for r in report['Removed']], ['fix/31-picker-speed'])

    def test_squash_merged_worktree_whose_remote_branch_was_deleted_is_removed(self):
        # oneezy-merge squash-merges, then deletes the remote branch: origin no longer holds the commits, the PR does.
        folder = self.task('feature/12-sweep')
        self.merged(folder, 13)
        git(self.repo, 'push', '-q', 'origin', '--delete', 'feature/12-sweep')
        self.swept()
        self.assertFalse(folder.exists())
        self.assertNotIn('feature/12-sweep', self.branches())

    def test_worktree_whose_ticket_closed_is_removed_once_its_work_is_pushed(self):
        folder = self.task('research/40-sweep-cost')
        self.ticket(40)
        report = self.swept()
        self.assertFalse(folder.exists())
        self.assertNotIn('research/40-sweep-cost', self.branches())
        self.assertEqual(report['Removed'][0]['Why'], 'ticket #40 closed')

    def test_ignored_files_such_as_node_modules_do_not_keep_a_merged_worktree(self):
        folder = self.task('fix/31-picker-speed')
        (folder / 'node_modules' / 'left-pad').mkdir(parents=True)
        (folder / 'node_modules' / 'left-pad' / 'index.js').write_text('module.exports = 1')
        self.merged(folder, 12)
        self.swept()
        self.assertFalse(folder.exists())

    def test_worktree_with_uncommitted_changes_is_kept_and_flagged(self):
        folder = self.task('fix/31-picker-speed')
        self.merged(folder, 12)
        (folder / 'draft.txt').write_text('not committed')
        report = self.swept()
        self.assertTrue((folder / 'draft.txt').exists())
        self.assertIn('fix/31-picker-speed', self.branches())
        self.assertEqual([(k['Branch'], k['Status']) for k in report['Kept']], [('fix/31-picker-speed', 'error')])
        self.assertIn('uncommitted', report['Kept'][0]['Detail'])

    def test_worktree_with_unpushed_commits_is_kept_and_flagged(self):
        folder = self.task('fix/31-picker-speed', pushed=False)
        self.ticket(31)
        report = self.swept()
        self.assertTrue(folder.exists())
        self.assertIn('fix/31-picker-speed', self.branches())
        self.assertEqual(report['Kept'][0]['Status'], 'error')
        self.assertIn('1 unpushed commit', report['Kept'][0]['Detail'])

    def test_work_committed_after_the_merge_keeps_the_worktree(self):
        folder = self.task('fix/31-picker-speed')
        self.merged(folder, 12)
        (folder / 'more.txt').write_text('follow-up')
        git(folder, 'add', '.')
        git(folder, 'commit', '-q', '-m', 'follow-up')
        git(folder, 'push', '-q')
        report = self.swept()
        self.assertTrue(folder.exists())
        self.assertIn('fix/31-picker-speed', self.branches())
        self.assertEqual(report['Removed'], [])

    def test_prototype_worktree_is_kept_even_when_its_ticket_closed(self):
        folder = self.task('prototype/33-tray-icon')
        self.ticket(33)
        self.merged(folder, 14)
        report = self.swept()
        self.assertTrue(folder.exists())
        self.assertIn('prototype/33-tray-icon', self.branches())
        self.assertEqual((report['Removed'], report['Kept']), ([], []))

    def test_open_work_is_left_alone(self):
        open_ticket = self.task('fix/31-picker-speed')
        self.ticket(31, 'OPEN')
        merged_elsewhere = self.task('fix/32-tray')
        self.merged(merged_elsewhere, 15, base='feature/30-picker')
        legacy = self.task('codex/remote-7026bdbd')
        report = self.swept()
        self.assertTrue(all(f.exists() for f in (open_ticket, merged_elsewhere, legacy)))
        self.assertEqual((report['Removed'], report['Kept']), ([], []))

    def test_ticket_closed_after_its_pr_merged_into_another_branch_counts_the_pr_as_saving_the_work(self):
        # An autopilot ticket lands in its autopilot branch, then closes; its remote branch is already gone.
        folder = self.task('feature/34-rows')
        self.merged(folder, 16, base='feature/30-picker')
        git(self.repo, 'push', '-q', 'origin', '--delete', 'feature/34-rows')
        self.ticket(34)
        self.swept()
        self.assertFalse(folder.exists())

    def test_background_session_in_a_merged_worktree_is_stopped_before_removal(self):
        folder = self.task('fix/31-picker-speed')
        self.merged(folder, 12)
        self.live(folder, 'background')
        report = self.swept()
        self.assertFalse(folder.exists())
        self.assertEqual(self.native()['Stops'], 1)
        self.assertEqual(self.native()['Agents'][0]['state'], 'stopped')
        self.assertEqual(report['Removed'][0]['Stopped'], [self.native()['Agents'][0]['sessionId']])

    def test_session_live_in_another_app_keeps_the_worktree_as_merged(self):
        folder = self.task('fix/31-picker-speed')
        self.merged(folder, 12)
        self.live(folder, 'interactive')
        report = self.swept()
        self.assertTrue(folder.exists())
        self.assertEqual(self.native()['Stops'], 0)
        self.assertEqual([(k['Branch'], k['Status']) for k in report['Kept']], [('fix/31-picker-speed', 'merged')])

    def test_unsaved_work_is_flagged_as_error_even_when_an_app_has_the_session_open(self):
        folder = self.task('fix/31-picker-speed')
        self.merged(folder, 12)
        (folder / 'draft.txt').write_text('not committed')
        self.live(folder, 'interactive')
        self.assertEqual(self.swept()['Kept'][0]['Status'], 'error')

    def test_kept_folder_is_never_touched(self):
        folder = self.task('fix/31-picker-speed')
        self.merged(folder, 12)
        report = self.swept(None, folder / 'src')
        self.assertTrue(folder.exists())
        self.assertEqual((report['Removed'], report['Kept']), ([], []))

    def test_github_failure_removes_nothing(self):
        folder = self.task('fix/31-picker-speed')
        self.merged(folder, 12)
        self.set_github(Mode='failure')
        result = self.sweep()
        self.assertNotEqual(result.returncode, 0)
        self.assertTrue(folder.exists())
        self.assertIn('fix/31-picker-speed', self.branches())
        self.assertIn('api.github.com', json.loads(result.stdout)['Error'])


class PickerFlagTests(SweepFixture):
    """The picker shows what the last sweep kept: 🔴 when unsaved work blocks removal, ✅ when only an open app does."""

    def status(self):
        result = subprocess.run([sys.executable, str(HERE.parent / 'remote_sessions.py'), 'status', '--json', '--only', 'brain',
                                 '--root', str(self.repo.parent), '--config', str(self.config), '--claude', str(FAKE_CLAUDE),
                                 '--desktop-sessions', str(self.temp / 'no-desktop')],
                                capture_output=True, text=True, encoding='utf-8', env=self.env)
        self.assertEqual(result.returncode, 0, result.stderr)
        return {Path(r['WorkingDirectory']).name: r for r in json.loads(result.stdout)}

    def conversation(self, id, folder):
        history = self.config / 'projects' / 'planted'
        history.mkdir(parents=True, exist_ok=True)
        (history / f'{id}.jsonl').write_text(json.dumps(dict(type='user', sessionId=id, cwd=str(folder), timestamp='2026-01-01T00:00:00Z')))

    def test_worktree_kept_for_unsaved_work_shows_red_and_one_kept_for_an_open_app_shows_merged(self):
        unsaved = self.task('fix/31-picker-speed')
        self.merged(unsaved, 12)
        (unsaved / 'draft.txt').write_text('not committed')
        self.conversation('11111111-1111-4111-8111-111111111111', unsaved)
        waiting = self.task('fix/32-tray')
        self.merged(waiting, 13)
        self.live(waiting, 'interactive')
        active = self.task('fix/33-wsl')
        self.conversation('33333333-3333-4333-8333-333333333333', active)
        before = self.status()
        self.assertEqual((before[unsaved.name]['Circle'], before[waiting.name]['Circle']), ('🔵', '🟣'))
        self.swept()
        rows = self.status()
        self.assertEqual((rows[unsaved.name]['Status'], rows[unsaved.name]['Circle']), ('error', '🔴'))
        self.assertEqual((rows[waiting.name]['Status'], rows[waiting.name]['Circle']), ('merged', '✅'))
        self.assertTrue(rows[waiting.name]['ViewOnly'])
        self.assertEqual(rows[active.name]['Circle'], '🔵')

    def test_flag_lapses_once_the_folder_has_another_branch_checked_out(self):
        unsaved = self.task('fix/31-picker-speed')
        self.merged(unsaved, 12)
        (unsaved / 'draft.txt').write_text('not committed')
        self.conversation('11111111-1111-4111-8111-111111111111', unsaved)
        self.swept()
        git(unsaved, 'switch', '-q', '-c', 'fix/34-next')
        self.assertEqual(self.status()[unsaved.name]['Circle'], '🔵')


class HookSweepTests(SweepFixture):
    """The WorktreeCreate hook starts the sweep after it creates a worktree, in the background."""

    def hook(self, name, cwd=None):
        payload = json.dumps(dict(session_id='abc123', transcript_path='/unused.jsonl', cwd=str(cwd or self.repo),
                                  hook_event_name='WorktreeCreate', name=name))
        started = time.monotonic()
        result = subprocess.run([sys.executable, str(HOOK)], input=payload, capture_output=True, text=True, encoding='utf-8',
                                cwd=str(cwd or self.repo), env=self.env, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr)
        return Path(result.stdout.strip().splitlines()[-1]), time.monotonic() - started

    def report(self, repo=None):
        """The sweep's saved report, once a sweep has finished in that repo."""
        file = Path(git(repo or self.repo, 'rev-parse', '--path-format=absolute', '--git-common-dir')) / 'worktree-sweep.json'
        return json.loads(file.read_text(encoding='utf-8')) if file.exists() else None

    def wait_for_report(self, repo=None, timeout=45):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            try:
                report = self.report(repo)
            except ValueError:
                report = None  # Caught mid-write.
            if report:
                return report
            time.sleep(.2)
        self.fail('The background sweep never finished.')

    def test_creating_a_worktree_sweeps_merged_ones_in_that_repo(self):
        done = self.task('fix/31-picker-speed')
        self.merged(done, 12)
        created, _ = self.hook('fix-32-tray')
        report = self.wait_for_report()
        self.assertFalse(done.exists())
        self.assertNotIn('fix/31-picker-speed', self.branches())
        self.assertTrue(created.is_dir())
        self.assertEqual([r['Branch'] for r in report['Removed']], ['fix/31-picker-speed'])

    def test_sweep_touches_only_the_repo_where_the_worktree_was_created(self):
        other = self.make_repo('tools')
        elsewhere = self.task('fix/31-picker-speed', repo=other)
        here = self.task('fix/31-picker-speed')
        self.merged(here, 12)  # Both branches share a name; GitHub answers the same for both.
        self.hook('fix-32-tray')
        self.wait_for_report()
        self.assertFalse(here.exists())
        self.assertTrue(elsewhere.exists())
        self.assertIn('fix/31-picker-speed', self.branches(other))
        self.assertIsNone(self.report(other))
        self.assertTrue(all(Path(c['Cwd']) == self.repo for c in self.github_data()['Calls']))

    def test_hook_returns_before_the_sweep_hears_from_github(self):
        done = self.task('fix/31-picker-speed')
        self.merged(done, 12)
        hold = self.temp / 'github-is-slow'
        hold.write_text('')
        self.set_github(Hold=str(hold))
        created, took = self.hook('fix-32-tray')
        self.assertTrue(created.is_dir())
        # The hook is back while GitHub still holds the sweep: nothing has been removed yet.
        deadline = time.monotonic() + 30
        while not self.github_data()['Calls'] and time.monotonic() < deadline:
            time.sleep(.1)
        self.assertTrue(self.github_data()['Calls'], 'the sweep never asked GitHub')
        self.assertTrue(done.exists())
        self.assertIsNone(self.report())
        self.assertLess(took, 10)
        hold.unlink()
        self.wait_for_report()
        self.assertFalse(done.exists())

    def test_the_new_worktree_and_the_requesting_session_folder_are_never_swept(self):
        requester = self.task('fix/31-picker-speed')
        self.merged(requester, 12)
        done = self.task('fix/32-tray')
        self.merged(done, 13)
        git(self.repo, 'branch', 'fix/33-restored', 'dev')
        restored_tip = git(self.repo, 'rev-parse', 'fix/33-restored')
        self.ticket(33)
        # A subagent of the session in the merged worktree asks for a worktree on an existing branch whose ticket closed.
        created, _ = self.hook('fix-33-restored', cwd=requester)
        report = self.wait_for_report()
        self.assertTrue(requester.exists())
        self.assertTrue(created.is_dir())
        self.assertEqual(git(created, 'rev-parse', 'HEAD'), restored_tip)
        self.assertFalse(done.exists())
        self.assertEqual([r['Branch'] for r in report['Removed']], ['fix/32-tray'])


if __name__ == '__main__':
    unittest.main()
