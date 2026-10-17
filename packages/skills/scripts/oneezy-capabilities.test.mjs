import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { bundle, root } from './oneezy-capabilities.mjs';
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');
const catalog = JSON.parse(read('docs/agents/capabilities/catalog.json'));

test('every authored Oneezy skill packages the current contract and host adapters; no unresolved or user-only automatic dependency', () => {
  const authored = fs.readdirSync(path.join(root, 'skills/oneezy')).filter(name => fs.existsSync(path.join(root, 'skills/oneezy', name, 'SKILL.md'))).sort();
  assert.deepEqual(Object.keys(catalog.skills).sort(), authored);
  assert.deepEqual(bundle(), []);
  for (const name of authored) {
    const entry = read(`skills/oneezy/${name}/SKILL.md`);
    assert.match(entry, /references\/capabilities\/contract.md/);
    const flow = read(`skills/oneezy/${name}/flow.yaml`);
    assert.match(flow, /references\/capabilities\/contract.md/);
  }
});

test('generator detects stale packaged routing and preserves unrelated and upstream files', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'oneezy-capabilities-'));
  try {
    fs.cpSync(path.join(root, 'docs/agents/capabilities'), path.join(repo, 'docs/agents/capabilities'), { recursive:true });
    for (const entry of Object.values(catalog.skills)) {
      fs.mkdirSync(path.join(repo, entry.path), {recursive:true});
      fs.writeFileSync(path.join(repo, entry.path, 'SKILL.md'), 'authored instructions');
    }
    fs.mkdirSync(path.join(repo, 'upstream/matt-pocock'), {recursive:true});
    const pinned = path.join(repo, 'upstream/matt-pocock/SKILL.md');
    fs.writeFileSync(pinned, 'pinned, unchanged');
    assert.ok(bundle(repo).length > 0);
    assert.deepEqual(bundle(repo, true), []);
    assert.deepEqual(bundle(repo), []);
    assert.equal(fs.readFileSync(pinned,'utf8'), 'pinned, unchanged');
    const target=path.join(repo,'skills/oneezy/oneezy-brain/references/capabilities/contract.md');
    fs.writeFileSync(target, 'stale GitHub capture');
    assert.ok(bundle(repo).some(error => error.includes('oneezy-brain/contract.md')));
    const file=path.join(repo,'docs/agents/capabilities/catalog.json');
    const changed=JSON.parse(fs.readFileSync(file,'utf8'));
    changed.skills['oneezy-skills'].dependencies.push({id:'oneezy-merge',need:'required',when:'automatic chain'});
    fs.writeFileSync(file, JSON.stringify(changed));
    assert.ok(bundle(repo).some(error => error.includes('user-only dependency')));
  } finally { fs.rmSync(repo,{recursive:true,force:true}); }
});

test('oneezy-agents reads only its own references/AGENTS-GLOBAL.md, the one hand-edited rules file (ADR-0018, ADR-0019)', () => {
  const skill = read('skills/oneezy/oneezy-agents/SKILL.md');
  assert.match(skill, /references\/AGENTS-GLOBAL\.md/);
  assert.doesNotMatch(skill, /raw\.githubusercontent|curl|web fetch/);
  assert.doesNotMatch(read('skills/oneezy/oneezy-agents/flow.yaml'), /https?:\/\//);
  assert.doesNotMatch(skill, /disable-model-invocation/);
  assert.match(read('skills/oneezy/oneezy-agents/references/AGENTS-GLOBAL.md'), /^# How Justin works/);
  for (const old of ['skills/oneezy/agents.md', 'skills/oneezy/oneezy-agents/references/agents.md']) assert.equal(fs.existsSync(path.join(root, old)), false, 'the rules live only in skills/oneezy/oneezy-agents/references/AGENTS-GLOBAL.md');
});

test('moved rules, templates and invocation boundaries retain reviewed behavior', () => {
  const hashes=JSON.parse(read('docs/research/2026-10-07-oneezy-rule-preservation.json'));
  const correction=JSON.parse(read('docs/research/2026-10-08-brain-capture-correction.json')).hashes;
  assert.deepEqual(Object.keys(correction), ['oneezy-brain/references/routing.md']);
  for (const [name, expected] of Object.entries(hashes)) assert.equal(createHash('sha256').update(read(`skills/oneezy/${name}`)).digest('hex'),correction[name] ?? expected,name);
  for(const name of ['estimate','merge','remote']) {
    assert.match(read(`skills/oneezy/oneezy-${name}/SKILL.md`),/disable-model-invocation: true/);
    assert.match(read(`skills/oneezy/oneezy-${name}/agents/openai.yaml`),/allow_implicit_invocation: false/);
    assert.equal(catalog.skills[`oneezy-${name}`].invocation,'explicit-only');
  }
  for(const name of ['daily-standup','backlog-refinement','sprint-planning','sprint-review','sprint-retrospective','quarterly-review','yearly-review']) {
    assert.match(read('skills/oneezy/oneezy-meeting/references/selection.md'),new RegExp(name));
    assert.ok(fs.existsSync(path.join(root,`skills/oneezy/oneezy-meeting/references/${name}.md`)));
  }
  assert.match(read('skills/oneezy/oneezy-estimate/references/rules.md'),/Estimate is \*\*write-once\*\*/);
  assert.match(read('skills/oneezy/oneezy-estimate/references/rules.md'),/In Progress and later are frozen/);
});

test('Brain loads connector instructions before dependent reads; Meeting has no current GitHub fallback', () => {
  const brain = read('skills/oneezy/oneezy-brain/SKILL.md');
  assert.ok(brain.indexOf('Load the actual Google Drive instructions') < brain.indexOf('Resolve its private registry'));
  assert.match(brain,/load Google Sheets instructions and their required read-safety reference/);
  assert.match(brain,/load Google Docs instructions and the route-required references/);
  const flow=read('skills/oneezy/oneezy-brain/flow.yaml');
  for(const dep of ['google-drive','google-sheets','google-docs']) assert.match(flow,new RegExp(`id: google-drive:${dep}`));
  const meeting=read('skills/oneezy/oneezy-meeting/flow.yaml');
  assert.doesNotMatch(meeting,/read-only GitHub fallback/);
  assert.match(read('skills/oneezy/oneezy-meeting/references/source-routing.md'),/Google Drive/);
  assert.equal(catalog.deliveries.length,2);
  assert.match(catalog.deliveries[1].issue,/GitHub Brain fallback/);
});

test('management routing preserves destination and approval boundaries instead of claiming mentions/install links are uploads', () => {
  const contract=read('docs/agents/capabilities/contract.md');
  assert.match(contract,/Access denial, approval refusal and required human invocation stop that destination/);
  assert.match(contract,/Continue independent destinations/);
  const chat=read('docs/agents/capabilities/chatgpt.md');
  assert.match(chat,/expected_release_id/); assert.match(chat,/delete_paths/);
  assert.match(chat,/cloud terminal\/npx route.*unknown\/unsupported/);
  const claude=read('docs/agents/capabilities/claude.md');
  assert.match(claude,/`\/plugin`.*panel/); assert.match(claude,/`claude plugin`.*CLI/);
  const codex=read('docs/agents/capabilities/codex.md');
  assert.match(codex,/`\/plugins`.*browser/); assert.match(codex,/`codex plugin`.*CLI/);
  assert.match(codex,/no observed codex plugin update command/);
  const management=read('skills/oneezy/oneezy-skills/references/management.md');
  assert.match(management,/Make the actual structured tool call or shell command/);
  assert.match(management,/review\/no-publication request/);
});
