"""Persistent, named Git worktrees shared by Claude and Codex: their names, planning and creation. No cleanup operations."""
import os
import re
import subprocess
from pathlib import Path
from typing import NamedTuple

from locks import file_lock


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


# Branch types (see CONTEXT.md): the first word of a task branch, not a ticket's Type.
BRANCH_TYPES = ('feature', 'fix', 'research', 'prototype', 'wayfinder', 'chore', 'docs')


class TaskNames(NamedTuple):
    folder: str
    branch: str


class ParsedTask(NamedTuple):
    branch_type: str
    number: int | None
    description: str | None


def parse_task(text):
    """Split a name such as fix-31-picker-speed or fix/31-picker-speed into its branch type, issue and description,
    either of the last two possibly None. None when the name does not start with a known branch type."""
    try:
        text = slug(text)
    except ValueError:
        return None
    match = re.fullmatch(rf"({'|'.join(BRANCH_TYPES)})(?:-(\d+)(?=-|$))?(?:-(.+))?", text)
    if not match or not (match.group(2) or match.group(3)):
        return None
    return ParsedTask(match.group(1), int(match.group(2)) if match.group(2) else None, match.group(3))


def task_names(repo, branch_type, number=None, description=None):
    """Folder <repo>-<type>-<issue>-<desc> and branch <type>/<issue>-<desc>; the issue or the description may be absent."""
    if branch_type not in BRANCH_TYPES:
        raise ValueError(f"Unknown branch type '{branch_type}'. Choose one of: {', '.join(BRANCH_TYPES)}.")
    suffix = '-'.join(str(p) for p in (number, slug(description) if description else None) if p)
    if not suffix:
        raise ValueError('Supply an issue number or a description for a new task.')
    # Keep the repository, branch type and ticket number at the beginning, even when truncating.
    return TaskNames(f'{slug(repo)}-{branch_type}-{suffix}'[:120].rstrip('-'), f'{branch_type}/{suffix}'[:120].rstrip('-'))


def default_branch(repo, folder):
    """The branch a task folder's name implies: brain-fix-31-login implies fix/31-login."""
    rest = folder.removeprefix(f'{slug(repo)}-')
    parsed = parse_task(rest)
    return task_names(repo, *parsed).branch if parsed else f'feature/{slug(rest)}'


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


def dev_base(project):
    """Where a new task branch starts: local dev, else origin/dev, else HEAD in a repo that has no dev at all."""
    return next((b for b, ref in (('dev', 'refs/heads/dev'), ('origin/dev', 'refs/remotes/origin/dev'))
                 if exists(project, ref)), 'HEAD')


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
    request = dict(Name=name, Branch=requested, Preferred=str(preferred) if preferred else None)
    branch = branch or default_branch(project.name, name)
    registered = [t for t in trees if t['Branch'] == branch]
    usable = [t for t in registered if not t['Prunable'] and (Path(t['Path']) / '.git').exists()]
    if usable:
        if same(usable[0]['Path'], project):
            raise ValueError('Task branch is checked out in the main project folder. Switch that folder to dev first.')
        return dict(ProjectDirectory=str(project), WorkingDirectory=usable[0]['Path'], Branch=branch,
                    Operation='reuse', Base=None, Request=request)
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
                    Operation='restore', Base=branch, Request=request)
    if branch_exists:
        number = 2
        while exists(project, f'refs/heads/{branch}-{number}'):
            number += 1
        branch = f'{branch}-{number}'
    remote = requested and exists(project, f'refs/remotes/origin/{requested}') and not branch_exists
    return dict(ProjectDirectory=str(project), WorkingDirectory=str(directory), Branch=branch,
                Operation='create', Base=f'origin/{requested}' if remote else dev_base(project), Request=request)


def common_dir(directory):
    return Path(git(directory, 'rev-parse', '--path-format=absolute', '--git-common-dir').stdout.strip())


def main_checkout(directory):
    """The main checkout of the repository that holds a folder, even when the folder is a linked worktree."""
    common = common_dir(directory)
    if common.name == '.git':
        return common.parent
    return Path(git(directory, 'rev-parse', '--show-toplevel').stdout.strip())


def creation_lock(project):
    """The per-repo lock every worktree creation takes: the WorktreeCreate hook, the picker and the CLI.
    It lives in the repo's Git directory, so every checkout of the repo shares it."""
    return file_lock(common_dir(project) / 'worktree-create.lock', 120, 'Another worktree is still being created in this repo.')


def checked_out_in(directory):
    return git(directory, 'branch', '--show-current').stdout.strip() or None


def create(workspace):
    """Create a planned worktree from what this repo already has; nothing is fetched. A new branch starts from
    origin/<branch> when only origin has it, else from dev_base."""
    if workspace['Operation'] == 'reuse':
        return
    project, directory, branch = (workspace[k] for k in ('ProjectDirectory', 'WorkingDirectory', 'Branch'))
    if workspace['Operation'] == 'restore':
        git(project, 'worktree', 'add', directory, branch)
        return
    if workspace['Request']['Branch'] == branch and exists(project, f'refs/remotes/origin/{branch}'):
        git(project, 'worktree', 'add', '-b', branch, directory, f'origin/{branch}')
        return
    git(project, 'worktree', 'add', '-b', branch, directory, dev_base(project))


def create_after_fetch(workspace):
    """The picker's and the CLI's creation, returning the workspace it made. Under the repo's creation lock it fetches
    origin and brings local dev up to date, then plans again, so a worktree another process (the WorktreeCreate hook)
    made for the branch since the first plan is reused instead of failing."""
    if workspace['Operation'] == 'reuse':
        return workspace
    project, request = workspace['ProjectDirectory'], workspace['Request']
    with creation_lock(project):
        if workspace['Operation'] == 'create':
            refresh_dev(project)
        workspace = plan(project, request['Name'], request['Branch'], request['Preferred'])
        create(workspace)
    return workspace


def refresh_dev(project):
    """Fetch origin, then create local dev when it is missing or fast-forward it to origin/dev."""
    if git(project, 'remote', 'get-url', 'origin', check=False).returncode == 0:
        git(project, 'fetch', 'origin')
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
