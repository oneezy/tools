#!/usr/bin/env python3
"""Compatibility stub: the engine lives in packages/remote-sessions (oneezy/tools#75).

`py -3 clis/remote-sessions-cli/remote_sessions.py workspace --plan --json` keeps working
from this path. New callers should run packages/remote-sessions/remote_sessions.py.
"""
import runpy
import sys
from pathlib import Path

ENGINE = Path(__file__).resolve().parents[2] / 'packages' / 'remote-sessions'

if __name__ == '__main__':
    sys.path.insert(0, str(ENGINE))
    runpy.run_path(str(ENGINE / 'remote_sessions.py'), run_name='__main__')
