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


def merge_skill_line(prefix):
    """The line of the first oneezy-merge copy's SKILL.md that starts with prefix."""
    skill = (merge_copies()[0] / 'SKILL.md').read_text(encoding='utf-8')
    return next(line for line in skill.splitlines() if line.startswith(prefix))


# A house rule that keeps research branches, or restates branch retention as its own rule, in any word order.
RETENTION_OVERRIDES = [
    re.compile(r'\bkeep\w*\s+(the\s+)?(research|prototype)\b[^.\n]*\bbranch', re.I),
    re.compile(r'\b(keep\w*|kept|retain\w*)\b[^.\n]*\bresearch\b[^.\n]*\bbranch', re.I),
    re.compile(r'\bresearch\b[^.\n]*\bbranch\w*\b[^.\n]*\b(keep\w*|kept|retain\w*|stays?|remains?)\b', re.I),
]


def overrides_retention(text):
    return any(pattern.search(text) for pattern in RETENTION_OVERRIDES)


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

    def test_oneezy_merge_land_mode_deletes_the_landed_branch_with_justins_ok_except_prototype(self):
        land = merge_skill_line('- **land**')
        self.assertRegex(land, r"delete the landed branch \(Justin's OK; a `prototype/\*` branch stays\b")
        self.assertEqual(land.count('delete the landed branch'), 1, land)

    def test_oneezy_merge_land_step_skips_deleting_prototype_branches(self):
        step = merge_skill_line('4. **Land**')
        self.assertRegex(step, r'delete the remote branch and the local branch once, unless the branch is `prototype/\*`')

    def test_no_rules_file_overrides_a_skills_branch_retention(self):
        files = rules_files()
        self.assertIn(REPO / 'AGENTS.md', files)
        for path in files:
            text = path.read_text(encoding='utf-8')
            self.assertFalse(overrides_retention(text), path)
            self.assertNotRegex(text, re.compile(r'baseRef', re.I), path)


class RetentionOverrideDetectorTests(unittest.TestCase):
    def test_catches_phrasings_that_keep_research_branches(self):
        for text in ('Keep research and prototype branches after merging.',
                     'Keep the prototype branch after landing.',
                     'Research branches are kept after merging.',
                     'Never delete a research branch; it stays for ticket links.',
                     'Retain research branches once merged.'):
            with self.subTest(text=text):
                self.assertTrue(overrides_retention(text))

    def test_allows_the_skills_own_retention_rule(self):
        for text in ('Once landed, a branch is deleted unless it is `prototype/*`, which `/prototype` keeps as a primary source.',
                     'Research findings live in the repo and are merged to `dev`.',
                     'Feature branches are deleted once landed.'):
            with self.subTest(text=text):
                self.assertFalse(overrides_retention(text))


if __name__ == '__main__':
    unittest.main()
