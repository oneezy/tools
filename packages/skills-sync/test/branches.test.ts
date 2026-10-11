// branches: the branch rules of ADR-0013 against the fake GitHub. One repository carries a branch per rule (main, dev,
// a -keep branch that is merged, merged, every commit in dev with no pull request, closed without merging, closed and
// merged, open, the base of an open one, no pull request, moved on after its merge, merged into main); the tests run
// the built CLI on the pretend machine and assert only what a user sees: --json, the text, exit codes, the requests
// the fake GitHub recorded and the state it has afterwards. No request ever names main, dev or a -keep branch as its
// target, in any mode.
import assert from "node:assert/strict";
import { afterAll, afterEach, beforeAll, test } from "vite-plus/test";
import {
  sha,
  startFakeGithub,
  type FakeGithub,
  type FixtureRepo,
  type RecordedRequest,
} from "./fixtures/fake-github/fake-github.mjs";
import { cli, destroy, pretendMachine, type PretendMachine } from "./machine.js";

interface RepoJson {
  repo: string;
  kept: string[];
  deleted: Array<{ branch: string; reason: string }>;
  archived: Array<{ branch: string; tag: string; commit: string; reused: boolean }>;
  left: Array<{ branch: string; why: string }>;
  skipped: string | null;
  problems: string[];
  lines: Array<{ mark: string; text: string }>;
}
interface BranchesJson {
  plan: boolean;
  repos: RepoJson[];
  ok: boolean;
}

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
  delete gh.fixture.pageSize;
});

/** The command needs no harness: a bare pretend machine with the fake GitHub. */
function machine(): PretendMachine {
  const m = pretendMachine({ harnesses: [], clis: [], github: gh });
  machines.push(m);
  return m;
}

const core = { main: { sha: sha("a") }, dev: { sha: sha("d") } };

/** One branch per rule. `ahead` is what compare dev...<branch> answers; a merged pull request is checked before it. */
function toolsRepo(): FixtureRepo {
  return {
    branches: {
      ...core,
      // merged, and all its commits are in dev: kept by its name alone
      "spike-keep": { sha: sha("e"), ahead: 0 },
      // its pull request was squash-merged into dev: deleted although compare says it is ahead
      "feat/merged": { sha: sha("1") },
      // no pull request, every commit is in dev
      "feat/all-in-dev": { sha: sha("2"), ahead: 0 },
      // its pull request was closed without merging: tagged, then deleted
      "feat/closed": { sha: sha("3"), ahead: 2 },
      // one pull request closed without merging, another merged into dev: deleted, no tag
      "feat/both": { sha: sha("4") },
      // an open pull request: left alone, deleting it would close the pull request
      "feat/open": { sha: sha("5") },
      // no pull request, commits dev lacks
      "feat/none": { sha: sha("6"), ahead: 3 },
      // merged into dev at an earlier head, then more commits: left alone
      "feat/moved": { sha: sha("7"), ahead: 2 },
      // merged into main, not dev
      "fix/to-main": { sha: sha("8"), ahead: 1 },
      // merged into dev at an earlier head, then more commits that a later pull request merged into main
      "feat/moved-twice": { sha: sha("b"), ahead: 3 },
      // merged into dev at its head, but an open pull request has it as base: left alone, the stack stays whole
      "feat/stack-base": { sha: sha("f") },
      "feat/stack-top": { sha: sha("g"), ahead: 3 },
    },
    pulls: [
      { number: 1, head: "spike-keep", merged: true },
      { number: 2, head: "feat/merged", merged: true },
      { number: 3, head: "feat/closed", state: "closed" },
      { number: 4, head: "feat/both", state: "closed" },
      { number: 5, head: "feat/both", merged: true },
      { number: 6, head: "feat/open" },
      { number: 7, head: "feat/moved", merged: true, sha: sha("9") },
      { number: 8, head: "fix/to-main", base: "main", merged: true },
      { number: 9, head: "feat/moved-twice", merged: true, sha: sha("c") },
      { number: 10, head: "feat/moved-twice", base: "main", merged: true },
      { number: 11, head: "feat/stack-top", base: "feat/stack-base" },
      { number: 12, head: "feat/stack-base", merged: true },
    ],
    tags: {},
  };
}

