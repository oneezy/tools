import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vite-plus/test";
import { gzipSync } from "node:zlib";
import { analyze, filesToRead, loadGitHub, memoryFileSet, parseRepoInput, untar, GitHubError } from "../src/index.js";
import { buildGraph } from "../src/graph.js";
import { readLocal } from "../src/local.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(here, "..");
const LIB = path.join(PKG, "fixtures", "plugin-library");
const graph = buildGraph([LIB]);
const part = (id: string) => graph.parts.find((p) => p.id === id);
const link = (s: string, t: string) => graph.links.find((e) => e.source === s && e.target === t);

/** The plugin-library fixture as repo-relative files, the shape a GitHub source produces. */
function fixtureFiles(): Map<string, string> {
  const local = readLocal([LIB]);
  const root = LIB.split(path.sep).join("/") + "/";
  return new Map(local.paths.map((p) => [p.slice(root.length), local.read(p) ?? ""]));
}

test("parseRepoInput takes owner/repo and GitHub URLs, rejects the rest", () => {
  const cases: Array<[string, unknown]> = [
    ["mattpocock/skills", { owner: "mattpocock", repo: "skills" }],
    ["mattpocock/skills@v2", { owner: "mattpocock", repo: "skills", ref: "v2" }],
    ["https://github.com/mattpocock/skills", { owner: "mattpocock", repo: "skills" }],
    ["github.com/mattpocock/skills.git", { owner: "mattpocock", repo: "skills" }],
    ["https://www.github.com/mattpocock/skills/?tab=readme#top", { owner: "mattpocock", repo: "skills" }],
    ["git@github.com:mattpocock/skills.git", { owner: "mattpocock", repo: "skills" }],
    [
      "https://github.com/cursor/plugins/tree/main/pstack",
      { owner: "cursor", repo: "plugins", refPath: ["main", "pstack"] },
    ],
    [
      "https://github.com/o/r/blob/feat/x/skills/a/SKILL.md",
      { owner: "o", repo: "r", refPath: ["feat", "x", "skills", "a", "SKILL.md"] },
    ],
    ["https://github.com/o/r/issues/3", { owner: "o", repo: "r" }],
    ["https://gitlab.com/o/r", null],
    ["./skills", null],
    ["C:\\dev\\skills", null],
    ["https://github.com/onlyowner", null],
    ["", null],
  ];
  for (const [input, want] of cases) assert.deepEqual(parseRepoInput(input), want, input);
});

test("plugin parts: commands, agents, hooks, MCP servers and scripts become nodes", () => {
  assert.equal(graph.meta.pluginCount, 1);
  const plugin = graph.plugins[0];
  assert.equal(plugin.id, "plugin:toolkit");
  assert.equal(plugin.version, "1.2.0");
  assert.deepEqual(plugin.skills, ["deploy", "review"]);
  assert.deepEqual(
    graph.parts.map((p) => p.id),
    [
      "agent:toolkit/release-notes",
      "command:toolkit/ship",
      "hook:toolkit/PostToolUse (Write|Edit)",
      "hook:toolkit/SessionStart",
      "mcp:toolkit/docs",
      "mcp:toolkit/tracker",
      "reference:deploy/references/env.md",
      "script:deploy/scripts/check.sh",
      "script:toolkit/scripts/format.sh",
      "script:toolkit/scripts/tracker.mjs",
    ],
  );
  assert.equal(part("command:toolkit/ship")?.description, "Review, deploy, then write release notes.");
  assert.equal(part("agent:toolkit/release-notes")?.details.model, "haiku");
  assert.deepEqual(part("hook:toolkit/PostToolUse (Write|Edit)")?.details.matcher, "Write|Edit");
  assert.equal(part("mcp:toolkit/docs")?.details.transport, "http", "inline mcpServers in plugin.json");
  assert.equal(part("mcp:toolkit/tracker")?.details.transport, "stdio");
  assert.equal(part("script:deploy/scripts/check.sh")?.skill, "deploy");
});

test("secrets in MCP config are never copied, only their keys", () => {
  const json = JSON.stringify(graph);
  assert.ok(!json.includes("do-not-copy-me"));
  assert.ok(!json.includes("secret-value"));
  assert.deepEqual(part("mcp:toolkit/tracker")?.details.envKeys, ["TRACKER_TOKEN"]);
  assert.deepEqual(part("mcp:toolkit/docs")?.details.headerKeys, ["Authorization"]);
});

