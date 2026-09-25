#!/usr/bin/env python3
"""Local Claude session manager. Python 3.10+, Git and Claude Code; no pip packages."""
import argparse
from contextlib import contextmanager, nullcontext
from copy import deepcopy
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
import unicodedata
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


UUID = re.compile(r'\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b', re.I)


def folder_exists(directory):
    return bool(directory) and Path(directory).is_dir()


def checked_out_branch(directory):
    """The branch a folder has checked out now, read from Git's HEAD file without spawning Git.
    None when HEAD is detached or the folder is not a Git checkout."""
    git = Path(directory) / '.git'
    try:
        if git.is_file():
            pointer = git.read_text(encoding='utf-8').strip().removeprefix('gitdir:').strip()
            git = (Path(directory) / pointer).resolve()
        head = (git / 'HEAD').read_text(encoding='utf-8').strip()
    except OSError:
        return None
    return head.removeprefix('ref: refs/heads/') if head.startswith('ref: refs/heads/') else None


def project_of(directory, projects):
    return next((name for name, path in projects.items() if wt.inside(directory, path)), None)


def moment(text):
    """A saved timestamp as an aware datetime, or None when it cannot be read."""
    try:
        value = datetime.fromisoformat(str(text).replace('Z', '+00:00'))
    except ValueError:
        return None
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)


# Transcript metadata by file path, kept while the file's modification time and size are unchanged.
# Each scan drops the entries of files it no longer sees, so the cache never outgrows the history.
TRANSCRIPTS = {}


def transcript_meta(file):
    """Folders, title and last activity of one transcript, re-parsed only when the file changes."""
    stat = file.stat()
    key, stamp = str(file), (stat.st_mtime_ns, stat.st_size)
    cached = TRANSCRIPTS.get(key)
    if cached and cached[0] == stamp:
        return cached[1]
    folders, last, title, auto_title, conflict = [], None, None, None, False
    entrypoint, teleported, version, permission = None, False, None, None
    updated = datetime.fromtimestamp(stat.st_mtime, timezone.utc).isoformat()
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
            # Another OS's transcripts are not local runnable tasks.
            if record.get('cwd') and os.path.isabs(record['cwd']):
                last = record['cwd']
                if last not in folders:
                    folders.append(last)
            if record.get('type') == 'custom-title' and record.get('customTitle'):
                title = record['customTitle']
            if record.get('type') == 'ai-title' and record.get('aiTitle'):
                auto_title = record['aiTitle']
            if record.get('type') == 'agent-name' and record.get('agentName'):
                auto_title = record['agentName']
            if record.get('type') == 'user' and record.get('timestamp'):
                updated = record['timestamp']
            # The first surface a session records is where it started; version and mode follow the latest record.
            entrypoint = entrypoint or record.get('entrypoint')
            teleported = teleported or bool(record.get('teleportedFrom'))
            version = record.get('version') or version
            permission = record.get('permissionMode') or permission
    meta = dict(Folders=folders, Last=last, Title=title or auto_title, Updated=updated, Conflict=conflict,
                Entrypoint=entrypoint, Teleported=teleported, Version=version, PermissionMode=permission)
    TRANSCRIPTS[key] = (stamp, meta)
    return meta


def active(agent):
    # A background agent that is `done` or `blocked` has finished its turn; its process stays up, waiting for a reply.
    return bool(agent and agent.get('pid') and state_of(agent) not in ('stopped', 'completed', 'failed', 'exited'))


def state_of(agent):
    return str((agent or {}).get('state') or '').lower()


# Surface names Claude records as a process's or transcript's `entrypoint`.
SURFACES = {'cli': 'CLI', 'claude-vscode': 'VS Code ext', 'claude-desktop': 'Desktop', 'sdk-cli': 'RC server'}
CIRCLES = dict(working='🟢', idle='🟡', stopped='🔵', live='🟣', new='⚪', history='⚫', error='🔴', merged='✅')
WORKING = ('working', 'busy', 'running')
FAILED = ('error', 'failed')


def surface_now(agent, process):
    """What runs a live session now, or None when nothing does."""
    if not active(agent):
        return None
    entrypoint = process.get('entrypoint')
    if agent['kind'] == 'background':
        return 'RC server' if entrypoint == 'sdk-cli' else 'Background'
    return SURFACES.get(entrypoint, entrypoint or 'CLI')


def failed(agent):
    """A background session that failed or waits on a permission decision, whether or not its process is still up."""
    state = state_of(agent)
    return bool(agent and agent['kind'] == 'background' and (state in FAILED or 'permission' in state))