/** The core branches and the -keep branch are never a request's target: not deleted, not compared as head, not asked about. */
function neverCore(requests: RecordedRequest[], names = ["main", "dev"]): void {
  const alt = names.join("|");
  for (const r of requests) {
    const p = decodeURIComponent(r.path);
    assert.doesNotMatch(p, new RegExp(`/heads/(${alt})(/|\\?|$)`), p);
    assert.doesNotMatch(p, new RegExp(`[?&]head=[^:&]+:(${alt})(&|$)`), p);
    assert.doesNotMatch(p, new RegExp(`[?&]base=(${alt})(&|$)`), p);
    assert.doesNotMatch(p, new RegExp(`/compare/[^?]*\\.\\.\\.(${alt})(\\?|$)`), p);
    assert.doesNotMatch(p, new RegExp(`/tags/archive/(${alt})(/|\\?|$)`), p);
    assert.ok(!p.includes("spike-keep"), p);
    const ref = (r.body as { ref?: unknown } | null)?.ref;
    if (typeof ref === "string") assert.doesNotMatch(ref, new RegExp(`/(${alt}|spike-keep)$`), ref);
  }
}

const writes = (requests: RecordedRequest[]) =>
  requests.filter((x) => x.method !== "GET").map((x) => `${x.method} ${decodeURIComponent(x.path)}`);

const expectedDeleted = [
  { branch: "feat/all-in-dev", reason: "all commits are in dev" },
  { branch: "feat/both", reason: "pull request #5 merged into dev" },
  { branch: "feat/closed", reason: "pull request #3 closed without merging" },
  { branch: "feat/merged", reason: "pull request #2 merged into dev" },
];
const expectedArchived = [{ branch: "feat/closed", tag: "archive/feat/closed", commit: sha("3"), reused: false }];
const expectedLeft = [
  { branch: "feat/moved", why: "pull request #7 merged into dev, then 2 commits more" },
  {
    branch: "feat/moved-twice",
    why: "pull request #9 merged into dev, then 3 commits more; pull request #10 merged into main",
  },
  { branch: "feat/none", why: "no pull request, 3 commits not in dev" },
  { branch: "feat/open", why: "open pull request #6" },
  { branch: "feat/stack-base", why: "base of open pull request #11" },
  { branch: "feat/stack-top", why: "open pull request #11" },
  { branch: "fix/to-main", why: "pull request #8 merged into main, 1 commit not in dev" },
];

