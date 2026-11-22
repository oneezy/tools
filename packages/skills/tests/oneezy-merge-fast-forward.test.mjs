// /oneezy-merge release, step 5: after a promotion merge lands on main, fast-forward dev to that merge commit,
// guarded. Every test runs the script as the skill does, against a temporary clone of a temporary bare remote.
import assert from 'node:assert/strict';
import {execFileSync, spawnSync} from 'node:child_process';
import {chmodSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';

const SCRIPT = fileURLToPath(new URL('../skills/oneezy/oneezy-merge/scripts/fast-forward-dev.mjs', import.meta.url));
const IDENTITY = ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false'];

const git = (cwd, ...args) => execFileSync('git', [...IDENTITY, ...args], {cwd, encoding: 'utf8'}).trim();
const commit = (cwd, file, text) => {
  writeFileSync(join(cwd, file), text);
  git(cwd, 'add', file);
  git(cwd, 'commit', '-q', '-m', `edit ${file}`);
  return git(cwd, 'rev-parse', 'HEAD');
};

// A remote whose dev holds one commit main lacks, then promoted: main gets a merge commit of dev, as step 5 makes it.
function promoted() {
  const dir = mkdtempSync(join(tmpdir(), 'oneezy-merge-ff-'));
  const remote = join(dir, 'remote.git');
  const work = join(dir, 'work');
  git(dir, 'init', '-q', '--bare', '-b', 'main', remote);
  git(dir, 'clone', '-q', remote, work);
  git(work, 'checkout', '-q', '-b', 'main');
  commit(work, 'a.txt', 'one\n');
  git(work, 'push', '-q', 'origin', 'main');
  git(work, 'checkout', '-q', '-b', 'dev');
  const dev = commit(work, 'b.txt', 'two\n');
  git(work, 'push', '-q', '-u', 'origin', 'dev');
  git(work, 'checkout', '-q', 'main');
  git(work, 'merge', '-q', '--no-ff', '-m', 'release: promote dev to main', dev);
  const merge = git(work, 'rev-parse', 'HEAD');
  git(work, 'push', '-q', 'origin', 'main');
  return {dir, remote, work, dev, merge};
}

const remoteRef = (fixture, branch) => git(fixture.remote, 'rev-parse', `refs/heads/${branch}`);

function run(fixture, {promoted = fixture.dev, merge = fixture.merge, checks = 'green'} = {}) {
  const result = spawnSync(process.execPath, [SCRIPT, '--json', '--promoted', promoted, '--merge', merge, '--checks', checks],
    {cwd: fixture.work, encoding: 'utf8'});
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('dev is fast-forwarded to the verified promotion commit when dev is unchanged, the trees match and checks are green', () => {
  const fixture = promoted();
  try {
    const report = run(fixture);
    assert.equal(report.outcome, 'fast-forwarded');
    assert.equal(remoteRef(fixture, 'dev'), fixture.merge);
    assert.equal(remoteRef(fixture, 'main'), fixture.merge);
    assert.equal(report.dev, fixture.merge);
    assert.equal(report.local, 'fast-forwarded');
    assert.equal(git(fixture.work, 'rev-parse', 'refs/heads/dev'), fixture.merge);
  } finally { rmSync(fixture.dir, {recursive: true, force: true}); }
});

test('dev that advanced after the promotion is left where it is, and the report says why', () => {
  const fixture = promoted();
  try {
    git(fixture.work, 'checkout', '-q', 'dev');
    const newer = commit(fixture.work, 'c.txt', 'newer work\n');
    git(fixture.work, 'push', '-q', 'origin', 'dev');
    const report = run(fixture);
    assert.equal(report.outcome, 'skipped');
    assert.match(report.reason, /dev advanced/);
    assert.equal(remoteRef(fixture, 'dev'), newer);
  } finally { rmSync(fixture.dir, {recursive: true, force: true}); }
});

test('red or unfinished checks on main leave dev at the promoted commit', () => {
  const fixture = promoted();
  try {
    for (const checks of ['red', 'pending']) {
      const report = run(fixture, {checks});
      assert.equal(report.outcome, 'skipped');
      assert.match(report.reason, new RegExp(`checks on main are ${checks}`));
      assert.equal(remoteRef(fixture, 'dev'), fixture.dev);
    }
  } finally { rmSync(fixture.dir, {recursive: true, force: true}); }
});

test('dev goes to the verified promotion commit, not to a newer origin/main', () => {
  const fixture = promoted();
  try {
    const later = commit(fixture.work, 'd.txt', 'later on main\n');
    git(fixture.work, 'push', '-q', 'origin', 'main');
    const report = run(fixture);
    assert.equal(report.outcome, 'fast-forwarded');
    assert.equal(remoteRef(fixture, 'dev'), fixture.merge);
    assert.notEqual(remoteRef(fixture, 'dev'), later);
  } finally { rmSync(fixture.dir, {recursive: true, force: true}); }
});

test('a merge that origin/main does not contain, or whose tree differs from dev, leaves dev alone', () => {
  const fixture = promoted();
  try {
    git(fixture.work, 'checkout', '-q', '-b', 'local', fixture.dev);
    const unpushed = commit(fixture.work, 'e.txt', 'never pushed\n');
    const missing = run(fixture, {merge: unpushed});
    assert.equal(missing.outcome, 'skipped');
    assert.match(missing.reason, /origin\/main does not contain/);

    git(fixture.work, 'checkout', '-q', 'main');
    commit(fixture.work, 'f.txt', 'only on main\n');
    git(fixture.work, 'merge', '-q', '--no-ff', '-m', 'release: promote dev to main', fixture.dev);
    const drifted = git(fixture.work, 'rev-parse', 'HEAD');
    git(fixture.work, 'push', '-q', 'origin', 'main');
    const report = run(fixture, {merge: drifted});
    assert.equal(report.outcome, 'skipped');
    assert.match(report.reason, /trees differ/);
    assert.equal(remoteRef(fixture, 'dev'), fixture.dev);
  } finally { rmSync(fixture.dir, {recursive: true, force: true}); }
});

test('a remote that refuses the push (a protected dev) is a reported skip, in one plain line', () => {
  const fixture = promoted();
  try {
    const hook = join(fixture.remote, 'hooks', 'pre-receive');
    writeFileSync(hook, '#!/bin/sh\necho "dev is protected" >&2\nexit 1\n');
    chmodSync(hook, 0o755);
    const result = spawnSync(process.execPath, [SCRIPT, '--promoted', fixture.dev, '--merge', fixture.merge, '--checks', 'green'],
      {cwd: fixture.work, encoding: 'utf8'});
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^dev not fast-forwarded: push refused/);
    assert.equal(remoteRef(fixture, 'dev'), fixture.dev);
  } finally { rmSync(fixture.dir, {recursive: true, force: true}); }
});

test('a git failure is one line and exit 1, with dev untouched', () => {
  const fixture = promoted();
  try {
    git(fixture.work, 'remote', 'set-url', 'origin', join(fixture.dir, 'missing.git'));
    const result = spawnSync(process.execPath, [SCRIPT, '--promoted', fixture.dev, '--merge', fixture.merge, '--checks', 'green'],
      {cwd: fixture.work, encoding: 'utf8'});
    assert.equal(result.status, 1);
    assert.match(result.stderr, /^dev not fast-forwarded: git failed: /);
    assert.equal(result.stderr.trim().split('\n').length, 1);
    assert.equal(remoteRef(fixture, 'dev'), fixture.dev);
  } finally { rmSync(fixture.dir, {recursive: true, force: true}); }
});
