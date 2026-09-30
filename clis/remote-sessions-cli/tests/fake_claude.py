"""Test-only native CLI substitute. Starts no agent process."""
import json
import os
from pathlib import Path
import sys
import uuid

config = Path(os.environ['CLAUDE_CONFIG_DIR'])
file = config / 'fake-native.json'
data = json.loads(file.read_text())
args = sys.argv[1:]


def save():
    file.write_text(json.dumps(data))


if args[0] == 'agents':
    if data.get('Mode') == 'inventory-failure':
        sys.exit(6)
    print('{invalid' if data.get('Mode') == 'malformed' else json.dumps(data['Agents']))
elif args[0] == '--bg':
    data['Starts'] += 1
    data['LastArguments'], data['LastDirectory'] = args, os.getcwd()
    if data.get('Mode') == 'launch-failure':
        save()
        sys.exit(9)
    new = '--resume' not in args
    id = str(uuid.uuid4()) if new else args[args.index('--resume') + 1]
    copied = any(a['sessionId'] == id and a['kind'] == 'background' for a in data['Agents']) and '--remote-control' in args
    if copied:
        id = str(uuid.uuid4())
    agent = dict(id=id[:8], sessionId=id, kind='background', state='idle', cwd=os.getcwd(), pid=9000 + data['Starts'], startedAt=f"run-{data['Starts']}")
    if data.get('Mode') == 'wrong-directory':
        agent['cwd'] = str(config)
    data['Agents'] = [a for a in data['Agents'] if a['sessionId'] != id] + [agent]
    history = config / 'projects' / 'test-history'
    history.mkdir(parents=True, exist_ok=True)
    (history / f'{id}.jsonl').write_text(json.dumps(dict(type='user', sessionId=id, cwd=agent['cwd'], timestamp='2026-09-24T12:00:00Z')))
    save()
    if data.get('Mode') == 'launch-exit-failure':
        sys.exit(9)
    if copied:
        print('Note: Started a copy with updated options.')
    print(f'Resumed {id}')
elif args[0] == 'stop':
    matches = [a for a in data['Agents'] if a.get('id') == args[1]]
    assert len(matches) == 1
    data['Stops'] += 1
    if data.get('Mode') != 'stop-no-effect':
        matches[0].update(state='stopped', pid=None)
    save()
else:
    raise ValueError(args)
