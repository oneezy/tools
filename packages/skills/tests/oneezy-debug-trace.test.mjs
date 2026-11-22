import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {ANSWER, clock, detect, locate, parseClaude, parseCodex, provenance, render, span, title, trace, zone}
  from '../skills/oneezy/oneezy-debug/scripts/trace.mjs';

const EM = ' ';
const lines = entries => entries.map(entry => JSON.stringify(entry)).join('\n');

function claudeHome() {
  const home = mkdtempSync(join(tmpdir(), 'debug-'));
  const plugin = join(home, 'plugins', 'oneezy');
  mkdirSync(join(plugin, 'skills', 'oneezy-skills'), {recursive: true});
  writeFileSync(join(plugin, 'plugin.json'), JSON.stringify({name: 'oneezy', version: '9.9.9'}));
  const entries = [
    {type: 'attachment', timestamp: '2026-10-12T09:59:59.000Z', attachment: {type: 'instructions', files: [{path: '/u/.claude/CLAUDE.md', type: 'User'}]}},
    {type: 'attachment', timestamp: '2026-10-12T09:59:59.000Z', attachment: {type: 'context_sections', sections: [{name: 'Memory', text: 'memory at `/m/silo` here'}]}},
    {type: 'user', promptId: 'p1', version: '2.0.0', entrypoint: 'cli', cwd: '/repo', sessionId: 's1', timestamp: '2026-10-12T10:00:00.000Z', message: {content: 'earlier prompt'}},
    {type: 'assistant', timestamp: '2026-10-12T10:00:01.000Z', message: {content: [{type: 'tool_use', id: 'old', name: 'Bash', input: {command: 'ls'}}]}},
    {type: 'user', promptId: 'p1', toolUseResult: {}, timestamp: '2026-10-12T10:00:02.000Z', message: {content: [{type: 'tool_result', tool_use_id: 'old', content: ''}]}},
    {type: 'user', promptId: 'p2', isMeta: true, timestamp: '2026-10-12T10:01:00.000Z', message: {content: '<relay><cited author="user">sync my skills 🎉 | now</cited></relay>'}},
    {type: 'assistant', requestedModel: 'model-a', timestamp: '2026-10-12T10:01:01.000Z', message: {model: 'model-a', content: [
      {type: 'tool_use', id: 'a', name: 'Skill', input: {skill: 'oneezy:oneezy-skills'}},
    ]}},
    {type: 'user', promptId: 'p2', toolUseResult: {}, timestamp: '2026-10-12T10:01:01.250Z', message: {content: [{type: 'tool_result', tool_use_id: 'a', content: 'ok'}]}},
    {type: 'user', promptId: 'p2', isMeta: true, timestamp: '2026-10-12T10:01:01.300Z', message: {content: [{type: 'text', text: `Base directory for this skill: ${join(plugin, 'skills', 'oneezy-skills')}`}]}},
    {type: 'assistant', timestamp: '2026-10-12T10:01:02.000Z', message: {content: [
      {type: 'tool_use', id: 'b', name: 'Bash', input: {command: 'npx skills-sync', description: 'Sync the skills'}},
      {type: 'tool_use', id: 'c', name: 'Agent', input: {description: 'Check the plugins'}},
    ]}},
    {type: 'user', promptId: 'p2', toolUseResult: {}, timestamp: '2026-10-12T10:01:05.500Z', message: {content: [{type: 'tool_result', tool_use_id: 'b', is_error: true, content: 'Exit code 1'}]}},
    {type: 'user', promptId: 'p2', toolUseResult: {agentId: 'x1'}, timestamp: '2026-10-12T10:03:02.000Z', message: {content: [{type: 'tool_result', tool_use_id: 'c', content: 'done'}]}},
    {type: 'assistant', timestamp: '2026-10-12T10:03:03.000Z', message: {content: [{type: 'tool_use', id: 'd', name: 'mcp__github__issue_write', input: {}}]}},
  ];
  const dir = join(home, 'projects', '-repo');
  mkdirSync(join(dir, 's1', 'subagents'), {recursive: true});
  writeFileSync(join(dir, 's1.jsonl'), lines(entries));
  writeFileSync(join(dir, 's1', 'subagents', 'agent-x1.jsonl'), lines([
    {type: 'user', isSidechain: true, timestamp: '2026-10-12T10:01:03.000Z', message: {content: 'check'}},
    {type: 'assistant', isSidechain: true, timestamp: '2026-10-12T10:01:04.000Z', message: {content: [{type: 'tool_use', id: 's', name: 'Read', input: {file_path: '/p/oneezy/plugin.json'}}]}},
    {type: 'user', isSidechain: true, toolUseResult: {}, timestamp: '2026-10-12T10:01:04.500Z', message: {content: [{type: 'tool_result', tool_use_id: 's', content: '{}'}]}},
  ]));
  return {home, file: join(dir, 's1.jsonl')};
}