test("links connect parts: command -> skill, command -> agent, skill -> files, hook/MCP -> script", () => {
  assert.equal(link("command:toolkit/ship", "deploy")?.type, "calls");
  assert.equal(link("command:toolkit/ship", "agent:toolkit/release-notes")?.type, "calls");
  assert.equal(link("deploy", "script:deploy/scripts/check.sh")?.type, "runs");
  assert.equal(link("deploy", "reference:deploy/references/env.md")?.type, "reads");
  assert.equal(link("hook:toolkit/PostToolUse (Write|Edit)", "script:toolkit/scripts/format.sh")?.type, "runs");
  assert.equal(link("mcp:toolkit/tracker", "script:toolkit/scripts/tracker.mjs")?.type, "runs");
  assert.ok(!link("hook:toolkit/SessionStart", "script:toolkit/scripts/format.sh"));
  for (const l of graph.links) assert.ok(l.evidence.length > 0 && l.evidence[0].line > 0);
  // skill -> skill stays in edges
  assert.deepEqual(
    graph.edges.map((e) => [e.source, e.target, e.type]),
    [["deploy", "review", "calls"]],
  );
  // a command that runs a manual-only skill is its entry point, so the skill is not one
  assert.equal(graph.nodes.find((n) => n.id === "deploy")?.entry, false);
});

test("a skill shipped twice (skills/ and a built plugin copy) is one node", () => {
  const review = graph.nodes.filter((n) => n.id === "review");
  assert.equal(review.length, 1);
  assert.ok(review[0].file.endsWith("fixtures/plugin-library/skills/review/SKILL.md"), "the authored copy wins");
  assert.equal(review[0].copies?.length, 1);
  assert.ok(review[0].copies?.[0].endsWith("plugins/toolkit/skills/review/SKILL.md"));
  assert.equal(review[0].plugin, "plugin:toolkit");
});

test("marketplaces list their plugins and point at the ones read", () => {
  assert.equal(graph.marketplaces.length, 1);
  const m = graph.marketplaces[0];
  assert.equal(m.name, "example-tools");
  assert.deepEqual(
    m.plugins.map((p) => [p.name, p.source, p.pluginId]),
    [
      ["toolkit", "./plugins/toolkit", "plugin:toolkit"],
      ["elsewhere", "github:example/elsewhere", undefined],
    ],
  );
});

test("analyze runs on an in-memory file set and matches the local result", () => {
  const files = fixtureFiles();
  const mem = analyze(memoryFileSet(files));
  assert.equal(mem.nodes[1].file, "skills/review/SKILL.md", "paths are as the source reports them");
  const strip = (g: typeof graph) =>
    JSON.stringify([
      g.nodes.map((n) => n.id),
      g.edges,
      g.parts.map((p) => p.id),
      g.links.map((l) => [l.source, l.target, l.type]),
    ]);
  assert.equal(strip(mem), strip(graph));
});

test("filesToRead asks for SKILL.md and manifests first, then what manifests point at, never scripts", () => {
  const files = fixtureFiles();
  const paths = [...files.keys()];
  const first = filesToRead(paths);
  assert.ok(first.includes("skills/review/SKILL.md"));
  assert.ok(first.includes("plugins/toolkit/.claude-plugin/plugin.json"));
  assert.ok(first.includes("plugins/toolkit/commands/ship.md"));
  assert.ok(first.includes("plugins/toolkit/hooks/hooks.json"));
  assert.ok(
    !first.some((p) => p.endsWith(".sh") || p.endsWith(".mjs") || p.endsWith("env.md")),
    "scripts and references are listed, not read",
  );
  const loaded = new Map(first.map((p) => [p, files.get(p) ?? ""]));
  assert.deepEqual(
    filesToRead(paths, (p) => loaded.get(p)),
    [],
  );
});

test("browser-safe modules import nothing from node:", () => {
  for (const f of ["analyze", "edges", "parse", "vfs", "github", "mermaid", "types", "index"]) {
    const src = fs.readFileSync(path.join(PKG, "src", `${f}.ts`), "utf8");
    assert.ok(!/from "node:/.test(src), `${f}.ts imports node:`);
  }
});

/* ---------- GitHub sources, with a fake fetch ---------- */

function tarEntry(name: string, body: string | Uint8Array, type = "0"): Buffer {
  const data = typeof body === "string" ? Buffer.from(body) : Buffer.from(body);
  const h = Buffer.alloc(512);
  h.write(name.slice(0, 100), 0);
  h.write("0000644\0", 100);
  h.write("0000000\0", 108);
  h.write("0000000\0", 116);
  h.write(data.length.toString(8).padStart(11, "0") + "\0", 124);
  h.write("00000000000\0", 136);
  h.write("        ", 148);
  h.write(type, 156);
  h.write("ustar\0", 257);
  h.write("00", 263);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
  return Buffer.concat([h, data, Buffer.alloc((512 - (data.length % 512)) % 512)]);
}

function pax(fields: Record<string, string>): string {
  return Object.entries(fields)
    .map(([k, v]) => {
      const rest = ` ${k}=${v}\n`;
      let n = rest.length;
      while (`${n}${rest}`.length !== n) n = `${n}${rest}`.length;
      return `${n}${rest}`;
    })
    .join("");
}

const SHA = "0123456789abcdef0123456789abcdef01234567";

function fixtureTarball(): Buffer {
  const top = "acme-lib-0123456";
  const parts = [tarEntry("pax_global_header", pax({ comment: SHA }), "g"), tarEntry(`${top}/`, "", "5")];
  for (const [p, text] of fixtureFiles()) {
    const full = `${top}/${p}`;
    if (full.length > 100) parts.push(tarEntry("././@PaxHeader", pax({ path: full }), "x"));
    parts.push(tarEntry(full.slice(0, 100), text));
  }
  parts.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(parts));
}

