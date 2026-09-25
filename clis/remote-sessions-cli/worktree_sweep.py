#!/usr/bin/env python3
"""Cleanup sweep for one repo's task worktrees. A worktree under .claude/worktrees whose branch has a PR merged into dev,
or whose ticket is closed, is removed with its local branch, provided nothing unsaved would be lost: no uncommitted
changes, no unpushed commits and no session live in another app. Background sessions there are stopped first.
prototype/* branches are kept. The WorktreeCreate hook starts it in the background after each creation; it never polls.
Python 3.10+ standard library, Git, gh and Claude Code."""
import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import subprocess
import sys
import time

from locks import file_lock
import remote_sessions as rs
import task_worktrees as wt


class GitHub:
    """The two questions the sweep asks GitHub, through gh run in the repo's folder so gh finds the repo itself."""

    def __init__(self, executable, project):
        self.executable, self.project = str(executable), project

    def ask(self, *args):
        prefix = [sys.executable, self.executable] if self.executable.endswith('.py') else [self.executable]
        result = subprocess.run(prefix + list(args), cwd=str(self.project), capture_output=True, text=True,
                                encoding='utf-8', errors='replace')
        return result.returncode, result.stdout, result.stderr.strip()

    def merged_pulls(self, branch):
        """Every merged PR whose head is this branch, into any base."""
        code, out, err = self.ask('pr', 'list', '--head', branch, '--state', 'merged', '--limit', '100',
                                  '--json', 'number,baseRefName,headRefOid')
        if code:
            raise RuntimeError(f'gh could not list the PRs of {branch}: {err}')
        return json.loads(out)

    def ticket_closed(self, number):
        code, out, err = self.ask('issue', 'view', str(number), '--json', 'state')
        if code and 'Could not resolve' in err:
            return False  # No such ticket: nothing to go by.
        if code:
            raise RuntimeError(f'gh could not read ticket #{number}: {err}')
        return json.loads(out).get('state') == 'CLOSED'


def contains(project, commit, tip):
    """Whether commit has tip in its history (or is tip)."""
    return wt.git(project, 'merge-base', '--is-ancestor', tip, commit, check=False).returncode == 0


def known(project, commit):
    return wt.git(project, 'cat-file', '-e', f'{commit}^{{commit}}', check=False).returncode == 0


def reason_to_remove(project, github, branch, tip, pulls):
    """Why a branch's worktree is done, or None: a PR merged into dev that holds the branch as it is now, else its closed
    ticket (the issue number in <type>/<issue>-<desc>). Work committed after the merge keeps it."""
    pull = next((p for p in pulls if p.get('baseRefName') == 'dev' and p.get('headRefOid') and contains(project, p['headRefOid'], tip)), None)
    if pull:
        return f"PR #{pull['number']} merged into dev"
    task = wt.parse_task(branch)
    if task and task.number and github.ticket_closed(task.number):
        return f'ticket #{task.number} closed'
    return None


def unsaved(project, folder, tip, pulls):
    """What removing the worktree would lose: uncommitted changes (untracked files count; ignored ones do not), and
    commits that neither origin nor a merged PR holds. A squash-merged PR holds the commits its head had."""
    lost = []
    if wt.git(folder, 'status', '--porcelain').stdout.strip():
        lost.append('uncommitted changes')
    heads = [p['headRefOid'] for p in pulls if p.get('headRefOid') and known(project, p['headRefOid'])]
    count = int(wt.git(project, 'rev-list', '--count', tip, '--not', '--remotes', *heads).stdout.strip() or 0)
    if count:
        lost.append(f"{count} unpushed commit{'s' if count > 1 else ''}")
    return lost


def candidates(project, keep):
    """Linked worktrees under .claude/worktrees that are on a branch, other than prototype/* and any folder in keep."""
    parent = project / '.claude' / 'worktrees'
    return [t for t in wt.worktrees(project)
            if wt.inside(t['Path'], parent) and not t['Prunable'] and t['Branch'] and not t['Branch'].startswith('prototype/')
            and not any(wt.inside(k, t['Path']) for k in keep)]


def remove(project, folder, branch):
    """Remove a clean worktree and delete its branch, under the repo's creation lock so no creation plans around it.
    Windows may hold a just-stopped session's folder for a moment, so removal is retried briefly."""
    with wt.creation_lock(project):
        for attempt in range(5):
            result = wt.git(project, 'worktree', 'remove', folder, check=False)
            if not result.returncode:
                break
            if attempt == 4:
                raise RuntimeError(result.stderr.strip() or result.stdout.strip())
            time.sleep(1)
        wt.git(project, 'branch', '-D', branch)