def status_of(row, agent, managed):
    """The one status a row shows. Live in another app wins; errors and conflicting history need a decision;
    a stopped session is resumable only when it is the newest conversation in its folder or one the picker
    tracks; older conversations, and any that cannot resume, are history."""
    if active(agent) and agent['kind'] != 'background':
        return 'live'
    if failed(agent) or row.get('Conflict'):
        return 'error'
    if active(agent):
        return 'working' if state_of(agent) in WORKING else 'idle'
    return 'stopped' if row.get('Available') and (row.get('Newest') or managed) else 'history'


def started_on(row, managed):
    """Where a session started: Web when teleported, Desktop when the desktop app lists it, else the first surface
    its transcript records. Without one, a session the picker tracks started in the background, any other on the CLI."""
    if row.get('Teleported'):
        return 'Web'
    if row.get('InDesktopApp'):
        return 'Desktop'
    entrypoint = row.get('StartEntrypoint')
    return SURFACES.get(entrypoint, entrypoint) if entrypoint else 'Background' if managed else 'CLI'


# Desktop store entries by file path, kept while the file's modification time and size are unchanged.
DESKTOP = {}


def desktop_entry(file):
    """One desktop store file as (session ID, entry), or None when it names no Claude session; re-read only on change."""
    stat = file.stat()
    key, stamp = str(file), (stat.st_mtime_ns, stat.st_size)
    cached = DESKTOP.get(key)
    if cached and cached[0] == stamp:
        return cached[1]
    try:
        data = read_json(file, {})
    except ValueError:
        data = None  # Unparsable until it changes; not re-read on every refresh.
    id = data.get('cliSessionId') if isinstance(data, dict) else None
    entry = None
    if isinstance(id, str) and UUID.fullmatch(id):
        entry = id.lower(), dict(Archived=bool(data.get('isArchived') or data.get('archived')), Title=data.get('title'),
                                 PermissionMode=data.get('permissionMode'))
    DESKTOP[key] = (stamp, entry)
    return entry


