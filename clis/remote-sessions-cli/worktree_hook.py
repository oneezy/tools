#!/usr/bin/env python3
"""Claude Code WorktreeCreate hook. Reads the hook input JSON on stdin, creates (or reuses) the worktree
with a readable name cut from local dev, and prints its absolute path as the last line of stdout.
Everything else goes to stderr. Python 3.10+ standard library and Git only."""
import json
import os
from pathlib import Path
import re
import sys

import task_worktrees as wt


def next_new(project):
    """Folder and branch for a worktree whose task is not known yet: <repo>-new-<n> on new/<n>,
    with n one above the highest number any folder or branch in this repo uses."""
    repo = wt.slug(project.name)
    folder = re.compile(rf'{re.escape(repo)}-new-(\d+)')
    used = [int(m.group(1)) for p in (project / '.claude' / 'worktrees').glob(f'{repo}-new-*') if (m := folder.fullmatch(p.name))]
    refs = wt.git(project, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/new/').stdout.split()
    used += [int(r.removeprefix('new/')) for r in refs if re.fullmatch(r'new/\d+', r)]
    n = max(used, default=0) + 1
    return wt.TaskNames(f'{repo}-new-{n}', f'new/{n}')


def worktree_for(cwd, name, note=lambda message: None):
    """Create or reuse the worktree a request names and return its path. Nothing is fetched; a new branch starts
    from local dev whatever base Claude proposed. note() receives what the requester should know."""
    project = wt.main_checkout(cwd)
    name = (name or '').strip()
    current = wt.checked_out_in(project)
    if name == 'main':
        raise ValueError('No session runs on main; it changes only by hand.')
    if name == 'dev':
        if current == 'dev':
            return str(project)
        raise ValueError(f"Sessions on dev belong in the main checkout, and it has {current or 'no branch'} checked out.")
    parsed = wt.parse_task(name)
    # Parallel subagents each run this hook: numbering, planning and creating happen under one per-repo lock,
    # so two unnamed requests never pick the same new/<n>.
    with wt.creation_lock(project):
        names = wt.task_names(project.name, *parsed) if parsed else next_new(project)
        if current == names.branch:
            return str(project)
        workspace = wt.plan(project, names.folder, names.branch)
        if not parsed and workspace['Operation'] != 'create':
            raise ValueError(f'{names.branch} is already in use; an unnamed worktree is never shared.')
        wt.create(workspace)
    if not parsed:
        asked = f"'{name}' does not start with a branch type ({', '.join(wt.BRANCH_TYPES)})" if name else 'No name was given'
        note(f'{asked}; created {names.folder} on {names.branch}. Rename the branch to <type>/<issue>-<desc> once the task is known.')
    return str(Path(os.path.abspath(workspace['WorkingDirectory'])))


def main():
    # Claude reads the path as UTF-8; a piped stdout on Windows would otherwise use the locale's code page.
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stderr.reconfigure(encoding='utf-8', errors='backslashreplace')

    def note(message):
        print(f'WorktreeCreate hook: {message}', file=sys.stderr)
    try:
        payload = json.loads(sys.stdin.buffer.read().decode('utf-8-sig') or '{}')
        path = worktree_for(payload.get('cwd') or os.getcwd(), payload.get('name') or '', note)
    except (OSError, ValueError, RuntimeError) as error:
        note(error)
        return 1
    print(path)
    return 0


if __name__ == '__main__':
    sys.exit(main())
