"""The repo's agent rules: branch retention follows Matt Pocock's skills, and every oneezy-merge copy agrees."""
from pathlib import Path
import os
import re
import unittest


def find_repo():
    """The tools checkout holding these tests, or None when the suite runs from a copy (tests/test-linux.sh)."""
    here = Path(__file__).resolve()
    return next((p for p in here.parents if (p / '.git').exists() and (p / 'AGENTS.md').is_file()), None)


REPO = find_repo()


def merge_copies():
    """Every harness's copy of oneezy-merge in this repo (.claude, .agents, and any other dot-folder)."""
    return sorted(p for p in REPO.glob('.*/skills/oneezy-merge') if p.is_dir())


def files_under(folder):
    return {p.relative_to(folder).as_posix(): p.read_bytes() for p in folder.rglob('*') if p.is_file()}


def rules_files():
    """AGENTS.md and CLAUDE.md files anywhere in the repo, outside Git, worktrees, skill copies and dependencies."""
    found = []
    for folder, dirs, files in os.walk(REPO):
        dirs[:] = [d for d in dirs if d not in ('.git', 'worktrees', 'skills', 'node_modules')]
        found += [Path(folder) / name for name in ('AGENTS.md', 'CLAUDE.md') if name in files]
    return found


@unittest.skipIf(REPO is None, 'the suite runs from a copy outside the tools checkout')
class AgentRulesTests(unittest.TestCase):
    def test_every_oneezy_merge_copy_in_the_repo_is_identical(self):
        copies = merge_copies()
        self.assertGreaterEqual(len(copies), 2, copies)
        first = files_under(copies[0])
        for other in copies[1:]:
            self.assertEqual(first, files_under(other), f'{other} differs from {copies[0]}')

    def test_oneezy_merge_land_mode_keeps_prototype_branches_and_deletes_the_rest(self):
        skill = (merge_copies()[0] / 'SKILL.md').read_text(encoding='utf-8')
        land = next(line for line in skill.splitlines() if line.startswith('- **land**'))
        self.assertIn('`prototype/*`', land)
        self.assertRegex(land, r'delete')
        step = next(line for line in skill.splitlines() if line.startswith('4. **Land**'))
        self.assertIn('`prototype/*`', step)

    def test_oneezy_merge_land_mode_is_justins_ok_to_delete(self):
        skill = (merge_copies()[0] / 'SKILL.md').read_text(encoding='utf-8')
        land = next(line for line in skill.splitlines() if line.startswith('- **land**'))
        self.assertRegex(land, r"Justin's OK to delete")

    def test_no_rules_file_overrides_a_skills_branch_retention(self):
        files = rules_files()
        self.assertIn(REPO / 'AGENTS.md', files)
        for path in files:
            text = path.read_text(encoding='utf-8')
            self.assertNotRegex(text, re.compile(r'keep\w*\s+(the\s+)?(research|prototype)\b[^.\n]*branch', re.I), path)
            self.assertNotRegex(text, re.compile(r'baseRef', re.I), path)


if __name__ == '__main__':
    unittest.main()
