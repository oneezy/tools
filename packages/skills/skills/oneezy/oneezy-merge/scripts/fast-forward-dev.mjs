#!/usr/bin/env node
// /oneezy-merge release, step 5: after a promotion, fast-forward origin/dev to the verified promotion merge commit.
// Run from a checkout of the promoted repo:
//
//   node fast-forward-dev.mjs --promoted <dev sha> --merge <merge sha> --checks green|red|pending [--json]
//
// --promoted is the dev commit the release PR promoted, --merge the merge commit it made on main, --checks the
// verdict on main's new head (step 3's rule). dev moves only when every guard holds: origin/main contains the merge,
// the merge carries the promoted commit with the same tree, the checks are green and origin/dev is still the promoted
// commit. The push is a plain fast-forward push: no force, no reset, so newer work on dev is never overwritten.
// Prints one line (or JSON) with outcome `fast-forwarded` or `skipped` and the reason; exit 0 either way, 2 on bad
// use, 1 with one line when git itself fails (a fetch refused, no dev on origin).
import {execFileSync, spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const git = (cwd, ...args) => execFileSync('git', args, {cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}).trim();
const holds = (cwd, ...args) => spawnSync('git', args, {cwd, stdio: 'ignore'}).status === 0;
const commitOf = (cwd, ref) => {
  try { return git(cwd, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`); } catch { return null; }
};
const firstLine = error => String(error.stderr || error.message).trim().split('\n')[0];

export function fastForwardDev({cwd = process.cwd(), promoted, merge, checks}) {
  git(cwd, 'fetch', '--quiet', 'origin', 'main', 'dev');
  const dev = git(cwd, 'rev-parse', 'refs/remotes/origin/dev');
  const skip = reason => ({outcome: 'skipped', reason, dev});
  const want = {promoted: commitOf(cwd, promoted), merge: commitOf(cwd, merge)};
  if (!want.promoted) return skip(`unknown promoted commit ${promoted}`);
  if (!want.merge) return skip(`unknown promotion commit ${merge}`);
  if (dev === want.merge) return {outcome: 'fast-forwarded', reason: 'dev was already at the promotion commit', dev, local: 'unchanged'};
  if (!holds(cwd, 'merge-base', '--is-ancestor', want.merge, 'refs/remotes/origin/main'))
    return skip(`origin/main does not contain the promotion commit ${want.merge}`);
  if (!holds(cwd, 'merge-base', '--is-ancestor', want.promoted, want.merge))
    return skip(`the promotion commit ${want.merge} does not carry the promoted dev ${want.promoted}`);
  if (git(cwd, 'rev-parse', `${want.promoted}^{tree}`) !== git(cwd, 'rev-parse', `${want.merge}^{tree}`))
    return skip(`trees differ between the promoted dev ${want.promoted} and the promotion commit ${want.merge}`);
  if (checks !== 'green') return skip(`checks on main are ${checks ?? 'unknown'}`);
  if (dev !== want.promoted) return skip(`dev advanced to ${dev} after the promotion of ${want.promoted}`);

  try { git(cwd, 'push', '--quiet', 'origin', `${want.merge}:refs/heads/dev`); }
  catch (error) { return skip(`push refused: ${firstLine(error)}`); }
  git(cwd, 'fetch', '--quiet', 'origin', 'dev');
  const after = git(cwd, 'rev-parse', 'refs/remotes/origin/dev');
  if (after !== want.merge) return {outcome: 'skipped', reason: `origin/dev is ${after} after the push`, dev: after};
  return {outcome: 'fast-forwarded', dev: after, local: syncLocalDev(cwd, want.merge)};
}

// The local dev ref follows when it can move forward without touching anyone's work: in the checkout that has dev,
// a fast-forward-only merge; elsewhere a fetch into dev, which git refuses for a non-fast-forward or a checked-out dev.
function syncLocalDev(cwd, merge) {
  if (!commitOf(cwd, 'refs/heads/dev')) return 'none';
  let branch = '';
  try { branch = git(cwd, 'symbolic-ref', '--quiet', '--short', 'HEAD'); } catch { /* detached */ }
  try {
    if (branch === 'dev') git(cwd, 'merge', '--quiet', '--ff-only', merge);
    else git(cwd, 'fetch', '--quiet', 'origin', 'dev:dev');
    return 'fast-forwarded';
  } catch (error) { return `left: ${firstLine(error)}`; }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const flag = name => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
  const args = {promoted: flag('--promoted'), merge: flag('--merge'), checks: flag('--checks')};
  if (!args.promoted || !args.merge || !args.checks) {
    console.error('usage: fast-forward-dev.mjs --promoted <dev sha> --merge <merge sha> --checks green|red|pending [--json]');
    process.exit(2);
  }
  let report;
  try { report = fastForwardDev(args); }
  catch (error) {
    console.error(`dev not fast-forwarded: git failed: ${firstLine(error)}`);
    process.exit(1);
  }
  console.log(argv.includes('--json') ? JSON.stringify(report)
    : report.outcome === 'fast-forwarded' ? `dev fast-forwarded to ${report.dev}${report.reason ? ` (${report.reason})` : ''}`
    : `dev not fast-forwarded: ${report.reason}`);
}