test("every rule holds: main, dev and the merged -keep branch are kept; merged and all-in-dev branches are deleted; the closed one is tagged then deleted; the closed-and-merged one is deleted with no tag; the rest, the base of an open pull request among them, are listed", async () => {
  const m = machine();
  gh.fixture.repos = { "oneezy/tools": toolsRepo() };
  const r = await cli(m, ["branches", "oneezy/tools", "--json"]);
  assert.equal(r.status, 0, r.stderr);
  const j = r.json as unknown as BranchesJson;
  assert.equal(j.plan, false);
  assert.equal(j.ok, true);
  assert.equal(j.repos.length, 1);
  const t = j.repos[0];
  assert.equal(t.repo, "oneezy/tools");
  assert.deepEqual(t.kept, ["dev", "main", "spike-keep"]);
  assert.deepEqual(t.deleted, expectedDeleted);
  assert.deepEqual(t.archived, expectedArchived);
  assert.deepEqual(t.left, expectedLeft);
  assert.equal(t.skipped, null);
  assert.deepEqual(t.problems, []);
  // what GitHub has afterwards
  const repo = gh.fixture.repos["oneezy/tools"];
  assert.deepEqual(Object.keys(repo.branches).sort(), [
    "dev",
    "feat/moved",
    "feat/moved-twice",
    "feat/none",
    "feat/open",
    "feat/stack-base",
    "feat/stack-top",
    "fix/to-main",
    "main",
    "spike-keep",
  ]);
  assert.deepEqual(repo.tags, { "archive/feat/closed": sha("3") });
  // the writes, in branch order, the tag made before its branch goes
  assert.deepEqual(writes(r.requests), [
    "DELETE /repos/oneezy/tools/git/refs/heads/feat/all-in-dev",
    "DELETE /repos/oneezy/tools/git/refs/heads/feat/both",
    "POST /repos/oneezy/tools/git/refs",
    "DELETE /repos/oneezy/tools/git/refs/heads/feat/closed",
    "DELETE /repos/oneezy/tools/git/refs/heads/feat/merged",
  ]);
  assert.deepEqual(r.requests.find((x) => x.method === "POST")?.body, {
    ref: "refs/tags/archive/feat/closed",
    sha: sha("3"),
  });
  const paths = r.requests.map((x) => decodeURIComponent(x.path));
  // every branch's head is read again right before its first write
  for (const d of expectedDeleted) assert.ok(paths.includes(`/repos/oneezy/tools/git/ref/heads/${d.branch}`), d.branch);
  // the merged pull request decides before any compare; the base of a stacked pull request is asked about
  assert.ok(!paths.some((p) => p.includes("compare/dev...feat/merged")));
  assert.ok(paths.includes("/repos/oneezy/tools/pulls?state=open&base=feat/stack-base&per_page=100"));
  // the pull requests themselves are only read
  assert.ok(!r.requests.some((x) => x.method !== "GET" && x.path.includes("/pulls")));
  neverCore(r.requests);
});

test("--plan lists every tag and delete without a single write request, and --json carries the same lists as the real run", async () => {
  const m = machine();
  gh.fixture.repos = { "oneezy/tools": toolsRepo() };
  const before = JSON.stringify(gh.fixture.repos);
  const text = await cli(m, ["branches", "oneezy/tools", "--plan"]);
  assert.equal(text.status, 0, text.stderr);
  assert.equal(
    text.stdout,
    [
      "oneezy/tools",
      "- feat/all-in-dev  delete: all commits are in dev",
      "- feat/both  delete: pull request #5 merged into dev",
      `- feat/closed  tag archive/feat/closed at ${sha("3").slice(0, 7)}, delete: pull request #3 closed without merging`,
      "- feat/merged  delete: pull request #2 merged into dev",
      ". feat/moved  left: pull request #7 merged into dev, then 2 commits more",
      ". feat/moved-twice  left: pull request #9 merged into dev, then 3 commits more; pull request #10 merged into main",
      ". feat/none  left: no pull request, 3 commits not in dev",
      ". feat/open  left: open pull request #6",
      ". feat/stack-base  left: base of open pull request #11",
      ". feat/stack-top  left: open pull request #11",
      ". fix/to-main  left: pull request #8 merged into main, 1 commit not in dev",
      "= kept: dev, main, spike-keep",
      "plan: 4 to delete, 1 to tag, 7 left alone, 3 kept",
      "",
    ].join("\n"),
  );
  const r = await cli(m, ["branches", "oneezy/tools", "--plan", "--json"]);
  assert.equal(r.status, 0, r.stderr);
  const j = r.json as unknown as BranchesJson;
  assert.equal(j.plan, true);
  assert.deepEqual(j.repos[0].kept, ["dev", "main", "spike-keep"]);
  assert.deepEqual(j.repos[0].deleted, expectedDeleted);
  assert.deepEqual(j.repos[0].archived, expectedArchived);
  assert.deepEqual(j.repos[0].left, expectedLeft);
  assert.ok([...text.requests, ...r.requests].every((x) => x.method === "GET"));
  // planning re-reads no head: it writes nothing
  assert.ok(!r.requests.some((x) => x.path.includes("/git/ref/heads/")));
  assert.equal(JSON.stringify(gh.fixture.repos), before, "the plan changed GitHub");
  neverCore([...text.requests, ...r.requests]);
});

