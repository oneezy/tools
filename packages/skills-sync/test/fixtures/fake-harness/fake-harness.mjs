// A stand-in for the claude and codex CLIs' plugin commands, put on PATH by the install tests so they never touch
// the machine's real harnesses. It answers with the shapes the real CLIs print (Claude Code 2.1.296, Codex 0.162.1),
// keeps its state in fake-harness.json in the harness's config folder (CLAUDE_CONFIG_DIR, CODEX_HOME), and appends
// every call to FAKE_HARNESS_LOG. FAKE_HARNESS_OLD=<claude,codex> makes one a CLI without plugin commands;
// FAKE_HARNESS_BROKEN=<claude,codex> one that installs but never resolves a plugin's skills. Claude also lists the
// account plugins claude.ai synced into <CLAUDE_CONFIG_DIR>/plugins/synced/<bucket>/<name>/ as <name>@synced, exactly
// as the real CLI does (version "unknown" unless the Claude manifest carries one), and answers details for them; a test
// switches one off through the state file's `synced` map ({ "<name>@synced": { enabled: false } }).
// Codex takes a marketplace from a local folder or from GitHub as `owner/repo`: the pretend GitHub is the folder
// FAKE_HARNESS_GITHUB, where <owner>/<repo> is a checkout of the library (its `.git-revision` file is the commit), cloned
// into <CODEX_HOME>/.tmp/marketplaces/<name> as the real CLI does; `marketplace upgrade` re-clones when the revision
// moved and reinstalls every plugin from it; `plugin add` copies the plugin into <CODEX_HOME>/plugins/cache/<mkt>/<id>/
// <version>; FAKE_HARNESS_FAIL_ADD=<ids> makes `plugin add` of those ids fail. The JSON shapes are the real CLI's.
// FAKE_HARNESS_FAIL_LIST=<claude,codex> makes `plugin list` fail (a CLI that cannot list its plugins);
// FAKE_HARNESS_FAIL_MARKETPLACE_LIST=<claude,codex> makes `plugin marketplace list` fail; FAKE_HARNESS_UPGRADE_ERRORS=<id,...>
// makes Codex's `marketplace upgrade` leave those plugins as they are and report one error each (exit 0, as the CLI);
// FAKE_HARNESS_FAIL_UNINSTALL=<id,...> makes `plugin uninstall <id>` (Codex: `plugin remove <id>`) fail for those ids.
import fs from "node:fs";
import path from "node:path";
import {spawnSync} from "node:child_process";

const [host, ...args] = process.argv.slice(2);
const has = (v, h) => (v ?? "").split(",").includes(h);
const home = host === "claude" ? process.env.CLAUDE_CONFIG_DIR : process.env.CODEX_HOME;
const file = path.join(home, "fake-harness.json");
const state = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : { marketplaces: {}, plugins: {} };
const save = () => (fs.mkdirSync(home, { recursive: true }), fs.writeFileSync(file, JSON.stringify(state, null, 2)));
if (process.env.FAKE_HARNESS_LOG) fs.appendFileSync(process.env.FAKE_HARNESS_LOG, JSON.stringify([host, ...args]) + "\n");
const out = (v) => process.stdout.write((typeof v === "string" ? v : JSON.stringify(v, null, 2)) + "\n");
const fail = (m) => (process.stderr.write(m + "\n"), process.exit(1));
const words = args.filter((a) => !a.startsWith("-"));
// "plugin marketplace add", "plugin install": the command's words, without its argument
const cmd = words.slice(0, words[1] === "marketplace" ? 3 : 2).join(" ");

const catalog = (root) =>
  JSON.parse(
    fs.readFileSync(
      path.join(root, host === "claude" ? ".claude-plugin" : ".agents/plugins", "marketplace.json"),
      "utf8",
    ),
  );
