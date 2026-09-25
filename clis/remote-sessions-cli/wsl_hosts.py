"""WSL distributions as Claude hosts, read through `wsl.exe`. Standard library only.

Listing distros never starts one. Scanning runs a command inside the distro, which boots it when stopped, so
callers scan only running distros unless Justin asks (W)."""
import json
import os
import shutil
import subprocess
import sys

# Docker Desktop's own distros never host Claude sessions; they are neither listed nor booted.
IGNORED = ('docker-desktop',)

# Run inside a distro by its login shell, so a per-user install (~/.local/bin) is on PATH. Without Claude it prints
# nothing; otherwise Claude's agent list, then the contents of each per-pid session file.
SCAN = """command -v claude >/dev/null 2>&1 || exit 0
claude agents --json --all || exit
for file in "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/sessions/*.json; do
  [ -f "$file" ] && cat "$file" && echo
done
exit 0"""


class WslError(RuntimeError):
    pass


def default_executable():
    """`wsl.exe` on Windows when it is installed; nothing elsewhere, where WSL is not a separate host."""
    if os.name != 'nt':
        return None
    return 'wsl.exe' if shutil.which('wsl.exe') else None


def run(executable, args, timeout):
    prefix = [sys.executable, executable] if executable.endswith('.py') else [executable]
    # WSL_UTF8 makes wsl.exe print UTF-8; older releases ignore it and print UTF-16LE, which decode() handles.
    env = dict(os.environ, WSL_UTF8='1')
    try:
        result = subprocess.run(prefix + args, capture_output=True, env=env, timeout=timeout)
    except (OSError, subprocess.TimeoutExpired) as error:
        raise WslError(str(error) or type(error).__name__) from error
    if result.returncode:
        raise WslError(decode(result.stdout + result.stderr).strip() or f'wsl exited {result.returncode}')
    return decode(result.stdout)


def decode(raw):
    if b'\0' in raw:
        return raw.decode('utf-16-le', errors='replace').lstrip('﻿')
    return raw.decode('utf-8', errors='replace')


def distros(executable):
    """Installed distros as dicts of Name and State ('Running', 'Stopped', ...), from `wsl --list --verbose`.
    Empty when WSL or any distro is missing."""
    try:
        text = run(executable, ['--list', '--verbose'], timeout=5)
    except WslError:
        return []
    found = []
    for line in text.splitlines()[1:]:
        fields = line.replace('*', ' ', 1).split()
        if len(fields) >= 2 and not fields[0].startswith(IGNORED):
            found.append(dict(Name=fields[0], State=fields[1]))
    return found


def scan(executable, name):
    """Claude's live agents in one distro and its per-pid session files, as (agents, files). Both are empty when Claude
    is not installed there. Raises WslError when the distro cannot be reached or Claude's output cannot be read.
    Boots the distro when it is stopped."""
    text = run(executable, ['-d', name, '--exec', 'sh', '-lc', SCAN], timeout=20)
    values, decoder, at = [], json.JSONDecoder(), 0
    while True:
        while at < len(text) and text[at].isspace():
            at += 1
        if at == len(text):
            break
        try:
            value, at = decoder.raw_decode(text, at)
        except ValueError as error:
            raise WslError(f'unreadable Claude output ({error.msg})') from error
        values.append(value)
    if not values:
        return [], []
    agents, files = values[0], [v for v in values[1:] if isinstance(v, dict)]
    if not isinstance(agents, list):
        raise WslError('Claude returned an unexpected agent inventory format.')
    return agents, files
