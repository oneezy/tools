// A stand-in for the claude and codex CLIs' plugin commands, put on PATH by the install tests so they never touch
// the machine's real harnesses. It answers with the shapes the real CLIs print (Claude Code 2.1.293, Codex 0.161.0),
// keeps its state in fake-harness.json in the harness's config folder (CLAUDE_CONFIG_DIR, CODEX_HOME), and appends
// every call to FAKE_HARNESS_LOG. FAKE_HARNESS_OLD=<claude,codex> makes one a CLI without plugin commands;
// FAKE_HARNESS_BROKEN=<claude,codex> one that installs but never resolves a plugin's skills.
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
  if (!root) fail(`marketplace ${mkt} is not configured`);
  const entry = catalog(root).plugins.find((p) => p.name === name);
  if (!entry) fail(`plugin ${name} was not found in marketplace ${mkt}`);
  return { name, mkt, dir: path.resolve(root, entry.source) };
};
const codexVersion = (dir) => JSON.parse(fs.readFileSync(path.join(dir, ".codex-plugin", "plugin.json"), "utf8")).version;

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
  const rows = Object.entries(state.plugins);
  out(
    host === "claude"
      ? rows.map(([id, p]) => ({ id, version: p.version, scope: "user", enabled: p.enabled,
          ...(process.env.FAKE_HARNESS_CACHE ? {installPath: p.dir} : {readFromFolder: p.dir}) }))
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
  if (!state.plugins[words[2]]) fail(`plugin ${words[2]} not found in installed plugins`);
  delete state.plugins[words[2]];
  save();
  out({ outcome: "ok" });
} else if (host === "claude" && cmd === "plugin details") {
  if (has(process.env.FAKE_HARNESS_FAIL_DETAILS, args[2])) fail(`fixture details failed: ${args[2]}`);
  const p = state.plugins[words[2]];
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
