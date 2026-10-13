// hook, the command the session-start entry runs: the quiet sync, then the checkout duties on real local git
// repositories, whoever owns them (a bare origin per repository under the pretend machine, the clones beside each
// other, a GitHub origin URL rewritten to the bare repository by url.insteadOf, or a plain path), then the drift line:
// the branches ahead of dev from the bare origin's refs, the open pull requests from the fake GitHub. The built CLI
// runs on the pretend machine from inside a checkout; the tests assert what a user sees: stdout, stderr, exit codes,
// and the checkouts' heads and trees afterwards.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, test } from "vite-plus/test";
import { repoOf } from "../src/commands/hook.js";
import { sha, startFakeGithub, type FakeGithub } from "./fixtures/fake-github/fake-github.mjs";
import {
  advanceOrigin,
  bareOrigin,
  checkoutOf,
  cli,
  destroy,
  git,
  hooksFile,
  originBranch,
  pretendMachine,
  snapshot,
  write,
  type PretendMachine,
} from "./machine.js";

let gh: FakeGithub;
const machines: PretendMachine[] = [];

beforeAll(async () => {
  gh = await startFakeGithub();
});
afterAll(async () => {
  await gh.close();
});
afterEach(() => {
  for (const m of machines.splice(0)) destroy(m);
  gh.fixture.repos = {};
});

/**
 * A machine with git checkouts, the fake claude on PATH and no codex: with a codex on PATH the sync inside `hook` would
 * also install Codex's plugins from GitHub (test/codex-form.test.ts covers that form).
 */
function machine(options: Parameters<typeof pretendMachine>[0] = {}): PretendMachine {
  const m = pretendMachine({ github: gh, git: true, clis: ["claude"], ...options });
  machines.push(m);
  return m;
}

const lines = (text: string) => (text ? text.trimEnd().split("\n") : []);
const head = (m: PretendMachine, checkout: string) => git(m, checkout, ["rev-parse", "HEAD"]);
const quiet = { main: { sha: sha("a") }, dev: { sha: sha("d") } };

/** Both repositories on GitHub without drift, and a checkout of each beside the other. */
function checkouts(m: PretendMachine): { skills: string; tools: string } {
  gh.fixture.repos = { "oneezy/skills": { branches: { ...quiet } }, "oneezy/tools": { branches: { ...quiet } } };
  return { skills: checkoutOf(m, "oneezy/skills"), tools: checkoutOf(m, "oneezy/tools") };
}

test("the first run writes the blocks and the hook entries and says so; a clean dev checkout behind origin is fast-forwarded; the drift line names the branches ahead of dev and the open pull requests", async () => {
  const m = machine();
  const { skills, tools } = checkouts(m);
  // the branches live on origin: two with commits of their own, one at dev's head (not ahead)
  originBranch(m, "oneezy/skills", "feat/b", 1);
  originBranch(m, "oneezy/skills", "feat/a", 2);
  originBranch(m, "oneezy/skills", "feat/done", 0);
  // the pull requests come from GitHub
  gh.fixture.repos = {
    ...gh.fixture.repos,
    "oneezy/skills": {
      branches: { ...quiet },
      pulls: [
        { number: 15, head: "feat/b" },
        { number: 12, head: "feat/a" },
        // into main, and a merged one: not open into dev
        { number: 7, head: "feat/x", base: "main" },
        { number: 3, head: "feat/done", merged: true },
      ],
    },
  };
  const moved = advanceOrigin(m, "oneezy/skills");
  const toolsHead = head(m, tools);
  const r = await cli(m, ["hook"], {}, skills);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, "");
  const out = lines(r.stdout);
  // the sync's report, since it changed things: the four writes and the summary
  for (const file of ["CLAUDE.md", "settings.json", "AGENTS.md", "hooks.json"])
    assert.ok(
      out.some((l) => l.startsWith("+ write") && l.includes(file)),
      r.stdout,
    );
  assert.ok(out.includes("4 changed, 0 already right, 0 left alone"), r.stdout);
  assert.ok(out.includes(`${skills}: dev fast-forwarded to ${moved.slice(0, 7)}`), r.stdout);
  assert.equal(head(m, skills), moved);
  assert.equal(head(m, tools), toolsHead);
  assert.ok(
    out.includes("oneezy/skills: 2 branches ahead of dev (feat/a, feat/b), 2 open pull requests (#12, #15)"),
    r.stdout,
  );
  assert.ok(!out.some((l) => l.startsWith("oneezy/tools:")), r.stdout);
  // GitHub was asked one thing, the session repository's open pull requests into dev; the branches were counted
  // locally, and the repository beside it gets no drift line and costs no request
  const paths = r.requests.map((q) => q.path);
  for (const [repo, n] of [
    ["oneezy/skills", 1],
    ["oneezy/tools", 0],
  ] as const)
    assert.equal(
      paths.filter((p) => p.startsWith(`/repos/${repo}/pulls?state=open&base=dev`)).length,
      n,
      paths.join("\n"),
    );
  assert.ok(!paths.some((p) => p.includes("/branches") || p.includes("/compare/")), paths.join("\n"));
  // the next session start: the machine is current, the checkout is current, only the drift is left to say
  const again = await cli(m, ["hook"], {}, skills);
  assert.equal(again.status, 0, again.stderr);
  assert.equal(again.stderr, "");
  assert.deepEqual(lines(again.stdout), [
    "oneezy/skills: 2 branches ahead of dev (feat/a, feat/b), 2 open pull requests (#12, #15)",
  ]);
});

