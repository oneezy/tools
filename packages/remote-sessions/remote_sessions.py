#!/usr/bin/env python3
"""Local Claude session manager. Python 3.10+, Git and Claude Code; no pip packages."""
import argparse
from contextlib import contextmanager, nullcontext
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import time
import uuid

import task_worktrees as wt


def read_json(path, default=None):
    try:
        return json.loads(Path(path).read_text(encoding='utf-8-sig'))
    except FileNotFoundError:
        return default


def write_json(path, data):
    fd, temporary = tempfile.mkstemp(prefix=path.name + '.', suffix='.tmp', dir=path.parent)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as stream:
            json.dump(data, stream, indent=2)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


@contextmanager
def root_lock(root, timeout=30):
    # The file stays in place so another process cannot lock a different inode.
    with open(root / '.remote-sessions.lock', 'a+b') as stream:
        stream.seek(0, 2)
        if not stream.tell():
            stream.write(b'\0')
            stream.flush()
        deadline = time.monotonic() + timeout
        while True:
            try:
                stream.seek(0)
                if os.name == 'nt':
                    import msvcrt
                    msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
                else:
                    import fcntl
                    fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except OSError:
                if time.monotonic() >= deadline:
                    raise RuntimeError('Another launcher action is still running.')
                time.sleep(.1)
        try:
            yield
        finally:
            stream.seek(0)
            if os.name == 'nt':
                msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(stream, fcntl.LOCK_UN)


def active(agent):
    return bool(agent and agent.get('pid') and agent.get('state') not in
                ('stopped', 'completed', 'failed', 'exited', 'done'))


