"""Persistent, named Git worktrees shared by Claude and Codex. No cleanup operations."""
from contextlib import contextmanager
import os
import re
import subprocess
import time
from pathlib import Path
from typing import NamedTuple


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


@contextmanager
def file_lock(path, timeout=30, busy='Another launcher action is still running.'):
    """Cross-process exclusive lock on a file. The file stays in place so another process cannot lock a different inode."""
    with open(path, 'a+b') as stream:
        stream.seek(0, 2)
        if not stream.tell():
            stream.write(b'\0')
            stream.flush()
        deadline = time.monotonic() + timeout
        while True:
            try:
                stream.seek(0)
                if os.name == 'nt':
                    import msvcrt
                    msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
                else:
                    import fcntl
                    fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except OSError:
                if time.monotonic() >= deadline:
                    raise RuntimeError(busy)
                time.sleep(.1)
        try:
            yield
        finally:
            stream.seek(0)
            if os.name == 'nt':
                msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(stream, fcntl.LOCK_UN)


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


def parse_task(text):
    """Split a name such as fix-31-picker-speed or fix/31-picker-speed into (branch type, issue, description),
    either of the last two possibly None. None when the name does not start with a known branch type."""
    try:
        text = slug(text)
    except ValueError:
        return None
    match = re.fullmatch(rf"({'|'.join(BRANCH_TYPES)})(?:-(\d+)(?=-|$))?(?:-(.+))?", text)
    if not match or not (match.group(2) or match.group(3)):
        return None
    return match.group(1), int(match.group(2)) if match.group(2) else None, match.group(3)


def task_names(repo, branch_type, number=None, description=None):
    """Folder <repo>-<type>-<issue>-<desc> and branch <type>/<issue>-<desc>; the issue or the description may be absent."""
    if branch_type not in BRANCH_TYPES:
        raise ValueError(f"Unknown branch type '{branch_type}'. Choose one of: {', '.join(BRANCH_TYPES)}.")
    suffix = '-'.join(str(p) for p in (number, slug(description) if description else None) if p)
    if not suffix:
        raise ValueError('Supply an issue number or a description for a new task.')
    # Keep the repository, branch type and ticket number at the beginning, even when truncating.
    return TaskNames(f'{slug(repo)}-{branch_type}-{suffix}'[:120].rstrip('-'), f'{branch_type}/{suffix}'[:120].rstrip('-'))


def requested_names(repo, task=None, issue=None, pr=None, branch_type=None):
    """Names for a task requested by --task/--issue/--pr/--type or picker N. The branch type comes from --type,
    else from a task that starts with one (fix-login is a fix), else feature. A PR number takes the issue's place."""
    number = issue or pr
    parsed = parse_task(task) if task else None
    if parsed and branch_type in (None, parsed[0]):
        branch_type, task_number, description = parsed
        if number and task_number:
            description = '-'.join(str(p) for p in (task_number, description) if p)
        number = number or task_number
    else:
        description = task
    return task_names(repo, branch_type or 'feature', number, description)


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
                Operation='create', Base=f'origin/{requested}' if remote else dev_base(project), RequestedBranch=requested)


def common_dir(directory):
    return Path(git(directory, 'rev-parse', '--path-format=absolute', '--git-common-dir').stdout.strip())


def main_checkout(directory):
    """The main checkout of the repository that holds a folder, even when the folder is a linked worktree."""
    common = common_dir(directory)
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
    return TaskNames(f'{repo}-new-{n}', f'new/{n}')


def hook_worktree(cwd, name):
    """What the WorktreeCreate hook does: create or reuse the worktree for a request, return its path.
    Nothing is fetched; a new branch starts from local dev whatever base Claude proposed."""
    project = main_checkout(cwd)
    name = (name or '').strip()
    current = checked_out_in(project)
    if name in ('dev', 'main'):
        if current == name:
            return str(project)
        raise ValueError(f"Sessions on {name} belong in the main checkout, and it has {current or 'no branch'} checked out.")
    parsed = parse_task(name)
    # Parallel subagents each run this hook: numbering, planning and creating happen under one per-repo lock,
    # so two unnamed requests never pick the same new/<n>.
    with file_lock(common_dir(project) / 'worktree-create.lock', 120, 'Another worktree is still being created in this repo.'):
        names = task_names(project.name, *parsed) if parsed else next_new(project)
        if current == names.branch:
            return str(project)
        workspace = plan(project, names.folder, names.branch)
        if not parsed and workspace['Operation'] != 'create':
            raise ValueError(f'{names.branch} is already in use; an unnamed worktree is never shared.')
        create(workspace)
    return str(Path(os.path.abspath(workspace['WorkingDirectory'])))


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
    if workspace.get('RequestedBranch') == branch and exists(project, f'refs/remotes/origin/{branch}'):
        git(project, 'worktree', 'add', '-b', branch, directory, f'origin/{branch}')
        return
    git(project, 'worktree', 'add', '-b', branch, directory, dev_base(project))


def create_after_fetch(workspace):
    """The picker's creation: fetch origin and bring local dev up to date first, then create."""
    if workspace['Operation'] == 'create':
        refresh_dev(workspace['ProjectDirectory'])
    create(workspace)


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