def sweep(repo, keep=(), gh='gh', claude=None, config=None):
    """Sweep one repo and return the report, which is also saved in the repo's Git directory for the picker."""
    project = wt.main_checkout(repo)
    report = dict(Repo=str(project), Swept=datetime.now(timezone.utc).isoformat(), Removed=[], Kept=[], Error=None, Skipped=None)
    if wt.git(project, 'remote', 'get-url', 'origin', check=False).returncode:
        report['Skipped'] = 'no origin remote, so nothing on GitHub to go by'
        return report
    if not candidates(project, keep):
        return report  # Nothing to ask GitHub about; the last report's flags name folders that are gone or kept.
    common = wt.common_dir(project)
    with file_lock(common / 'worktree-sweep.lock', 600, 'Another sweep of this repo is still running.'):
        try:
            trees = candidates(project, keep)  # Again: a sweep that held the lock may have removed some.
            # Prune first: a remote branch deleted since the last fetch no longer counts as holding the work.
            fetch = wt.git(project, 'fetch', '--prune', 'origin', check=False)
            if fetch.returncode:
                raise RuntimeError(f'Could not fetch origin: {fetch.stderr.strip()}')
            github = GitHub(gh, project)
            options = rs.parser().parse_args(['status', '--root', str(project.parent),
                                              *(['--claude', claude] if claude else []), *(['--config', config] if config else [])])
            manager = rs.Manager(options)
            agents = None
            for tree in trees:
                folder, branch = tree['Path'], tree['Branch']
                tip = wt.git(project, 'rev-parse', f'refs/heads/{branch}').stdout.strip()
                pulls = github.merged_pulls(branch)
                why = reason_to_remove(project, github, branch, tip, pulls)
                if not why:
                    continue
                entry = dict(Path=folder, Branch=branch, Why=why)
                lost = unsaved(project, folder, tip, pulls)
                if lost:
                    report['Kept'].append(dict(entry, Status='error', Detail=', '.join(lost)))
                    continue
                agents = manager.agents() if agents is None else agents
                here = [a for a in agents if rs.active(a) and wt.inside(a['cwd'], folder)]
                if any(rs.live_elsewhere(a) for a in here):
                    report['Kept'].append(dict(entry, Status='merged', Detail='a session is live in another app'))
                    continue
                try:
                    for agent in here:
                        manager.claude(['stop', agent['id']])
                    if here:
                        agents = manager.agents()
                        if any(rs.active(a) and wt.inside(a['cwd'], folder) for a in agents):
                            raise RuntimeError('a background session there is still running after stop')
                    remove(project, folder, branch)
                except (OSError, RuntimeError, ValueError) as error:
                    report['Kept'].append(dict(entry, Status='error', Detail=f'removal failed: {error}'))
                    continue
                report['Removed'].append(dict(entry, Stopped=[a['sessionId'] for a in here]))
        except (OSError, RuntimeError, ValueError) as error:
            report['Error'] = str(error)
        rs.write_json(common / wt.SWEEP_REPORT, report)
    return report


def start(repo, keep=()):
    """Start a sweep of one repo in the background and return at once. The sweep outlives the caller, holds none of its
    output streams (Claude waits for those to close) and opens no console window."""
    args = [sys.executable, str(Path(__file__).resolve()), str(repo), *(a for k in keep for a in ('--keep', str(k)))]
    options = dict(stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                   cwd=str(Path(__file__).resolve().parent), close_fds=True)
    if os.name != 'nt':
        return subprocess.Popen(args, start_new_session=True, **options)
    flags = subprocess.CREATE_NO_WINDOW | subprocess.CREATE_NEW_PROCESS_GROUP
    try:
        # Leave the hook's job object when it allows that, so the sweep survives the hook's cleanup.
        return subprocess.Popen(args, creationflags=flags | subprocess.CREATE_BREAKAWAY_FROM_JOB, **options)
    except OSError:
        return subprocess.Popen(args, creationflags=flags, **options)


def parser():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('repo', help='Any folder of the repo to sweep.')
    p.add_argument('--keep', action='append', default=[], help='Never touch the worktree holding this folder. Repeatable.')
    p.add_argument('--gh', default=os.environ.get('REMOTE_SESSIONS_GH') or 'gh')
    p.add_argument('--claude', default=os.environ.get('REMOTE_SESSIONS_CLAUDE'))
    p.add_argument('--config', help='Claude configuration folder (default: CLAUDE_CONFIG_DIR, else ~/.claude).')
    p.add_argument('--json', action='store_true')
    return p


def main(argv=None):
    options = parser().parse_args(argv)
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(errors='replace')
    report = sweep(options.repo, options.keep, options.gh, options.claude, options.config)
    if options.json:
        print(json.dumps(report, indent=2))
    else:
        for item in report['Removed']:
            print(f"removed {item['Path']} ({item['Branch']}): {item['Why']}")
        for item in report['Kept']:
            print(f"kept {item['Path']} ({item['Branch']}): {item['Why']}; {item['Detail']}")
        if report['Skipped']:
            print(f"Skipped: {report['Skipped']}")
        if report['Error']:
            print(f"Error: {report['Error']}", file=sys.stderr)
    return 1 if report['Error'] else 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (OSError, ValueError, RuntimeError) as error:
        print(f'Error: {error}', file=sys.stderr)
        sys.exit(1)