type Handler = (url: string, init?: RequestInit) => Response;
function fakeFetch(handler: Handler) {
  const calls: string[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    return handler(url, init);
  }) as typeof fetch;
  return { f, calls };
}

test("untar reads ustar, pax paths and the global sha comment", () => {
  const long = "a/" + "x".repeat(120) + "/SKILL.md";
  const tar = Buffer.concat([
    tarEntry("pax_global_header", pax({ comment: SHA }), "g"),
    tarEntry("././@PaxHeader", pax({ path: long }), "x"),
    tarEntry(long.slice(0, 100), "hello"),
    tarEntry("a/link", "", "2"),
    Buffer.alloc(1024),
  ]);
  const out = untar(new Uint8Array(tar));
  assert.equal(out.globalComment, SHA);
  assert.deepEqual(
    out.files.map((f) => [f.path, Buffer.from(f.data).toString()]),
    [[long, "hello"]],
  );
});

test("loadGitHub via tarball: one API request, repo-relative paths, sha in blob links", async () => {
  const tgz = fixtureTarball();
  const { f, calls } = fakeFetch((url) =>
    url.includes("/tarball/") ? new Response(new Uint8Array(tgz)) : new Response("", { status: 500 }),
  );
  const g = await loadGitHub("https://github.com/acme/lib", { via: "tarball", fetch: f });
  assert.deepEqual(calls, ["https://api.github.com/repos/acme/lib/tarball/HEAD"]);
  assert.equal(g.meta.source.kind, "github");
  if (g.meta.source.kind !== "github") return;
  assert.equal(g.meta.source.sha, SHA);
  assert.equal(g.meta.source.blobBase, `https://github.com/acme/lib/blob/${SHA}/`);
  assert.equal(g.nodes.find((n) => n.id === "review")?.file, "skills/review/SKILL.md");
  assert.equal(g.parts.length, graph.parts.length);
  assert.equal(g.links.length, graph.links.length);
});

test("loadGitHub via tree: one API request, raw downloads only for files it reads, slash branches", async () => {
  const files = fixtureFiles();
  const tree = { tree: [...files.keys()].map((p) => ({ path: p, type: "blob" })), truncated: false };
  const { f, calls } = fakeFetch((url) => {
    if (url.startsWith("https://api.github.com/repos/acme/lib/git/trees/feat?"))
      return new Response("{}", { status: 404 });
    if (url.startsWith("https://api.github.com/repos/acme/lib/git/trees/feat/x?recursive=1"))
      return Response.json(tree);
    const raw = /^https:\/\/raw\.githubusercontent\.com\/acme\/lib\/feat\/x\/(.+)$/.exec(url);
    if (raw && files.has(decodeURIComponent(raw[1]))) return new Response(files.get(decodeURIComponent(raw[1])));
    return new Response("nope", { status: 404 });
  });
  const g = await loadGitHub("https://github.com/acme/lib/tree/feat/x/plugins/toolkit", { fetch: f });
  assert.equal(
    calls.filter((u) => u.startsWith("https://api.github.com")).length,
    2,
    "one miss for branch 'feat', one hit for 'feat/x'",
  );
  assert.ok(!calls.some((u) => u.endsWith(".sh") || u.endsWith(".mjs")), "scripts are never downloaded");
  assert.ok(
    !calls.some((u) => u.endsWith("skills/review/SKILL.md") && !u.includes("plugins/")),
    "files outside the subpath are not downloaded",
  );
  assert.equal(g.meta.source.kind === "github" && g.meta.source.ref, "feat/x");
  assert.equal(g.meta.source.kind === "github" && g.meta.source.subpath, "plugins/toolkit");
  assert.deepEqual(
    g.nodes.map((n) => [n.id, n.file]),
    [
      ["deploy", "plugins/toolkit/skills/deploy/SKILL.md"],
      ["review", "plugins/toolkit/skills/review/SKILL.md"],
    ],
  );
  assert.equal(g.plugins[0]?.id, "plugin:toolkit");
  assert.deepEqual(g.meta.warnings, []);
});

test("loadGitHub reports rate limits and missing repos as GitHubError", async () => {
  const limited = fakeFetch(
    () =>
      new Response("{}", { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1700000000" } }),
  );
  await assert.rejects(
    loadGitHub("acme/lib", { fetch: limited.f }),
    (e: unknown) => e instanceof GitHubError && e.rateLimitReset === 1700000000 && /rate limit/.test(e.message),
  );
  const missing = fakeFetch(() => new Response("{}", { status: 404 }));
  await assert.rejects(
    loadGitHub("acme/lib", { fetch: missing.f }),
    (e: unknown) => e instanceof GitHubError && e.status === 404,
  );
  await assert.rejects(
    loadGitHub("not a repo", { fetch: missing.f }),
    (e: unknown) => e instanceof GitHubError && e.status === 400,
  );
});