test("a dirty checkout and one on another branch are named on stderr and left alone, not even fetched, when origin moved; a checkout found beside the current one counts too", async () => {
  const m = machine();
  const { skills, tools } = checkouts(m);
  await cli(m, []);
  // the dirty one: a changed file
  fs.appendFileSync(path.join(skills, "README.md"), "local edit\n");
  advanceOrigin(m, "oneezy/skills");
  const skillsHead = head(m, skills);
  // the one on another branch, with an untracked file too
  git(m, tools, ["checkout", "--quiet", "-b", "feat/x"]);
  write(path.join(tools, "notes.txt"), "wip\n");
  advanceOrigin(m, "oneezy/tools");
  const toolsHead = head(m, tools);
  // run from inside tools: skills is a sibling
  const r = await cli(m, ["hook"], {}, tools);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "");
  assert.deepEqual(lines(r.stderr).sort(), [
    `${skills}: on dev, dirty (1 file); left alone`,
    `${tools}: on feat/x, dirty (1 file); left alone`,
  ]);
  assert.equal(head(m, skills), skillsHead);
  assert.equal(head(m, tools), toolsHead);
  // no fetch either: origin/dev in each is still where the clone left it
  assert.equal(git(m, skills, ["rev-parse", "origin/dev"]), skillsHead);
  assert.equal(git(m, tools, ["rev-parse", "origin/dev"]), git(m, tools, ["rev-parse", "dev"]));
  assert.ok(fs.readFileSync(path.join(skills, "README.md"), "utf8").endsWith("local edit\n"));
  assert.ok(fs.existsSync(path.join(tools, "notes.txt")));
  // clean but on another branch: named without a file count
  fs.rmSync(path.join(tools, "notes.txt"));
  const again = await cli(m, ["hook"], {}, tools);
  assert.ok(lines(again.stderr).includes(`${tools}: on feat/x; left alone`), again.stderr);
});

test("a checkout whose git status cannot be read is named on stderr and left alone, not fetched, never taken for clean", async () => {
  const m = machine();
  const { skills } = checkouts(m);
  await cli(m, []);
  advanceOrigin(m, "oneezy/skills");
  const skillsHead = head(m, skills);
  write(path.join(skills, ".git", "index"), "not an index");
  const r = await cli(m, ["hook"], {}, skills);
  assert.equal(r.status, 0, r.stderr);
  const err = lines(r.stderr).filter((l) => l.startsWith(`${skills}:`));
  assert.equal(err.length, 1, r.stderr);
  assert.match(err[0], /: git status not read \(exit 128\)/);
  assert.ok(err[0].endsWith("; left alone"), r.stderr);
  assert.equal(head(m, skills), skillsHead);
  assert.equal(git(m, skills, ["rev-parse", "origin/dev"]), skillsHead);
});

