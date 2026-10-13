// ChatGPT as a destination (tools#196). ChatGPT's plugins live on Justin's account, and only Plugin Creator inside a
// ChatGPT chat changes them; a Codex signed in with ChatGPT lists them as remote marketplaces (created-by-me-remote,
// workspace-*), versions included. So status reads the ChatGPT copies through Codex: green per plugin at the release, a
// note and one manual step with the line to type in ChatGPT when any is behind or missing, a note when this machine
// cannot tell. The account copies are the ChatGPT destination, never a stray duplicate: no step says to uninstall them,
// and the skills Codex then lists twice are a note, not red. The CLI runs as a process on the pretend machine against
// the fake GitHub; the tests assert what a user sees.
import assert from "node:assert/strict";
import { afterAll, afterEach, beforeAll, test } from "vite-plus/test";
import { startFakeGithub, type FakeGithub, type FixtureRelease } from "./fixtures/fake-github/fake-github.mjs";
import {
  checkoutOf,
  cli,
  codexLogin,
  codexTrust,
  destroy,
  githubClone,
  installedPlugin,
  pretendMachine,
  syncedPlugin,
  type PretendMachine,
} from "./machine.js";

interface Line {
  ok: boolean;
  mark: string;
  text: string;
}
interface ChatgptJson {
  checked: boolean;
  reason?: string;
  plugins: Array<{
    id: string;
    marketplace: string | null;
    version: string | null;
    latest: string | null;
    current: boolean;
  }>;
  current: boolean;
  lines: Line[];
}
interface StatusJson {
  harnesses: Record<string, { lines: Line[]; duplicates: Array<{ skill: string; in: string[] }> }>;
  chatgpt: ChatgptJson | null;
  manualSteps: Array<{ id: string; title: string; steps: string[] }>;
  red: number;
  ok: boolean;
}

const LINE = "@oneezy-skills update my ChatGPT plugins to the latest oneezy/skills release";
const BOOTSTRAP =
  "@Plugin Creator update (or create, if I have none) my personal oneezy plugin to the oneezy archive in the latest github.com/oneezy/skills release (its release.json lists the files and sha256s): use update_plugin with expected_release_id, delete only files the release dropped with paths relative to the plugin root, delete nothing if under half the paths match, then read it back and report";

let gh: FakeGithub;
let r17: FixtureRelease;
const machines: PretendMachine[] = [];

beforeAll(async () => {
  gh = await startFakeGithub();
  r17 = gh.fixture.releases.find((r) => r.number === 17)!;
});
afterAll(async () => {
  await gh.close();
});
afterEach(() => {
  for (const m of machines.splice(0)) destroy(m);
});

const lines = (text: string) => (text ? text.trimEnd().split("\n") : []);
const json = (r: { json: Record<string, unknown> | null }) => r.json as unknown as StatusJson;
/** The lines of one section of the text report: from its header up to the next header (a line without a mark). */
const section = (text: string, header: string) => {
  const all = lines(text);
  const start = all.indexOf(header);
  if (start < 0) return [];
  const rest = all.slice(start + 1);
  const end = rest.findIndex((l) => !/^[=!.] /.test(l));
  return [header, ...(end < 0 ? rest : rest.slice(0, end))];
};

/** A PC after the repair (every harness green), with the Codex hook trusted; status runs from the skills checkout. */
async function synced(): Promise<{ m: PretendMachine; cwd: string }> {
  const m = pretendMachine({ github: gh, git: true });
  machines.push(m);
  githubClone(m, r17);
  for (const id of Object.keys(r17.plugins)) syncedPlugin(m, id, { files: r17.plugins[id].files });
  const cwd = checkoutOf(m, "oneezy/skills");
  checkoutOf(m, "oneezy/tools");
  const r = await cli(m, [], {}, cwd);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  codexTrust(m, 0);
  return { m, cwd };
}

