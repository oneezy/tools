#!/usr/bin/env python3
"""Local Claude session manager. Python 3.10+, Git and Claude Code; no pip packages."""
import argparse
from contextlib import nullcontext
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
import threading
import time
import unicodedata
import uuid

from locks import file_lock
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


def root_lock(root, timeout=30):
    """The lock every state-changing launcher action takes on its projects root."""
    return file_lock(root / '.remote-sessions.lock', timeout)


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
    entrypoint, kind, teleported, version, permission = None, None, False, None, None
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
            # The first surface a session records is where it started, and that record says whether it was a
            # --bg launch (whose entrypoint is `cli` too); version and mode follow the latest record.
            if not entrypoint and record.get('entrypoint'):
                entrypoint, kind = record['entrypoint'], record.get('sessionKind')
            teleported = teleported or bool(record.get('teleportedFrom'))
            version = record.get('version') or version
            permission = record.get('permissionMode') or permission
    meta = dict(Folders=folders, Last=last, Title=title or auto_title, Updated=updated, Conflict=conflict,
                Entrypoint=entrypoint, Kind=kind, Teleported=teleported, Version=version, PermissionMode=permission)
    TRANSCRIPTS[key] = (stamp, meta)
    return meta


def active(agent):
    # A background agent that is `done` or `blocked` has finished its turn; its process stays up, waiting for a reply.
    return bool(agent and agent.get('pid') and state_of(agent) not in ('stopped', 'completed', 'failed', 'exited'))


def live_elsewhere(agent):
    """A session live in another app (a terminal, VS Code, the desktop app) is view-only: never resumed or stopped here."""
    return active(agent) and agent['kind'] != 'background'


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
    if live_elsewhere(agent):
        return SURFACES.get(entrypoint, entrypoint or 'CLI')
    return 'RC server' if entrypoint == 'sdk-cli' else 'Background'


def failed(agent):
    """A background session that failed or waits on a permission decision, whether or not its process is still up."""
    state = state_of(agent)
    return bool(agent and agent['kind'] == 'background' and (state in FAILED or 'permission' in state))


def status_of(row, agent, managed):
    """The one status a row shows. Live in another app wins; errors and conflicting history need a decision;
    a stopped session is resumable only when it is the newest conversation in its folder or one the picker
    tracks; older conversations, and any that cannot resume, are history."""
    if live_elsewhere(agent):
        return 'live'
    if failed(agent) or row.get('Conflict'):
        return 'error'
    if active(agent):
        return 'working' if state_of(agent) in WORKING else 'idle'
    return 'stopped' if row.get('Available') and (row.get('Newest') or managed) else 'history'