test("an archive tag already at the branch head is reused; one at another commit stops that branch with a problem line and no delete, exit 1", async () => {
  const m = machine();
  gh.fixture.repos = {
    "oneezy/tools": {
      branches: {
        ...core,
        "feat/closed": { sha: sha("3"), ahead: 2 },
        "feat/stale": { sha: sha("4"), ahead: 1 },
      },
      pulls: [
        { number: 3, head: "feat/closed", state: "closed" },
        { number: 4, head: "feat/stale", state: "closed" },
      ],
      tags: { "archive/feat/closed": sha("3"), "archive/feat/stale": sha("f") },
    },
  };
  const plan = await cli(m, ["branches", "oneezy/tools", "--plan", "--json"]);
  assert.equal(plan.status, 1);
  assert.equal((plan.json as unknown as BranchesJson).ok, false);
  assert.ok(plan.requests.every((x) => x.method === "GET"));

  const r = await cli(m, ["branches", "oneezy/tools"]);
  assert.equal(r.status, 1);
  const why = `archive/feat/stale exists at ${sha("f").slice(0, 7)}, the branch is at ${sha("4").slice(0, 7)}`;
  assert.equal(
    r.stdout,
    [
      "oneezy/tools",
      `- feat/closed  archive/feat/closed already at ${sha("3").slice(0, 7)}, deleted: pull request #3 closed without merging`,
      `! feat/stale  ${why}; left alone`,
      "= kept: dev, main",
      "branches: 1 deleted, 1 tagged, 1 left alone, 2 kept, 1 problem",
      "",
    ].join("\n"),
  );
  const j = await cli(m, ["branches", "oneezy/tools", "--json"]);
  const t = (j.json as unknown as BranchesJson).repos[0];
  assert.deepEqual(t.deleted, []);
  assert.deepEqual(t.left, [{ branch: "feat/stale", why }]);
  assert.deepEqual(t.problems, [`feat/stale: ${why}; left alone`]);
  // the real run made no tag (both existed) and one delete
  assert.deepEqual(writes(r.requests), ["DELETE /repos/oneezy/tools/git/refs/heads/feat/closed"]);
  const repo = gh.fixture.repos["oneezy/tools"];
  assert.deepEqual(Object.keys(repo.branches).sort(), ["dev", "feat/stale", "main"]);
  assert.deepEqual(repo.tags, { "archive/feat/closed": sha("3"), "archive/feat/stale": sha("f") });
  neverCore([...plan.requests, ...r.requests, ...j.requests]);
});