/** The fixture release-17's plugin versions. */
const V17: Record<string, string> = { "matt-pocock": "1.3.1", oneezy: "0.43.1", play: "0.43.0" };

/** The ChatGPT account's copy of a release plugin, as a signed-in Codex lists it. */
function accountCopy(
  m: PretendMachine,
  id: string,
  version?: string,
  marketplace = "created-by-me-remote",
  installed = true,
): void {
  installedPlugin(m, "codex", id, {
    files: r17.plugins[id].files,
    version: version ?? V17[id],
    marketplace,
    installed,
  });
}

test("every release plugin on the ChatGPT account at the release: a green ChatGPT section, the doubled Codex skills a note, exit 0", async () => {
  const { m, cwd } = await synced();
  codexLogin(m, "chatgpt");
  for (const id of Object.keys(r17.plugins)) accountCopy(m, id);
  const r = await cli(m, ["status"], {}, cwd);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(section(r.stdout, "ChatGPT  account copies, read through Codex"), [
    "ChatGPT  account copies, read through Codex",
    "= matt-pocock@created-by-me-remote 1.3.1 (latest 1.3.1)",
    "= oneezy@created-by-me-remote 0.43.1 (latest 0.43.1)",
    "= play@created-by-me-remote 0.43.0 (latest 0.43.0)",
  ]);
  assert.ok(
    lines(r.stdout).includes(
      ". oneezy-status listed twice: oneezy@oneezy-skills, oneezy@created-by-me-remote (one is the ChatGPT account copy; Codex loads both)",
    ),
    r.stdout,
  );
  assert.match(lines(r.stdout).at(-1)!, /^status: all green$/);
  const j = json(await cli(m, ["status", "--json"], {}, cwd));
  assert.equal(j.ok, true);
  assert.deepEqual(j.manualSteps, []);
  assert.equal(j.chatgpt?.checked, true);
  assert.equal(j.chatgpt?.current, true);
  assert.deepEqual(
    j.chatgpt?.plugins.map((p) => [p.id, p.marketplace, p.version, p.latest, p.current]),
    [
      ["matt-pocock", "created-by-me-remote", "1.3.1", "1.3.1", true],
      ["oneezy", "created-by-me-remote", "0.43.1", "0.43.1", true],
      ["play", "created-by-me-remote", "0.43.0", "0.43.0", true],
    ],
  );
  // the duplicates stay facts in --json; only their line is a note
  assert.ok(j.harnesses.codex.duplicates.some((d) => d.skill === "oneezy-status"));
});

test("a ChatGPT copy behind the release and one missing are notes and one manual step with the line to type in ChatGPT; no step says to uninstall", async () => {
  const { m, cwd } = await synced();
  codexLogin(m, "chatgpt");
  accountCopy(m, "matt-pocock");
  accountCopy(m, "oneezy", "0.42.0");
  const r = await cli(m, ["status"], {}, cwd);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(section(r.stdout, "ChatGPT  account copies, read through Codex"), [
    "ChatGPT  account copies, read through Codex",
    "= matt-pocock@created-by-me-remote 1.3.1 (latest 1.3.1)",
    ". oneezy@created-by-me-remote 0.42.0 (latest 0.43.1); manual step below",
    ". play not on the ChatGPT account (latest 0.43.0); manual step below",
  ]);
  const j = json(await cli(m, ["status", "--json"], {}, cwd));
  assert.equal(j.ok, true);
  assert.equal(j.chatgpt?.current, false);
  assert.deepEqual(
    j.chatgpt?.plugins.map((p) => [p.id, p.marketplace, p.version, p.current]),
    [
      ["matt-pocock", "created-by-me-remote", "1.3.1", true],
      ["oneezy", "created-by-me-remote", "0.42.0", false],
      ["play", null, null, false],
    ],
  );
  assert.deepEqual(j.manualSteps, [
    {
      id: "chatgpt-update",
      title: "Bring the ChatGPT plugins up to release-17: oneezy, play",
      steps: [
        "Open ChatGPT (the website or the desktop app) and start a new chat.",
        `The account's oneezy plugin predates the update procedure, so first type: ${BOOTSTRAP}`,
        `Start another new chat and type: ${LINE}`,
        "Approve each plugin update ChatGPT asks about. It ends with every plugin updated, already current, or failed and why.",
        "Start codex once on this machine so it picks up the account's new copies, then run status again.",
      ],
    },
  ]);
  assert.ok(lines(r.stdout).includes(`   3. Start another new chat and type: ${LINE}`), r.stdout);
});

