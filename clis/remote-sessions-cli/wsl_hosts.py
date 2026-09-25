"""WSL distributions as Claude hosts, read through `wsl.exe`. Standard library only.

Listing distros never starts one. Scanning runs a command inside the distro, which boots it when stopped, so
callers scan only running distros unless Justin asks (W)."""
import json
import os
import shutil
import subprocess

import commands

# Docker Desktop's own distros never host Claude sessions; they are neither listed nor booted.
IGNORED = ('docker-desktop',)

# Seconds a scan may take. A running distro answers in about a second; a wedged one must not stall every picker
# refresh for long. Booting a stopped distro (W) takes longer.
SCAN_TIMEOUT = 10
BOOT_TIMEOUT = 60

# Run inside a distro by its login shell, so a per-user install (~/.local/bin) is on PATH. Without Claude it prints
# nothing of its own; otherwise, between the two markers, Claude's agent list, then the contents of each per-pid
# session file. The markers set it apart from whatever the login profile or logout script prints (a banner, or the
# escape codes of `clear`).
BEGIN, END = '@@claude-scan@@', '@@claude-scan-end@@'
SCAN = f"""command -v claude >/dev/null 2>&1 || exit 0
echo {BEGIN}
claude agents --json --all || exit
for file in "${{CLAUDE_CONFIG_DIR:-$HOME/.claude}}"/sessions/*.json; do
  [ -f "$file" ] && cat "$file" && echo
done
echo {END}
exit 0"""


class WslError(RuntimeError):
    pass


def default_executable():
    """`wsl.exe` on Windows when it is installed; nothing elsewhere, where WSL is not a separate host."""
    if os.name != 'nt':
        return None
    return 'wsl.exe' if shutil.which('wsl.exe') else None


def run(executable, args, timeout):
    # WSL_UTF8 makes wsl.exe print UTF-8; older releases ignore it and print UTF-16LE, which decode() handles.
    env = dict(os.environ, WSL_UTF8='1')
    try:
        result = subprocess.run(commands.prefix(executable) + args, capture_output=True, env=env, timeout=timeout)
    except subprocess.TimeoutExpired as error:
        raise WslError(f'no answer in {timeout:g} s') from error
    except OSError as error:
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
    Empty when WSL or any distro is missing. The states are the English words wsl.exe prints; on a Windows display
    language that translates them, no distro reads as Running or Stopped, so none is scanned or noted."""
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


def scan(executable, name, boot=False):
    """Claude's live agents in one distro and its per-pid session files, as (agents, files). Both are empty when Claude
    is not installed there. Raises WslError when the distro cannot be reached, does not answer in time, or Claude's
    output cannot be read. Boots the distro when it is stopped; `boot` allows the longer wait that takes."""
    output = run(executable, ['-d', name, '--exec', 'sh', '-lc', SCAN], timeout=BOOT_TIMEOUT if boot else SCAN_TIMEOUT)
    begin = output.find(BEGIN)
    if begin < 0:
        return [], []
    text = output[begin + len(BEGIN):].split(END, 1)[0]
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
