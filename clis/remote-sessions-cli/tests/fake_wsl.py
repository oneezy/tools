"""Test-only `wsl.exe` substitute. Boots nothing real; records what a real WSL would have done.

State lives in the JSON file named by FAKE_WSL_STATE:
  Distros: [{Name, State, Version}]    what `wsl --list --verbose` reports
  Homes:   {distro: {Agents, Files, Noise}}  what Claude in a distro reports: `claude agents --json --all` and its
                                       per-pid session files, with the Noise text a login shell prints before and
                                       after them; a distro without an entry has no Claude installed
           {distro: {Hang: seconds}}       a wedged distro: the command sleeps that long before printing anything
           {distro: {Shell: {Config, Path}}}  run the command in a real local `sh` instead, with that Claude config
                                       folder and that folder of commands first on PATH
  Boots:   count of stopped distros a command started, as `wsl -d <stopped distro>` does
  Calls:   every argument list received
Without a state file it behaves like WSL with no distributions installed.
"""
import json
import os
from pathlib import Path
import subprocess
import sys
import time

args = sys.argv[1:]
path = Path(os.environ.get('FAKE_WSL_STATE', '')) if os.environ.get('FAKE_WSL_STATE') else None
data = json.loads(path.read_text()) if path and path.is_file() else None


def out(text, utf16=False):
    # Without WSL_UTF8, wsl.exe's own messages are UTF-16LE; programs run inside a distro print their own bytes.
    sys.stdout.buffer.write(text.encode('utf-16-le' if utf16 and not os.environ.get('WSL_UTF8') else 'utf-8'))
    sys.stdout.flush()


if data is None:
    out('Windows Subsystem for Linux has no installed distributions.\r\n', utf16=True)
    sys.exit(1)
data.setdefault('Calls', []).append(args)
data.setdefault('Boots', 0)


def save():
    path.write_text(json.dumps(data))


if args in (['--list', '--verbose'], ['-l', '-v']):
    lines = ['  NAME              STATE           VERSION']
    lines += [f"{'*' if n == 0 else ' '} {d['Name']:<17} {d['State']:<15} {d.get('Version', 2)}" for n, d in enumerate(data['Distros'])]
    save()
    out('\r\n'.join(lines) + '\r\n', utf16=True)
elif args[:1] in (['-d'], ['--distribution']) and args[2:4] in (['--exec', 'sh'], ['-e', 'sh']) and args[4] == '-lc':
    distro = next((d for d in data['Distros'] if d['Name'] == args[1]), None)
    if not distro:
        save()
        out('There is no distribution with the supplied name.\r\n', utf16=True)
        sys.exit(1)
    if distro['State'] != 'Running':
        distro['State'] = 'Running'
        data['Boots'] += 1
    save()
    script, home = args[5], data.get('Homes', {}).get(args[1])
    if home and home.get('Hang'):
        time.sleep(home['Hang'])
    if home and home.get('Shell'):
        shell = home['Shell']
        env = dict(os.environ, CLAUDE_CONFIG_DIR=shell['Config'], PATH=shell['Path'] + os.pathsep + os.environ['PATH'])
        result = subprocess.run(['sh', '-lc', script], env=env, capture_output=True)
        sys.stdout.buffer.write(result.stdout)
        sys.stderr.buffer.write(result.stderr)
        sys.exit(result.returncode)
    # Emulates the distro running the engine's script: nothing without Claude; else Claude's agent list, then the
    # contents of each session file.
    assert 'claude agents --json --all' in script and 'sessions/*.json' in script, script
    begin, end = 'echo @@claude-scan@@', 'echo @@claude-scan-end@@'
    assert begin in script and end in script, script
    if home:
        noise = home.get('Noise') or ''
        out(noise + begin[5:] + '\n' + json.dumps(home.get('Agents', [])) + '\n'
            + ''.join(json.dumps(f) + '\n' for f in home.get('Files', [])) + end[5:] + '\n' + noise)
else:
    save()
    raise ValueError(args)