const skillsOf = (dir) => {
  const d = path.join(dir, "skills");
  return fs.existsSync(d) ? fs.readdirSync(d).filter((n) => fs.existsSync(path.join(d, n, "SKILL.md"))).sort() : [];
};
const resolve = (id) => {
  const at = id.lastIndexOf("@");
  const [name, mkt] = [id.slice(0, at), id.slice(at + 1)];
  const root = state.marketplaces[mkt];
  if (!root) fail(host === "codex" ? `Error: plugin \`${name}\` was not found in marketplace \`${mkt}\`` : `marketplace ${mkt} is not configured`);
  const entry = catalog(root).plugins.find((p) => p.name === name);
  if (!entry) fail(host === "codex" ? `Error: plugin \`${name}\` was not found in marketplace \`${mkt}\`` : `plugin ${name} was not found in marketplace ${mkt}`);
  return { name, mkt, dir: path.resolve(root, entry.source) };
};
const codexVersion = (dir) => JSON.parse(fs.readFileSync(path.join(dir, ".codex-plugin", "plugin.json"), "utf8")).version ?? null;
// Codex: where a marketplace was added from; a marketplace registered before this fake knew sources is a local folder
const sourceOf = (name) => state.sources?.[name] ?? { sourceType: "local", source: state.marketplaces[name] };
// the pretend GitHub: <FAKE_HARNESS_GITHUB>/<owner>/<repo> is the clone `owner/repo` or its Git URL would give
const githubClone = (ownerRepo) => {
  const m = /^(?:https:\/\/github\.com\/)?([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:@[\w.-]+)?$/.exec(ownerRepo);
  const base = process.env.FAKE_HARNESS_GITHUB;
  if (!m || !base) return null;
  const dir = path.join(base, m[1], m[2]);
  return fs.existsSync(dir) ? { owner: m[1], repo: m[2], dir } : null;
};
const revisionOf = (clone) => {
  try {
    return fs.readFileSync(path.join(clone, ".git-revision"), "utf8").trim();
  } catch {
    return "0";
  }
};
const snapshotOf = (name) => path.join(home, ".tmp", "marketplaces", name);
const clone = (from, to) => {
  fs.rmSync(to, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.cpSync(from, to, { recursive: true });
};
// Codex installs a Git marketplace's plugin into its cache, keyed by the manifest's version, as the real CLI does; a
// local marketplace's plugin is read in place here (the install tests compare paths with the library's built folder)
const codexInstall = (p, enabled) => {
  const version = codexVersion(p.dir);
  let dir = p.dir;
  if (sourceOf(p.mkt).sourceType === "git") {
    dir = path.join(home, "plugins", "cache", p.mkt, p.name, version ?? "unversioned");
    clone(p.dir, dir);
  }
  return { version, enabled, dir, skills: skillsOf(dir) };
};
// the account plugins: every folder under plugins/synced/<bucket>/, the bucket's manifest.json and *.meta.json skipped
const synced = () => {
  const root = path.join(home, "plugins", "synced");
  if (host !== "claude" || !fs.existsSync(root)) return [];
  const out = [];
  for (const bucket of fs.readdirSync(root).sort()) {
    const dir = path.join(root, bucket);
    if (bucket.startsWith(".") || !fs.statSync(dir).isDirectory()) continue;
    for (const name of fs.readdirSync(dir).sort()) {
      const installPath = path.join(dir, name);
      if (name.startsWith(".") || !fs.statSync(installPath).isDirectory()) continue;
      let version = "unknown";
      try {
        version = JSON.parse(fs.readFileSync(path.join(installPath, ".claude-plugin", "plugin.json"), "utf8")).version ?? "unknown";
      } catch {
        /* no Claude manifest, or none with a version */
      }
      const enabled = state.synced?.[`${name}@synced`]?.enabled ?? true;
      out.push({ id: `${name}@synced`, version, scope: "synced", enabled, installPath });
    }
  }
  return out;
};

if (args[0] === "plugin" && args.includes("--help")) {
  if (cmd === "plugin update" && process.env.FAKE_HARNESS_NO_UPDATE) fail("unknown command update");
  if (has(process.env.FAKE_HARNESS_OLD, host)) out(`Usage: ${host} [options] [prompt]`);
  else out(`Usage: ${host} plugin [command]\n\nCommands:\n  install  update  list  marketplace  uninstall\n${has(process.env.FAKE_HARNESS_NO_WRITE_JSON, host) ? "" : "Options:\n  --json  Print machine-readable result"}`);
} else if (has(process.env.FAKE_HARNESS_OLD, host)) {
  fail(`unknown command ${args.join(" ")}`);
} else if (cmd === "plugin marketplace list") {
  if (has(process.env.FAKE_HARNESS_FAIL_MARKETPLACE_LIST, host)) fail("fixture marketplace list failed");
  const rows = Object.entries(state.marketplaces);
  out(
    host === "claude"
      ? rows.map(([name, p]) => ({ name, source: "directory", path: p, installLocation: p }))
      : {
          marketplaces: rows.map(([name, root]) => {
            const { sourceType, source } = sourceOf(name);
            return { name, root, marketplaceSource: { sourceType, source } };
          }),
        },
  );
} else if (cmd === "plugin marketplace add") {
  if (has(process.env.FAKE_HARNESS_NO_WRITE_JSON, host) && args.includes("--json")) fail("unknown option '--json'");
  if (has(process.env.FAKE_HARNESS_FAIL_MARKETPLACE, host)) {
    out("registry provider context");
    fail("fixture registry registration denied");
  }
  let root = path.resolve(words[3]);
  let source = { sourceType: "local", source: root };
  let gh = null;
  if (host === "codex" && !fs.existsSync(root)) {
    // not a folder here: owner/repo (or a Git URL) on the pretend GitHub, snapshotted like the real CLI's git clone
    gh = githubClone(words[3]);
    if (!gh) fail(`Error: failed to clone https://github.com/${words[3].replace(/\.git$/, "")}.git`);
    // the revision is compared only by upgrade, so the first upgrade after an add re-clones (the real CLI does too)
    source = { sourceType: "git", source: `https://github.com/${gh.owner}/${gh.repo}.git`, revision: null };
  }
  const name = catalog(gh ? gh.dir : root).name;
  if (host === "codex" && state.marketplaces[name]) {
    // as codex 0.162.1: the same source again is already added (exit 0, nothing changed); a Git source over a local
    // registration replaces it in place; any other source of the name is refused until the old one is removed
    const prev = sourceOf(name);
    if (prev.sourceType === source.sourceType && prev.source === source.source) {
      out({ marketplaceName: name, installedRoot: state.marketplaces[name], alreadyAdded: true });
      process.exit(0);
    }
    if (!(prev.sourceType === "local" && source.sourceType === "git"))
      fail(`Error: marketplace '${name}' is already added from a different source; remove it before adding this source`);
  }
  if (gh) {
    root = snapshotOf(name);
    clone(gh.dir, root);
  }
  state.marketplaces[name] = root;
  if (host === "codex") (state.sources ??= {})[name] = source;
  save();
  out(host === "claude" ? { outcome: "ok", marketplace: name } : { marketplaceName: name, installedRoot: root, alreadyAdded: false });
} else if (cmd === "plugin marketplace remove") {
  if (has(process.env.FAKE_HARNESS_NO_WRITE_JSON, host) && args.includes("--json")) fail("unknown option '--json'");
  if (!state.marketplaces[words[3]])
    fail(host === "codex" ? `Error: marketplace \`${words[3]}\` is not configured or installed` : `marketplace ${words[3]} is not configured`);
  const root = state.marketplaces[words[3]];
  delete state.marketplaces[words[3]];
  // Claude's remove cascades to the marketplace's plugins; Codex's does not: its [plugins] entries and caches stay
  if (host === "claude")
    for (const id of Object.keys(state.plugins)) if (id.endsWith(`@${words[3]}`)) delete state.plugins[id];
  const source = sourceOf(words[3]);
  if (state.sources) delete state.sources[words[3]];
  save();
  out(host === "claude" ? { outcome: "ok" } : { marketplaceName: words[3], installedRoot: source.sourceType === "git" ? root : null });
} else if (host === "codex" && cmd === "plugin marketplace upgrade") {
  // refresh every Git marketplace named (or all of them): a new revision on the pretend GitHub is cloned over the
  // snapshot and every plugin installed from it is reinstalled from the new snapshot
  const names = words[3] ? [words[3]] : Object.keys(state.marketplaces).filter((n) => sourceOf(n).sourceType === "git");
  const upgraded = [];
  const errors = [];
  for (const name of names) {
    if (!state.marketplaces[name]) fail(`Error: marketplace \`${name}\` is not configured or installed`);
    const src = sourceOf(name);
    if (src.sourceType !== "git") fail(`Error: marketplace \`${name}\` is not configured as a Git marketplace`);
    const gh = githubClone(src.source);
    if (!gh) fail(`Error: failed to fetch ${src.source}`);
    const revision = revisionOf(gh.dir);
    if (revision === src.revision && !process.env.FAKE_HARNESS_UPGRADE_ALWAYS) continue;
    clone(gh.dir, state.marketplaces[name]);
    src.revision = revision;
    state.sources[name] = src;
    upgraded.push(state.marketplaces[name]);
    for (const [id, p] of Object.entries(state.plugins)) {
      if (!id.endsWith(`@${name}`)) continue;
      if (has(process.env.FAKE_HARNESS_UPGRADE_ERRORS, id)) {
        errors.push(`Error: failed to install plugin \`${id}\`: fixture upgrade denied`);
        continue;
      }
      const entry = catalog(state.marketplaces[name]).plugins.find((x) => x.name === id.slice(0, id.lastIndexOf("@")));
      if (!entry) continue; // no longer in the catalog: the cache stays as it was
      state.plugins[id] = codexInstall({ name: entry.name, mkt: name, dir: path.resolve(state.marketplaces[name], entry.source) }, p.enabled);
    }
  }
  save();
  if (args.includes("--json")) out({ selectedMarketplaces: names, upgradedRoots: upgraded, errors });
  else for (const name of names) out(upgraded.includes(state.marketplaces[name]) ? `Upgraded marketplace \`${name}\`.` : `Marketplace \`${name}\` is already up to date.`);
} else if (cmd === "plugin list") {
  if (has(process.env.FAKE_HARNESS_FAIL_LIST, host)) fail("fixture plugin list failed");
  const rows = Object.entries(state.plugins);
  out(
    host === "claude"
      ? [
          ...rows.map(([id, p]) => ({ id, version: p.version, scope: "user", enabled: p.enabled,
            ...(process.env.FAKE_HARNESS_CACHE ? {installPath: p.dir} : {readFromFolder: p.dir}) })),
          ...synced(),
        ]
      : {
          installed: rows.map(([id, p]) => {
            const name = id.slice(0, id.lastIndexOf("@"));
            const mkt = id.slice(id.lastIndexOf("@") + 1);
            const { sourceType, source } = sourceOf(mkt);
            return {
              pluginId: id,
              name,
              marketplaceName: mkt,
              version: p.version ?? null,
              installed: true,
              enabled: p.enabled,
              source: { source: "local", path: p.source ?? p.dir },
              marketplaceSource: { sourceType, source: source ?? null },
              installPolicy: "AVAILABLE",
              authPolicy: "ON_USE",
            };
          }),
          available: [],
        },
  );
} else if ((host === "claude" && ["plugin install", "plugin update"].includes(cmd)) || (host === "codex" && cmd === "plugin add")) {
  if (has(process.env.FAKE_HARNESS_NO_WRITE_JSON, host) && args.includes("--json")) fail("unknown option '--json'");
  if (host === "codex" && has(process.env.FAKE_HARNESS_FAIL_ADD, words[2])) {
    out(`add provider context: ${words[2]}`);
    fail(`Error: fixture add denied: ${words[2]}`);
  }
  const p = resolve(words[2]);
  const at = state.plugins[words[2]];
  // Native Claude install leaves an existing cache untouched; only update rebuilds it.
  if (host === "claude" && cmd === "plugin install" && at) {
    out({ outcome: "ok", message: "already installed" });
    process.exit(0);
  }
  if (cmd === "plugin update") {
    if (has(process.env.FAKE_HARNESS_FAIL_UPDATE, words[2])) {
      out(`update provider context: ${words[2]}`);
      fail(`fixture update denied: ${words[2]}`);
    }
    if (process.env.FAKE_HARNESS_STALE_UPDATE) {
      out({ outcome: "ok", message: "already up to date" });
      process.exit(0);
    }
  }
  if (host === "codex") {
    // idempotent: a second add answers the same JSON
    const installed = codexInstall(p, at?.enabled ?? true);
    state.plugins[words[2]] = { ...installed, source: p.dir };
    save();
    out({ pluginId: words[2], name: p.name, marketplaceName: p.mkt, version: installed.version, installedPath: installed.dir, authPolicy: "ON_USE" });
    process.exit(0);
  }
  const version = process.env.FAKE_HARNESS_CACHE
        ? spawnSync("git", ["-C", state.marketplaces[p.mkt], "rev-parse", "--short=12", "HEAD"], {encoding:"utf8"}).stdout.trim()
        : "c69993a67bba";
  let dir = p.dir;
  if (process.env.FAKE_HARNESS_CACHE) {
    dir = path.join(home, "cache", p.mkt, p.name, version);
    fs.cpSync(p.dir, dir, { recursive: true });
  }
  state.plugins[words[2]] = {
    version,
    enabled: cmd === "plugin update" && process.env.FAKE_HARNESS_DISABLED_UPDATE ? false : at?.enabled ?? true,
    dir,
    skills: skillsOf(dir),
  };
  save();
  out({ outcome: "ok", pluginId: words[2] });
} else if ((host === "claude" && cmd === "plugin uninstall") || (host === "codex" && cmd === "plugin remove")) {
  if (has(process.env.FAKE_HARNESS_NO_WRITE_JSON, host) && args.includes("--json")) fail("unknown option '--json'");
  if (has(process.env.FAKE_HARNESS_FAIL_UNINSTALL, words[2])) fail(`fixture uninstall denied: ${words[2]}`);
  if (!state.plugins[words[2]]) fail(`plugin ${words[2]} not found in installed plugins`);
  const p = state.plugins[words[2]];
  delete state.plugins[words[2]];
  save();
  if (host === "codex") {
    // removes the [plugins] entry and the cache version folder
    if (p.dir && p.dir.startsWith(path.join(home, "plugins", "cache"))) fs.rmSync(p.dir, { recursive: true, force: true });
    const at = words[2].lastIndexOf("@");
    out({ pluginId: words[2], name: words[2].slice(0, at), marketplaceName: words[2].slice(at + 1) });
  } else out({ outcome: "ok" });
} else if (host === "claude" && cmd === "plugin details") {
  if (has(process.env.FAKE_HARNESS_FAIL_DETAILS, args[2])) fail(`fixture details failed: ${args[2]}`);
  const account = synced().find((s) => s.id === words[2]);
  const p = state.plugins[words[2]] ?? (account ? { dir: account.installPath } : null);
  if (!p) fail(`Plugin "${words[2]}" not found.`);
  const skills = has(process.env.FAKE_HARNESS_BROKEN, host) ? [] : skillsOf(p.dir);
  out(`${words[2]}\n\nComponent inventory\n  Skills (${skills.length})  ${skills.join(", ")}\n  Agents (0)`);
} else if (host === "codex" && args[0] === "debug" && args[1] === "prompt-input") {
  if (has(process.env.FAKE_HARNESS_FAIL_PROMPT, host)) fail("fixture prompt inventory failed");
  const lines = [];
  let rootIndex = 0;
  if (!has(process.env.FAKE_HARNESS_BROKEN, host))
    for (const [id, p] of Object.entries(state.plugins)) {
      if (!p.enabled) continue;
      const alias = `r${rootIndex++}`;
      if (process.env.FAKE_HARNESS_ALIASES) lines.push(`- \`${alias}\` = \`${path.join(p.dir, "skills")}\``);
      for (const s of skillsOf(p.dir)) lines.push(`- ${id.slice(0, id.lastIndexOf("@"))}:${s}: ${s} skill (file: ${process.env.FAKE_HARNESS_ALIASES ? alias + "/" + s + "/SKILL.md" : path.join(p.dir, "skills", s, "SKILL.md")})`);
    }
  out(JSON.stringify([{ type: "message", content: [{ text: `### Available skills\n${lines.join("\n")}` }] }]));
} else fail(`fake ${host}: unhandled ${args.join(" ")}`);