def default_desktop_stores():
    """Where the desktop app keeps its Claude Code session list on this host (MSIX installs are virtualized)."""
    if os.name == 'nt':
        roaming = Path(os.environ.get('APPDATA') or Path.home() / 'AppData' / 'Roaming')
        local = Path(os.environ.get('LOCALAPPDATA') or Path.home() / 'AppData' / 'Local')
        apps = [roaming / 'Claude', *(local / 'Packages').glob('Claude_*/LocalCache/Roaming/Claude')]
    elif sys.platform == 'darwin':
        apps = [Path.home() / 'Library' / 'Application Support' / 'Claude']
    else:
        apps = [Path(os.environ.get('XDG_CONFIG_HOME') or Path.home() / '.config') / 'Claude']
    return [app / 'claude-code-sessions' for app in apps]


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

    @staticmethod
    def folder_root(candidate, projects):
        """The session folder a path belongs to: its task worktree, else the project root it sits in.
        Tool activity may temporarily cd below that folder; those records still belong to it."""
        for path in projects.values():
            parent = path / '.claude' / 'worktrees'
            if wt.inside(candidate, parent) and not wt.same(candidate, parent):
                return str(parent / Path(os.path.relpath(candidate, parent)).parts[0])
        return next((str(path) for path in projects.values() if wt.inside(candidate, path)), candidate)

    def desktop_store(self):
        """The desktop app's own session list by Claude session ID: archive flag, title and permission mode.
        Unreadable entries are skipped; the store is optional."""
        stores = [Path(self.options.desktop_sessions)] if self.options.desktop_sessions else default_desktop_stores()
        found, scanned = {}, set()
        for store in stores:
            for file in sorted(store.rglob('*.json')) if store.is_dir() else ():
                scanned.add(str(file))
                try:
                    entry = desktop_entry(file)
                except (OSError, ValueError):
                    continue
                if entry:
                    found[entry[0]] = entry[1]
        for key in DESKTOP.keys() - scanned:
            del DESKTOP[key]
        return found

    def saved(self):
        catalog = {}
        projects = self.projects()
        desktop = self.desktop_store()
        # Transcripts repeat a few folders thousands of times; resolving each is slow on Windows.
        roots, branches, scanned = {}, {}, set()
        for file in (self.config / 'projects').glob('*/*.jsonl'):
            try:
                if str(uuid.UUID(file.stem)) != file.stem.lower():
                    continue
            except ValueError:
                continue
            scanned.add(str(file))
            meta = transcript_meta(file)
            for candidate in meta['Folders']:
                if candidate not in roots:
                    roots[candidate] = self.folder_root(candidate, projects)
            app = desktop.get(file.stem.lower(), {})
            # A session archived in the desktop app stays out of the picker, like a deleted one.
            if not meta['Last'] or app.get('Archived'):
                continue
            cwd, title = roots[meta['Last']], meta['Title'] or app.get('Title')
            updated = meta['Updated']
            conflict = meta['Conflict'] or any(not wt.same(roots[f], cwd) for f in meta['Folders'])
            for project, path in projects.items():
                # Every session under a project folder: its task worktrees and the repo root itself.
                is_tree = wt.inside(cwd, path / '.claude' / 'worktrees')
                if not is_tree and not wt.same(cwd, path):
                    continue
                # A session follows its folder: once the folder is gone, the session is gone too.
                if not folder_exists(cwd):
                    continue
                reason = ('history has conflicting session or folder metadata' if conflict else
                          'history saved; worktree checkout missing' if is_tree and not (Path(cwd) / '.git').exists() else None)
                if cwd not in branches:
                    branches[cwd] = checked_out_branch(cwd)
                row = dict(SessionId=file.stem, Project=project, WorkingDirectory=cwd, Updated=updated, Branch=branches[cwd],
                           Worktree=is_tree, Available=not reason, UnavailableReason=reason, Conflict=conflict, Title=title,
                           StartEntrypoint=meta['Entrypoint'], Teleported=meta['Teleported'], InDesktopApp=bool(app),
                           ClaudeVersion=meta['Version'], PermissionMode=meta['PermissionMode'] or app.get('PermissionMode'))
                if file.stem in catalog and not wt.same(catalog[file.stem]['WorkingDirectory'], cwd):
                    raise ValueError(f'Conflicting saved locations for session {file.stem}.')
                catalog[file.stem] = row
        for key in TRANSCRIPTS.keys() - scanned:
            del TRANSCRIPTS[key]
        rows = sorted(catalog.values(), key=lambda s: s['Updated'], reverse=True)
        # The newest conversation in each folder is the one it resumes; older ones are history.
        seen = set()
        for row in rows:
            folder = wt.key(row['WorkingDirectory'])
            row['Newest'] = folder not in seen
            seen.add(folder)
        return rows

    def managed(self, id, entry, saved):
        found = next((dict(s) for s in saved if s['SessionId'] == id), None)
        # A session whose folder is gone is gone too. State records a task only once its folder exists.
        if not found and not folder_exists(entry.get('WorkingDirectory')):
            return None
        row = found or dict(SessionId=id, Project=entry['Project'], WorkingDirectory=entry['WorkingDirectory'],
                            Available=False, NewSession=entry.get('NewSession', False),
                            Branch=checked_out_branch(entry['WorkingDirectory']),
                            UnavailableReason='transcript missing')
        row['Task'] = entry.get('Task')
        return row

    def follow_folders(self, state):
        """A session follows its folder: record the branch each folder has checked out now (none when detached)."""
        changed = False
        for entry in state['Sessions'].values():
            if not folder_exists(entry.get('WorkingDirectory')):
                continue
            branch = checked_out_branch(entry['WorkingDirectory'])
            if branch != entry.get('Branch'):
                entry['Branch'], changed = branch, True
        if changed:
            write_json(self.state_path, state)

    def adopt(self, sessions, saved, agents):
        """Settle launches that were never confirmed: a new task, or an ID taken only from Claude's output.
        An entry whose own ID has appeared is confirmed. Otherwise it belongs to the one untracked session
        in its folder: the live background session there, else a conversation saved there since the launch,
        never an older one. Returns whether any entry changed."""
        changed = False
        for id, entry in list(sessions.items()):
            if not (entry.get('NewSession') or entry.get('Unconfirmed')) or not folder_exists(entry.get('WorkingDirectory')):
                continue
            folder = entry['WorkingDirectory']
            live = {a['sessionId'] for a in agents if active(a) and a['kind'] == 'background' and wt.same(a['cwd'], folder)}
            here = [r for r in saved if wt.same(r['WorkingDirectory'], folder)]
            if id in live or any(r['SessionId'] == id for r in here):
                entry['NewSession'] = False
                entry.pop('Unconfirmed', None)
                changed = True
                continue
            launched = moment(entry.get('Updated'))
            since = {r['SessionId'] for r in here if launched and (moment(r['Updated']) or launched) > launched}
            candidates = (live - sessions.keys()) or (since - sessions.keys())
            if len(candidates) == 1:
                rekey(sessions, id, candidates.pop())
                changed = True
        return changed

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
                row = self.managed(id, entry, saved)
                if not row:
                    raise ValueError(f"Task '{name}' had its folder deleted; its session stays gone. Choose a different task name.")
                return [row]
            return [dict(SessionId=str(uuid.uuid4()), Project=project, Task=name, Branch=o.branch,
                         Available=False, NewSession=True, Name=wt.task_name(project, o.task or o.branch, o.issue, o.pr))]
        if o.session_id:
            id = current(sessions, o.session_id)
            if id in sessions and sessions[id]['Project'] not in projects:
                raise ValueError('The saved session belongs to a different project.')
            row = self.managed(id, sessions[id], saved) if id in sessions else next((s for s in saved if s['SessionId'] == id), None)
            if not row:
                raise ValueError(f'Saved session {id} was not found or its folder is gone. Nothing is recreated.')
            return [row]
        if o.action == 'resume':
            raise ValueError('Resume requires --session-id with the full saved conversation UUID.')
        selected = []
        for project in projects:
            managed = [self.managed(id, e, saved) for id, e in sessions.items() if e['Project'] == project and not e.get('ReplacedBy')]
            managed = [row for row in managed if row and row.get('Available')]
            if managed:
                selected.extend(managed)
                continue
            found = [s for s in saved if s['Project'] == project and s['Available']]
            seen = set()
            for s in found:
                key = wt.key(s['WorkingDirectory'])
                if key not in seen:
                    selected.append(s)
                    seen.add(key)
            if not found:
                raise ValueError(f'{project}: no available task. Use --task with a descriptive name, or resume an exact history ID.')
        return selected

    def launch_plan(self, s, agents):
        id, project = s['SessionId'], s['Project']
        directory = s.get('WorkingDirectory')
        if not s.get('NewSession'):
            running = [a for a in agents if active(a) and (a['sessionId'] == id or wt.same(a['cwd'], directory))]
            if running:
                return dict(Session=s, Mode='running', Arguments=[], WorkingDirectory=running[0]['cwd'],
                            SessionId=running[0]['sessionId'], Project=project, Agent=running[0])
            # A resume continues the same conversation in its original folder, or nothing happens.
            if not s.get('Available'):
                raise ValueError(f"Session {id} cannot resume: {s.get('UnavailableReason') or 'folder missing'}. Nothing is recreated.")
            args = ['--bg', '--resume', id]
            if not any(a['sessionId'] == id and a['kind'] == 'background' for a in agents):
                args += ['--remote-control', f"{project} {s.get('Task') or s.get('Title') or Path(directory).name}"]
            return dict(Session=s, Mode='resume', Arguments=args, WorkingDirectory=directory, SessionId=id, Project=project)
        # A new request carries its Name; a stored task is named by its task, else by its folder.
        name = s.get('Name') or (wt.task_name(project, s['Task']) if s.get('Task') else Path(directory).name)
        workspace = wt.plan(self.projects()[project], name, s.get('Branch'), directory)
        base = dict(Session=s, Mode='new', Arguments=['--bg', '--remote-control', f"{project} {s.get('Task') or name}"],
                    WorkingDirectory=workspace['WorkingDirectory'], SessionId=id, Project=project, Workspace=workspace)
        if workspace['Operation'] == 'reuse':
            other = next((a for a in agents if active(a) and wt.same(a['cwd'], workspace['WorkingDirectory'])), None)
            if other:
                base.update(Mode='running', SessionId=other['sessionId'], Arguments=[], Agent=other)
                return base
            old = next((r for r in self.saved() if r['Available'] and wt.same(r['WorkingDirectory'], workspace['WorkingDirectory'])), None)
            if old:
                old.update(Task=s.get('Task'), Branch=workspace['Branch'])
                return self.launch_plan(old, agents)
        return base

    def process(self, agent):
        """The per-pid session file of a live session's process: its surface and Remote Control registration.
        Empty unless the file names the same process and session."""
        if not active(agent):
            return {}
        try:
            data = read_json(self.config / 'sessions' / f"{agent['pid']}.json", {})
        except (OSError, ValueError):
            return {}
        if isinstance(data, dict) and data.get('pid') == agent['pid'] and data.get('sessionId') == agent['sessionId']:
            return data
        return {}

    def bridge(self, agent):
        return self.process(agent).get('bridgeSessionId')

    def status(self, saved, state, agents):
        sessions = deepcopy(state['Sessions'])
        self.adopt(sessions, saved, agents)
        projects = self.projects()
        rows = list(saved)
        ids = {r['SessionId'] for r in rows}
        rows += [row for row in (self.managed(id, e, saved) for id, e in sessions.items()
                                 if id not in ids and e['Project'] in projects) if row]
        ids = {r['SessionId'] for r in rows}
        # Every live or failed session under a project folder is listed, even before Claude has saved its transcript.
        for a in agents:
            folder = self.folder_root(a['cwd'], projects) if (active(a) or failed(a)) and a['sessionId'] not in ids else None
            project = folder and project_of(folder, projects)
            if project:
                rows.append(dict(SessionId=a['sessionId'], Project=project, WorkingDirectory=folder,
                                 Branch=checked_out_branch(folder), Available=False, UnavailableReason='transcript missing'))
                ids.add(a['sessionId'])
        result = []
        for s in rows:
            id = s['SessionId']
            # The live record when there is one, else the last one Claude keeps, which may say how the session ended.
            records = [a for a in agents if a['sessionId'] == id]
            agent = next((a for a in records if active(a)), records[-1] if records else None)
            running = active(agent)
            entry = sessions.get(id, {})
            process = self.process(agent)
            bridge = process.get('bridgeSessionId')
            task = entry.get('Task')
            title = (task if task not in (None, 'remote') else None) or (agent or {}).get('name') or s.get('Title') or task or Path(s.get('WorkingDirectory') or s['Project']).name
            origin = started_on(s, managed=id in sessions)
            status = status_of(s, agent, managed=id in sessions)
            result.append(dict(s, Task=title, Stoppable=running and agent['kind'] == 'background', Running=running,
                               ViewOnly=running and agent['kind'] != 'background',
                               State=agent.get('state') if agent else s.get('UnavailableReason') or 'stopped',
                               Status=status, Circle=CIRCLES[status], Origin=origin, Source=surface_now(agent, process) or origin,
                               Remote='📡' if bridge else '', PermissionMode=process.get('permissionMode') or s.get('PermissionMode'),
                               ClaudeVersion=process.get('version') or s.get('ClaudeVersion'),
                               RemoteRegistered=bool(bridge), RemoteSessionId=bridge,
                               RemoteUrl=f'https://claude.ai/code/{bridge}' if bridge else None,
                               Connection='registration found; delivery unverified' if bridge else 'no bridge registration',
                               AgentId=(agent or {}).get('id'), ReplacedBy=entry.get('ReplacedBy')))
        return result

    def confirm(self, launch, reported, before):
        """Find the session a launch produced: the requested ID, or the copy Claude reports.
        Returns it (None when Claude has not listed it in time) and the last inventory read."""
        id, directory = launch['SessionId'], launch['WorkingDirectory']
        earlier = {a['sessionId'] for a in before if active(a)}
        deadline = time.monotonic() + self.options.launch_wait
        while True:
            inventory = self.agents()
            in_folder = [a for a in inventory if active(a) and a['kind'] == 'background' and wt.same(a['cwd'], directory)]
            started = [a for a in in_folder if a['sessionId'] not in earlier]
            found = (next((a for a in in_folder if launch['Mode'] == 'resume' and a['sessionId'] == id), None)
                     or next((a for a in in_folder if a['sessionId'].lower() in reported), None)
                     or (started[0] if len(started) == 1 else None))
            if found or time.monotonic() >= deadline:
                return found, inventory
            time.sleep(.5)

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
                if launch['Agent']['kind'] != 'background' and self.options.session_id:
                    # A session live in another app is view-only: resuming it would collide with that window.
                    raise ValueError(f"Session {id} is live in another app; it is view-only here." if launch['SessionId'] == id else
                                     f"Another app has session {launch['SessionId']} live in {launch['WorkingDirectory']}; it is view-only here.")
                pending = s.get('NewSession') and id in sessions
                if self.options.task or self.options.branch or self.options.issue or self.options.pr or pending:
                    entry = sessions.setdefault(launch['SessionId'], dict(Project=s['Project'], WorkingDirectory=launch['WorkingDirectory']))
                    entry.update(Task=s.get('Task'), Branch=workspace['Branch'] if workspace else s.get('Branch'))
                    if pending and id != launch['SessionId']:
                        sessions[id]['ReplacedBy'] = launch['SessionId']
                    write_json(self.state_path, state)
                results.append(dict(Project=s['Project'], SessionId=launch['SessionId'], WorkingDirectory=launch['WorkingDirectory'], Result='already running; not restarted'))
                continue
            if workspace:
                wt.create(workspace)
            branch = workspace['Branch'] if workspace else checked_out_branch(launch['WorkingDirectory'])
            # Recorded only once the folder exists, so a recorded task whose folder is gone was deleted.
            sessions[id] = dict(Project=s['Project'], Task=s.get('Task'), Branch=branch, WorkingDirectory=launch['WorkingDirectory'],
                                NewSession=launch['Mode'] == 'new', Updated=datetime.now(timezone.utc).isoformat())
            write_json(self.state_path, state)
            output = self.claude(launch['Arguments'], launch['WorkingDirectory'])
            reported = {m.lower() for m in UUID.findall(output)}
            agent, inventory = self.confirm(launch, reported, before)
            printed = None if agent else printed_session(reported, id, inventory)
            actual = agent['sessionId'] if agent else printed or id
            result = launch_result(launch['Mode'], listed=bool(agent), copied=actual != id)
            if actual != id:
                # Claude started a copy (or chose the ID of a new task). Follow it; the old ID stays history.
                rekey(sessions, id, actual)
                if launch['Mode'] == 'resume':
                    sessions[id] = dict(Project=s['Project'], WorkingDirectory=launch['WorkingDirectory'], ReplacedBy=actual)
                id = actual
            if agent:
                sessions[id]['NewSession'] = False
            elif printed:
                # Only Claude's output names it; a later start confirms it or moves to the session in the folder.
                sessions[id]['Unconfirmed'] = True
            write_json(self.state_path, state)
            bridge = self.bridge(agent)
            results.append(dict(Project=s['Project'], SessionId=id, Task=s.get('Task'), Branch=branch,
                                WorkingDirectory=launch['WorkingDirectory'], Result=result,
                                RemoteRegistered=bool(bridge), RemoteUrl=f'https://claude.ai/code/{bridge}' if bridge else None,
                                Connection='registration found; delivery unverified' if bridge else 'no bridge registration; attach and run /remote-control'))
        return results

    def target(self, state):
        """The session --session-id names now: a saved ID that continued as a copy names the copy."""
        return self.options.session_id and current(state['Sessions'], self.options.session_id)

    @staticmethod
    def stoppable(agents, projects, id):
        # One rule: every background session can be stopped; a session live in another app is view-only.
        if id:
            chosen = [a for a in agents if active(a) and a['sessionId'] == id]
            if any(not project_of(a['cwd'], projects) for a in chosen):
                raise ValueError(f'Session {id} runs outside the selected projects; nothing was stopped.')
        else:
            chosen = [a for a in agents if active(a) and a['kind'] == 'background' and project_of(a['cwd'], projects)]
        for a in chosen:
            if a['kind'] != 'background':
                raise ValueError(f"Session {a['sessionId']} is live in another app; it is view-only here.")
        return chosen

    def stop(self, state):
        agents, projects, id = self.agents(), self.projects(), self.target(state)
        results = []
        for a in self.stoppable(agents, projects, id):
            if sum(item.get('id') == a['id'] for item in agents) != 1:
                raise ValueError('Ambiguous native agent identifier; nothing was stopped.')
            self.claude(['stop', a['id']])
            if any(b['sessionId'] == a['sessionId'] and active(b) for b in self.agents()):
                raise RuntimeError('Claude still reports the session active after stop.')
            results.append(dict(SessionId=a['sessionId'], Project=project_of(a['cwd'], projects),
                                Result='stopped; conversation and worktree retained'))
        if id and not results:
            entry = state['Sessions'].get(id)
            project = entry['Project'] if entry and entry.get('Project') in projects else next(
                (s['Project'] for s in self.saved() if s['SessionId'] == id), None)
            if not project:
                raise ValueError(f'Session {id} was not found in the selected projects; nothing was stopped.')
            results.append(dict(SessionId=id, Project=project, Result='already stopped; history retained'))
        return results

    def execute(self):
        o = self.options
        if o.action in ('start', 'resume', 'stop', 'workspace') and not o.only:
            raise ValueError('Choose projects explicitly with --only.')
        mutation = o.action in ('start', 'resume', 'stop', 'workspace') and not o.plan
        with root_lock(self.root) if mutation else nullcontext():
            state = self.state()
            if mutation:
                self.follow_folders(state)
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
                    projects = self.projects()
                    return [dict(Project=project_of(a['cwd'], projects), SessionId=a['sessionId'], Result='stop background session; keep history')
                            for a in self.stoppable(self.agents(), projects, self.target(state))]
                return self.stop(state)
            saved = self.saved()
            if o.action == 'sessions':
                return saved
            if o.action == 'status':
                return self.status(saved, state, self.agents())
            # A launch that was never confirmed belongs to the session now in its folder.
            if self.adopt(state['Sessions'], saved, self.agents()) and mutation:
                write_json(self.state_path, state)
            selected = self.selection(saved, state)
            if o.plan:
                agents = self.agents()
                return [self.launch_plan(s, agents) for s in selected]
            return self.start(selected, state)


