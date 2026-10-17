#!/usr/bin/env node
// Build the /oneezy-debug report for this chat from the harness's own transcript. Claude Code writes
// ~/.claude/projects/<cwd>/<session>.jsonl (subagents under <session>/subagents/agent-<id>.jsonl) and Codex writes
// ~/.codex/sessions/**/rollout-*-<thread>.jsonl; both stamp every prompt, tool call and result, and record the
// instruction files they loaded. Any other harness gets `available: false`, and the skill fills the report by hand.
//
//   node trace.mjs                        header, the <<ANSWER>> marker, then the table (this turn)
//   node trace.mjs --scope chat           every turn of the chat, one parent row per prompt
//   node trace.mjs --tz America/Chicago   times in this zone (default: ONEEZY_DEBUG_TZ, else the machine's zone)
//   node trace.mjs --json                 the trace as JSON
//   node trace.mjs --transcript <file> --harness claude|codex
import {existsSync, readdirSync, readFileSync, statSync} from 'node:fs';
import {homedir, hostname, platform} from 'node:os';
import {basename, dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

export const ANSWER = '<<ANSWER>>';
const EM = '\u2003';

export function detect(env = process.env) {
  if (env.CLAUDECODE === '1' || env.CLAUDE_CODE_ENTRYPOINT) return 'claude';
  if (env.CODEX_THREAD_ID || env.CODEX_SESSION_ID || env.CODEX_SANDBOX) return 'codex';
  return null;
}

const jsonl = file => readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap(line => {
  try { return [JSON.parse(line)]; } catch { return []; }
});
const text = value => (typeof value === 'string' ? value : JSON.stringify(value ?? ''));
const short = path => String(path ?? '').split(/[/\\]/).filter(Boolean).slice(-2).join('/');

// Titles are plain words: no emoji, no table-breaking pipes, one line.
export function title(raw, max = 60) {
  const flat = String(raw ?? '').replace(/<[^>]*>/g, ' ').replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, '')
    .replace(/\|/g, '/').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function claudeTitle(name, input = {}) {
  if (name === 'Skill') return `Load skill ${input.skill}`;
  if (name === 'Bash') return input.description || `Run ${input.command}`;
  if (name === 'Read') return `Read ${short(input.file_path)}`;
  if (name === 'Write') return `Write ${short(input.file_path)}`;
  if (name === 'Edit' || name === 'NotebookEdit') return `Edit ${short(input.file_path ?? input.notebook_path)}`;
  if (name === 'Grep') return `Search files for ${input.pattern}`;
  if (name === 'Glob') return `Find files ${input.pattern}`;
  if (name === 'Agent' || name === 'Task') return `Run subagent: ${input.description ?? ''}`;
  if (name === 'WebFetch') return `Fetch ${input.url}`;
  if (name === 'WebSearch') return `Search the web for ${input.query}`;
  if (name === 'ToolSearch') return 'Load tool definitions';
  const mcp = name.match(/^mcp__(.+?)__(.+)$/);
  if (mcp) return `Call ${mcp[1]} ${mcp[2].replace(/_/g, ' ')}`;
  return `Use ${name}`;
}

const node = (rowTitle, start) => ({title: title(rowTitle), start, end: null, ok: null, children: []});

// A skill's plugin and version come from the plugin.json above the folder the harness loaded it from.
export function provenance(skill, base) {
  let dir = base;
  for (let i = 0; dir && i < 4; i++, dir = dirname(dir)) {
    for (const file of ['plugin.json', '.claude-plugin/plugin.json', '.codex-plugin/plugin.json']) {
      try {
        const meta = JSON.parse(readFileSync(join(dir, file), 'utf8'));
        if (meta.name) return {name: skill, plugin: meta.name, version: meta.version ?? null, path: base};
      } catch { /* not this level */ }
    }
  }
  return {name: skill, plugin: null, version: null, path: base ?? null};
}

function isPrompt(entry) {
  if (entry.type !== 'user' || entry.isMeta || entry.isSidechain || entry.toolUseResult) return false;
  const content = entry.message?.content;
  return !(Array.isArray(content) && content.some(part => part.type === 'tool_result'));
}

// Claude Code: one parent row per typed prompt, a child row per tool call, a subagent's calls under its row.
export function parseClaude(entries, {file = null, depth = 0} = {}) {
  const calls = [];
  const byId = new Map();
  const skills = new Map();
  const bases = new Map();
  let model = null;
  let selected = null;
  for (const entry of entries) {
    const content = Array.isArray(entry.message?.content) ? entry.message.content : [];
    const messageText = typeof entry.message?.content === 'string' ? entry.message.content : content.filter(part => part.type === 'text').map(part => part.text).join('\n');
    for (const match of messageText.matchAll(/Base directory for this skill: ([^\r\n]+)/g)) bases.set(basename(match[1].trim()), match[1].trim());
    if (entry.type === 'assistant') {
      model = entry.message?.model ?? model;
      selected = entry.requestedModel ?? selected;
      for (const part of content.filter(part => part.type === 'tool_use')) {
        const row = node(claudeTitle(part.name, part.input), entry.timestamp);
        row.at = entry.timestamp;
        calls.push(row);
        byId.set(part.id, {row, name: part.name});
        if (part.name === 'Skill') skills.set(String(part.input?.skill).split(':').pop(), null);
        if (part.name === 'Read' && /SKILL\.md$/.test(part.input?.file_path ?? '')) {
          const dir = dirname(part.input.file_path);
          skills.set(basename(dir), dir);
        }
      }
    }
    if (entry.type === 'user') {
      for (const part of content.filter(part => part.type === 'tool_result')) {
        const call = byId.get(part.tool_use_id);
        if (!call) continue;
        Object.assign(call.row, {end: entry.timestamp, ok: part.is_error !== true});
        const agent = entry.toolUseResult?.agentId;
        const sub = agent && file && join(file.replace(/\.jsonl$/, ''), 'subagents', `agent-${agent}.jsonl`);
        if (sub && depth < 2 && existsSync(sub)) call.row.children = parseClaude(jsonl(sub), {file: null, depth: depth + 1}).calls;
      }
    }
  }
  // A turn is every entry sharing a promptId (harness notes and relayed messages are isMeta but still open a turn);
  // without promptIds, a typed prompt opens one.
  const groups = new Map();
  entries.forEach((entry, i) => {
    const key = entry.promptId ?? (isPrompt(entry) ? `prompt-${i}` : null);
    if (!key || entry.isSidechain) return;
    if (!groups.has(key)) groups.set(key, {start: entry.timestamp, entries: []});
    if (entry.type === 'user' && !entry.toolUseResult && typeof entry.message?.content === 'string') groups.get(key).entries.push(entry);
  });
  for (const group of groups.values()) {
    for (const entry of group.entries) {
      const typed = entry.message.content.match(/<command-name>\/?([^<]+)<\/command-name>/);
      if (typed) skills.set(typed[1].split(':').pop(), null);
    }
  }
  const starts = [...groups.values()].filter(group => group.entries.length && group.start);
  const turns = starts.map((group, n) => {
    const said = group.entries.find(entry => !entry.isMeta) ?? group.entries.at(-1);
    const next = starts[n + 1]?.start;
    const cited = said.message.content.match(/<cited[^>]*author="user"[^>]*>([\s\S]*?)<\/cited>/);
    const row = node(`Handle prompt: ${cited?.[1] ?? said.message.content}`, group.start);
    const stamps = entries.filter(entry => entry.type === 'user' || entry.type === 'assistant').map(entry => entry.timestamp)
      .filter(at => at && at >= group.start && (!next || at < next)).sort();
    row.end = stamps.at(-1) ?? null;
    row.children = calls.filter(call => call.at >= row.start && (!next || call.at < next));
    row.meta = !group.entries.some(entry => !entry.isMeta);
    return row;
  }).filter((row, n, rows) => !row.meta || row.children.length || n === rows.length - 1);
  // The harness records what it loaded as attachments: instruction files, context sections, recalled memories.
  const attached = type => entries.filter(entry => entry.attachment?.type === type).map(entry => entry.attachment);
  const instructions = attached('instructions').flatMap(a => a.files ?? []).map(f => `${f.path} (${String(f.type).toLowerCase()})`);
  const sections = attached('context_sections').flatMap(a => a.sections ?? []);
  const memory = sections.flatMap(section => [...String(section.text).matchAll(/memory at `([^`]+)`/g)].map(match => match[1]));
  const recalled = attached('relevant_memories').flatMap(a => a.memories ?? []).length;
  const context = [...sections.map(section => section.name), ...attached('session_context').flatMap(a => Object.keys(a.context ?? {}))];
  selected = selected ?? attached('model').at(-1)?.identity?.modelId ?? null;
  const first = entries.find(entry => entry.version) ?? {};
  return {
    calls,
    turns,
    model: {verified: model, selected},
    version: first.version ?? null,
    entrypoint: first.entrypoint ?? null,
    cwd: first.cwd ?? null,
    session: first.sessionId ?? null,
    instructions: [...new Set(instructions)],
    memory: [...new Set(memory)],
    recalled,
    context: [...new Set(context)],
    skills: [...skills].map(([name, dir]) => provenance(name, dir ?? bases.get(name) ?? null)),
  };
}

function codexArgs(payload) {
  if (payload.type === 'local_shell_call') return {command: payload.action?.command};
  if (payload.type === 'custom_tool_call') return {input: payload.input};
  try { return JSON.parse(payload.arguments ?? '{}'); } catch { return {raw: payload.arguments}; }
}

function codexTitle(name, args) {
  const command = args.cmd ?? args.command;
  if (command) return `Run ${Array.isArray(command) ? command.join(' ') : command}`;
  const file = String(args.input ?? '').match(/^\*\*\* (Add|Update|Delete) File: (.+)$/m);
  if (file) return `${file[1] === 'Update' ? 'Edit' : file[1]} ${short(file[2])}`;
  return `Use ${name}`;
}

function codexOk(output) {
  const body = typeof output === 'object' && output !== null ? output.content ?? output.output ?? JSON.stringify(output) : output;
  try {
    const exit = JSON.parse(body)?.metadata?.exit_code;
    if (exit !== undefined) return exit === 0;
  } catch { /* plain text output */ }
  const code = String(body ?? '').match(/(?:Process exited with code|Exit code:?)\s*(-?\d+)/i);
  return code ? Number(code[1]) === 0 : true;
}

// Codex: each rollout line is {timestamp, type, payload}; a prompt is an event_msg of type user_message.
export function parseCodex(entries) {
  const calls = [];
  const byId = new Map();
  const skills = new Map();
  let meta = {};
  let context = {};
  const prompts = [];
  entries.forEach((entry, i) => {
    const payload = entry.payload ?? {};
    if (entry.type === 'session_meta') meta = payload;
    if (entry.type === 'turn_context') context = payload;
    if (entry.type === 'event_msg' && payload.type === 'user_message') prompts.push(i);
    if (entry.type !== 'response_item') return;
    if (['function_call', 'custom_tool_call', 'local_shell_call'].includes(payload.type)) {
      const args = codexArgs(payload);
      const row = node(codexTitle(payload.name ?? 'shell', args), entry.timestamp);
      row.at = entry.timestamp;
      calls.push(row);
      if (payload.call_id) byId.set(payload.call_id, row);
      for (const match of JSON.stringify(args).matchAll(/([^\s'"]+)[/\\]SKILL\.md/g)) skills.set(basename(match[1]), match[1]);
    }
    if (['function_call_output', 'custom_tool_call_output'].includes(payload.type)) {
      const row = byId.get(payload.call_id);
      if (row) Object.assign(row, {end: entry.timestamp, ok: codexOk(payload.output)});
    }
  });
  const turns = prompts.map((index, n) => {
    const next = prompts[n + 1];
    const stamps = entries.slice(index, next ?? entries.length).map(entry => entry.timestamp).filter(Boolean);
    const row = node(`Handle prompt: ${entries[index].payload.message ?? ''}`, entries[index].timestamp);
    row.end = stamps.at(-1) ?? null;
    row.children = calls.filter(call => call.at >= row.start && (next === undefined || call.at < entries[next].timestamp));
    return row;
  });
  const all = entries.map(entry => text(entry.payload?.content)).join('\n');
  return {
    calls,
    turns,
    model: {verified: null, selected: context.model ?? null},
    effort: context.effort ?? null,
    provider: meta.model_provider ?? null,
    version: meta.cli_version ?? null,
    entrypoint: meta.originator ?? null,
    cwd: meta.cwd ?? context.cwd ?? null,
    session: meta.id ?? null,
    instructions: [...new Set([...all.matchAll(/AGENTS\.md instructions for ([^\n<\\"]+)/g)].map(match => `${match[1].trim().replace(/[\\/]+$/, '')}/AGENTS.md`))],
    memory: [],
    recalled: 0,
    context: [],
    systemPrompt: meta.base_instructions ? 'embedded in the rollout file (session_meta)' : null,
    skills: [...skills].map(([name, dir]) => provenance(name, dir)),
  };
}

function newest(dir, test, depth) {
  let best = null;
  const walk = (path, level) => {
    let names;
    try { names = readdirSync(path); } catch { return; }
    for (const name of names) {
      const full = join(path, name);
      let stat;
      try { stat = statSync(full); } catch { continue; }
      if (stat.isDirectory() && level < depth) walk(full, level + 1);
      else if (stat.isFile() && test(name) && (!best || stat.mtimeMs > best.mtimeMs)) best = {path: full, mtimeMs: stat.mtimeMs};
    }
  };
  walk(dir, 0);
  return best?.path ?? null;
}

const SURFACES = {cli: 'terminal', remote_projects: 'Claude Projects thread', remote: 'Claude Code on the web',
  'claude-desktop': 'Claude desktop app', 'claude-vscode': 'VS Code', codex_cli_rs: 'Codex CLI', codex_vscode: 'Codex IDE extension'};

export function locate(harness, env = process.env) {
  if (harness === 'claude') {
    const id = env.CLAUDE_CODE_SESSION_ID;
    const remote = env.CLAUDE_CODE_REMOTE_SESSION_ID;
    const cloud = env.CLAUDE_CODE_REMOTE === 'true';
    return {
      harness: 'Claude Code',
      provider: env.CLAUDE_CODE_USE_BEDROCK ? 'Amazon Bedrock' : env.CLAUDE_CODE_USE_VERTEX ? 'Google Vertex AI' : 'Anthropic',
      effort: env.CLAUDE_EFFORT ?? null,
      link: remote?.startsWith('cse_') ? `https://claude.ai/code/session_${remote.slice(4)}` : id ? `claude --resume ${id}` : null,
      location: cloud ? `cloud container ${env.CLAUDE_CODE_CONTAINER_ID ?? '(id unknown)'}` : `computer ${hostname()}`,
      systemPrompt: 'built into Claude Code, not a file',
      transcript: newest(join(env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'projects'),
        name => (id ? name === `${id}.jsonl` : name.endsWith('.jsonl')), 1),
    };
  }
  if (harness === 'codex') {
    const id = env.CODEX_THREAD_ID ?? env.CODEX_SESSION_ID;
    return {
      harness: 'Codex',
      link: id ? `codex resume ${id}` : null,
      location: `computer ${hostname()}`,
      transcript: newest(join(env.CODEX_HOME ?? join(homedir(), '.codex'), 'sessions'),
        name => name.startsWith('rollout-') && name.endsWith('.jsonl') && (!id || name.includes(id)), 4),
    };
  }
  return {harness: null, transcript: null};
}