test('Claude Code: a turn per promptId, timed rows, subagent calls nested, loaded files and skill versions', () => {
  const {home, file} = claudeHome();
  const env = {CLAUDECODE: '1', CLAUDE_CONFIG_DIR: home, CLAUDE_CODE_SESSION_ID: 's1', CLAUDE_CODE_REMOTE: 'true',
    CLAUDE_CODE_REMOTE_SESSION_ID: 'cse_abc', CLAUDE_CODE_CONTAINER_ID: 'container_1', CLAUDE_EFFORT: 'high'};
  const t = trace({harness: 'claude', env});
  assert.equal(t.transcript, file);
  assert.equal(t.link, 'https://claude.ai/code/session_abc');
  assert.equal(t.location, 'cloud container container_1');
  assert.deepEqual(t.model, {verified: 'model-a', selected: 'model-a'});
  assert.deepEqual(t.instructions, ['/u/.claude/CLAUDE.md (user)']);
  assert.deepEqual(t.memory, ['/m/silo']);
  assert.deepEqual(t.skills.map(s => [s.name, s.plugin, s.version]), [['oneezy-skills', 'oneezy', '9.9.9']]);
  assert.equal(t.rows.length, 1);
  const [turn] = t.rows;
  assert.equal(turn.title, 'Handle prompt: sync my skills / now');
  assert.deepEqual(turn.children.map(row => [row.title, row.ok]), [
    ['Load skill oneezy:oneezy-skills', true], ['Sync the skills', false], ['Run subagent: Check the plugins', true], ['Call github issue write', null],
  ]);
  assert.deepEqual(turn.children[2].children.map(row => row.title), ['Read oneezy/plugin.json']);
  assert.equal(trace({harness: 'claude', env, scope: 'chat'}).rows.length, 2);

  const out = render(t, {tz: 'UTC'});
  const [header, table] = out.split(ANSWER);
  assert.match(header, /^\*\*Debug\*\* · Claude Code 2\.0\.0 · terminal · cloud container container_1/);
  assert.match(header, /Model: model-a \[verified\] · model-a \[selected\] · provider Anthropic/);
  assert.match(header, /Reasoning effort: high \[selected\] · unknown \[verified\]/);
  assert.match(header, /Skills: oneezy-skills \(oneezy 9\.9\.9\)/);
  assert.match(header, /Times: UTC/);
  assert.match(table, /\| Status \| Title \| Start \| Duration \|/);
  assert.match(table, /\n\| ⚠️ \| Handle prompt: sync my skills \/ now \| 10:01:00 a\.m\. \| ongoing \|/);
  assert.match(table, new RegExp(`\\| ${EM}✅ \\| ${EM}Load skill oneezy:oneezy-skills \\| 10:01:01 a\\.m\\. \\| 250 ms \\|`));
  assert.match(table, new RegExp(`\\| ${EM}❌ \\| ${EM}Sync the skills \\| 10:01:02 a\\.m\\. \\| 3\\.5 sec \\|`));
  assert.match(table, new RegExp(`\\| ${EM}✅ \\| ${EM}Run subagent: Check the plugins \\| 10:01:02 a\\.m\\. \\| 2 min 0 sec \\|`));
  assert.match(table, new RegExp(`\\| ${EM}${EM}✅ \\| ${EM}${EM}Read oneezy/plugin\\.json \\| 10:01:04 a\\.m\\. \\| 500 ms \\|`));
  assert.match(table, new RegExp(`\\| ${EM}ℹ️ \\| ${EM}Call github issue write \\| 10:03:03 a\\.m\\. \\| ongoing \\|`));
  assert.match(table, /✅ success · ❌ failure · ⚠️ warning · ℹ️ information/);
});

