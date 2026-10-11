// A stand-in for the claude and codex CLIs' plugin commands, put on PATH by the install tests so they never touch
// the machine's real harnesses. It answers with the shapes the real CLIs print (Claude Code 2.1.296, Codex 0.161.0),
// keeps its state in fake-harness.json in the harness's config folder (CLAUDE_CONFIG_DIR, CODEX_HOME), and appends
// every call to FAKE_HARNESS_LOG. FAKE_HARNESS_OLD=<claude,codex> makes one a CLI without plugin commands;
// FAKE_HARNESS_BROKEN=<claude,codex> one that installs but never resolves a plugin's skills. Claude also lists the
// account plugins claude.ai synced into <CLAUDE_CONFIG_DIR>/plugins/synced/<bucket>/<name>/ as <name>@synced, exactly
// as the real CLI does (version "unknown" unless the Claude manifest carries one), and answers details for them; a test
// switches one off through the state file's `synced` map ({ "<name>@synced": { enabled: false } }).
// FAKE_HARNESS_FAIL_LIST=<claude,codex> makes `plugin list` fail (a CLI that cannot list its plugins);
// FAKE_HARNESS_FAIL_UNINSTALL=<id,...> makes `plugin uninstall <id>` (Codex: `plugin remove <id>`) fail for those ids.
//
// The third host is hermes (`hermes plugins ...`, hermes-agent v0.21.6 shapes). Its state is Hermes's own files under
// HERMES_HOME, the ones the real CLI writes and the tool reads: plugins/<name>/ (copied from a pretend GitHub checkout
// under FAKE_HERMES_GITHUB/<owner>/<repo>/<ref or HEAD>/<subdir>), plugins/.install-metadata.json ({ pinned, revision,
// source: "<url>#<subdir>" } per name) and config.yaml (plugins.enabled, plugins.disabled). `install` refuses a name whose
// plugins/<name> is a link, an existing name without --force, a --ref that is not a 40-hex sha; FAKE_HARNESS_FAIL_INSTALL=
// <names> makes those installs fail; FAKE_HARNESS_CAUTION=<names> gives them a caution scan verdict, which without --force
// and without a TTY aborts; FAKE_HARNESS_FAIL_ENABLE=<names> makes `enable` fail for those names and FAKE_HARNESS_FAIL_LIST
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
const resolve = (id) => {
  const at = id.lastIndexOf("@");
  const [name, mkt] = [id.slice(0, at), id.slice(at + 1)];
  const root = state.marketplaces[mkt];
  if (!root) fail(`marketplace ${mkt} is not configured`);
  const entry = catalog(root).plugins.find((p) => p.name === name);
  if (!entry) fail(`plugin ${name} was not found in marketplace ${mkt}`);
  return { name, mkt, dir: path.resolve(root, entry.source) };
};
const codexVersion = (dir) => JSON.parse(fs.readFileSync(path.join(dir, ".codex-plugin", "plugin.json"), "utf8")).version;
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
  const rows = Object.entries(state.marketplaces);
  out(
    host === "claude"
      ? rows.map(([name, p]) => ({ name, source: "directory", path: p, installLocation: p }))
      : { marketplaces: rows.map(([name, p]) => ({ name, root: p })) },
  );
} else if (cmd === "plugin marketplace add") {
  if (has(process.env.FAKE_HARNESS_NO_WRITE_JSON, host) && args.includes("--json")) fail("unknown option '--json'");
  if (has(process.env.FAKE_HARNESS_FAIL_MARKETPLACE, host)) {
    out("registry provider context");
    fail("fixture registry registration denied");
  }
  const root = path.resolve(words[3]);
  const name = catalog(root).name;
  state.marketplaces[name] = root;
  save();
  out({ outcome: "ok", marketplace: name });
} else if (cmd === "plugin marketplace remove") {
  if (!state.marketplaces[words[3]]) fail(`marketplace ${words[3]} is not configured`);
  delete state.marketplaces[words[3]];
  // Claude's remove cascades to the marketplace's plugins; Codex's does not
  if (host === "claude")
    for (const id of Object.keys(state.plugins)) if (id.endsWith(`@${words[3]}`)) delete state.plugins[id];
  save();
  out({ outcome: "ok" });
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
          installed: rows.map(([id, p]) => ({
            pluginId: id,
            name: id.slice(0, id.lastIndexOf("@")),
            marketplaceName: id.slice(id.lastIndexOf("@") + 1),
            version: p.version,
            installed: true,
            enabled: p.enabled,
          })),
          available: [],
        },
  );
} else if ((host === "claude" && ["plugin install", "plugin update"].includes(cmd)) || (host === "codex" && cmd === "plugin add")) {
  if (has(process.env.FAKE_HARNESS_NO_WRITE_JSON, host) && args.includes("--json")) fail("unknown option '--json'");
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
  const version = host === "claude"
      ? process.env.FAKE_HARNESS_CACHE
        ? spawnSync("git", ["-C", state.marketplaces[p.mkt], "rev-parse", "--short=12", "HEAD"], {encoding:"utf8"}).stdout.trim()
        : "c69993a67bba"
      : codexVersion(p.dir);
  let dir = p.dir;
  if (host === "claude" && process.env.FAKE_HARNESS_CACHE) {
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
  if (has(process.env.FAKE_HARNESS_FAIL_UNINSTALL, words[2])) fail(`fixture uninstall denied: ${words[2]}`);
  if (!state.plugins[words[2]]) fail(`plugin ${words[2]} not found in installed plugins`);
  delete state.plugins[words[2]];
  save();
  out({ outcome: "ok" });
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
        // Python's str(version): "None" for a manifest without one
        version: p.version === undefined ? "None" : String(p.version),
        description: p.description,
        source: pin ? `git pinned@${pin.slice(0, 8)}` : "user",
        removed: null,
      };
    });
    if (!args.includes("--no-bundled"))
      rows.unshift({ name: "memory-wiki", status: "not enabled", version: "0.1.0", description: "Markdown wiki memory", source: "bundled", removed: null });
    if (!rows.length) {
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
    if (fs.existsSync(target) && !args.includes("--force"))
      fail(`Plugin '${name}' already exists. Use force reinstall or run \`hermes plugins update ${name}\`.`);
    if (fs.existsSync(target) && !ref && prior?.pinned === true)
      fail(`Plugin '${name}' is pinned. Reinstall it with an explicit --ref <40-character commit SHA> to change its source or revision.`);
    if (has(process.env.FAKE_HARNESS_CAUTION, name) && !args.includes("--force")) {
      out("⚠ Security scan flagged this plugin:");
      out("  caution: shell commands in documentation");
      // no TTY: the y/N question reads EOF, which counts as no
      fail("Aborted.");
    }
    fs.rmSync(target, { recursive: true, force: true });
    fs.mkdirSync(pluginsDir, { recursive: true });
    fs.cpSync(from, target, { recursive: true });
    const meta = readMeta();
    meta[name] = { pinned: !!ref, revision: ref ?? "0".repeat(40), source };
    writeMeta(meta);
    out(`✓ Installed ${name}`);
    if (args.includes("--enable")) {
      setLists(name, true);
      out(`✓ Plugin ${name} enabled.`);
    } else if (args.includes("--no-enable") || prior) out(`Plugin installed but not enabled. Run \`hermes plugins enable ${name}\` to activate.`);
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
