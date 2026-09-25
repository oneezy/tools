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

    def hook(self, name, cwd=None, command=None):
        payload = dict(session_id='abc123', transcript_path='/unused.jsonl', cwd=str(cwd or self.repo),
                       hook_event_name='WorktreeCreate', name=name)
        result = subprocess.run(command or [sys.executable, str(HOOK)], input=json.dumps(payload), capture_output=True,
                                text=True, cwd=str(cwd or self.repo))
        return result

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

    def test_request_from_inside_a_worktree_lands_under_the_main_checkout(self):
        first = self.created('bold-oak-a3f2')
        second = self.created('calm-elm-b4c1', cwd=first)
        self.assertEqual(second, self.repo / '.claude' / 'worktrees' / 'brain-new-2')


if __name__ == '__main__':
    unittest.main()
