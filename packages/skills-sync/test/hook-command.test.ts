// hook, the command the session-start entry runs: the quiet sync, then the checkout duties on real local git
// repositories (a bare origin per repository under the pretend machine, the clones beside each other, their GitHub
// origin URL rewritten to the bare repository by url.insteadOf), then the drift line from the fake GitHub. The built
// CLI runs on the pretend machine from inside a checkout; the tests assert what a user sees: stdout, stderr, exit codes,
// and the checkouts' heads and trees afterwards.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, test } from "vite-plus/test";
import { sha, startFakeGithub, type FakeGithub } from "./fixtures/fake-github/fake-github.mjs";
import {
  advanceOrigin,
  checkoutOf,
  cli,
  destroy,
  git,
  hooksFile,
  pretendMachine,
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

function machine(options: Parameters<typeof pretendMachine>[0] = {}): PretendMachine {
  const m = pretendMachine({ github: gh, git: true, ...options });
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
  gh.fixture.repos = {
    ...gh.fixture.repos,
    "oneezy/skills": {
      branches: {
        ...quiet,
        "feat/b": { sha: sha("2"), ahead: 1 },
        "feat/a": { sha: sha("1"), ahead: 2 },
        // every commit in dev: not ahead
        "feat/done": { sha: sha("d") },
      },
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
  // GitHub was asked about the branches of both repositories, compared only the ones that are not main or dev
  const paths = r.requests.map((q) => q.path);
  assert.ok(paths.some((p) => p.startsWith("/repos/oneezy/skills/branches")));
  assert.ok(paths.some((p) => p.startsWith("/repos/oneezy/tools/branches")));
  assert.ok(!paths.some((p) => /compare\/dev\.\.\.(main|dev)(\?|$)/.test(p)), paths.join("\n"));
  assert.ok(paths.some((p) => p.includes("/pulls?state=open&base=dev")));
  // the next session start: the machine is current, the checkout is current, only the drift is left to say
  const again = await cli(m, ["hook"], {}, skills);
  assert.equal(again.status, 0, again.stderr);
  assert.equal(again.stderr, "");
  assert.deepEqual(lines(again.stdout), [
    "oneezy/skills: 2 branches ahead of dev (feat/a, feat/b), 2 open pull requests (#12, #15)",
  ]);
});

test("a dirty checkout and one on another branch are named on stderr and left alone, even when origin moved; a checkout found beside the current one counts too", async () => {
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
  assert.ok(fs.readFileSync(path.join(skills, "README.md"), "utf8").endsWith("local edit\n"));
  assert.ok(fs.existsSync(path.join(tools, "notes.txt")));
  // clean but on another branch: named without a file count
  fs.rmSync(path.join(tools, "notes.txt"));
  const again = await cli(m, ["hook"], {}, tools);
  assert.ok(lines(again.stderr).includes(`${tools}: on feat/x; left alone`), again.stderr);
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
});

test("GitHub unreachable: the sync's red line goes to stderr, the drift is skipped, the checkout is still fast-forwarded, exit 0; a drift that GitHub refuses is one stderr line", async () => {
  const offline = machine({ github: null });
  const skills = checkoutOf(offline, "oneezy/skills");
  const settle = await cli(offline, []);
  assert.equal(settle.status, 1, settle.stderr);
  const moved = advanceOrigin(offline, "oneezy/skills");
  const r = await cli(offline, ["hook"], {}, skills);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(lines(r.stdout), [`${skills}: dev fast-forwarded to ${moved.slice(0, 7)}`]);
  const err = lines(r.stderr);
  assert.equal(err.length, 1, r.stderr);
  assert.ok(err[0].startsWith("! conflict") && err[0].includes("latest release not read"), err[0]);
  // the release is served but the repository's branches are not (not in the fixture): the drift line is a stderr line
  const m = machine();
  const checkout = checkoutOf(m, "oneezy/skills");
  await cli(m, []);
  const d = await cli(m, ["hook"], {}, checkout);
  assert.equal(d.status, 0, d.stderr);
  assert.equal(d.stdout, "");
  assert.deepEqual(lines(d.stderr), ["oneezy/skills: branches and pull requests not read: 404 Not Found"]);
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