class Manager:
    def __init__(self, options):
        self.options = options
        self.root = Path(options.root).expanduser().absolute()
        self.config = Path(options.config).expanduser().absolute()
        self.state_path = self.root / '.remote-sessions.json'

    def projects(self):
        projects = {p.name: p for p in sorted(self.root.iterdir()) if p.is_dir() and not p.name.startswith(('.', '_'))}
        names = [n.strip() for item in self.options.only for n in item.split(',') if n.strip()]
        for name in names:
            if name not in projects:
                raise ValueError(f"Unknown project '{name}' in {self.root}.")
        return {n: p for n, p in projects.items() if not names or n in names}

    def state(self):
        state = read_json(self.state_path, dict(Version=2, Sessions={}))
        if state.get('Version') != 2 or not isinstance(state.get('Sessions'), dict):
            raise ValueError(f'Unrecognized state format: {self.state_path}')
        return state

    def claude(self, args, directory=None):
        executable = self.options.claude
        prefix = [executable]
        if executable.endswith('.py'):
            prefix = [sys.executable, executable]
        elif executable.endswith('.ps1'):
            prefix = ['pwsh', '-NoProfile', '-File', executable]
        env = os.environ.copy()
        if 'CLAUDE_CONFIG_DIR' in env or not wt.same(self.config, Path.home() / '.claude'):
            env['CLAUDE_CONFIG_DIR'] = str(self.config)
        result = subprocess.run(prefix + args, cwd=directory or self.root, env=env,
                                capture_output=True, text=True, encoding='utf-8', errors='replace')
        if result.returncode:
            raise RuntimeError(f'Claude exited {result.returncode}. {result.stderr.strip() or result.stdout.strip()}')
        return result.stdout

    def agents(self):
        agents = json.loads(self.claude(['agents', '--json', '--all']))
        if not isinstance(agents, list):
            raise ValueError('Claude returned an unexpected agent inventory format.')
        for agent in agents:
            if not agent.get('sessionId') or not agent.get('cwd'):
                raise ValueError('Claude returned an incomplete agent record.')
            if agent.get('kind') == 'interactive' and agent.get('pid'):
                agent['state'] = agent.get('status')
            elif agent.get('kind') == 'background':
                if not agent.get('id'):
                    raise ValueError('Claude returned an incomplete agent record.')
            elif agent.get('kind') == 'interactive':
                raise ValueError('Claude returned an incomplete agent record.')
            else:
                raise ValueError('Claude returned an unexpected agent kind.')
        return agents

    def saved(self):
        catalog = {}
        projects = self.projects()
        # Transcripts repeat a few folders thousands of times; resolving each is slow on Windows.
        roots = {}
        for file in (self.config / 'projects').glob('*/*.jsonl'):
            try:
                if str(uuid.UUID(file.stem)) != file.stem.lower():
                    continue
            except ValueError:
                continue
            cwd, title, auto_title, conflict = None, None, None, False
            updated = datetime.fromtimestamp(file.stat().st_mtime, timezone.utc).isoformat()
            # Stream metadata; never expose prompts or tool results as session labels.
            with file.open(encoding='utf-8-sig', errors='replace') as stream:
                for line in stream:
                    try:
                        record = json.loads(line)
                    except ValueError:
                        continue
                    if record.get('isSidechain'):
                        continue
                    if record.get('sessionId') and record['sessionId'] != file.stem:
                        conflict = True
                    if record.get('cwd'):
                        candidate = record['cwd']
                        # Another OS's transcripts are not local runnable tasks.
                        if not os.path.isabs(candidate):
                            continue
                        if candidate not in roots:
                            roots[candidate] = candidate
                            # Tool activity may temporarily cd below the task root. Those
                            # records still belong to the same persistent worktree.
                            for path in projects.values():
                                parent = path / '.claude' / 'worktrees'
                                if wt.inside(candidate, parent):
                                    relative = os.path.relpath(candidate, parent)
                                    roots[candidate] = str(parent / Path(relative).parts[0])
                                    break
                        candidate = roots[candidate]
                        if cwd and not wt.same(cwd, candidate):
                            conflict = True
                        cwd = candidate
                    if record.get('type') == 'custom-title' and record.get('customTitle'):
                        title = record['customTitle']
                    if record.get('type') == 'ai-title' and record.get('aiTitle'):
                        auto_title = record['aiTitle']
                    if record.get('type') == 'agent-name' and record.get('agentName'):
                        auto_title = record['agentName']
                    if record.get('type') == 'user' and record.get('timestamp'):
                        updated = record['timestamp']
            if not cwd:
                continue
            for project, path in projects.items():
                is_tree = wt.inside(cwd, path / '.claude' / 'worktrees')
                if not is_tree and not (self.options.include_project_sessions and wt.same(cwd, path)):
                    continue
                reason = ('history has conflicting session or folder metadata' if conflict else
                          'history saved; working folder missing' if not Path(cwd).is_dir() else
                          'history saved; worktree checkout missing' if is_tree and not (Path(cwd) / '.git').exists() else None)
                row = dict(SessionId=file.stem, Project=project, WorkingDirectory=cwd, Updated=updated,
                           Worktree=is_tree, Available=not reason, UnavailableReason=reason, Title=title or auto_title)
                if file.stem in catalog and not wt.same(catalog[file.stem]['WorkingDirectory'], cwd):
                    raise ValueError(f'Conflicting saved locations for session {file.stem}.')
                catalog[file.stem] = row
        return sorted(catalog.values(), key=lambda s: s['Updated'], reverse=True)

    def managed(self, id, entry, saved):
        found = next((dict(s) for s in saved if s['SessionId'] == id), None)
        row = found or dict(SessionId=id, Project=entry['Project'], WorkingDirectory=entry.get('WorkingDirectory'),
                            Available=False, NewSession=entry.get('NewSession', False),
                            UnavailableReason='saved worktree or transcript missing')
        row.update(Task=entry.get('Task'), Branch=entry.get('Branch'))
        return row

    def selection(self, saved, state):
        o = self.options
        projects = self.projects()
        sessions = state['Sessions']
        named = o.task or o.branch or o.issue or o.pr
        if named:
            if len(projects) != 1 or o.session_id or o.action != 'start':
                raise ValueError('Use task/issue/PR/branch with start and exactly one --only project, without --session-id.')
            project = next(iter(projects))
            name = task_label(o) or o.branch
            matches = [(id, e) for id, e in sessions.items() if e['Project'] == project and not e.get('ReplacedBy')
                       and (e.get('Task') == name or (o.branch and e.get('Branch') == o.branch))]
            if len(matches) > 1:
                raise ValueError('More than one saved task matches; select its exact session ID.')
            if matches:
                id, entry = matches[0]
                if o.branch and entry.get('Branch') and entry['Branch'] != o.branch:
                    raise ValueError('Task already uses another branch; choose a different task name.')
                return [self.managed(id, entry, saved)]
            return [dict(SessionId=str(uuid.uuid4()), Project=project, Task=name, Branch=o.branch,
                         Available=False, NewSession=True, Name=wt.task_name(project, o.task or o.branch, o.issue, o.pr))]
        if o.session_id:
            id, visited = o.session_id, set()
            while sessions.get(id, {}).get('ReplacedBy'):
                if id in visited:
                    raise ValueError('Saved replacement links contain a cycle.')
                visited.add(id)
                id = sessions[id]['ReplacedBy']
            if id in sessions:
                if sessions[id]['Project'] not in projects:
                    raise ValueError('The saved session belongs to a different project.')
                return [self.managed(id, sessions[id], saved)]
            found = [s for s in saved if s['SessionId'] == id]
            if len(found) != 1:
                raise ValueError(f'Saved session {id} was not found. No replacement will be created.')
            return found
        if o.action == 'resume':
            raise ValueError('Resume requires --session-id with the full saved conversation UUID.')
        selected = []
        for project in projects:
            managed = [(id, e) for id, e in sessions.items() if e['Project'] == project and not e.get('ReplacedBy')]
            if managed:
                selected.extend(self.managed(id, e, saved) for id, e in managed)
                continue
            found = [s for s in saved if s['Project'] == project and s['Available']]
            seen = set()
            for s in found:
                key = os.path.normcase(os.path.abspath(s['WorkingDirectory']))
                if key not in seen:
                    selected.append(s)
                    seen.add(key)
            if not found:
                raise ValueError(f'{project}: no available task. Use --task with a descriptive name, or resume an exact history ID.')
        return selected

    def launch_plan(self, s, agents):
        id, project = s['SessionId'], s['Project']
        directory = s.get('WorkingDirectory')
        running = [a for a in agents if active(a) and (a['sessionId'] == id or wt.same(a['cwd'], directory))]
        if running:
            return dict(Session=s, Mode='running', Arguments=[], WorkingDirectory=running[0]['cwd'],
                        SessionId=running[0]['sessionId'], Project=project)
        background = any(a['sessionId'] == id and a['kind'] == 'background' for a in agents)
        args = ['--bg', '--resume', id]
        if not background:
            args += ['--remote-control', f"{project} {s.get('Task') or s.get('Title') or Path(directory or project).name}"]
        base = dict(Session=s, Mode='resume', Arguments=args, WorkingDirectory=directory, SessionId=id, Project=project)
        if s.get('Available'):
            return base
        if 'conflicting' in (s.get('UnavailableReason') or ''):
            raise ValueError('Conflicting session metadata needs inspection before recovery.')
        name = s.get('Name') or wt.task_name(project, s.get('Task') or f'recovered-{id[:8]}')
        workspace = wt.plan(self.projects()[project], name, s.get('Branch'), directory)
        base['Workspace'] = workspace
        base['WorkingDirectory'] = workspace['WorkingDirectory']
        if not s.get('NewSession') and wt.same(directory, workspace['WorkingDirectory']) and (workspace['Operation'] == 'restore' or (workspace['Operation'] == 'reuse' and background)):
            return base
        if workspace['Operation'] == 'reuse':
            other = next((a for a in agents if active(a) and wt.same(a['cwd'], workspace['WorkingDirectory'])), None)
            if other:
                base.update(Mode='running', SessionId=other['sessionId'], Arguments=[])
                return base
            old = next((r for r in self.saved() if r['Available'] and wt.same(r['WorkingDirectory'], workspace['WorkingDirectory'])), None)
            if old:
                old.update(Task=s.get('Task'), Branch=workspace['Branch'])
                return self.launch_plan(old, agents)
        base.update(Mode='new', Arguments=['--bg', '--remote-control', f"{project} {s.get('Task') or name}"])
        return base

    def bridge(self, agent):
        if not active(agent):
            return None
        try:
            data = read_json(self.config / 'sessions' / f"{agent['pid']}.json", {})
        except ValueError:
            return None
        if data.get('pid') == agent['pid'] and data.get('sessionId') == agent['sessionId']:
            return data.get('bridgeSessionId')
        return None

    def status(self, saved, state, agents):
        sessions = state['Sessions']
        rows = list(saved)
        ids = {r['SessionId'] for r in rows}
        rows += [self.managed(id, e, saved) for id, e in sessions.items()
                 if id not in ids and e['Project'] in self.projects()]
        result = []
        for s in rows:
            id = s['SessionId']
            agent = next((a for a in agents if a['sessionId'] == id and active(a)), None)
            entry = sessions.get(id, {})
            owned = entry.get('Ownership') == 'confirmed'
            if agent:
                owned = owned and agent['kind'] == 'background' and wt.same(agent['cwd'], entry.get('WorkingDirectory')) and agent.get('startedAt') == entry.get('StartedAt')
            bridge = self.bridge(agent)
            task = entry.get('Task')
            title = (task if task not in (None, 'remote') else None) or (agent or {}).get('name') or s.get('Title') or task or Path(s.get('WorkingDirectory') or s['Project']).name
            result.append(dict(s, Task=title, Branch=entry.get('Branch'), Managed=bool(owned), Running=active(agent),
                               State=agent.get('state') if agent else s.get('UnavailableReason') or 'stopped',
                               RemoteRegistered=bool(bridge), RemoteSessionId=bridge,
                               RemoteUrl=f'https://claude.ai/code/{bridge}' if bridge else None,
                               Connection='registration found; delivery unverified' if bridge else 'no bridge registration',
                               AgentId=(agent or {}).get('id'), ReplacedBy=entry.get('ReplacedBy')))
        return result

    def start(self, selected, state):
        results = []
        sessions = state['Sessions']
        for s in selected:
            before = self.agents()
            launch = self.launch_plan(s, before)
            s = launch['Session']
            id = s['SessionId']
            workspace = launch.get('Workspace')
            if launch['Mode'] == 'running':
                pending = s.get('NewSession') and id in sessions
                if self.options.task or self.options.branch or self.options.issue or self.options.pr or pending:
                    entry = sessions.setdefault(launch['SessionId'], dict(Project=s['Project'], WorkingDirectory=launch['WorkingDirectory'], Ownership='unmanaged'))
                    entry.update(Task=s.get('Task'), Branch=workspace['Branch'] if workspace else s.get('Branch'))
                    if pending and id != launch['SessionId']:
                        sessions[id]['ReplacedBy'] = launch['SessionId']
                    write_json(self.state_path, state)
                results.append(dict(Project=s['Project'], SessionId=launch['SessionId'], WorkingDirectory=launch['WorkingDirectory'], Result='already running; not restarted or adopted'))
                continue
            replaces = id if launch['Mode'] == 'new' and not s.get('NewSession') else None
            if replaces:
                id = str(uuid.uuid4())
            branch = workspace['Branch'] if workspace else s.get('Branch') or wt.git(launch['WorkingDirectory'], 'symbolic-ref', '--quiet', '--short', 'HEAD', check=False).stdout.strip()
            sessions[id] = dict(Project=s['Project'], Task=s.get('Task'), Branch=branch, WorkingDirectory=launch['WorkingDirectory'],
                                Ownership='pending', NewSession=launch['Mode'] == 'new', Replaces=replaces,
                                Updated=datetime.now(timezone.utc).isoformat())
            if replaces:
                sessions.setdefault(replaces, dict(Project=s['Project'], WorkingDirectory=s.get('WorkingDirectory'), Ownership='unmanaged'))['ReplacedBy'] = id
            write_json(self.state_path, state)
            if workspace:
                wt.create(workspace)
            output = self.claude(launch['Arguments'], launch['WorkingDirectory'])
            agent = None
            prior_ids = {a['sessionId'] for a in before}
            for attempt in range(10):
                inventory = self.agents()
                matches = [a for a in inventory if active(a) and
                           ((a['kind'] == 'background' and a['sessionId'] not in prior_ids and wt.same(a['cwd'], launch['WorkingDirectory']))
                            if launch['Mode'] == 'new' else a['sessionId'] == id)]
                if len(matches) > 1:
                    raise ValueError('More than one native session matches the launch; ownership remains pending.')
                if matches:
                    agent = matches[0]
                    break
                time.sleep(.5)
            if not agent or not agent.get('startedAt') or agent['kind'] != 'background' or not wt.same(agent['cwd'], launch['WorkingDirectory']) or re.search(r'^\s*note:.*(copy|copied)', output, re.I | re.M):
                raise RuntimeError('Claude did not confirm the requested session and folder. Ownership remains pending; inspect claude agents.')
            if launch['Mode'] == 'new' and agent['sessionId'] != id:
                sessions[agent['sessionId']] = sessions.pop(id)
                for entry in sessions.values():
                    if entry.get('ReplacedBy') == id:
                        entry['ReplacedBy'] = agent['sessionId']
                id = agent['sessionId']
            sessions[id].update(Ownership='confirmed', NewSession=False, StartedAt=agent.get('startedAt'))
            write_json(self.state_path, state)
            bridge = self.bridge(agent)
            result = 'resumed original conversation and worktree' if launch['Mode'] == 'resume' else 'created replacement task; previous branch and history retained' if replaces else 'created task in a persistent worktree'
            results.append(dict(Project=s['Project'], SessionId=id, Task=s.get('Task'), Branch=branch,
                                WorkingDirectory=launch['WorkingDirectory'], Replaces=replaces, Result=result,
                                RemoteRegistered=bool(bridge), RemoteUrl=f'https://claude.ai/code/{bridge}' if bridge else None,
                                Connection='registration found; delivery unverified' if bridge else 'no bridge registration; attach and run /remote-control'))
        return results

    def stop(self, state):
        selected = [(id, e) for id, e in state['Sessions'].items() if e['Project'] in self.projects()
                    and not e.get('ReplacedBy') and (not self.options.session_id or self.options.session_id == id)]
        if not selected:
            raise ValueError('No matching managed sessions. Nothing was stopped.')
        results = []
        for id, entry in selected:
            if entry.get('Ownership') != 'confirmed':
                raise ValueError(f'Session {id} has uncertain ownership; inspect it before stopping.')
            agents = self.agents()
            matches = [a for a in agents if a['sessionId'] == id and active(a)]
            if matches:
                a = matches[0]
                if len(matches) != 1 or a['kind'] != 'background' or not wt.same(a['cwd'], entry['WorkingDirectory']) or not a.get('startedAt') or a['startedAt'] != entry.get('StartedAt'):
                    raise ValueError(f'Session {id} is now owned by another run; nothing was stopped.')
                if sum(item.get('id') == a['id'] for item in agents) != 1:
                    raise ValueError('Ambiguous native agent identifier; nothing was stopped.')
                self.claude(['stop', a['id']])
                if any(a['sessionId'] == id and active(a) for a in self.agents()):
                    raise RuntimeError('Claude still reports the session active after stop.')
            results.append(dict(SessionId=id, Project=entry['Project'], Result='stopped; conversation and worktree retained' if matches else 'already stopped; history retained'))
        return results

    def execute(self):
        o = self.options
        if o.action in ('start', 'resume', 'stop', 'workspace') and not o.only:
            raise ValueError('Choose projects explicitly with --only.')
        mutation = o.action in ('start', 'resume', 'stop', 'workspace') and not o.plan
        with root_lock(self.root) if mutation else nullcontext():
            state = self.state()
            if o.action == 'workspace':
                projects = self.projects()
                if len(projects) != 1:
                    raise ValueError('Workspace requires exactly one --only project.')
                project = next(iter(projects))
                name = wt.task_name(project, o.task or o.branch, o.issue, o.pr)
                workspace = wt.plan(projects[project], name, o.branch)
                if not o.plan:
                    wt.create(workspace)
                workspace['Commands'] = dict(Claude=['claude', '--remote-control', name], Codex=['codex', '-C', workspace['WorkingDirectory']])
                workspace['Title'] = name
                return [workspace]
            if o.action == 'stop':
                if o.plan:
                    return [dict(Project=e['Project'], SessionId=id, Result='stop managed session; keep history') for id, e in state['Sessions'].items()
                            if e['Project'] in self.projects() and (not o.session_id or id == o.session_id)]
                return self.stop(state)
            saved = self.saved()
            if o.action == 'sessions':
                return saved
            if o.action == 'status':
                return self.status(saved, state, self.agents())
            selected = self.selection(saved, state)
            if o.plan:
                agents = self.agents()
                return [self.launch_plan(s, agents) for s in selected]
            return self.start(selected, state)