def rekey(sessions, old, new):
    """Move a state entry to the session ID Claude actually runs, now confirmed, and point replacement links at it."""
    moved = dict(sessions.pop(old), NewSession=False)
    moved.pop('Unconfirmed', None)
    sessions[new] = moved
    for entry in sessions.values():
        if entry.get('ReplacedBy') == old:
            entry['ReplacedBy'] = new


def current(sessions, id):
    """Follow replacement links from a saved ID to the session it continues as."""
    visited = set()
    while sessions.get(id, {}).get('ReplacedBy'):
        if id in visited:
            raise ValueError('Saved replacement links contain a cycle.')
        visited.add(id)
        id = sessions[id]['ReplacedBy']
    return id


def printed_session(reported, requested, inventory):
    """The one session ID a launch printed, besides the requested one, that Claude lists nowhere yet:
    a slow start or copy. An ID Claude lists, in any folder, belongs to another session."""
    others = reported - {requested.lower()}
    if len(others) == 1 and not any(a['sessionId'].lower() in others for a in inventory):
        return others.pop()
    return None


def launch_result(mode, listed, copied):
    if not listed:
        return 'launched; not listed yet by claude agents, stoppable once it appears'
    if mode == 'new':
        return 'created task in a persistent worktree'
    return 'resumed as the copy Claude reported, in the same worktree' if copied else 'resumed original conversation and worktree'


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
    p.add_argument('--include-project-sessions', '-IncludeProjectSessions', action='store_true',
                   help='Accepted for compatibility; repo-root sessions are always listed now.')
    p.add_argument('--desktop-sessions', '-DesktopSessions', help="The desktop app's session store folder (default: found per host).")
    p.add_argument('--config', '-ClaudeConfigDirectory', default=os.environ.get('CLAUDE_CONFIG_DIR', str(Path.home() / '.claude')))
    p.add_argument('--claude', '-ClaudeExecutable', default='claude.exe' if os.name == 'nt' else 'claude')
    p.add_argument('--launch-wait', '-LaunchWait', type=float, default=90, help='Seconds to wait for Claude to list a launched session.')
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
    """Rows in view: live, resumable and needing attention; H adds history (older conversations and unavailable rows)."""
    def shown(r):
        if r.get('ReplacedBy'):
            return False
        if history or r.get('Running'):
            return True
        return r.get('Status') != 'history' and bool(r.get('Available') or r.get('Status') in ('error', 'merged'))
    return sorted([r for r in rows if shown(r)], key=lambda r: (not r.get('Running', False), r['Project'], r.get('Task') or ''))