test("a drift line names eight branches and eight pull requests at most, the rest is a count", async () => {
  const m = machine();
  const { skills } = checkouts(m);
  for (let i = 1; i <= 9; i++) originBranch(m, "oneezy/skills", `feat/b${i}`, 1);
  gh.fixture.repos = {
    ...gh.fixture.repos,
    "oneezy/skills": {
      branches: { ...quiet },
      pulls: Array.from({ length: 10 }, (_, i) => ({ number: i + 1, head: `feat/b${(i % 9) + 1}` })),
    },
  };
  await cli(m, []);
  const r = await cli(m, ["hook"], {}, skills);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(lines(r.stdout), [
    "oneezy/skills: 9 branches ahead of dev (feat/b1, feat/b2, feat/b3, feat/b4, feat/b5, feat/b6, feat/b7, feat/b8 … and 1 more), " +
      "10 open pull requests (#1, #2, #3, #4, #5, #6, #7, #8 … and 2 more)",
  ]);
});

test("hook takes no flags: --plan is refused with exit 2 and nothing is written", async () => {
  const m = machine();
  const before = snapshot(m.home);
  for (const flags of [["--plan"], ["--json"], ["--quiet"], ["--agents", "codex"]]) {
    const r = await cli(m, ["hook", ...flags]);
    assert.equal(r.status, 2, flags.join(" "));
    assert.equal(r.stdout, "", flags.join(" "));
    assert.equal(r.stderr, "hook takes no flags but --library\n", flags.join(" "));
  }
  assert.deepEqual(snapshot(m.home), before);
});

test("a checkout is known by its origin URL in every form GitHub gives out, and by nothing else", () => {
  assert.equal(repoOf("https://github.com/oneezy/skills.git"), "oneezy/skills");
  assert.equal(repoOf("https://github.com/oneezy/skills"), "oneezy/skills");
  assert.equal(repoOf("git@github.com:oneezy/tools.git"), "oneezy/tools");
  assert.equal(repoOf("ssh://git@github.com/oneezy/tools.git"), "oneezy/tools");
  assert.equal(repoOf("ssh://git@github.com:22/oneezy/tools.git"), "oneezy/tools");
  assert.equal(repoOf("https://Oneezy@GitHub.com/Oneezy/Tools/"), "Oneezy/Tools");
  assert.equal(repoOf("https://gitlab.com/oneezy/skills.git"), null);
  assert.equal(repoOf("https://notgithub.com/oneezy/skills.git"), null);
  assert.equal(repoOf("https://github.community/oneezy/skills"), null);
  assert.equal(repoOf("/srv/git/oneezy/skills.git"), null);
});

test("nothing changed, nothing ahead, nothing open: hook prints nothing and exits 0; outside any repository there are no checkout duties and GitHub is not asked about branches", async () => {
  const m = machine();
  const { skills } = checkouts(m);
  await cli(m, []);
  const r = await cli(m, ["hook"], {}, skills);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "");
  assert.equal(r.stderr, "");
  const home = await cli(m, ["hook"]);
  assert.equal(home.status, 0, home.stderr);
  assert.equal(home.stdout, "");
  assert.equal(home.stderr, "");
  assert.ok(!home.requests.some((q) => q.path.includes("/branches") || q.path.includes("/pulls")));
  // the fetch brought every branch of origin, so the drift needs no request for them
  assert.ok(git(m, skills, ["for-each-ref", "refs/remotes/origin/"]).includes("refs/remotes/origin/main"));
});