function trail(cwd) {
  if (!cwd) return null;
  if (existsSync(join(cwd, 'decisions.tsv'))) return join(cwd, 'decisions.tsv');
  const audit = newest(join(cwd, '.audit'), name => name.endsWith('.tsv'), 0);
  return audit;
}

export function trace({harness = detect(), transcript, scope = 'turn', env = process.env} = {}) {
  const found = locate(harness, env);
  const file = transcript ?? found.transcript;
  if (!harness || !file || !existsSync(file)) return {available: false, harness: found.harness, transcript: file ?? null};
  const parsed = harness === 'codex' ? parseCodex(jsonl(file)) : parseClaude(jsonl(file), {file});
  const rows = scope === 'chat' ? parsed.turns : parsed.turns.slice(-1);
  return {available: true, ...found, ...parsed, effort: parsed.effort ?? found.effort ?? null,
    provider: parsed.provider ?? found.provider ?? null, systemPrompt: parsed.systemPrompt ?? found.systemPrompt ?? null,
    surface: SURFACES[parsed.entrypoint] ?? parsed.entrypoint, transcript: file, trail: trail(parsed.cwd), rows, scope};
}

export function clock(iso, tz) {
  if (!iso) return '—';
  return new Intl.DateTimeFormat('en-US', {timeZone: tz, hour: 'numeric', minute: '2-digit', second: '2-digit'})
    .format(new Date(iso)).replace(' AM', ' a.m.').replace(' PM', ' p.m.');
}

