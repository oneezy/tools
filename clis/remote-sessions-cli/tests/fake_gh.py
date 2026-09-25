"""Test-only gh substitute. Answers the GitHub REST calls the tools make from a JSON
fixture named by FAKE_GH_STATE, and records every call. Touches no network.

Fixture keys: Repo, DefaultBranch, RulesForbidden (the rules API answers 403, as it does on a
free-plan private repo), Branches {name: {protected, deletionRule, vanishes, deleteFails}} where vanishes
says when another run deletes it (after-listing: every call after the branch list misses it;
before-delete: only the DELETE misses it) and deleteFails makes its DELETE answer 403,
Issues {number: open|closed}, Pulls (share the issue numbers, as on GitHub) [{number, head, headRepo, base, state, merged}], Calls.
"""
import json
import os
from pathlib import Path
import sys
from urllib.parse import parse_qs, unquote, urlsplit

file = Path(os.environ['FAKE_GH_STATE'])
data = json.loads(file.read_text())
args = sys.argv[1:]
data.setdefault('Calls', []).append(args)


def save():
    file.write_text(json.dumps(data))


def reply(value):
    save()
    print(json.dumps(value))
    sys.exit(0)


def fail(status, message):
    save()
    print(f'gh: {message} (HTTP {status})', file=sys.stderr)
    sys.exit(1)


if not args or args[0] != 'api':
    fail(400, f'fake gh does not handle {args}')
method = 'GET'
rest = args[1:]
if rest[:2] in (['-X', 'DELETE'], ['--method', 'DELETE']):
    method, rest = 'DELETE', rest[2:]
url = urlsplit(rest[0])
path, query = unquote(url.path), {k: v[0] for k, v in parse_qs(url.query).items()}
repo = data['Repo']
owner = repo.split('/')[0]
base = f'repos/{repo}'
branches = data['Branches']

if path == base:
    reply(dict(full_name=repo, default_branch=data['DefaultBranch']))
if path == f'{base}/git/matching-refs/heads/':
    listed = [dict(ref=f'refs/heads/{name}') for name in branches]
    for name in [n for n, b in branches.items() if b.get('vanishes') == 'after-listing']:
        del branches[name]
    reply(listed)
if path.startswith(f'{base}/git/refs/heads/') and method == 'DELETE':
    name = path[len(f'{base}/git/refs/heads/'):]
    if branches.get(name, {}).get('vanishes') == 'before-delete':
        del branches[name]
    if name not in branches:
        fail(422, 'Reference does not exist')
    if branches[name].get('deleteFails'):
        fail(403, 'Resource not accessible by integration')
    del branches[name]
    save()
    sys.exit(0)
if path.startswith(f'{base}/branches/'):
    name = path[len(f'{base}/branches/'):]
    if name not in branches:
        fail(404, 'Branch not found')
    reply(dict(name=name, protected=bool(branches[name].get('protected'))))
if path.startswith(f'{base}/rules/branches/'):
    if data.get('RulesForbidden'):
        fail(403, 'Upgrade to GitHub Pro or make this repository public to enable this feature.')
    name = path[len(f'{base}/rules/branches/'):]
    reply([dict(type='deletion')] if branches.get(name, {}).get('deletionRule') else [])
if path.startswith(f'{base}/issues/'):
    number = path[len(f'{base}/issues/'):]
    pull = next((p for p in data.get('Pulls', []) if str(p['number']) == number), None)
    if pull:
        reply(dict(number=int(number), state=pull['state'], pull_request=dict(url=f'{base}/pulls/{number}')))
    if number not in data['Issues']:
        fail(404, 'Not Found')
    reply(dict(number=int(number), state=data['Issues'][number]))
if path == f'{base}/pulls':
    pulls = [p for p in data.get('Pulls', []) if p['state'] == query.get('state', 'open')]
    if 'head' in query:
        pulls = [p for p in pulls if f"{p.get('headRepo', repo).split('/')[0]}:{p['head']}" == query['head']]
    if 'base' in query:
        pulls = [p for p in pulls if p['base'] == query['base']]
    reply([dict(number=p['number'], head=dict(ref=p['head']), base=dict(ref=p['base'])) for p in pulls])
fail(404, f'fake gh has no route for {method} {rest[0]}')