test("GitHub unreachable: the sync's red line goes to stderr, the kept block's one line to stdout, the pull requests are not asked for, the branches ahead still count, the checkout is still fast-forwarded, exit 0; pull requests GitHub refuses are one stderr line", async () => {
  const offline = machine({ github: null });
  const skills = checkoutOf(offline, "oneezy/skills");
  const settle = await cli(offline, []);
  assert.equal(settle.status, 1, settle.stderr);
  const moved = advanceOrigin(offline, "oneezy/skills");
  originBranch(offline, "oneezy/skills", "feat/offline", 1);
  const r = await cli(offline, ["hook"], {}, skills);
  assert.equal(r.status, 0, r.stderr);
  // the blocks need no release: already current, nothing about them on stdout
  assert.deepEqual(lines(r.stdout), [
    `${skills}: dev fast-forwarded to ${moved.slice(0, 7)}`,
    "oneezy/skills: 1 branch ahead of dev (feat/offline)",
  ]);
  const err = lines(r.stderr);
  assert.equal(err.length, 1, r.stderr);
  assert.ok(err[0].startsWith("! conflict") && err[0].includes("latest release not read"), err[0]);
  // the release is served but the repository's pull requests are not (not in the fixture): with a token, one stderr
  // line; without one, a 404 is what a private repository answers anyone, so nothing is said
  const m = machine();
  const checkout = checkoutOf(m, "oneezy/skills");
  await cli(m, []);
  const d = await cli(m, ["hook"], { GITHUB_TOKEN: "t0ken" }, checkout);
  assert.equal(d.status, 0, d.stderr);
  assert.equal(d.stdout, "");
  assert.deepEqual(lines(d.stderr), ["oneezy/skills: open pull requests not read: 404 Not Found"]);
  const anonymous = await cli(m, ["hook"], {}, checkout);
  assert.equal(anonymous.status, 0, anonymous.stderr);
  assert.equal(anonymous.stdout, "");
  assert.equal(anonymous.stderr, "");
});

test("a conflict in the sync (a hooks file that is not JSON) is the one thing that exits 1, on stderr; the rest of the run still happens", async () => {
  const m = machine();
  const { skills } = checkouts(m);
  write(hooksFile(m, "claude-code"), "{ not json");
  const moved = advanceOrigin(m, "oneezy/skills");
  const r = await cli(m, ["hook"], {}, skills);
  assert.equal(r.status, 1, r.stderr);
  const err = lines(r.stderr);
  assert.equal(err.length, 1, r.stderr);
  assert.ok(err[0].startsWith("! conflict") && err[0].includes("settings.json"), err[0]);
  assert.ok(lines(r.stdout).includes(`${skills}: dev fast-forwarded to ${moved.slice(0, 7)}`), r.stdout);
  assert.equal(fs.readFileSync(hooksFile(m, "claude-code"), "utf8"), "{ not json");
});

// Every repository in reach, whoever owns it (tools#145): the session's repository and the git repositories beside it,
// or, outside any repository, the ones directly inside the folder the session starts in. One takes part in the dev flow
// when it has a dev branch (its own or origin's) and an origin; one that does not is never mentioned.

/** A git repository at `dir` with one commit on `branch` and no remote. Returns `dir`. */
function localRepo(m: PretendMachine, dir: string, branch: string): string {
  fs.mkdirSync(dir, { recursive: true });
  git(m, dir, ["init", "--quiet"]);
  git(m, dir, ["symbolic-ref", "HEAD", `refs/heads/${branch}`]);
  write(path.join(dir, "README.md"), `# ${path.basename(dir)}\n`);
  git(m, dir, ["add", "."]);
  git(m, dir, ["commit", "--quiet", "-m", "first"]);
  return dir;
}

/** A bare repository at <base>/elsewhere/<name>.git, origin of `dir`, holding `dir`'s `branch` as `as`. */
function plainOrigin(m: PretendMachine, dir: string, name: string, branch: string, as = branch): string {
  const bare = path.join(m.base, "elsewhere", `${name}.git`);
  fs.mkdirSync(bare, { recursive: true });
  git(m, bare, ["init", "--quiet", "--bare"]);
  git(m, dir, ["remote", "add", "origin", bare]);
  git(m, dir, ["push", "--quiet", "origin", `${branch}:${as}`]);
  git(m, dir, ["fetch", "--quiet", "origin"]);
  return bare;
}