def task_label(options):
    return ' '.join(str(v) for v in (f'issue-{options.issue}' if options.issue else f'pr-{options.pr}' if options.pr else '', options.task) if v)


def parser():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('action', nargs='?', default='menu', choices=['menu', 'sessions', 'status', 'start', 'resume', 'stop', 'workspace'])
    default_root = os.environ.get('REMOTE_PROJECTS_ROOT') or str(Path('V:/dev') if os.name == 'nt' and Path('V:/dev').is_dir() else Path.home() / 'dev')
    p.add_argument('--root', '-Root', default=default_root)
    p.add_argument('--only', '-Only', nargs='+', default=[])
    p.add_argument('--session-id', '-SessionId')
    p.add_argument('--task', '-Task')
    p.add_argument('--branch', '-Branch')
    ticket = p.add_mutually_exclusive_group()
    ticket.add_argument('--issue', '-Issue', type=int)
    ticket.add_argument('--pr', '-PR', type=int)
    p.add_argument('--plan', '-Plan', action='store_true')
    p.add_argument('--json', '-Json', action='store_true')
    p.add_argument('--include-project-sessions', '-IncludeProjectSessions', action='store_true')
    p.add_argument('--config', '-ClaudeConfigDirectory', default=os.environ.get('CLAUDE_CONFIG_DIR', str(Path.home() / '.claude')))
    p.add_argument('--claude', '-ClaudeExecutable', default='claude.exe' if os.name == 'nt' else 'claude')
    return p


