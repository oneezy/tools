"""Test-only GitHub CLI substitute. Answers the merged-PR and ticket queries the cleanup sweep asks from the JSON file
FAKE_GH_DATA names, and records every call with its folder. Starts nothing and needs no network."""
import json
import os
from pathlib import Path
import sys
import time

file = Path(os.environ['FAKE_GH_DATA'])
args = sys.argv[1:]


def load():
    return json.loads(file.read_text(encoding='utf-8'))


def option(name):
    return args[args.index(name) + 1] if name in args else None


# Calls are recorded before any hold, so a test can see a sweep that is still waiting on GitHub.
data = load()
data['Calls'].append(dict(Args=args, Cwd=os.getcwd()))
file.write_text(json.dumps(data), encoding='utf-8')
index = len(data['Calls']) - 1
deadline = time.monotonic() + 60
# Hold holds every call from the HoldAfter-th on (0 by default) while its file exists.
while data.get('Hold') and index >= data.get('HoldAfter', 0) and Path(data['Hold']).exists() and time.monotonic() < deadline:
    time.sleep(.1)
data = load()
if data.get('Mode') == 'failure':
    print('error connecting to api.github.com', file=sys.stderr)
    sys.exit(1)
if args[:2] == ['pr', 'list']:
    fields = option('--json').split(',')
    state = (option('--state') or 'open').upper()
    found = [pr for pr in data['PullRequests'] if pr['headRefName'] == option('--head') and state in ('ALL', pr['state'])]
    print(json.dumps([{f: pr.get(f) for f in fields} for pr in found]))
elif args[0] == 'api' and args[1].startswith('repos/{owner}/{repo}/issues/'):
    # Like gh api, GitHub's answer goes to stdout even when the call fails; Wording changes gh's own error line.
    number = args[1].rsplit('/', 1)[1]
    state = data['Issues'].get(number)
    if not state:
        print(json.dumps(dict(message='Not Found', status='404')))
        print(data.get('Wording') or 'gh: Not Found (HTTP 404)', file=sys.stderr)
        sys.exit(1)
    print(json.dumps(dict(number=int(number), state=state.lower())))
else:
    raise ValueError(args)