/**
 * The folder of repositories most tests use, `<base>/dev`, with the session's repository `alpha` (someone/alpha on
 * GitHub) and beside it: beta (acme/beta on GitHub, clean on dev), fox (a clone whose origin is a path, not GitHub,
 * clean on dev), tools (oneezy/tools, dirty on dev), delta (acme/delta, clean on a feature branch), echo (main only,
 * here and on its origin, which then moves on), golf (dev with no origin), a linked worktree of alpha (its `.git` a
 * file) and a folder that is no repository.
 */
function devFolder(m: PretendMachine) {
  gh.fixture.repos = {
    "someone/alpha": { branches: { ...quiet } },
    "acme/beta": { branches: { ...quiet } },
    "acme/delta": { branches: { ...quiet } },
    "oneezy/tools": { branches: { ...quiet } },
  };
  const dev = path.join(m.base, "dev");
  const alpha = checkoutOf(m, "someone/alpha");
  const beta = checkoutOf(m, "acme/beta");
  const fox = path.join(dev, "fox");
  git(m, m.base, ["clone", "--quiet", bareOrigin(m, "lab/fox"), fox]);
  const tools = checkoutOf(m, "oneezy/tools");
  fs.appendFileSync(path.join(tools, "README.md"), "local edit\n");
  const delta = checkoutOf(m, "acme/delta");
  git(m, delta, ["checkout", "--quiet", "-b", "feat/x"]);
  const echo = localRepo(m, path.join(dev, "echo"), "main");
  const echoOrigin = plainOrigin(m, echo, "echo", "main");
  const echoWork = path.join(m.base, "scratch-echo");
  git(m, m.base, ["clone", "--quiet", "--branch", "main", echoOrigin, echoWork]);
  write(path.join(echoWork, "CHANGES.md"), "moved\n");
  git(m, echoWork, ["add", "."]);
  git(m, echoWork, ["commit", "--quiet", "-m", "moved"]);
  git(m, echoWork, ["push", "--quiet", "origin", "main"]);
  const golf = localRepo(m, path.join(dev, "golf"), "dev");
  const worktree = path.join(dev, "alpha-feature");
  git(m, alpha, ["worktree", "add", "--quiet", "-b", "feat/wt", worktree]);
  write(path.join(dev, "notes", "todo.md"), "nothing\n");
  return { dev, alpha, beta, fox, tools, delta, echo, golf, worktree };
}

test("from inside a repository, it and every git repository beside it are tended, whoever owns them: a clean dev behind origin is fast-forwarded, a dirty one or one on another branch is named and left alone, one with no dev or no origin is never mentioned, a linked worktree beside it is no repository of its own", async () => {
  const m = machine();
  const d = devFolder(m);
  await cli(m, []);
  const movedAlpha = advanceOrigin(m, "someone/alpha");
  const movedBeta = advanceOrigin(m, "acme/beta");
  const movedFox = advanceOrigin(m, "lab/fox");
  advanceOrigin(m, "oneezy/tools");
  advanceOrigin(m, "acme/delta");
  const untouched = ["tools", "delta", "echo", "golf", "worktree"] as const;
  const before = untouched.map((k) => head(m, d[k]));
  const echoTracking = git(m, d.echo, ["rev-parse", "origin/main"]);
  const r = await cli(m, ["hook"], {}, d.alpha);
  assert.equal(r.status, 0, r.stderr);
  // the session's repository first, then the ones beside it by name
  assert.deepEqual(lines(r.stdout), [
    `${d.alpha}: dev fast-forwarded to ${movedAlpha.slice(0, 7)}`,
    `${d.beta}: dev fast-forwarded to ${movedBeta.slice(0, 7)}`,
    `${d.fox}: dev fast-forwarded to ${movedFox.slice(0, 7)}`,
  ]);
  assert.deepEqual(lines(r.stderr), [
    `${d.delta}: on feat/x; left alone`,
    `${d.tools}: on dev, dirty (1 file); left alone`,
  ]);
  assert.equal(head(m, d.alpha), movedAlpha);
  assert.equal(head(m, d.beta), movedBeta);
  assert.equal(head(m, d.fox), movedFox);
  assert.deepEqual(
    untouched.map((k) => head(m, d[k])),
    before,
  );
  // nothing switched, nothing created, nothing thrown away
  assert.equal(git(m, d.delta, ["rev-parse", "--abbrev-ref", "HEAD"]), "feat/x");
  assert.equal(git(m, d.worktree, ["rev-parse", "--abbrev-ref", "HEAD"]), "feat/wt");
  assert.equal(git(m, d.echo, ["branch", "--list", "dev"]), "");
  assert.ok(fs.readFileSync(path.join(d.tools, "README.md"), "utf8").endsWith("local edit\n"));
  // echo has no dev: not even fetched
  assert.equal(git(m, d.echo, ["rev-parse", "origin/main"]), echoTracking);
  // GitHub was asked for the open pull requests of the session's repository only
  const pulls = r.requests.map((q) => q.path).filter((p) => p.includes("/pulls"));
  assert.deepEqual(
    pulls.map((p) => p.split("/pulls")[0]),
    ["/repos/someone/alpha"],
  );
  // the next session start: nothing moved, so only the two left alone are named again
  const again = await cli(m, ["hook"], {}, d.alpha);
  assert.equal(again.status, 0, again.stderr);
  assert.equal(again.stdout, "");
  assert.deepEqual(lines(again.stderr), lines(r.stderr));
});