const codex = [
  {timestamp: '2026-10-12T10:00:00.000Z', type: 'session_meta', payload: {id: 't1', cli_version: '0.9.0', originator: 'codex_cli_rs', model_provider: 'openai', cwd: '/repo', base_instructions: {text: '...'}}},
  {timestamp: '2026-10-12T10:00:00.010Z', type: 'turn_context', payload: {model: 'codex-test', effort: 'high'}},
  {timestamp: '2026-10-12T10:00:00.020Z', type: 'response_item', payload: {type: 'message', role: 'user', content: [{type: 'input_text', text: '# AGENTS.md instructions for /repo\n...'}]}},
  {timestamp: '2026-10-12T10:00:01.000Z', type: 'event_msg', payload: {type: 'user_message', message: '$oneezy-debug check'}},
  {timestamp: '2026-10-12T10:00:02.000Z', type: 'response_item', payload: {type: 'function_call', name: 'shell', call_id: 'c1',
    arguments: JSON.stringify({command: ['cat', '/home/u/.codex/skills/oneezy-debug/SKILL.md']})}},
  {timestamp: '2026-10-12T10:00:02.400Z', type: 'response_item', payload: {type: 'function_call_output', call_id: 'c1',
    output: JSON.stringify({output: '...', metadata: {exit_code: 0}})}},
  {timestamp: '2026-10-12T10:00:03.000Z', type: 'response_item', payload: {type: 'custom_tool_call', name: 'apply_patch', call_id: 'c2',
    input: '*** Begin Patch\n*** Update File: docs/a.md\n'}},
  {timestamp: '2026-10-12T10:01:13.000Z', type: 'response_item', payload: {type: 'custom_tool_call_output', call_id: 'c2', output: 'Exit code: 1\nfailed'}},
];

test('Codex: rollout turns, exit codes, selected model and effort, AGENTS.md and SKILL.md loads', () => {
  const t = parseCodex(codex);
  assert.deepEqual(t.model, {verified: null, selected: 'codex-test'});
  assert.equal(t.effort, 'high');
  assert.equal(t.provider, 'openai');
  assert.deepEqual(t.instructions, ['/repo/AGENTS.md']);
  assert.deepEqual(t.skills.map(s => s.name), ['oneezy-debug']);
  assert.equal(t.systemPrompt, 'embedded in the rollout file (session_meta)');
  assert.deepEqual(t.turns[0].children.map(row => [row.title, row.ok]), [
    ['Run cat /home/u/.codex/skills/oneezy-debug/SKILL.md', true], ['Edit docs/a.md', false],
  ]);
  const out = render({available: true, harness: 'Codex', link: 'codex resume t1', location: 'computer pc', transcript: 'r.jsonl',
    surface: 'Codex CLI', trail: null, ...t, rows: t.turns}, {tz: 'UTC'});
  assert.match(out, /Model: unknown \[verified\] · codex-test \[selected\] · provider openai/);
  assert.match(out, /\n\| ⚠️ \| Handle prompt: \$oneezy-debug check \| 10:00:01 a\.m\. \| 1 min 12 sec \|/);
});

test('formatting: plain titles, time-only starts, named zones, spans', () => {
  assert.equal(title('Ship it 🚀 | now <b>x</b>'), 'Ship it / now x');
  assert.equal(clock('2026-10-12T20:30:05.000Z', 'America/Chicago'), '3:30:05 p.m.');
  assert.equal(clock(null, 'UTC'), '—');
  assert.match(zone('America/Chicago', new Date('2026-10-12T12:00:00Z')), /^America\/Chicago, CDT \(UTC−05:00\)$/);
  assert.deepEqual([span(250), span(3500), span(125000), span(3720000)], ['250 ms', '3.5 sec', '2 min 5 sec', '1 h 2 min']);
});

test('detect, locate and the fallback read only the environment and the transcript folders', () => {
  assert.equal(detect({CLAUDECODE: '1'}), 'claude');
  assert.equal(detect({CODEX_THREAD_ID: 't1'}), 'codex');
  assert.equal(detect({}), null);
  assert.equal(locate('claude', {CLAUDE_CODE_SESSION_ID: 's1', CLAUDE_CONFIG_DIR: '/nowhere'}).link, 'claude --resume s1');
  assert.equal(locate('codex', {CODEX_THREAD_ID: 't1', CODEX_HOME: '/nowhere'}).link, 'codex resume t1');
  assert.deepEqual(provenance('x', null), {name: 'x', plugin: null, version: null, path: null});
  assert.equal(trace({harness: null, env: {}}).available, false);
  assert.match(render({available: false}), /Transcript not available/);
});
