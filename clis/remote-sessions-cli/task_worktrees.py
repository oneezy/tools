"""Persistent, named Git worktrees shared by Claude and Codex. No cleanup operations."""
import os
import re
import subprocess
from pathlib import Path


def key(path):
    """A path's identity for comparing and grouping folders: absolute, and case-folded where the OS ignores case."""
    return os.path.normcase(os.path.abspath(path))


def same(a, b):
    return bool(a and b) and key(a) == key(b)


def inside(path, parent):
    try:
        return Path(path).resolve().is_relative_to(Path(parent).resolve())
    except (ValueError, OSError):
        return False


def git(directory, *args, check=True):
    result = subprocess.run(['git', '-C', str(directory), *args], capture_output=True, text=True,
                            encoding='utf-8', errors='replace')
    if check and result.returncode:
        raise RuntimeError(f"Git failed in {directory}: {result.stderr.strip() or result.stdout.strip()}")
    return result


def slug(text):
    value = re.sub(r'[^a-z0-9]+', '-', text.lower()).strip('-')[:90].rstrip('-')
    if not value:
        raise ValueError('Supply a descriptive task name.')
    return value


def task_name(project, task, issue=None, pr=None):
    # Keep the repository and ticket number at the beginning, even when truncating.
    prefix = slug(project)
    kind = f'issue-{issue}' if issue else f'pr-{pr}' if pr else ''
    title = slug(task) if task else ''
    if not title and not kind:
        raise ValueError('Supply --task, --issue, or --pr for a new task.')
    return '-'.join(p for p in (prefix, kind, title) if p)[:120].rstrip('-')


def worktrees(project):
    trees = []
    for block in git(project, '-c', 'core.quotePath=false', 'worktree', 'list', '--porcelain').stdout.strip().split('\n\n'):
        fields = dict(line.partition(' ')[::2] for line in block.splitlines())
        if 'worktree' in fields:
            trees.append(dict(Path=str(Path(fields['worktree'])), Branch=fields.get('branch', '').removeprefix('refs/heads/'),
                              Prunable='prunable' in fields))
    return trees


def exists(project, ref):
    return git(project, 'show-ref', '--verify', '--quiet', ref, check=False).returncode == 0


def plan(project, name, branch=None, preferred=None):
    project = Path(project).absolute()
    if not same(git(project, 'rev-parse', '--show-toplevel').stdout.strip(), project):
        raise ValueError(f'{project} must be the root of its own Git repository.')
    trees = worktrees(project)
    if not branch and preferred:
        branch = next((t['Branch'] for t in trees if same(t['Path'], preferred)), None)
    if branch in ('main', 'dev'):
        raise ValueError('Choose a task branch, not main or dev.')
    if branch and git(project, 'check-ref-format', '--branch', branch, check=False).returncode:
        raise ValueError(f'Invalid task branch: {branch}')
    requested = branch
    branch = branch or f'codex/{name}'
    registered = [t for t in trees if t['Branch'] == branch]
    usable = [t for t in registered if not t['Prunable'] and (Path(t['Path']) / '.git').exists()]
    if usable:
        if same(usable[0]['Path'], project):
            raise ValueError('Task branch is checked out in the main project folder. Switch that folder to dev first.')
        return dict(ProjectDirectory=str(project), WorkingDirectory=usable[0]['Path'], Branch=branch,
                    Operation='reuse', Base=None)
    branch_exists = exists(project, f'refs/heads/{branch}')
    base_dir = project / '.claude' / 'worktrees'
    directory = base_dir / name
    number = 2
    while directory.exists() or any(same(t['Path'], directory) for t in trees):
        directory = base_dir / f'{name}-{number}'
        number += 1
    if branch_exists and not registered:
        if preferred and not Path(preferred).exists() and inside(preferred, base_dir):
            directory = Path(preferred)
        return dict(ProjectDirectory=str(project), WorkingDirectory=str(directory), Branch=branch,
                    Operation='restore', Base=branch)
    if branch_exists:
        number = 2
        while exists(project, f'refs/heads/codex/{name}-{number}'):
            number += 1
        branch = f'codex/{name}-{number}'
    remote = requested and exists(project, f'refs/remotes/origin/{requested}') and not branch_exists
    return dict(ProjectDirectory=str(project), WorkingDirectory=str(directory), Branch=branch,
                Operation='create', Base=f'origin/{requested}' if remote else 'dev', RequestedBranch=requested)


def create(workspace):
    if workspace['Operation'] == 'reuse':
        return
    project, directory, branch = (workspace[k] for k in ('ProjectDirectory', 'WorkingDirectory', 'Branch'))
    if workspace['Operation'] == 'restore':
        git(project, 'worktree', 'add', directory, branch)
        return
    if git(project, 'remote', 'get-url', 'origin', check=False).returncode == 0:
        git(project, 'fetch', 'origin')
    requested = workspace.get('RequestedBranch')
    if requested == branch and exists(project, f'refs/remotes/origin/{branch}'):
        git(project, 'worktree', 'add', '-b', branch, directory, f'origin/{branch}')
        return
    has_remote_dev = exists(project, 'refs/remotes/origin/dev')
    if not exists(project, 'refs/heads/dev'):
        git(project, 'branch', 'dev', 'origin/dev' if has_remote_dev else 'HEAD')
    elif has_remote_dev:
        local = git(project, 'rev-parse', 'dev').stdout.strip()
        remote = git(project, 'rev-parse', 'origin/dev').stdout.strip()
        if local != remote and git(project, 'merge-base', '--is-ancestor', 'origin/dev', 'dev', check=False).returncode:
            if git(project, 'merge-base', '--is-ancestor', 'dev', 'origin/dev', check=False).returncode:
                raise ValueError('Local dev has diverged from origin/dev; reconcile it before creating a task.')
            tree = next((t for t in worktrees(project) if t['Branch'] == 'dev'), None)
            if tree:
                if git(tree['Path'], 'status', '--porcelain').stdout.strip():
                    raise ValueError('The dev checkout has uncommitted changes; cannot fast-forward it safely.')
                git(tree['Path'], 'merge', '--ff-only', 'origin/dev')
            else:
                git(project, 'update-ref', 'refs/heads/dev', remote, local)
    git(project, 'worktree', 'add', '-b', branch, directory, 'dev')