test("a session in a linked worktree tends the repository's main checkout and the repositories beside that, never the worktree", async () => {
  const m = machine();
  gh.fixture.repos = { "someone/alpha": { branches: { ...quiet } }, "acme/beta": { branches: { ...quiet } } };
  const alpha = checkoutOf(m, "someone/alpha");
  const beta = checkoutOf(m, "acme/beta");
  // the task's worktree lives inside the main checkout, which ignores it as a real repository does
  fs.appendFileSync(path.join(alpha, ".git", "info", "exclude"), ".claude/\n");
  const task = path.join(alpha, ".claude", "worktrees", "task");
  git(m, alpha, ["worktree", "add", "--quiet", "-b", "feat/task", task]);
  await cli(m, []);
  const movedAlpha = advanceOrigin(m, "someone/alpha");
  const movedBeta = advanceOrigin(m, "acme/beta");
  const taskHead = head(m, task);
  const r = await cli(m, ["hook"], {}, task);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, "");
  assert.deepEqual(lines(r.stdout), [
    `${alpha}: dev fast-forwarded to ${movedAlpha.slice(0, 7)}`,
    `${beta}: dev fast-forwarded to ${movedBeta.slice(0, 7)}`,
  ]);
  assert.equal(head(m, alpha), movedAlpha);
  assert.equal(head(m, task), taskHead);
  assert.equal(git(m, task, ["rev-parse", "--abbrev-ref", "HEAD"]), "feat/task");
});

test("outside any repository, the git repositories directly inside the session's folder are tended, nothing deeper", async () => {
  const m = machine();
  const d = devFolder(m);
  // a repository two levels down is not looked at
  const deep = checkoutOf(m, "acme/deep", path.join(d.dev, "notes", "deep"));
  gh.fixture.repos = { ...gh.fixture.repos, "acme/deep": { branches: { ...quiet } } };
  await cli(m, []);
  const movedAlpha = advanceOrigin(m, "someone/alpha");
  const movedBeta = advanceOrigin(m, "acme/beta");
  const deepHead = head(m, deep);
  advanceOrigin(m, "acme/deep");
  const r = await cli(m, ["hook"], {}, d.dev);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(lines(r.stdout), [
    `${d.alpha}: dev fast-forwarded to ${movedAlpha.slice(0, 7)}`,
    `${d.beta}: dev fast-forwarded to ${movedBeta.slice(0, 7)}`,
  ]);
  assert.deepEqual(lines(r.stderr), [
    `${d.delta}: on feat/x; left alone`,
    `${d.tools}: on dev, dirty (1 file); left alone`,
  ]);
  assert.equal(head(m, deep), deepHead);
});