def started_on(row, managed):
    """Where a session started: Web when teleported, Desktop when the desktop app lists it, Background when its first
    surface record is a --bg launch, else that surface. Without one, a session the picker tracks started in the
    background, any other on the CLI."""
    if row.get('Teleported'):
        return 'Web'
    if row.get('InDesktopApp'):
        return 'Desktop'
    if row.get('StartKind') == 'bg':
        return 'Background'
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
    session = data.get('cliSessionId') if isinstance(data, dict) else None
    entry = None
    if isinstance(session, str) and UUID.fullmatch(session):
        entry = session.lower(), dict(Archived=bool(data.get('isArchived') or data.get('archived')), Title=data.get('title'),
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


def session_row(id, project, folder, branch, **fields):
    """One inventory row with every field a saved conversation has. The defaults describe a session whose transcript
    Claude has not saved: no title, time or history, and nothing to resume from yet."""
    row = dict(SessionId=id, Project=project, WorkingDirectory=folder, Branch=branch, Updated=None, Worktree=False,
               Available=False, UnavailableReason='transcript missing', Conflict=False, Newest=False, NewSession=False,
               Title=None, StartEntrypoint=None, StartKind=None, Teleported=False, InDesktopApp=False,
               ClaudeVersion=None, PermissionMode=None)
    row.update(fields)
    return row


class Manager:
    def __init__(self, options):
        self.options = options
        self.root = Path(options.root).expanduser().absolute()
        self.config = Path(options.config).expanduser().absolute()
        self.state_path = self.root / '.remote-sessions.json'
        # Session IDs the desktop app has archived, as of the last saved() scan; never listed or resumed.
        self.archived = set()

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

    def fingerprint(self):
        """What the inventory reads, cheaply: the modification times of the project root, the transcript
        folders and each project's task worktrees folder, and the times and sizes of every per-pid session file and
        every file in the desktop store. Equal fingerprints mean nothing listed has changed.
        Reads only folder and file times: no Claude, no Git, no transcript. The desktop store is walked as the
        inventory walks it, so the check grows with the store.
        Assumes real Claude rewrites a live session's `<config>/sessions/<pid>.json` when its status changes, as
        seen on Claude 2.1.x. A status that changes only in `claude agents` shows at the next full read (R)."""
        def stamp(path):
            try:
                return path.stat().st_mtime_ns
            except OSError:
                return None

        def files(folder):
            try:
                with os.scandir(folder) as entries:
                    return sorted((e.name, e.stat().st_mtime_ns, e.stat().st_size) for e in entries if e.is_file())
            except OSError:
                return None

        transcripts = self.config / 'projects'
        folders = [self.root, transcripts, *(p for p in transcripts.glob('*') if p.is_dir())]
        try:
            folders += [path / '.claude' / 'worktrees' for path in self.projects().values()]
        except ValueError:
            pass
        stores = [Path(self.options.desktop_sessions)] if self.options.desktop_sessions else default_desktop_stores()
        desktop = [(str(folder), files(folder)) for store in stores for folder in (store, *store.rglob('*')) if folder.is_dir()]
        return [(str(folder), stamp(folder)) for folder in folders], files(self.config / 'sessions'), desktop

    def saved(self):
        catalog = {}
        projects = self.projects()
        desktop = self.desktop_store()
        # Transcripts repeat a few folders thousands of times; resolving each is slow on Windows.
        roots, branches, scanned, archived = {}, {}, set(), set()
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
            if app.get('Archived'):
                archived.add(file.stem)
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
                row = session_row(file.stem, project, cwd, branches[cwd], Updated=updated, Worktree=is_tree,
                                  Available=not reason, UnavailableReason=reason, Conflict=conflict, Title=title,
                                  StartEntrypoint=meta['Entrypoint'], StartKind=meta['Kind'], Teleported=meta['Teleported'],
                                  InDesktopApp=bool(app), ClaudeVersion=meta['Version'],
                                  PermissionMode=meta['PermissionMode'] or app.get('PermissionMode'))
                if file.stem in catalog and not wt.same(catalog[file.stem]['WorkingDirectory'], cwd):
                    raise ValueError(f'Conflicting saved locations for session {file.stem}.')
                catalog[file.stem] = row
        for key in TRANSCRIPTS.keys() - scanned:
            del TRANSCRIPTS[key]
        self.archived = archived
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
        # A session whose folder is gone, or that the desktop app archived, is gone too.
        # State records a task only once its folder exists.
        if not found and (id in self.archived or not folder_exists(entry.get('WorkingDirectory'))):
            return None
        folder, project = entry['WorkingDirectory'], entry['Project']
        row = found or session_row(id, project, folder, checked_out_branch(folder), Worktree=self.in_worktrees(folder, project),
                                   NewSession=entry.get('NewSession', False))
        row['Task'] = entry.get('Task')
        return row

    def in_worktrees(self, folder, project):
        """Whether a folder is one of the project's task worktrees, not the project root."""
        return wt.inside(folder, self.root / project / '.claude' / 'worktrees')

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
        if o.type and not named:
            raise ValueError('--type needs a task: supply an issue number or a description for a new task.')
        if named:
            if len(projects) != 1 or o.session_id or o.action != 'start':
                raise ValueError('Use task/issue/PR/branch with start and exactly one --only project, without --session-id.')
            project = next(iter(projects))
            name = task_label(o) or o.branch
            folder, branch = requested_names(project, o)
            # One task per branch, however it was spelled: the branch it has, or the one it asked for when a collision
            # gave it a suffix. A saved task label still finds tasks from before the scheme.
            matches = [(id, e) for id, e in sessions.items() if e['Project'] == project and not e.get('ReplacedBy')
                       and (branch in (e.get('Branch'), e.get('RequestedBranch')) or e.get('Task') == name)]
            if len(matches) > 1:
                raise ValueError('More than one saved task matches; select its exact session ID.')
            if matches:
                id, entry = matches[0]
                if o.branch and entry.get('Branch') and o.branch not in (entry['Branch'], entry.get('RequestedBranch')):
                    raise ValueError('Task already uses another branch; choose a different task name.')
                row = self.managed(id, entry, saved)
                if not row:
                    raise ValueError(f"Task '{name}' had its folder deleted; its session stays gone. Choose a different task name.")
                return [row]
            return [dict(SessionId=str(uuid.uuid4()), Project=project, Task=name, Branch=branch,
                         Available=False, NewSession=True, Name=folder)]
        if o.session_id:
            id = current(sessions, o.session_id)
            if id in sessions and sessions[id]['Project'] not in projects:
                raise ValueError('The saved session belongs to a different project.')
            row = self.managed(id, sessions[id], saved) if id in sessions else next((s for s in saved if s['SessionId'] == id), None)
            if not row:
                raise ValueError(f'Saved session {id} was not found, was archived in the desktop app, or its folder is gone. '
                                 'Nothing is recreated.')
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
        # A new request carries its Name; a stored task is named by its folder.
        name = s.get('Name') or Path(directory).name
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
                rows.append(session_row(a['sessionId'], project, folder, checked_out_branch(folder),
                                        Worktree=self.in_worktrees(folder, project)))
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
            result.append(dict(s, Task=title, Stoppable=running and not live_elsewhere(agent), Running=running,
                               ViewOnly=live_elsewhere(agent),
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
                if live_elsewhere(launch['Agent']) and self.options.session_id:
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
                workspace = wt.create_after_fetch(workspace)
                launch['WorkingDirectory'] = workspace['WorkingDirectory']
            branch = workspace['Branch'] if workspace else checked_out_branch(launch['WorkingDirectory'])
            asked = s.get('Branch') if workspace else sessions.get(id, {}).get('RequestedBranch')
            # Recorded only once the folder exists, so a recorded task whose folder is gone was deleted.
            sessions[id] = dict(Project=s['Project'], Task=s.get('Task'), Branch=branch, WorkingDirectory=launch['WorkingDirectory'],
                                NewSession=launch['Mode'] == 'new', Updated=datetime.now(timezone.utc).isoformat())
            if asked and asked != branch:
                sessions[id]['RequestedBranch'] = asked
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
            if live_elsewhere(a):
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
                name, branch = requested_names(project, o)
                workspace = wt.plan(projects[project], name, branch)
                if not o.plan:
                    workspace = wt.create_after_fetch(workspace)
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


def requested_names(project, options):
    """Folder and branch a start or workspace request names: branch type --type (else feature), then --issue or --pr,
    then the --task description, which never supplies a branch type. An explicit --branch keeps its own spelling,
    and given alone it names the folder too: --branch codex/foo is folder <repo>-codex-foo."""
    if options.branch and not (options.task or options.issue or options.pr):
        return wt.TaskNames(f'{wt.slug(project)}-{wt.slug(options.branch)}', options.branch)
    names = wt.task_names(project, options.type or 'feature', options.issue or options.pr, options.task)
    return names._replace(branch=options.branch or names.branch)


def task_label(options):
    ticket = f'issue-{options.issue}' if options.issue else f'pr-{options.pr}' if options.pr else ''
    return ' '.join(str(v) for v in (options.type, ticket, options.task) if v) if ticket or options.task else ''


def parser():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('action', nargs='?', default='menu', choices=['menu', 'sessions', 'status', 'start', 'resume', 'stop', 'workspace'])
    default_root = os.environ.get('REMOTE_PROJECTS_ROOT') or str(Path('V:/dev') if os.name == 'nt' and Path('V:/dev').is_dir() else Path.home() / 'dev')
    p.add_argument('--root', '-Root', default=default_root)
    p.add_argument('--only', '-Only', nargs='+', default=[])
    p.add_argument('--session-id', '-SessionId')
    p.add_argument('--task', '-Task')
    p.add_argument('--branch', '-Branch')
    p.add_argument('--type', '-Type', choices=wt.BRANCH_TYPES, help='Branch type of a new task; default: feature.')
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
    # Seconds between the open picker's checks for changed sessions. Hidden: the spec fixes about 3 s; tests pass 0.
    p.add_argument('--refresh-every', type=float, default=3, help=argparse.SUPPRESS)
    return p


def clean(value):
    # Titles come from external history. Strip terminal control sequences before rendering.
    return re.sub(r'[\x00-\x1f\x7f-\x9f]', '', re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]', '', str(value or '')))


def color(text, code):
    return f'\033[{code}m{text}\033[0m' if sys.stdout.isatty() and not os.environ.get('NO_COLOR') else text


def keypress(timeout=None):
    """The next key, or None when `timeout` seconds pass without one (None waits for ever)."""
    if os.name == 'nt':
        import msvcrt
        deadline = None if timeout is None else time.monotonic() + timeout
        try:
            while deadline is not None and not msvcrt.kbhit():
                if time.monotonic() >= deadline:
                    return None
                time.sleep(.02)
        except KeyboardInterrupt:
            return '\x03'  # Between reads the console turns Ctrl+C into an interrupt; it is still the Ctrl+C key.
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
        # TCSANOW: a key typed between two waits stays queued instead of being flushed.
        tty.setraw(fd, termios.TCSANOW)
        if timeout is not None and not select.select([fd], [], [], timeout)[0]:
            return None
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
        return r.get('Status') != 'history' and bool(r.get('Available') or r.get('Status') == 'error')
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


EMOJI_STYLE = chr(0xfe0f)  # Asks for emoji presentation: Windows Terminal then draws a text symbol two cells wide.


def glyph_cells(glyph):
    first = glyph[0]
    if unicodedata.combining(first) or first in ZERO_WIDTH:
        return 0
    return 2 if EMOJI_STYLE in glyph or unicodedata.east_asian_width(first) in 'WF' else 1


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


def inventory(manager):
    """Every row the picker lists: a full read of Claude, transcripts, the desktop store and state."""
    state = manager.state()
    return manager.status(manager.saved(), state, manager.agents())


QUIT_KEYS = ('q', '\x1b', '\x03')
ACTION_KEYS = ('\r', '\n', 'n', 'x')


class Reload(threading.Thread):
    """One inventory read off the key loop, so a refresh never holds up a keypress. start() runs it.
    `rows` holds the result, or `error` whatever stopped it."""

    def __init__(self, manager):
        super().__init__(daemon=True)
        self.manager, self.rows, self.error = manager, None, None

    def run(self):
        try:
            self.rows = inventory(self.manager)
        except Exception as error:  # Expected or not, a failure reaches the picker as a warning; the thread never dies silently.
            self.error = error


class LiveRefresh:
    """The rows the open picker shows, kept current. Every `interval` seconds a check reads folder and file times
    only; when they changed, a full inventory read runs off the key loop. `warning` says why rows may be stale."""

    def __init__(self, manager, interval):
        self.manager, self.interval = manager, max(0, interval)
        self.rows, self.seen, self.check_at, self.loading, self.again, self.warning = [], None, 0, None, False, ''

    def load(self):
        """Read the full inventory now, on the key loop: when the picker opens and after an action."""
        self.settle()
        # Taken first, so a change made while the inventory loads is seen at the next check.
        self.seen = self.manager.fingerprint()
        self.rows, self.warning = inventory(self.manager), ''
        self.check_at = time.monotonic() + self.interval

    def reload(self, seen=None):
        """Start a full read off the key loop. Asked for while one runs, another runs once it finishes."""
        if self.loading:
            self.again = True
            return
        self.seen, self.loading = seen or self.manager.fingerprint(), Reload(self.manager)
        self.loading.start()

    def settle(self):
        """Wait out a read in flight and drop it: it must not outlive the picker or race an action."""
        if self.loading:
            self.loading.join()
        self.loading, self.again = None, False

    def key(self):
        """The next keypress, or None when a read came back and the picker must redraw."""
        while True:
            if self.loading and not self.loading.is_alive():
                done, self.loading = self.loading, None
                if self.again:
                    self.again = False
                    self.reload()
                if done.error:
                    # The old rows stay, and the picker says why, until a read succeeds.
                    error = done.error if isinstance(done.error, (OSError, ValueError, RuntimeError)) \
                        else f'{type(done.error).__name__}: {done.error}'
                    self.warning = f'Live refresh failed; rows may be out of date. {error}'
                else:
                    self.rows, self.warning = done.rows, ''
                return None
            key = keypress(.05 if self.loading else max(0, self.check_at - time.monotonic()))
            if key is not None:
                return key
            if not self.loading and time.monotonic() >= self.check_at:
                now = self.manager.fingerprint()
                if now != self.seen:
                    self.reload(now)
                self.check_at = time.monotonic() + self.interval


def menu(manager):
    if not sys.stdin.isatty():
        raise ValueError('The picker requires a terminal. Use status --json for scripts.')
    cursor, focus, checked, message, history, refresh = 0, None, set(), '', False, True
    live = LiveRefresh(manager, manager.options.refresh_every)
    while True:
        if refresh:
            live.load()
            refresh = False
        all_rows = live.rows
        rows = visible_rows(all_rows, history)
        for project in manager.projects():
            if not any(r['Project'] == project for r in rows):
                rows.append(dict(Project=project, SessionId=f'new:{project}', Task='New named task', NewProject=True, Available=True,
                                 Status='new'))
        if not rows:
            print('No project folders found.')
            return
        # The cursor follows its session when a refresh moves rows, and holds its place when the session is gone.
        cursor = next((i for i, r in enumerate(rows) if r['SessionId'] == focus), min(cursor, len(rows) - 1))
        focus = rows[cursor]['SessionId']
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
        if live.warning:
            print(color(clean(live.warning), '91'))
        key = live.key()
        if key is None:
            continue
        if key in QUIT_KEYS + ACTION_KEYS:
            live.settle()
        if key in QUIT_KEYS:
            return
        if key in ('up', 'k', 'down', 'j'):
            cursor = (cursor + (-1 if key in ('up', 'k') else 1)) % len(rows)
            focus = rows[cursor]['SessionId']
        elif key == 'h':
            history = not history
            checked.clear()
        elif key == 'r':
            live.reload()
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
        elif key in ACTION_KEYS:
            targets = [row] if key == 'n' else [r for r in rows if r['SessionId'] in checked]
            messages = []
            for target in targets:
                if key == 'x' and target.get('NewProject'):
                    continue  # A new-task placeholder has no session to stop.
                options = argparse.Namespace(**vars(manager.options))
                options.only = [target['Project']]
                options.task = options.branch = options.issue = options.pr = options.type = options.session_id = None
                options.action = 'stop' if key == 'x' else 'resume'
                if key == 'n' or (target.get('NewProject') and key != 'x'):
                    # The same names the WorktreeCreate hook gives: <repo>-<type>-<issue>-<desc> on <type>/<issue>-<desc>.
                    branch_type = input(f"Branch type ({', '.join(wt.BRANCH_TYPES)}), blank for feature: ").strip().lower() or 'feature'
                    issue = input('Issue number, blank for none: ').strip().lstrip('#')
                    task = input('Description, blank cancels unless an issue is given: ').strip()
                    if not task and not issue:
                        continue
                    if issue and not (issue.isdigit() and int(issue) > 0):
                        messages.append(f'Issue must be a number, not {issue!r}.')
                        continue
                    options.action, options.type, options.task, options.issue = 'start', branch_type, task or None, int(issue) if issue else None
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