JOINER = chr(0x200d)
ZERO_WIDTH = {JOINER, chr(0xfe0e), chr(0xfe0f)}  # Joiner and variation selectors.


def glyphs(text):
    """Text split as a terminal draws it: combining marks, selectors and skin tones join the character before,
    and a joiner joins the next, so a joined emoji sequence (a family, a toned hand) is one glyph."""
    glyph = ''
    for c in text:
        if glyph and (unicodedata.combining(c) or c in ZERO_WIDTH or 0x1F3FB <= ord(c) <= 0x1F3FF or glyph.endswith(JOINER)):
            glyph += c
            continue
        if glyph:
            yield glyph
        glyph = c
    if glyph:
        yield glyph


def glyph_cells(glyph):
    first = glyph[0]
    return 0 if unicodedata.combining(first) or first in ZERO_WIDTH else 2 if unicodedata.east_asian_width(first) in 'WF' else 1


def cells(text):
    """Terminal cells a string takes: wide glyphs (emoji, CJK) take two, combining marks and selectors none."""
    return sum(glyph_cells(g) for g in glyphs(text))


def fit(text, width):
    """Cut or pad text to exactly `width` terminal cells, so an emoji never shifts the columns after it."""
    kept, used = [], 0
    for glyph in glyphs(clean(text)):
        if used + glyph_cells(glyph) > width:
            break
        kept.append(glyph)
        used += glyph_cells(glyph)
    return ''.join(kept) + ' ' * (width - used)