test("a repository the token cannot read or write is reported and skipped (a refused tag leaves its branch), and the others still run; --quiet prints only changes and problems", async () => {
  const m = machine();
  gh.fixture.repos = {
    "oneezy/locked": {
      writable: false,
      branches: { ...core, "feat/x": { sha: sha("1"), ahead: 1 } },
      pulls: [{ number: 1, head: "feat/x", state: "closed" }],
    },
    "oneezy/tools": { branches: { ...core, "feat/y": { sha: sha("2"), ahead: 0 } } },
  };
  const r = await cli(m, ["branches", "oneezy/nothere", "oneezy/locked", "oneezy/tools", "--quiet"]);
  assert.equal(r.status, 1);
  assert.equal(
    r.stdout,
    [
      "oneezy/nothere",
      "! skipped: cannot read repository: 404 Not Found",
      "oneezy/locked",
      "! skipped: cannot write: 403 Resource not accessible by personal access token",
      "oneezy/tools",
      "- feat/y  deleted: all commits are in dev",
      "branches: 1 deleted, 0 tagged, 2 problems",
      "",
    ].join("\n"),
  );
  // the refused tag was the only write tried on the locked repository: no delete followed it, nothing is recorded
  assert.deepEqual(
    writes(r.requests).filter((w) => w.includes("oneezy/locked")),
    ["POST /repos/oneezy/locked/git/refs"],
  );
  assert.ok("feat/x" in gh.fixture.repos["oneezy/locked"].branches, "the unwritable repository lost a branch");
  assert.deepEqual(gh.fixture.repos["oneezy/locked"].tags, {});
  assert.ok(!("feat/y" in gh.fixture.repos["oneezy/tools"].branches));

  gh.fixture.repos["oneezy/tools"].branches["feat/y"] = { sha: sha("2"), ahead: 0 };
  const j = await cli(m, ["branches", "oneezy/nothere", "oneezy/locked", "oneezy/tools", "--json"]);
  assert.equal(j.status, 1);
  const out = j.json as unknown as BranchesJson;
  assert.equal(out.ok, false);
  assert.deepEqual(
    out.repos.map((x) => [x.repo, x.skipped, x.problems, x.deleted.length, x.archived.length]),
    [
      ["oneezy/nothere", "cannot read repository: 404 Not Found", ["cannot read repository: 404 Not Found"], 0, 0],
      [
        "oneezy/locked",
        "cannot write: 403 Resource not accessible by personal access token",
        ["cannot write: 403 Resource not accessible by personal access token"],
        0,
        0,
      ],
      ["oneezy/tools", null, [], 1, 0],
    ],
  );
  assert.deepEqual(out.repos[1].kept, ["dev", "main"]);
  neverCore([...r.requests, ...j.requests]);
});

test("a branch pushed to between the listing and its delete is left alone: the head is read again before the first write", async () => {
  const m = machine();
  gh.fixture.repos = {
    "oneezy/tools": {
      branches: {
        ...core,
        "feat/racing": { sha: sha("1"), ahead: 0, movedTo: sha("2") },
        "feat/racing-closed": { sha: sha("3"), ahead: 1, movedTo: sha("4") },
        "feat/still": { sha: sha("5"), ahead: 0 },
      },
      pulls: [{ number: 1, head: "feat/racing-closed", state: "closed" }],
    },
  };
  const r = await cli(m, ["branches", "oneezy/tools", "--json"]);
  assert.equal(r.status, 0, r.stderr);
  const t = (r.json as unknown as BranchesJson).repos[0];
  assert.deepEqual(t.deleted, [{ branch: "feat/still", reason: "all commits are in dev" }]);
  assert.deepEqual(t.archived, []);
  assert.deepEqual(t.left, [
    { branch: "feat/racing", why: "moved during the run" },
    { branch: "feat/racing-closed", why: "moved during the run" },
  ]);
  assert.deepEqual(writes(r.requests), ["DELETE /repos/oneezy/tools/git/refs/heads/feat/still"]);
  assert.deepEqual(gh.fixture.repos["oneezy/tools"].tags, {});
  assert.deepEqual(Object.keys(gh.fixture.repos["oneezy/tools"].branches).sort(), [
    "dev",
    "feat/racing",
    "feat/racing-closed",
    "main",
  ]);
  neverCore(r.requests);
});

