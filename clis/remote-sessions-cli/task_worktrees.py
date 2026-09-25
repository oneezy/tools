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


TYPES = ('feature', 'fix', 'research', 'prototype', 'wayfinder', 'chore', 'docs')


def parse_task(text):
    """Split a name such as fix-31-picker-speed or fix/31-picker-speed into (type, issue, description),
    either of the last two possibly None. None when the name does not start with a known type."""
    try:
        text = slug(text)
    except ValueError:
        return None
    match = re.fullmatch(rf"({'|'.join(TYPES)})(?:-(\d+)(?=-|$))?(?:-(.+))?", text)
    if not match or not (match.group(2) or match.group(3)):
        return None
    return match.group(1), int(match.group(2)) if match.group(2) else None, match.group(3)


def task_names(repo, kind, number=None, description=None):
    """Folder <repo>-<type>-<issue>-<desc> and branch <type>/<issue>-<desc>; the issue or the description may be absent."""
    if kind not in TYPES:
        raise ValueError(f"Unknown task type '{kind}'. Choose one of: {', '.join(TYPES)}.")
    tail = '-'.join(str(p) for p in (number, slug(description) if description else None) if p)
    if not tail:
        raise ValueError('Supply an issue number or a description for a new task.')
    # Keep the repository, type and ticket number at the beginning, even when truncating.
    return f'{slug(repo)}-{kind}-{tail}'[:120].rstrip('-'), f'{kind}/{tail}'[:120].rstrip('-')


def names(repo, task=None, issue=None, pr=None, kind=None):
    """Folder and branch for a named task. The type comes from --type, else from a task that starts with one
    (fix-login is a fix), else feature. A PR number takes the issue's place."""
    number = issue or pr
    parsed = parse_task(task) if task else None
    if parsed and kind in (None, parsed[0]):
        kind, found, description = parsed
        if number and found:
            description = '-'.join(str(p) for p in (found, description) if p)
        number = number or found
    else:
        description = task
    return task_names(repo, kind or 'feature', number, description)


def default_branch(repo, folder):
    """The branch a task folder's name implies: brain-fix-31-login implies fix/31-login."""
    rest = folder.removeprefix(f'{slug(repo)}-')
    parsed = parse_task(rest)
    return task_names(repo, *parsed)[1] if parsed else f'feature/{slug(rest)}'


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
    branch = branch or default_branch(project.name, name)
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
        while exists(project, f'refs/heads/{branch}-{number}'):
            number += 1
        branch = f'{branch}-{number}'
    remote = requested and exists(project, f'refs/remotes/origin/{requested}') and not branch_exists
    return dict(ProjectDirectory=str(project), WorkingDirectory=str(directory), Branch=branch,
                Operation='create', Base=f'origin/{requested}' if remote else 'dev', RequestedBranch=requested)


def main_checkout(directory):
    """The main checkout of the repository that holds a folder, even when the folder is a linked worktree."""
    common = Path(git(directory, 'rev-parse', '--path-format=absolute', '--git-common-dir').stdout.strip())
    if common.name == '.git':
        return common.parent
    return Path(git(directory, 'rev-parse', '--show-toplevel').stdout.strip())


def next_new(project):
    """Folder and branch for a worktree whose task is not known yet: <repo>-new-<n> on new/<n>,
    with n one above the highest number any folder or branch in this repo uses."""
    repo = slug(project.name)
    folder = re.compile(rf'{re.escape(repo)}-new-(\d+)')
    used = [int(m.group(1)) for p in (project / '.claude' / 'worktrees').glob(f'{repo}-new-*') if (m := folder.fullmatch(p.name))]
    refs = git(project, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/new/').stdout.split()
    used += [int(r.removeprefix('new/')) for r in refs if re.fullmatch(r'new/\d+', r)]
    n = max(used, default=0) + 1
    return f'{repo}-new-{n}', f'new/{n}'


def hook_worktree(cwd, name):
    """What the WorktreeCreate hook does: create or reuse the worktree for a request, return its path."""
    project = main_checkout(cwd)
    name = (name or '').strip()
    if name in ('dev', 'main'):
        if checked_out_in(project) == name:
            return str(project)
        raise ValueError(f'Sessions on {name} belong in the main checkout, and it has {checked_out_in(project) or "no branch"} checked out.')
    parsed = parse_task(name)
    folder, branch = task_names(project.name, *parsed) if parsed else next_new(project)
    if checked_out_in(project) == branch:
        return str(project)
    workspace = plan(project, folder, branch)
    create(workspace, fetch=False)
    return str(Path(os.path.abspath(workspace['WorkingDirectory'])))


def checked_out_in(directory):
    return git(directory, 'branch', '--show-current').stdout.strip() or None


def create(workspace, fetch=True):
    """Create a planned worktree. With fetch (the picker), origin is fetched and local dev fast-forwarded first;
    without it (the hook), the worktree is cut from local dev as it is, or from HEAD in a repo with no dev."""
    if workspace['Operation'] == 'reuse':
        return
    project, directory, branch = (workspace[k] for k in ('ProjectDirectory', 'WorkingDirectory', 'Branch'))
    if workspace['Operation'] == 'restore':
        git(project, 'worktree', 'add', directory, branch)
        return
    if fetch and git(project, 'remote', 'get-url', 'origin', check=False).returncode == 0:
        git(project, 'fetch', 'origin')
    requested = workspace.get('RequestedBranch')
    if requested == branch and exists(project, f'refs/remotes/origin/{branch}'):
        git(project, 'worktree', 'add', '-b', branch, directory, f'origin/{branch}')
        return
    if not fetch:
        git(project, 'worktree', 'add', '-b', branch, directory, 'dev' if exists(project, 'refs/heads/dev') else 'HEAD')
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
