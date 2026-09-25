#!/usr/bin/env python3
"""Claude Code WorktreeCreate hook. Reads the hook input JSON on stdin, creates (or reuses) the worktree
with a readable name cut from local dev, and prints its absolute path as the last line of stdout.
Everything else goes to stderr. Python 3.10+ standard library and Git only."""
import json
import os
import sys

import task_worktrees as wt


def main():
    # Claude reads the path as UTF-8; a piped stdout on Windows would otherwise use the locale's code page.
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stderr.reconfigure(encoding='utf-8', errors='backslashreplace')
    try:
        payload = json.loads(sys.stdin.buffer.read().decode('utf-8-sig') or '{}')
        path = wt.hook_worktree(payload.get('cwd') or os.getcwd(), payload.get('name') or '')
    except (OSError, ValueError, RuntimeError) as error:
        print(f'WorktreeCreate hook: {error}', file=sys.stderr)
        return 1
    print(path)
    return 0


if __name__ == '__main__':
    sys.exit(main())
