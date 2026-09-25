#!/usr/bin/env python3
"""Delete a ticket's remote branch once the ticket closes.

Driven by .github/workflows/delete-branch.yml (hosted in oneezy/tools, called from any repo).
Every input is an environment variable, so it runs by hand too:
    REPO=oneezy/tools EVENT=issues ACTION=closed ISSUE=33 DRY_RUN=1 python3 scripts/delete_remote_branch.py
"""
from functools import cached_property
import json
import os
import re
import subprocess
import sys
from urllib.parse import quote


class HttpError(RuntimeError):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


class Gone(Exception):
    """Another run deleted the branch after this one listed it: the closing PR and its ticket
    fire at the same moment, and GitHub may auto-delete a merged head."""


class GitHub:
    def __init__(self, repo, executable):
        self.repo = repo
        self.prefix = [sys.executable, executable] if executable.endswith('.py') else [executable]

    def api(self, *args, absent=()):
        """Run gh api; an HTTP status listed in absent answers None instead of failing."""
        result = subprocess.run(self.prefix + ['api', *args], capture_output=True, text=True, encoding='utf-8', errors='replace')
        if result.returncode:
            status = re.search(r'HTTP (\d{3})', result.stderr)
            status = status and int(status.group(1))
            if status in absent:
                return None
            raise HttpError(status, result.stderr.strip() or f'gh api {" ".join(args)} failed')
        return json.loads(result.stdout) if result.stdout.strip() else None

    def branches(self):
        return [r['ref'][len('refs/heads/'):] for r in self.api(f'repos/{self.repo}/git/matching-refs/heads/')]

    @cached_property
    def default_branch(self):
        """Looked up only when a branch is up for deletion."""
        return self.api(f'repos/{self.repo}')['default_branch']

    def protected(self, branch):
        name = quote(branch, safe='/')
        info = self.api(f'repos/{self.repo}/branches/{name}', absent=(404,))
        if info is None:
            raise Gone
        if info.get('protected'):
            return True
        # A private repo on a free plan has no rulesets, and the rules API answers 403 there.
        rules = self.api(f'repos/{self.repo}/rules/branches/{name}', absent=(403, 404)) or []
        return any(rule.get('type') == 'deletion' for rule in rules)

    def open_pull_request(self, branch):
        owner = self.repo.split('/')[0]
        for side in (f'head={quote(owner + ":" + branch, safe="")}', f'base={quote(branch, safe="")}'):
            pulls = self.api(f'repos/{self.repo}/pulls?state=open&per_page=1&{side}')
            if pulls:
                return pulls[0]['number']
        return None

    def ticket_closed(self, number):
        """True only for a closed issue; a missing number or a pull request is no ticket."""
        issue = self.api(f'repos/{self.repo}/issues/{number}', absent=(404,))
        return bool(issue) and 'pull_request' not in issue and issue['state'] == 'closed'

    def delete(self, branch):
        try:
            self.api('-X', 'DELETE', f'repos/{self.repo}/git/refs/heads/{quote(branch, safe="/")}')
        except HttpError as error:
            if error.status == 422 and 'Reference does not exist' in str(error):
                raise Gone from None
            raise


TICKET = re.compile(r'^(?:[^/]+/)?(\d+)-')


def ticket_of(branch):
    match = TICKET.match(branch)
    return match and match.group(1)


def ticket_branches(branches, number):
    return [b for b in branches if ticket_of(b) == number]


def reason_to_keep(github, branch, permanent):
    if branch in permanent or branch == github.default_branch:
        return 'a permanent branch'
    if branch.startswith('prototype/'):
        return 'prototype branches are kept'
    if github.protected(branch):
        return 'protected'
    number = github.open_pull_request(branch)
    if number:
        return f'open pull request #{number} still uses it'
    return None


def candidates(github, env, integration):
    """The branches this closing event makes deletable, before the keep rules."""
    if env.get('ACTION') != 'closed':
        return []
    if env.get('EVENT') == 'issues':
        return ticket_branches(github.branches(), env['ISSUE'])
    if env.get('EVENT') != 'pull_request' or env.get('PR_HEAD_REPO', github.repo) != github.repo:
        return []  # a fork's head lives in the fork; a same-named branch here is someone else's
    head = env['PR_HEAD']
    ticket = ticket_of(head)
    landed = env.get('PR_MERGED') == 'true' and env.get('PR_BASE') == integration
    if not landed and not (ticket and github.ticket_closed(ticket)):
        return []
    return [head] if head in github.branches() else []  # GitHub may have auto-deleted it already


def main():
    env = os.environ
    if not env.get('REPO'):
        sys.exit('delete_remote_branch.py: set REPO=owner/name')
    github = GitHub(env['REPO'], env.get('GH', 'gh'))
    integration = env.get('INTEGRATION_BRANCH') or 'dev'
    permanent = {'main', 'dev', integration, env.get('RELEASE_BRANCH') or 'main'}
    failed = []
    for branch in candidates(github, env, integration):
        try:
            reason = reason_to_keep(github, branch, permanent)
            if reason:
                print(f'kept {branch}: {reason}')
            elif env.get('DRY_RUN'):
                print(f'would delete {branch}')
            else:
                github.delete(branch)
                print(f'deleted {branch}')
        except Gone:
            print(f'{branch} is already gone')
        except RuntimeError as error:  # one branch failing must not skip the rest
            print(f'failed {branch}: {error}', file=sys.stderr)
            failed.append(branch)
    if failed:
        sys.exit(f'delete_remote_branch.py: could not delete {", ".join(failed)}')


if __name__ == '__main__':
    main()