export function zone(tz, at = new Date()) {
  const part = type => new Intl.DateTimeFormat('en-US', {timeZone: tz, timeZoneName: type}).formatToParts(at).find(p => p.type === 'timeZoneName')?.value;
  return `${tz}, ${part('short')} (${part('longOffset').replace('GMT', 'UTC').replace('-', '−') || 'UTC+0'})`;
}

export function span(ms) {
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)} sec`;
  if (ms < 3600000) return `${Math.floor(ms / 60000)} min ${Math.round((ms % 60000) / 1000)} sec`;
  return `${Math.floor(ms / 3600000)} h ${Math.round((ms % 3600000) / 60000)} min`;
}

// A parent's duration is its full span, never the sum of its children; a row with no result is ongoing or unresolved.
function status(row, last) {
  if (row.title.startsWith('Handle prompt')) {
    const flat = descendants(row);
    if (flat.some(child => child.ok === false || (child.ok === null && child !== last))) return '⚠️';
    return 'ℹ️';
  }
  if (row.ok === null) return row === last ? 'ℹ️' : '⚠️';
  return row.ok ? '✅' : '❌';
}
const descendants = row => row.children.flatMap(child => [child, ...descendants(child)]);

function duration(row, last) {
  const ends = [row.end, ...descendants(row).map(child => child.end)].filter(Boolean).sort();
  const pending = row.ok === null && !row.title.startsWith('Handle prompt');
  if (pending) return row === last ? 'ongoing' : 'no result';
  if (row.title.startsWith('Handle prompt') && descendants(row).includes(last) && last.ok === null) return 'ongoing';
  return ends.length ? span(Date.parse(ends.at(-1)) - Date.parse(row.start)) : '—';
}

export function render(t, {tz = Intl.DateTimeFormat().resolvedOptions().timeZone} = {}) {
  if (!t.available) return 'Transcript not available; fill the report by hand from references/harnesses.md.';
  const unknown = 'unknown';
  const list = items => (items.length ? items.map(item => `\`${item}\``).join(', ') : 'none found');
  const skills = t.skills.length ? t.skills.map(s => `${s.name}${s.plugin ? ` (${s.plugin}${s.version ? ` ${s.version}` : ''})` : ''}`).join(', ') : 'none';
  const header = [
    `**Debug** · ${t.harness}${t.version ? ` ${t.version}` : ''} · ${t.surface ?? unknown} · ${t.location}`,
    `- Model: ${t.model.verified ? `${t.model.verified} [verified]` : `${unknown} [verified]`} · ${t.model.selected ?? unknown} [selected] · provider ${t.provider ?? unknown}`,
    `- Reasoning effort: ${t.effort ?? unknown} [selected] · ${unknown} [verified]`,
    `- Session: ${t.link ?? unknown} · id \`${t.session ?? unknown}\``,
    `- Working folder: \`${t.cwd ?? unknown}\` · ${platform()}`,
    `- System prompt: ${t.systemPrompt ?? unknown}`,
    `- Instructions loaded: ${list(t.instructions)}`,
    ...(t.memory.length ? [`- Memory: ${list(t.memory)}${t.recalled ? ` · ${t.recalled} recalled this chat` : ''}`] : []),
    ...(t.context.length ? [`- Context sections: ${t.context.join(', ')}`] : []),
    `- Skills: ${skills}`,
    `- Decision trail: ${t.trail ? `\`${t.trail}\`` : 'none found'}`,
    `- Times: ${zone(tz)}`,
  ];
  const all = t.rows.flatMap(row => [row, ...descendants(row)]);
  const last = all.filter(row => !row.title.startsWith('Handle prompt')).at(-1);
  const lines = [];
  const walk = (row, level) => {
    const pad = EM.repeat(level);
    lines.push(`| ${pad}${status(row, last)} | ${pad}${row.title} | ${clock(row.start, tz)} | ${duration(row, last)} |`);
    row.children.forEach(child => walk(child, level + 1));
  };
  t.rows.forEach(row => walk(row, 0));
  return [
    ...header,
    '',
    ANSWER,
    '',
    '| Status | Title | Start | Duration |',
    '|---|---|---|---|',
    ...lines,
    '',
    `✅ success · ❌ failure · ⚠️ warning · ℹ️ information. Rows from the ${t.harness} transcript \`${t.transcript}\`; [verified] read from it or the harness, [selected] configured, unknown not exposed.`,
  ].join('\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const flag = name => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
  const result = trace({harness: flag('--harness') ?? detect(), transcript: flag('--transcript'), scope: flag('--scope') ?? 'turn'});
  const tz = flag('--tz') ?? process.env.ONEEZY_DEBUG_TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  console.log(argv.includes('--json') ? JSON.stringify(result, null, 2) : render(result, {tz}));
}
