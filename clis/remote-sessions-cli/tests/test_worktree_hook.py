"""The WorktreeCreate hook, driven the way Claude drives it: input JSON on stdin, the path on stdout."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

HOOK = Path(__file__).resolve().parents[1] / 'worktree_hook.py'


def git_bash():
    """Git Bash on Windows (never WSL's bash.exe, which runs Linux paths), plain bash elsewhere."""
    if os.name != 'nt':
        return shutil.which('bash')
    git_exe = shutil.which('git')
    # git.exe lives in Git\cmd or Git\mingw64\bin; bash.exe in Git\bin.
    found = git_exe and next((p / 'bin' / 'bash.exe' for p in Path(git_exe).resolve().parents if (p / 'bin' / 'bash.exe').is_file()), None)
    return str(found) if found else None


BASH = git_bash()


def git(directory, *args):
    result = subprocess.run(['git', '-C', str(directory), *args], capture_output=True, text=True)
    if result.returncode:
        raise AssertionError(result.stderr)
    return result.stdout.strip()


class WorktreeHookTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix="hook test's ")
        self.addCleanup(temp.cleanup)
        self.repo = Path(temp.name) / 'brain'
        self.repo.mkdir()
        git(self.repo, 'init', '-b', 'dev')
        git(self.repo, 'config', 'user.name', 'Fixture')
        git(self.repo, 'config', 'user.email', 'fixture@example.invalid')
        (self.repo / '.gitignore').write_text('.claude/worktrees/\n')
        git(self.repo, 'add', '.')
        git(self.repo, 'commit', '-m', 'fixture')

    def payload(self, name, cwd=None):
        return json.dumps(dict(session_id='abc123', transcript_path='/unused.jsonl', cwd=str(cwd or self.repo),
                               hook_event_name='WorktreeCreate', name=name))

    def hook(self, name, cwd=None, command=None):
        return subprocess.run(command or [sys.executable, str(HOOK)], input=self.payload(name, cwd), capture_output=True,
                              text=True, encoding='utf-8', cwd=str(cwd or self.repo))

    def created(self, name, **options):
        result = self.hook(name, **options)
        self.assertEqual(result.returncode, 0, result.stderr)
        # Claude reads the last non-empty line of stdout as the worktree path.
        return Path(result.stdout.strip().splitlines()[-1])

    def branch(self, folder):
        return git(folder, 'branch', '--show-current')

    def test_unnamed_request_creates_repo_new_n_on_new_n_and_prints_its_path(self):
        folder = self.created('bold-oak-a3f2')
        self.assertTrue(folder.is_absolute())
        self.assertEqual(folder, self.repo / '.claude' / 'worktrees' / 'brain-new-1')
        self.assertTrue(folder.is_dir())
        self.assertEqual(self.branch(folder), 'new/1')

    def test_each_unnamed_request_takes_the_next_free_number(self):
        self.assertEqual(self.created('bold-oak-a3f2').name, 'brain-new-1')
        second = self.created('calm-elm-b4c1')
        self.assertEqual((second.name, self.branch(second)), ('brain-new-2', 'new/2'))

    def test_worktree_is_cut_from_local_dev_whatever_the_main_checkout_has(self):
        git(self.repo, 'switch', '-c', 'main')
        (self.repo / 'main-only.txt').write_text('main')
        git(self.repo, 'add', '.')
        git(self.repo, 'commit', '-m', 'main only')
        folder = self.created('bold-oak-a3f2')
        self.assertEqual(git(folder, 'rev-parse', 'HEAD'), git(self.repo, 'rev-parse', 'dev'))
        self.assertFalse((folder / 'main-only.txt').exists())

    def test_named_task_gets_type_issue_and_description_names(self):
        folder = self.created('fix-31-picker-speed')
        self.assertEqual(folder, self.repo / '.claude' / 'worktrees' / 'brain-fix-31-picker-speed')
        self.assertEqual(self.branch(folder), 'fix/31-picker-speed')

    def test_named_task_without_an_issue_and_branch_spelling_of_a_name(self):
        folder = self.created('docs-readme-refresh')
        self.assertEqual((folder.name, self.branch(folder)), ('brain-docs-readme-refresh', 'docs/readme-refresh'))
        folder = self.created('research/40-sweep-cost')
        self.assertEqual((folder.name, self.branch(folder)), ('brain-research-40-sweep-cost', 'research/40-sweep-cost'))

    def worktree_count(self):
        return sum(line.startswith('worktree ') for line in git(self.repo, 'worktree', 'list', '--porcelain').splitlines())

    def test_second_request_for_a_checked_out_branch_reuses_its_worktree(self):
        first = self.created('fix-31-picker-speed')
        (first / 'unsaved.txt').write_text('keep')
        self.assertEqual(self.created('fix/31-picker-speed'), first)
        self.assertEqual(self.worktree_count(), 2)
        self.assertEqual((first / 'unsaved.txt').read_text(), 'keep')

    def test_dev_belongs_in_the_main_checkout(self):
        self.assertEqual(self.created('dev'), self.repo)
        self.assertEqual(self.worktree_count(), 1)

    def test_existing_branch_that_is_not_checked_out_keeps_its_commits(self):
        git(self.repo, 'switch', '-c', 'fix/31-picker-speed')
        (self.repo / 'work.txt').write_text('work')
        git(self.repo, 'add', '.')
        git(self.repo, 'commit', '-m', 'work')
        tip = git(self.repo, 'rev-parse', 'HEAD')
        git(self.repo, 'switch', 'dev')
        folder = self.created('fix-31-picker-speed')
        self.assertEqual((self.branch(folder), git(folder, 'rev-parse', 'HEAD')), ('fix/31-picker-speed', tip))

    def test_refusals_exit_nonzero_with_no_path_on_stdout(self):
        outside = self.repo.parent / 'not-a-repo'
        outside.mkdir()
        for name, cwd in (('bold-oak-a3f2', outside), ('main', self.repo)):
            result = self.hook(name, cwd=cwd)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(result.stdout.strip(), '')
            self.assertIn('WorktreeCreate hook', result.stderr)
        self.assertEqual(self.worktree_count(), 1)

    @unittest.skipUnless(BASH,'bash not installed')
    def test_hook_runs_as_a_bash_shell_command(self):
        # Claude's default hook shell: Git Bash on Windows, bash on Linux.
        command = f"'{Path(sys.executable).as_posix()}' '{HOOK.as_posix()}'"
        self.assertEqual(self.created('fix-31-picker-speed', command=[BASH, '-c', command]).name, 'brain-fix-31-picker-speed')

    @unittest.skipUnless(shutil.which('pwsh') or shutil.which('powershell'), 'PowerShell not installed')
    def test_hook_runs_as_a_powershell_shell_command(self):
        shell = shutil.which('pwsh') or shutil.which('powershell')
        command = f"& '{sys.executable}' '{HOOK}'"
        self.assertEqual(self.created('bold-oak-a3f2', command=[shell, '-NoProfile', '-Command', command]).name, 'brain-new-1')

    def test_parallel_unnamed_requests_each_get_their_own_worktree(self):
        # A workflow spawns isolated subagents at once; none may share or fail to get a worktree.
        env = dict(os.environ, PYTHONIOENCODING='utf-8')
        runs = [subprocess.Popen([sys.executable, str(HOOK)], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                 stderr=subprocess.PIPE, text=True, encoding='utf-8', cwd=str(self.repo), env=env)
                for _ in range(6)]
        for run in runs:
            run.stdin.write(self.payload('bold-oak-a3f2'))
            run.stdin.close()
        folders = []
        for run in runs:
            out, err = run.stdout.read(), run.stderr.read()
            self.assertEqual(run.wait(), 0, err)
            folders.append(Path(out.strip().splitlines()[-1]))
        self.assertEqual(sorted(f.name for f in folders), [f'brain-new-{n}' for n in range(1, 7)])
        self.assertEqual(sorted(self.branch(f) for f in folders), [f'new/{n}' for n in range(1, 7)])
        self.assertEqual(self.worktree_count(), 7)

    def test_path_with_non_ascii_characters_reaches_claude_as_utf8(self):
        repo = self.repo.parent / 'café ✓' / 'brain'
        repo.parent.mkdir()
        shutil.move(str(self.repo), str(repo))
        env = {k: v for k, v in os.environ.items() if k not in ('PYTHONIOENCODING', 'PYTHONUTF8')}
        result = subprocess.run([sys.executable, str(HOOK)], input=self.payload('bold-oak-a3f2', repo).encode('utf-8'),
                                capture_output=True, cwd=str(repo), env=env)
        self.assertEqual(result.returncode, 0, result.stderr.decode('utf-8', 'replace'))
        folder = Path(result.stdout.decode('utf-8').strip().splitlines()[-1])
        self.assertEqual(folder, repo / '.claude' / 'worktrees' / 'brain-new-1')
        self.assertTrue(folder.is_dir())

    def clone_ahead_of_local_dev(self):
        """An origin whose dev (and a pushed task branch) moved on after this repo last fetched."""
        origin = self.repo.parent / 'origin.git'
        git(self.repo.parent, 'clone', '--bare', '-q', str(self.repo), str(origin))
        git(self.repo, 'remote', 'add', 'origin', str(origin))
        git(self.repo, 'fetch', '-q', 'origin')
        other = self.repo.parent / 'other'
        git(self.repo.parent, 'clone', '-q', str(origin), str(other))
        git(other, 'config', 'user.name', 'Fixture')
        git(other, 'config', 'user.email', 'fixture@example.invalid')
        git(other, 'commit', '-q', '--allow-empty', '-m', 'remote only')
        git(other, 'push', '-q', 'origin', 'dev')
        return other

    def test_cuts_from_local_dev_without_fetching_a_newer_origin_dev(self):
        self.clone_ahead_of_local_dev()
        known = git(self.repo, 'rev-parse', 'origin/dev')
        folder = self.created('fix-31-picker-speed')
        self.assertEqual(git(folder, 'rev-parse', 'HEAD'), git(self.repo, 'rev-parse', 'dev'))
        self.assertEqual(git(self.repo, 'rev-parse', 'origin/dev'), known)

    def test_branch_known_only_on_origin_is_checked_out_at_its_remote_commit(self):
        other = self.clone_ahead_of_local_dev()
        git(other, 'switch', '-q', '-c', 'fix/31-picker-speed')
        git(other, 'commit', '-q', '--allow-empty', '-m', 'task work')
        git(other, 'push', '-q', 'origin', 'fix/31-picker-speed')
        git(self.repo, 'fetch', '-q', 'origin')
        folder = self.created('fix-31-picker-speed')
        self.assertEqual(self.branch(folder), 'fix/31-picker-speed')
        self.assertEqual(git(folder, 'rev-parse', 'HEAD'), git(other, 'rev-parse', 'HEAD'))

    def test_request_from_inside_a_worktree_lands_under_the_main_checkout(self):
        first = self.created('bold-oak-a3f2')
        second = self.created('calm-elm-b4c1', cwd=first)
        self.assertEqual(second, self.repo / '.claude' / 'worktrees' / 'brain-new-2')


if __name__ == '__main__':
    unittest.main()