test("a repository on dev whose origin has no dev is named and left alone; a fetch that hangs is cut off at the fetch timeout and named, and the others are still fast-forwarded", async () => {
  const m = machine();
  gh.fixture.repos = { "acme/beta": { branches: { ...quiet } } };
  const dev = path.join(m.base, "dev");
  const beta = checkoutOf(m, "acme/beta");
  // hotel: dev here, main only on its origin
  const hotel = localRepo(m, path.join(dev, "hotel"), "dev");
  plainOrigin(m, hotel, "hotel", "dev", "main");
  // india: an origin over ssh that never answers
  const india = localRepo(m, path.join(dev, "india"), "dev");
  git(m, india, ["remote", "add", "origin", "ssh://git@example.invalid/acme/india.git"]);
  git(m, india, ["config", "core.sshCommand", "sleep 30;"]);
  await cli(m, []);
  const movedBeta = advanceOrigin(m, "acme/beta");
  const started = Date.now();
  const r = await cli(m, ["hook"], { SKILLS_SYNC_FETCH_TIMEOUT_MS: "1000" }, beta);
  assert.ok(Date.now() - started < 15_000, "the hung fetch held the hook up");
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(lines(r.stdout), [`${beta}: dev fast-forwarded to ${movedBeta.slice(0, 7)}`]);
  const err = lines(r.stderr);
  assert.equal(err.length, 2, r.stderr);
  assert.equal(err[0], `${hotel}: origin has no dev; left alone`);
  assert.ok(err[1].startsWith(`${india}: fetch of origin failed (timed out after 1 s)`), err[1]);
  assert.equal(head(m, hotel), git(m, hotel, ["rev-parse", "origin/main"]));
  // nothing the cut-off fetch started still holds the repository: it can be deleted at once, no retries
  fs.rmSync(india, { recursive: true, force: true });
  assert.ok(!fs.existsSync(india));
});

test("the drift line and the pull request request are the session's repository's only: a repository beside it with branches ahead and open pull requests, and a private one GitHub answers 404, say nothing but their fast-forward", async () => {
  const m = machine();
  const alpha = checkoutOf(m, "someone/alpha");
  const beta = checkoutOf(m, "acme/beta");
  const secret = checkoutOf(m, "acme/secret");
  originBranch(m, "someone/alpha", "feat/a", 1);
  originBranch(m, "acme/beta", "feat/b1", 1);
  originBranch(m, "acme/beta", "feat/b2", 2);
  originBranch(m, "acme/secret", "feat/s", 1);
  // acme/secret is not in the fixture: GitHub answers 404, as it does a private repository to anyone without access
  gh.fixture.repos = {
    "someone/alpha": { branches: { ...quiet }, pulls: [{ number: 4, head: "feat/a" }] },
    "acme/beta": {
      branches: { ...quiet },
      pulls: [
        { number: 1, head: "feat/b1" },
        { number: 2, head: "feat/b2" },
      ],
    },
  };
  await cli(m, []);
  const movedBeta = advanceOrigin(m, "acme/beta");
  const r = await cli(m, ["hook"], {}, alpha);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, "");
  assert.deepEqual(lines(r.stdout), [
    `${beta}: dev fast-forwarded to ${movedBeta.slice(0, 7)}`,
    "someone/alpha: 1 branch ahead of dev (feat/a), 1 open pull request (#4)",
  ]);
  const pulls = r.requests.map((q) => q.path).filter((p) => p.includes("/pulls"));
  assert.deepEqual(
    pulls.map((p) => p.split("/pulls")[0]),
    ["/repos/someone/alpha"],
  );
  // the private one was still fetched: its branches are there, just not reported
  assert.ok(git(m, secret, ["for-each-ref", "refs/remotes/origin/"]).includes("refs/remotes/origin/feat/s"));
});