def age(row, now=None):
    """Last activity as a short relative time."""
    then = moment(row['Updated']) if row.get('Updated') else None
    if not then:
        return 'now' if row.get('Running') else ''
    seconds = max(0, ((now or datetime.now(timezone.utc)) - then).total_seconds())
    return next((f'{int(seconds // size)}{unit} ago' for unit, size in (('d', 86400), ('h', 3600), ('m', 60)) if seconds >= size), 'just now')


COLUMNS = ('STATUS', 'REPO', 'TASK', 'SOURCE', 'BRANCH', 'LAST ACTIVE', 'REMOTE')


FIXED_WIDTHS = {'STATUS': 10, 'SOURCE': 11, 'LAST ACTIVE': 11, 'REMOTE': 6}
ROW_PREFIX = 6  # The cursor and checkbox, '> [x] ', before the first column.


def column_widths(columns):
    """Cell widths of the table columns for a terminal this wide; Task and Branch share what is left."""
    widths = dict(FIXED_WIDTHS, REPO=min(16, max(8, columns // 10)))
    # One cell stays free at the right edge, and one space separates each pair of columns.
    spare = columns - 1 - ROW_PREFIX - sum(widths.values()) - (len(COLUMNS) - 1)
    task = max(10, spare * 3 // 5)
    widths.update(TASK=task, BRANCH=max(8, spare - task))
    return tuple(widths[name] for name in COLUMNS)


def table_line(values, widths):
    return ' '.join(fit(value, width) for value, width in zip(values, widths)).rstrip()


def selectable(row):
    # A session live in another app is view-only: it is never checked for resume or stop.
    return bool(row.get('Available') or row.get('Running')) and not row.get('ViewOnly')


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
                rows.append(dict(Project=project, SessionId=f'new:{project}', Task='New named task', NewProject=True, Available=True,
                                 Status='new'))
        if not rows:
            print('No project folders found.')
            return
        cursor = min(cursor, len(rows) - 1)
        terminal = shutil.get_terminal_size()
        height = max(3, terminal.lines - 16)
        widths = column_widths(terminal.columns)
        start = max(0, min(cursor - height // 2, len(rows) - height))
        print('\033[2J\033[H', end='')
        print(color(f'Claude sessions | {sys.platform} | {manager.root}', '96'))
        print('Space select | A available | Enter resume | N new task | X stop | H history | R refresh | Q quit\n')
        print(color(' ' * ROW_PREFIX + table_line(COLUMNS, widths), '96'))
        print(color('─' * min(terminal.columns - 1, 160), '90'))
        for index in range(start, min(start + height, len(rows))):
            row = rows[index]
            status = row.get('Status', 'new')
            values = (f"{CIRCLES[status]} {status}", row['Project'], row.get('Task'), row.get('Source', ''),
                      row.get('Branch') or '', age(row), row.get('Remote', ''))
            line = f"{'>' if index == cursor else ' '} [{'x' if row['SessionId'] in checked else ' '}] {table_line(values, widths)}"
            print(color(line, '93' if index == cursor else '95' if row.get('ViewOnly') else '92' if row.get('Running')
                        else '90' if not selectable(row) else '0'))
        row = rows[cursor]
        print('\n' + clean(row.get('Task')))
        print(f"Folder:  {clean(row.get('WorkingDirectory') or manager.projects()[row['Project']])}")
        print(f"Remote:  {clean(row.get('RemoteUrl') or 'not registered')}")
        if not row.get('NewProject'):
            print(f"Session: {clean(row['SessionId'])} | permission {clean(row.get('PermissionMode') or '-')} | Claude {clean(row.get('ClaudeVersion') or '-')}")
            print(f"Started: {clean(row.get('Origin'))} | runs now: {clean(row.get('Source') if row.get('Running') else 'nothing')}"
                  + (' | live in another app; view-only' if row.get('ViewOnly') else ''))
        hidden = sum(not r.get('ReplacedBy') for r in all_rows) - len(visible_rows(all_rows, history))
        print(color(f'{hidden} more in history; H {"hides" if history else "shows"} it. 📡 registered for Remote Control; phone delivery unverified.', '90'))
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
            if row.get('ViewOnly'):
                message = f"{row.get('Task')} is live in {row.get('Source')}; it is view-only here."
            elif row['SessionId'] in checked:
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
                if key == 'x' and target.get('NewProject'):
                    continue  # A new-task placeholder has no session to stop.
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
                try:
                    result = Manager(options).execute()
                    messages.extend(f"{r.get('Project') or target['Project']}: {r.get('Result', '')}. {r.get('Connection', '')}" for r in result)
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
    # Status circles and titles are Unicode; a legacy code page must not turn them into a crash.
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(errors='replace')
    if options.action == 'menu':
        menu(manager)
        return
    rows = manager.execute()
    if options.json:
        print(json.dumps(rows, indent=2))
    else:
        for row in rows:
            print(color(f"{clean(row.get('Project'))}  {clean(row.get('Task') or row.get('Title') or row.get('SessionId'))}", '96'))
            for field in ('Status', 'Source', 'State', 'Result', 'Connection', 'Branch', 'WorkingDirectory', 'RemoteUrl', 'Operation', 'Commands'):
                if row.get(field) is not None:
                    print(f'  {field}: {clean(row[field])}')


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, RuntimeError) as error:
        print(f'Error: {error}', file=sys.stderr)
        sys.exit(1)