test("once the account's oneezy carries the update procedure (0.46.0 or later), the step is the one line", async () => {
  const { m, cwd } = await synced();
  codexLogin(m, "chatgpt");
  accountCopy(m, "matt-pocock");
  accountCopy(m, "oneezy", "0.46.0");
  const j = json(await cli(m, ["status", "--json"], {}, cwd));
  assert.deepEqual(j.manualSteps, [
    {
      id: "chatgpt-update",
      title: "Bring the ChatGPT plugins up to release-17: play",
      steps: [
        "Open ChatGPT (the website or the desktop app) and start a new chat.",
        `Type: ${LINE}`,
        "Approve each plugin update ChatGPT asks about. It ends with every plugin updated, already current, or failed and why.",
        "Start codex once on this machine so it picks up the account's new copies, then run status again.",
      ],
    },
  ]);
});

test("each copy is judged by its own skills: an account copy still carrying a dropped skill leaves the library's Codex copy green, and is itself behind", async () => {
  const { m, cwd } = await synced();
  codexLogin(m, "chatgpt");
  for (const id of ["matt-pocock", "play"]) accountCopy(m, id);
  const stale = new Map(r17.plugins.oneezy.files);
  stale.set(
    "skills/old-dropped/SKILL.md",
    Buffer.from("---\nname: old-dropped\ndescription: a skill the release dropped\n---\n"),
  );
  installedPlugin(m, "codex", "oneezy", { files: stale, version: "0.42.0", marketplace: "created-by-me-remote" });
  const r = await cli(m, ["status"], {}, cwd);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(!r.stdout.includes("skills differ"), r.stdout);
  assert.ok(
    lines(r.stdout).includes(". oneezy@created-by-me-remote 0.42.0 (latest 0.43.1); manual step below"),
    r.stdout,
  );
  // the same at the release's version: the extra skill alone makes the account copy behind, and the reason says so
  installedPlugin(m, "codex", "oneezy", { files: stale, version: "0.43.1", marketplace: "created-by-me-remote" });
  const same = await cli(m, ["status"], {}, cwd);
  assert.equal(same.status, 0, same.stdout + same.stderr);
  assert.ok(
    lines(same.stdout).includes(
      ". oneezy@created-by-me-remote 0.43.1 (latest 0.43.1; skills differ: extra old-dropped); manual step below",
    ),
    same.stdout,
  );
});

test("account copies Codex lists but has not installed here still count: they are on the ChatGPT account, and Codex loads none of them", async () => {
  const { m, cwd } = await synced();
  codexLogin(m, "chatgpt");
  for (const id of Object.keys(r17.plugins)) accountCopy(m, id, undefined, "created-by-me-remote", false);
  const r = await cli(m, ["status"], {}, cwd);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(section(r.stdout, "ChatGPT  account copies, read through Codex"), [
    "ChatGPT  account copies, read through Codex",
    "= matt-pocock@created-by-me-remote 1.3.1 (latest 1.3.1)",
    "= oneezy@created-by-me-remote 0.43.1 (latest 0.43.1)",
    "= play@created-by-me-remote 0.43.0 (latest 0.43.0)",
  ]);
  // not installed in Codex: no doubled skill, nothing in Codex's own lines
  assert.ok(!r.stdout.includes("listed twice"), r.stdout);
  const j = json(await cli(m, ["status", "--json"], {}, cwd));
  assert.equal(j.chatgpt?.current, true);
  assert.deepEqual(j.manualSteps, []);
});

