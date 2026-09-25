"""Seam 4: the delete-branch GitHub Action's script against a fake gh.

Run with python -m unittest discover -s tests -p test_delete_remote_branch.py -v.
"""
import json
import os
import re
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

TOOL = Path(__file__).resolve().parents[1]
SCRIPT = TOOL / 'scripts' / 'delete_remote_branch.py'
REPO_ROOT = TOOL.parents[1]
FAKE_GH = Path(__file__).with_name('fake_gh.py')


class DeleteRemoteBranchTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix='delete-branch ')
        self.addCleanup(temp.cleanup)
        self.state = Path(temp.name) / 'github.json'
        self.github(branches=['main', 'dev'])

    def github(self, branches, issues=None, pulls=None, protected=(), deletion_rules=(), rules_forbidden=False,
               vanishes=None, delete_fails=(), default_branch='main'):
        vanishes = vanishes or {}
        self.state.write_text(json.dumps(dict(
            Repo='oneezy/app', DefaultBranch=default_branch, RulesForbidden=rules_forbidden,
            Branches={b: dict(protected=b in protected, deletionRule=b in deletion_rules, vanishes=vanishes.get(b),
                              deleteFails=b in delete_fails) for b in branches},
            Issues={str(k): v for k, v in (issues or {}).items()}, Pulls=pulls or [], Calls=[])))

    def remote_branches(self):
        return sorted(json.loads(self.state.read_text())['Branches'])

    def event(self, succeeds=True, **env):
        inputs = ('ISSUE', 'PR_HEAD', 'PR_BASE', 'PR_MERGED', 'PR_HEAD_REPO', 'DRY_RUN', 'INTEGRATION_BRANCH', 'RELEASE_BRANCH')
        base = {k: v for k, v in os.environ.items() if k not in inputs}
        base.update(GH=str(FAKE_GH), FAKE_GH_STATE=str(self.state), REPO='oneezy/app', **env)
        result = subprocess.run([sys.executable, str(SCRIPT)], env=base, capture_output=True, text=True)
        self.assertEqual(result.returncode == 0, succeeds, result.stdout + result.stderr)
        return result.stdout + result.stderr

    def close_issue(self, number, **env):
        return self.event(EVENT='issues', ACTION='closed', ISSUE=str(number), **env)

    def test_closing_a_ticket_deletes_its_research_and_fix_branches(self):
        self.github(['main', 'dev', 'research/33-hook-triggers', 'fix/33-slow-launch', 'fix/330-other', 'feature/3-other', 'feature/34-picker'],
                    issues={33: 'closed'})
        self.close_issue(33)
        self.assertEqual(self.remote_branches(), ['dev', 'feature/3-other', 'feature/34-picker', 'fix/330-other', 'main'])

    def test_dry_run_reports_and_deletes_nothing(self):
        self.github(['main', 'dev', 'fix/33-slow-launch'], issues={33: 'closed'})
        output = self.close_issue(33, DRY_RUN='1')
        self.assertIn('would delete fix/33-slow-launch', output)
        self.assertEqual(self.remote_branches(), ['dev', 'fix/33-slow-launch', 'main'])

    def close_pr(self, head, base='dev', merged=True, head_repo='oneezy/app', **env):
        return self.event(EVENT='pull_request', ACTION='closed', PR_HEAD=head, PR_HEAD_REPO=head_repo, PR_BASE=base,
                          PR_MERGED='true' if merged else 'false', **env)

    def test_pull_request_merged_into_dev_deletes_its_branch(self):
        self.github(['main', 'dev', 'feature/12-login', 'feature/13-logout'], issues={12: 'open'})
        self.close_pr('feature/12-login')
        self.assertEqual(self.remote_branches(), ['dev', 'feature/13-logout', 'main'])

    def test_pull_request_closed_elsewhere_deletes_its_branch_only_once_its_ticket_closed(self):
        self.github(['main', 'dev', 'fix/40-sweep', 'fix/41-rules', 'spike-notes'], issues={40: 'open', 41: 'closed'})
        self.close_pr('fix/40-sweep', merged=False)
        self.close_pr('fix/41-rules', base='feature/30-picker')
        self.close_pr('spike-notes', merged=False)
        self.assertEqual(self.remote_branches(), ['dev', 'fix/40-sweep', 'main', 'spike-notes'])

    def test_merged_pull_request_from_a_fork_leaves_the_same_named_branch_alone(self):
        self.github(['main', 'dev', 'fix/12-login'], issues={12: 'closed'})
        self.close_pr('fix/12-login', head_repo='someone/app')
        self.assertEqual(self.remote_branches(), ['dev', 'fix/12-login', 'main'])

    def test_a_leading_number_that_is_no_ticket_never_deletes_the_branch(self):
        self.github(['main', 'dev', '2026-09-notes', 'docs/45-readme'],
                    pulls=[dict(number=45, head='docs/45-readme', base='dev', state='closed')])
        self.close_pr('2026-09-notes', merged=False)
        self.close_pr('docs/45-readme', merged=False)
        self.assertEqual(self.remote_branches(), ['2026-09-notes', 'dev', 'docs/45-readme', 'main'])

    def test_head_branch_github_already_deleted_is_not_an_error(self):
        self.github(['main', 'dev'], issues={12: 'closed'})
        output = self.close_pr('fix/12-login')
        self.assertNotIn('deleted', output)
        self.assertEqual(self.remote_branches(), ['dev', 'main'])

    def test_main_and_dev_are_never_deleted_as_a_merged_head(self):
        self.github(['main', 'dev', 'staging'])
        self.close_pr('main')
        self.close_pr('dev', base='staging')
        self.assertEqual(self.remote_branches(), ['dev', 'main', 'staging'])

    def test_branch_an_open_pull_request_still_uses_is_kept(self):
        self.github(['main', 'dev', 'feature/30-picker', 'fix/31-resume', 'research/30-notes'], issues={30: 'closed'},
                    pulls=[dict(number=50, head='fix/31-resume', base='feature/30-picker', state='open'),
                           dict(number=51, head='research/30-notes', base='dev', state='open')])
        output = self.close_issue(30)
        self.assertEqual(self.remote_branches(), ['dev', 'feature/30-picker', 'fix/31-resume', 'main', 'research/30-notes'])
        self.assertIn('kept feature/30-picker', output)

    def test_prototype_and_protected_branches_survive_their_ticket_closing(self):
        self.github(['main', 'dev', 'prototype/33-tray-icon', 'feature/33-persist', 'chore/33-ruleset', 'fix/33-gone'],
                    issues={33: 'closed'}, protected=['feature/33-persist'], deletion_rules=['chore/33-ruleset'])
        output = self.close_issue(33)
        self.assertEqual(self.remote_branches(), ['chore/33-ruleset', 'dev', 'feature/33-persist', 'main', 'prototype/33-tray-icon'])
        self.assertIn('kept prototype/33-tray-icon', output)

    def test_a_private_repo_without_rulesets_still_deletes_the_branch(self):
        self.github(['main', 'dev', 'fix/33-slow-launch'], issues={33: 'closed'}, rules_forbidden=True)
        self.close_issue(33)
        self.assertEqual(self.remote_branches(), ['dev', 'main'])

    def test_a_branch_another_run_deletes_first_is_not_an_error(self):
        # A PR merging into dev closes its ticket at the same moment, so two runs race for one branch.
        self.github(['main', 'dev', 'fix/33-slow-launch', 'research/33-notes', 'fix/33-rules'], issues={33: 'closed'},
                    vanishes={'fix/33-slow-launch': 'before-delete', 'research/33-notes': 'after-listing'})
        self.close_issue(33)
        self.assertEqual(self.remote_branches(), ['dev', 'main'])

    def test_one_branch_failing_to_delete_still_deletes_the_others_and_fails_the_run(self):
        self.github(['main', 'dev', 'fix/33-a', 'fix/33-b', 'fix/33-c'], issues={33: 'closed'}, delete_fails=['fix/33-b'])
        output = self.close_issue(33, succeeds=False)
        self.assertEqual(self.remote_branches(), ['dev', 'fix/33-b', 'main'])
        self.assertIn('fix/33-b', output)

    def test_a_close_with_nothing_to_delete_only_lists_branches(self):
        self.github(['main', 'dev', 'fix/34-other'], issues={33: 'closed'})
        self.close_issue(33)
        calls = json.loads(self.state.read_text())['Calls']
        self.assertEqual(calls, [['api', 'repos/oneezy/app/git/matching-refs/heads/']])

    def test_a_repo_whose_branches_are_not_main_and_dev(self):
        self.github(['trunk', 'develop', 'dev', 'feature/12-login', 'feature/13-logout'], issues={12: 'open', 13: 'open'},
                    default_branch='trunk')
        self.close_pr('feature/12-login', base='develop', INTEGRATION_BRANCH='develop')
        self.close_pr('feature/13-logout', base='dev', INTEGRATION_BRANCH='develop')
        self.close_pr('trunk', base='develop', INTEGRATION_BRANCH='develop')
        self.assertEqual(self.remote_branches(), ['dev', 'develop', 'feature/13-logout', 'trunk'])

    def test_readme_caller_uses_a_reusable_workflow_that_runs_this_script(self):
        readme = (TOOL / 'README.md').read_text(encoding='utf-8')
        uses = re.search(r'uses: oneezy/tools/(\S+)@main', readme[readme.index('## Delete the remote branch'):])
        self.assertIsNotNone(uses, 'README documents no caller')
        workflow = (REPO_ROOT / uses.group(1)).read_text(encoding='utf-8')
        self.assertIn('workflow_call:', workflow)
        script = SCRIPT.relative_to(REPO_ROOT).as_posix()
        self.assertIn(f'sparse-checkout: {script}', workflow)
        self.assertIn(f'python3 {script}', workflow)
        self.assertIn('contents: write', readme)


if __name__ == '__main__':
    unittest.main()