def clean(value):
    # Titles come from external history. Strip terminal control sequences before rendering.
    return re.sub(r'[\x00-\x1f\x7f-\x9f]', '', re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]', '', str(value or '')))


def color(text, code):
    return f'\033[{code}m{text}\033[0m' if sys.stdout.isatty() and not os.environ.get('NO_COLOR') else text


def keypress():
    if os.name == 'nt':
        import msvcrt
        key = msvcrt.getwch()
        if key in ('\x00', '\xe0'):
            return {'H': 'up', 'P': 'down'}.get(msvcrt.getwch(), '')
        return key.lower()
    import select
    import termios
    import tty
    fd = sys.stdin.fileno()
    previous = termios.tcgetattr(fd)
    try:
        tty.setraw(fd)
        key = os.read(fd, 1).decode(errors='replace')
        if key == '\x1b' and select.select([fd], [], [], .1)[0]:
            suffix = os.read(fd, 2).decode(errors='replace')
            return {'[A': 'up', '[B': 'down'}.get(suffix, '')
        return key.lower()
    finally:
        termios.tcsetattr(fd, termios.TCSADRAIN, previous)


def visible_rows(rows, history=False):
    return sorted([r for r in rows if not r.get('ReplacedBy') and (history or r.get('Available') or r.get('Running'))],
                  key=lambda r: (not r.get('Running', False), r['Project'], r.get('Task') or ''))