test("a dev that cannot fast-forward is named and left as it was, nothing reset; a repository on main with a dev branch is named and main is not touched", async () => {
  const m = machine();
  gh.fixture.repos = { "acme/beta": { branches: { ...quiet } }, "acme/delta": { branches: { ...quiet } } };
  const beta = checkoutOf(m, "acme/beta");
  const delta = checkoutOf(m, "acme/delta");
  await cli(m, []);
  // beta: a commit of its own on dev, and origin's dev moved on: they diverged
  write(path.join(beta, "LOCAL.md"), "mine\n");
  git(m, beta, ["add", "."]);
  git(m, beta, ["commit", "--quiet", "-m", "local"]);
  const betaHead = head(m, beta);
  const movedBeta = advanceOrigin(m, "acme/beta");
  // delta: on main, with dev beside it
  git(m, delta, ["checkout", "--quiet", "main"]);
  const deltaMain = head(m, delta);
  const deltaDev = git(m, delta, ["rev-parse", "refs/heads/dev"]);
  advanceOrigin(m, "acme/delta");
  const r = await cli(m, ["hook"], {}, beta);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "");
  const err = lines(r.stderr);
  assert.equal(err.length, 2, r.stderr);
  assert.match(
    err[0],
    new RegExp(`^${escape(beta)}: dev does not fast-forward to origin/dev \\(exit \\d+\\).*; left alone$`),
  );
  assert.equal(err[1], `${delta}: on main; left alone`);
  assert.equal(head(m, beta), betaHead);
  assert.equal(git(m, beta, ["rev-parse", "origin/dev"]), movedBeta);
  assert.equal(git(m, beta, ["status", "--porcelain"]), "");
  assert.equal(git(m, beta, ["rev-parse", "--abbrev-ref", "HEAD"]), "dev");
  assert.equal(head(m, delta), deltaMain);
  assert.equal(git(m, delta, ["rev-parse", "refs/heads/dev"]), deltaDev);
  assert.equal(git(m, delta, ["rev-parse", "--abbrev-ref", "HEAD"]), "main");
});

test("more repositories than are tended at once: every one is fast-forwarded, the lines in a fixed order (the session's first, then by name)", async () => {
  const m = machine();
  const dev = path.join(m.base, "dev");
  const names = ["mike", "alpha", "kilo", "bravo", "juliet", "charlie", "lima", "delta", "echo"];
  const dirs = names.map((n) => {
    const dir = path.join(dev, n);
    git(m, m.base, ["clone", "--quiet", bareOrigin(m, `lab/${n}`), dir]);
    return dir;
  });
  await cli(m, []);
  const moved = new Map(names.map((n) => [n, advanceOrigin(m, `lab/${n}`)]));
  const r = await cli(m, ["hook"], {}, dirs[0]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, "");
  const order = ["mike", ...names.filter((n) => n !== "mike").sort()];
  assert.deepEqual(
    lines(r.stdout),
    order.map((n) => `${path.join(dev, n)}: dev fast-forwarded to ${(moved.get(n) ?? "").slice(0, 7)}`),
  );
  for (const n of names) assert.equal(head(m, path.join(dev, n)), moved.get(n), n);
});

test("past the hook's deadline no fetch starts and no drift is read: one stderr line counts the repositories not fetched, and they are left as they were", async () => {
  const m = machine();
  gh.fixture.repos = { "acme/beta": { branches: { ...quiet } }, "acme/delta": { branches: { ...quiet } } };
  const beta = checkoutOf(m, "acme/beta");
  const delta = checkoutOf(m, "acme/delta");
  const tools = checkoutOf(m, "oneezy/tools");
  fs.appendFileSync(path.join(tools, "README.md"), "local edit\n");
  originBranch(m, "acme/beta", "feat/b", 1);
  await cli(m, []);
  const betaHead = head(m, beta);
  const deltaHead = head(m, delta);
  advanceOrigin(m, "acme/beta");
  advanceOrigin(m, "acme/delta");
  const r = await cli(m, ["hook"], { SKILLS_SYNC_HOOK_DEADLINE_MS: "1" }, beta);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "");
  // the dirty one needs no fetch to be named, so it still is
  assert.deepEqual(lines(r.stderr), [
    `${tools}: on dev, dirty (1 file); left alone`,
    "2 repositories not fetched: out of time (0.001 s since the hook started)",
  ]);
  assert.equal(head(m, beta), betaHead);
  assert.equal(head(m, delta), deltaHead);
  assert.equal(git(m, beta, ["rev-parse", "origin/dev"]), betaHead);
  assert.ok(!r.requests.some((q) => q.path.includes("/pulls")));
});

/** `text` with every regular-expression character escaped. */
function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