test("the repository's default branch is kept like main, whatever its name, and never named by a request", async () => {
  const m = machine();
  gh.fixture.repos = {
    "oneezy/old": {
      defaultBranch: "master",
      branches: { dev: core.dev, master: { sha: sha("a"), ahead: 0 }, "feat/x": { sha: sha("1"), ahead: 0 } },
      pulls: [{ number: 1, head: "master", merged: true }],
    },
  };
  const r = await cli(m, ["branches", "oneezy/old"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(
    r.stdout,
    [
      "oneezy/old",
      "- feat/x  deleted: all commits are in dev",
      "= kept: dev, master",
      "branches: 1 deleted, 0 tagged, 0 left alone, 2 kept",
      "",
    ].join("\n"),
  );
  assert.deepEqual(Object.keys(gh.fixture.repos["oneezy/old"].branches).sort(), ["dev", "master"]);
  neverCore(r.requests, ["main", "dev", "master"]);
});

test("with no repository named, the token's own repositories are done (archived ones left out, one without dev skipped as a note), every page read; without a token, exit 2", async () => {
  const m = machine();
  gh.fixture.repos = {
    "oneezy/a": { branches: { ...core, "feat/a": { sha: sha("1"), ahead: 0 } } },
    "oneezy/b": { archived: true, branches: { ...core, "feat/b": { sha: sha("2"), ahead: 0 } } },
    "oneezy/c": { branches: { main: core.main, "feat/c": { sha: sha("3") } } },
  };
  gh.fixture.pageSize = 1;
  const none = await cli(m, ["branches", "--plan"]);
  assert.equal(none.status, 2);
  assert.match(
    none.stderr,
    /a token is needed to list your repositories: set GITHUB_TOKEN or GH_TOKEN, or name owner\/repo/,
  );
  assert.equal(none.stdout, "");
  assert.equal(none.requests.length, 0);

  const r = await cli(m, ["branches", "--plan", "--json"], { GH_TOKEN: "t0k" });
  assert.equal(r.status, 0, r.stderr);
  const j = r.json as unknown as BranchesJson;
  assert.equal(j.ok, true);
  assert.deepEqual(
    j.repos.map((x) => [x.repo, x.skipped, x.deleted.map((d) => d.branch)]),
    [
      ["oneezy/a", null, ["feat/a"]],
      ["oneezy/c", "no dev branch", []],
    ],
  );
  assert.deepEqual(j.repos[1].problems, []);
  // the list of repositories and the list of branches were read page by page, with the token
  const paths = r.requests.map((x) => x.path);
  assert.deepEqual(
    paths.filter((p) => p.startsWith("/user/repos")),
    [
      "/user/repos?affiliation=owner&per_page=100",
      "/user/repos?affiliation=owner&per_page=100&page=2",
      "/user/repos?affiliation=owner&per_page=100&page=3",
    ],
  );
  assert.ok(paths.includes("/repos/oneezy/a/branches?per_page=100&page=3"), paths.join("\n"));
  assert.ok(r.requests.every((x) => x.headers.authorization === "Bearer t0k"));
  assert.ok(r.requests.every((x) => x.method === "GET"));
  neverCore(r.requests);

  const text = await cli(m, ["branches"], { GH_TOKEN: "t0k" });
  assert.equal(text.status, 0, text.stderr);
  assert.equal(
    text.stdout,
    [
      "oneezy/a",
      "- feat/a  deleted: all commits are in dev",
      "= kept: dev, main",
      "oneezy/c",
      ". skipped: no dev branch",
      "branches: 1 deleted, 0 tagged, 0 left alone, 2 kept",
      "",
    ].join("\n"),
  );
});

test("a protected branch and one with an open pull request are left alone; --quiet then prints nothing at all; a name that is not owner/repo is exit 2 before any request", async () => {
  const m = machine();
  gh.fixture.repos = {
    "oneezy/tools": {
      branches: { ...core, release: { sha: sha("1"), protected: true, ahead: 0 }, "feat/open": { sha: sha("2") } },
      pulls: [{ number: 1, head: "feat/open" }],
    },
  };
  const quiet = await cli(m, ["branches", "oneezy/tools", "--quiet"]);
  assert.equal(quiet.status, 0, quiet.stderr);
  assert.equal(quiet.stdout, "");
  const r = await cli(m, ["branches", "oneezy/tools"]);
  assert.equal(
    r.stdout,
    [
      "oneezy/tools",
      ". feat/open  left: open pull request #1",
      ". release  left: protected on GitHub",
      "= kept: dev, main",
      "branches: 0 deleted, 0 tagged, 2 left alone, 2 kept",
      "",
    ].join("\n"),
  );
  assert.ok([...quiet.requests, ...r.requests].every((x) => x.method === "GET"));
  neverCore([...quiet.requests, ...r.requests]);

  const bad = await cli(m, ["branches", "oneezy/tools", "nope"]);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /name each repository as owner\/repo, not nope/);
  assert.equal(bad.requests.length, 0);
});