def selectable(row):
    return bool(row.get('Available') or row.get('Running'))


def menu(manager):
    if not sys.stdin.isatty():
        raise ValueError('The picker requires a terminal. Use status --json for scripts.')
    cursor, checked, message, history, refresh = 0, set(), '', False, True
    while True:
        if refresh:
            state = manager.state()
            all_rows = manager.status(manager.saved(), state, manager.agents())
            refresh = False
        rows = visible_rows(all_rows, history)
        for project in manager.projects():
            if not any(r['Project'] == project for r in rows):
                rows.append(dict(Project=project, SessionId=f'new:{project}', Task='New named task', NewProject=True, Available=True))
        if not rows:
            print('No project folders found.')
            return
        cursor = min(cursor, len(rows) - 1)
        terminal = shutil.get_terminal_size()
        height = max(3, terminal.lines - 14)
        project_width = min(20, max(10, terminal.columns // 6))
        task_width = min(42, max(16, terminal.columns - project_width - 34))
        status_width = max(12, terminal.columns - project_width - task_width - 9)
        start = max(0, min(cursor - height // 2, len(rows) - height))
        print('\033[2J\033[H', end='')
        print(color(f'Claude sessions | {sys.platform} | {manager.root}', '96'))
        print('Space select | A available | Enter resume | N new task | X stop | H history | R refresh | Q quit\n')
        print(color(f"      {'REPOSITORY':{project_width}} {'TASK':{task_width}} STATUS", '96'))
        print(color('─' * min(terminal.columns - 1, 110), '90'))
        for index in range(start, min(start + height, len(rows))):
            row = rows[index]
            status = ('running; remote registered*' if row.get('RemoteRegistered') else 'running; no bridge') if row.get('Running') else row.get('State', 'Enter a task name')
            line = f"{'>' if index == cursor else ' '} [{'x' if row['SessionId'] in checked else ' '}] {clean(row['Project']):{project_width}.{project_width}} {clean(row.get('Task')):{task_width}.{task_width}} {clean(status)[:status_width]}"
            print(color(line, '93' if index == cursor else '92' if row.get('Running') else '90' if not selectable(row) else '0'))
        row = rows[cursor]
        print('\n' + clean(row.get('Task')))
        print(clean(row.get('WorkingDirectory') or manager.projects()[row['Project']]))
        print(clean(row.get('RemoteUrl') or row['SessionId']))
        missing = sum(not r.get('Available') and not r.get('Running') for r in all_rows)
        print(color(f'{missing} unavailable history rows. H {"hides" if history else "shows"} history. *Registration does not verify phone delivery.', '90'))
        if message:
            print(color(clean(message), '93'))
        key = keypress()
        if key in ('q', '\x1b', '\x03'):
            return
        if key in ('up', 'k'):
            cursor = (cursor - 1) % len(rows)
        elif key in ('down', 'j'):
            cursor = (cursor + 1) % len(rows)
        elif key == 'h':
            history = not history
            checked.clear()
        elif key == 'r':
            refresh = True
        elif key == ' ':
            if row['SessionId'] in checked:
                checked.remove(row['SessionId'])
            else:
                checked.add(row['SessionId'])
        elif key == 'a':
            available = {r['SessionId'] for r in rows if selectable(r) and not r.get('NewProject')}
            checked = set() if available <= checked else available
        elif key in ('\r', '\n', 'n', 'x'):
            targets = [row] if key == 'n' else [r for r in rows if r['SessionId'] in checked]
            messages = []
            for target in targets:
                options = argparse.Namespace(**vars(manager.options))
                options.only = [target['Project']]
                options.task = options.branch = options.issue = options.pr = options.session_id = None
                options.action = 'stop' if key == 'x' else 'resume'
                if key == 'n' or (target.get('NewProject') and key != 'x'):
                    name = input('Task name, e.g. issue-2-fix-login. Blank cancels: ').strip()
                    if not name:
                        continue
                    options.action, options.task = 'start', name
                else:
                    options.session_id = target['SessionId']
                if options.action == 'resume' and not selectable(target):
                    answer = input('Recovery may create a replacement conversation. Type recover to proceed: ')
                    if answer != 'recover':
                        continue
                try:
                    result = Manager(options).execute()
                    messages.extend(f"{r['Project']}: {r.get('Result', '')}. {r.get('Connection', '')}" for r in result)
                    checked.discard(target['SessionId'])
                except (OSError, ValueError, RuntimeError) as error:
                    messages.append(str(error))
            message = ' | '.join(messages)
            refresh = True


def main(argv=None):
    options = parser().parse_args(argv)
    if (options.issue is not None and options.issue < 1) or (options.pr is not None and options.pr < 1):
        raise ValueError('Issue and PR numbers must be positive.')
    manager = Manager(options)
    if options.action == 'menu':
        menu(manager)
        return
    rows = manager.execute()
    if options.json:
        print(json.dumps(rows, indent=2))
    else:
        for row in rows:
            print(color(f"{clean(row.get('Project'))}  {clean(row.get('Task') or row.get('Title') or row.get('SessionId'))}", '96'))
            for field in ('State', 'Result', 'Connection', 'Branch', 'WorkingDirectory', 'RemoteUrl', 'Operation', 'Commands'):
                if row.get(field) is not None:
                    print(f'  {field}: {clean(row[field])}')


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, RuntimeError) as error:
        print(f'Error: {error}', file=sys.stderr)
        sys.exit(1)