test("signed in with ChatGPT but Codex lists no account plugin at all: not checked, never 'not on the account'", async () => {
  const { m, cwd } = await synced();
  codexLogin(m, "chatgpt");
  const r = await cli(m, ["status"], {}, cwd);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(section(r.stdout, "ChatGPT  account copies, read through Codex"), [
    "ChatGPT  account copies, read through Codex",
    ". not checked: Codex lists no ChatGPT account plugin yet (it reads the account when codex starts: start codex once, then run status again)",
  ]);
  const j = json(await cli(m, ["status", "--json"], {}, cwd));
  assert.equal(j.chatgpt?.checked, false);
  assert.ok(!j.manualSteps.some((s) => s.id === "chatgpt-update"));
});

test("a workspace copy counts as the ChatGPT copy; OpenAI's curated plugins are not the account's own and keep their uninstall step", async () => {
  const { m, cwd } = await synced();
  codexLogin(m, "chatgpt");
  for (const id of Object.keys(r17.plugins)) accountCopy(m, id, undefined, "workspace-directory");
  installedPlugin(m, "codex", "oneezy", {
    files: r17.plugins.oneezy.files,
    version: "0.43.1",
    marketplace: "openai-curated-remote",
  });
  const j = json(await cli(m, ["status", "--json"], {}, cwd));
  assert.equal(j.chatgpt?.current, true);
  assert.deepEqual(
    j.manualSteps.map((s) => s.id),
    ["codex-other-plugins"],
  );
  assert.equal(
    j.manualSteps[0].title,
    "Uninstall the Codex plugins from other marketplaces that double the library's: oneezy@openai-curated-remote",
  );
  // doubled with a plugin that is neither the library's nor the account's: still red
  assert.ok(
    j.harnesses.codex.lines.some((l) => !l.ok && l.text.startsWith("oneezy-status listed 3 times")),
    JSON.stringify(j.harnesses.codex.lines),
  );
});

test("a Codex not signed in with ChatGPT, or no Codex at all, cannot tell: a note saying why, no step, nothing red", async () => {
  const { m, cwd } = await synced();
  const out = await cli(m, ["status"], {}, cwd);
  assert.equal(out.status, 0, out.stdout + out.stderr);
  assert.deepEqual(section(out.stdout, "ChatGPT  account copies, read through Codex"), [
    "ChatGPT  account copies, read through Codex",
    ". not checked: Codex on this machine is not signed in with ChatGPT (codex login)",
  ]);
  codexLogin(m, "api-key");
  const key = json(await cli(m, ["status", "--json"], {}, cwd));
  assert.deepEqual(
    [key.chatgpt?.checked, key.chatgpt?.reason],
    [false, "Codex on this machine is not signed in with ChatGPT (codex login)"],
  );
  assert.deepEqual(key.manualSteps, []);

  const bare = pretendMachine({ github: gh, harnesses: ["claude-code"], clis: ["claude"] });
  machines.push(bare);
  const none = json(await cli(bare, ["status", "--json"]));
  assert.deepEqual(
    [none.chatgpt?.checked, none.chatgpt?.reason],
    [false, "no Codex on this machine to read the ChatGPT account through"],
  );
  assert.ok(!none.manualSteps.some((s) => s.id === "chatgpt-update"));
});

test("a cloud session has no ChatGPT section: no Codex runs there", async () => {
  const m = pretendMachine({ github: gh, env: { CLAUDE_CODE_REMOTE: "true" } });
  machines.push(m);
  const r = await cli(m, ["status", "--json"]);
  assert.equal(json(r).chatgpt, null);
  assert.ok(!r.stdout.includes("ChatGPT  account plugins"));
});
