// build --artifacts: one deterministic archive per built plugin under artifacts/, the record of what each is
// (releases.json), and a note when the recorded ChatGPT release holds a file the new archive lacks (<id>.changes.md).
// The archives are read back here by a reader written from the ZIP specification, not by the tool's own code.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, test } from "vite-plus/test";
import zlib from "node:zlib";

let base: string;
let root: string;
let homeDir: string;
let up: Repo;
let library: Repo;

const CLI = path.resolve(import.meta.dirname, "..", "dist", "src", "cli.js");
const HARNESS_ENV = ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "XDG_CONFIG_HOME", "HERMES_HOME"] as const;
const GIT = ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false"];

/** Run the CLI against the temp library, home redirected into the temp folder, every harness override dropped. */
function cli(...args: string[]): { status: number | null; stdout: string; stderr: string } {
  return cliIn(root, ...args);
}

/** The same against another library folder: a clone. */
function cliIn(repo: string, ...args: string[]): { status: number | null; stdout: string; stderr: string } {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: homeDir, USERPROFILE: homeDir };
  for (const k of HARNESS_ENV) delete env[k];
  return spawnSync(process.execPath, [CLI, ...args, "--repo", repo], { encoding: "utf8", cwd: repo, env });
}

/** A temp git repository: the library itself, a source standing in for upstream, or (init false) a clone already there. */
class Repo {
  constructor(public dir: string, init = true) {
    if (!init) return;
    fs.mkdirSync(dir, { recursive: true });
    this.git("init", "-q", "-b", "main");
  }
  git(...args: string[]): string {
    const r = spawnSync("git", [...GIT, "-C", this.dir, ...args], { encoding: "utf8" });
    assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  }
  commit(msg: string): string {
    this.git("add", "-A");
    this.git("commit", "-q", "-m", msg);
    return this.git("rev-parse", "HEAD");
  }
}

function write(rel: string, text: string | Buffer): void {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
}

function json(rel: string): any {
  return JSON.parse(fs.readFileSync(path.join(root, rel), "utf8"));
}

function skillMd(name: string, body = "body"): string {
  return `---\nname: ${name}\ndescription: ${name} skill\n---\n${body}\n`;
}

/** Every file under a folder of the library, relative path with / separators -> bytes. */
function files(rel: string): Map<string, Buffer> {
  return filesIn(path.join(root, rel));
}

function filesIn(dir: string): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else out.set(path.relative(dir, full).split("\\").join("/"), fs.readFileSync(full));
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out;
}

function artifacts(): string[] {
  return fs.existsSync(path.join(root, "artifacts")) ? fs.readdirSync(path.join(root, "artifacts")).sort() : [];
}

function sha256(b: Buffer): string {
  return createHash("sha256").update(b).digest("hex");
}

interface Entry {
  name: string;
  method: number;
  flags: number;
  time: number;
  date: number;
  crc: number;
  data: Buffer;
}

/**
 * The entries of a ZIP, read from its central directory as the specification lays it out (APPNOTE 4.3.7, 4.3.12,
 * 4.3.16), each checked against its local header. No comment, no ZIP64: the end record is the last 22 bytes.
 */
function unzip(buf: Buffer): Entry[] {
  const end = buf.length - 22;
  assert.equal(buf.readUInt32LE(end), 0x06054b50, "end of central directory record");
  const count = buf.readUInt16LE(end + 10);
  assert.equal(buf.readUInt16LE(end + 8), count, "one disk");
  let at = buf.readUInt32LE(end + 16);
  assert.equal(at + buf.readUInt32LE(end + 12), end, "the central directory ends where the end record starts");
  const out: Entry[] = [];
  let expectLocal = 0;
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(at), 0x02014b50, "central directory header");
    const [flags, method, time, date] = [8, 10, 12, 14].map((o) => buf.readUInt16LE(at + o));
    const [crc, csize, size] = [16, 20, 24].map((o) => buf.readUInt32LE(at + o));
    const [nameLen, extraLen, commentLen] = [28, 30, 32].map((o) => buf.readUInt16LE(at + o));
    const local = buf.readUInt32LE(at + 42);
    const name = buf.toString("utf8", at + 46, at + 46 + nameLen);
    assert.equal(local, expectLocal, `${name}: local headers follow one another with no gap`);
    assert.equal(buf.readUInt32LE(local), 0x04034b50, `${name}: local file header`);
    assert.deepEqual([6, 8, 10, 12].map((o) => buf.readUInt16LE(local + o)), [flags, method, time, date], `${name}: local header agrees`);
    assert.deepEqual([14, 18, 22].map((o) => buf.readUInt32LE(local + o)), [crc, csize, size], `${name}: local sizes and crc agree`);
    const [localNameLen, localExtraLen] = [26, 28].map((o) => buf.readUInt16LE(local + o));
    assert.equal(buf.toString("utf8", local + 30, local + 30 + localNameLen), name);
    assert.equal(csize, size, `${name}: stored, not compressed`);
    const start = local + 30 + localNameLen + localExtraLen;
    out.push({ name, method, flags, time, date, crc, data: buf.subarray(start, start + csize) });
    expectLocal = start + csize;
    at += 46 + nameLen + extraLen + commentLen;
  }
  assert.equal(at, end, "nothing between the last central header and the end record");
  return out;
}

const CONFIG = (extra: Record<string, unknown> = {}) => ({
  version: 1,
  library: { name: "skills", owner: "oneezy", homepage: "https://github.com/oneezy/skills" },
  sources: { up: { repo: up.dir, ref: "main", root: "skills", skills: ["a", "b"], attribution: ["LICENSE"] } },
  plugins: {
    oneezy: { displayName: "Oneezy", description: "Justin's own skills.", group: "oneezy" },
    up: { displayName: "Up", description: "Up's skills, following main.", source: "up" },
  },
  ...extra,
});

function config(extra: Record<string, unknown> = {}): void {
  write("skills-sync.json", JSON.stringify(CONFIG(extra), null, 2) + "\n");
}

beforeAll(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "skills-sync-artifacts-"));
});
afterAll(() => {
  fs.rmSync(base, { recursive: true, force: true });
});
beforeEach(() => {
  for (const n of fs.readdirSync(base)) fs.rmSync(path.join(base, n), { recursive: true, force: true });
  root = path.join(base, "dev", "skills");
  homeDir = path.join(base, "home");
  fs.mkdirSync(homeDir);
  up = new Repo(path.join(base, "up"));
  for (const n of ["a", "b"]) {
    fs.mkdirSync(path.join(up.dir, "skills", n), { recursive: true });
    fs.writeFileSync(path.join(up.dir, "skills", n, "SKILL.md"), skillMd(n));
  }
  fs.writeFileSync(path.join(up.dir, "LICENSE"), "MIT License\n\nPermission is hereby granted, free of charge, to any person\n");
  up.commit("one");

  library = new Repo(root);
  write(".gitignore", ".agents/skills/\n.claude/skills/\nupstream/\nartifacts/\nskills-sync.local.json\n");
  write("skills/oneezy/own-one/SKILL.md", skillMd("own-one"));
  write("skills/oneezy/own-one/scripts/run.sh", "#!/bin/sh\necho ünïcode\n");
  write("skills/oneezy/own-one/assets/dot.bin", Buffer.from([0, 255, 13, 10, 0, 1, 2, 3]));
  write("skills/oneezy/own-two/SKILL.md", skillMd("own-two"));
  config();
  assert.equal(cli("refresh", "--quiet").status, 0);
  library.commit("library");
});

test("build --artifacts writes artifacts/<id>-<version>.zip for each built plugin: a store-only ZIP holding the package under one folder named after the plugin, entries sorted by path with forward slashes and no directory entries, every timestamp 1980-01-01 00:00, each entry the bytes of the package file with its CRC-32", () => {
  const r = cli("build", "--plugins", "--catalogs", "--artifacts", "--json");
  assert.equal(r.status, 0, r.stderr);
  const version = `0.1.0+${library.git("rev-parse", "--short=12", "HEAD")}`;
  assert.deepEqual(artifacts(), [`oneezy-${version}.zip`, "releases.json", `up-${version}.zip`]);
  for (const id of ["oneezy", "up"]) {
    const entries = unzip(fs.readFileSync(path.join(root, "artifacts", `${id}-${version}.zip`)));
    const pkg = files(`plugins/${id}`);
    const names = entries.map((e) => e.name);
    assert.deepEqual(names, [...pkg.keys()].map((k) => `${id}/${k}`).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)), "every package file, under <id>/, sorted by path");
    assert.ok(names.every((n) => !n.includes("\\") && !n.endsWith("/")), "forward slashes, directories implicit");
    for (const e of entries) {
      assert.equal(e.method, 0, `${e.name}: stored`);
      assert.equal(e.time, 0, `${e.name}: 00:00:00`);
      assert.equal(e.date, 0x21, `${e.name}: 1980-01-01 (year 0, month 1, day 1 in DOS form)`);
      assert.equal(e.flags, 0x0800, `${e.name}: the name is UTF-8, nothing else set`);
      assert.ok(e.data.equals(pkg.get(e.name.slice(id.length + 1))!), `${e.name}: the package file's bytes`);
      assert.equal(e.crc, zlib.crc32(e.data), `${e.name}: CRC-32`);
    }
  }
  assert.ok(unzip(fs.readFileSync(path.join(root, "artifacts", `oneezy-${version}.zip`))).some((e) => e.name === "oneezy/skills/own-one/assets/dot.bin"), "a binary file travels as it is");
  assert.deepEqual(fs.readdirSync(homeDir), [], "nothing written outside the library");
});

const ALL = ["build", "--plugins", "--catalogs", "--artifacts"];

/** The actions of a --json run that touch a file: neither a skip, a note nor a conflict. */
function changes(r: { stdout: string }): Array<{ kind: string; path: string; note?: string }> {
  return (JSON.parse(r.stdout).actions as Array<{ kind: string; path: string; note?: string }>).filter((a) => a.kind !== "skip" && a.kind !== "note" && a.kind !== "conflict");
}

function same(a: Map<string, Buffer>, b: Map<string, Buffer>): boolean {
  return a.size === b.size && [...a].every(([k, v]) => b.get(k)?.equals(v));
}

test("two builds of the same input give byte-identical archives and record, from nothing each time; a second run rewrites nothing; a library commit that touches no input changes no archive; after one own skill changes only its package and its archive change: the other plugin's archive keeps its name and bytes, and the changed plugin's older archive is removed", () => {
  assert.equal(cli(...ALL, "--quiet").status, 0);
  const first = files("artifacts");
  const v1 = `0.1.0+${library.git("rev-parse", "--short=12", "HEAD")}`;
  assert.deepEqual([...first.keys()].sort(), [`oneezy-${v1}.zip`, "releases.json", `up-${v1}.zip`]);

  // the same input, built again with no output of the first build left
  for (const d of ["artifacts", "plugins", ".claude-plugin", ".agents/plugins"]) fs.rmSync(path.join(root, d), { recursive: true });
  assert.equal(cli(...ALL, "--quiet").status, 0);
  assert.ok(same(files("artifacts"), first), "byte-identical archives and releases.json");
  // and the archives alone, from the packages on disk
  fs.rmSync(path.join(root, "artifacts"), { recursive: true });
  assert.equal(cli("build", "--artifacts", "--quiet").status, 0);
  assert.ok(same(files("artifacts"), first));

  const again = cli(...ALL, "--json");
  assert.equal(again.status, 0, again.stderr);
  assert.deepEqual(changes(again), [], "a second run writes nothing");

  // the build is committed; HEAD moves; no package input did: the archives stay as they are
  library.commit("built");
  assert.deepEqual(changes(cli(...ALL, "--json")), []);
  assert.ok(same(files("artifacts"), first));

  // one own skill edited and committed
  const upPackage = files("plugins/up");
  write("skills/oneezy/own-one/SKILL.md", skillMd("own-one", "edited"));
  library.commit("edit own-one");
  const edited = cli(...ALL, "--json");
  assert.equal(edited.status, 0, edited.stderr);
  const v3 = `0.2.0+${library.git("rev-parse", "--short=12", "HEAD")}`;
  const after = files("artifacts");
  assert.deepEqual([...after.keys()].sort(), [`oneezy-${v3}.zip`, "releases.json", `up-${v1}.zip`], "the older oneezy archive is gone");
  assert.ok(after.get(`up-${v1}.zip`)!.equals(first.get(`up-${v1}.zip`)!), "the untouched plugin's archive: same name, same bytes");
  assert.ok(same(files("plugins/up"), upPackage), "and its package");
  assert.ok(!after.get(`oneezy-${v3}.zip`)!.equals(first.get(`oneezy-${v1}.zip`)!));
  const touched = changes(edited).map((a) => `${a.kind} ${path.relative(root, a.path).split("\\").join("/")}`).sort();
  assert.deepEqual(touched, [
    `delete artifacts/oneezy-${v1}.zip`,
    `write artifacts/oneezy-${v3}.zip`,
    "write artifacts/releases.json",
    "write plugins/oneezy/.codex-plugin/plugin.json",
    "write plugins/oneezy/NOTICE.md",
    "write plugins/oneezy/plugin.json",
    "write plugins/oneezy/skills/own-one/SKILL.md",
  ]);
  const before = JSON.parse(first.get("releases.json")!.toString("utf8")).plugins;
  const now = json("artifacts/releases.json").plugins;
  assert.deepEqual(now.up, before.up, "the untouched plugin's record is the same");
  assert.notEqual(now.oneezy.sha256, before.oneezy.sha256);
  assert.equal(now.oneezy.version, v3);
});

const MIT = "MIT License\n\nCopyright (c) 2026 oneezy\n\nPermission is hereby granted, free of charge, to any person obtaining a copy\n";

test("the archives do not depend on the checkout's line endings: a clone git converts to CRLF (core.autocrlf=true) and one it leaves as committed (core.autocrlf=false) give the archives and the record of the library they were cloned from, byte for byte; every text file is archived with LF, a shell script and the library's LICENSE among them, and so is one committed with CRLF, in the library or upstream; a binary file and a file with mixed line endings travel as they are; the working set keeps upstream's bytes", () => {
  // both repositories commit byte for byte here, whatever this machine's git settings say, so a CRLF file can be committed as one
  library.git("config", "core.autocrlf", "false");
  up.git("config", "core.autocrlf", "false");
  fs.writeFileSync(path.join(up.dir, "skills", "a", "windows.txt"), "upstream\r\nwith CRLF\r\n");
  up.commit("a CRLF file");
  const bin = Buffer.from([0, 255, 13, 10, 0, 1, 2, 3]);
  // binary without a NUL byte: control characters, and CR LF pairs that are data
  const controls = Buffer.from([1, 2, 3, 13, 10, 4, 5, 6, 7, 14, 15, 16, 13, 10]);
  write("skills/oneezy/own-one/assets/controls.bin", controls);
  write("LICENSE", MIT);
  write("skills/oneezy/own-one/notes/crlf.txt", "one\r\ntwo\r\n");
  write("skills/oneezy/own-one/notes/mixed.txt", "one\r\ntwo\nthree\r\n");
  assert.equal(cli("refresh", "--quiet").status, 0);
  assert.equal(cli(...ALL, "--quiet").status, 0);
  library.commit("built");
  const version = json("plugins/oneezy/plugin.json").version;
  const first = files("artifacts");
  assert.deepEqual([...first.keys()].sort(), [`oneezy-${version}.zip`, "releases.json", `up-${version}.zip`]);
  assert.equal(fs.readFileSync(path.join(root, ".agents", "skills", "a", "windows.txt"), "utf8"), "upstream\r\nwith CRLF\r\n", "the working set is upstream's bytes");

  for (const autocrlf of ["true", "false"]) {
    const clone = path.join(base, `clone-${autocrlf}`);
    library.git("clone", "-q", "-c", `core.autocrlf=${autocrlf}`, root, clone);
    const at = new Repo(clone, false);
    const eol = new Map(at.git("ls-files", "--eol").split(/\r?\n/).map((l) => [l.split("\t")[1], l.split(/\s+/).slice(0, 2).join(" ")]));
    const converted = autocrlf === "true" ? "i/lf w/crlf" : "i/lf w/lf";
    for (const f of ["LICENSE", "skills/oneezy/own-one/SKILL.md", "skills/oneezy/own-one/scripts/run.sh"]) assert.equal(eol.get(f), converted, `${f} in the core.autocrlf=${autocrlf} clone`);
    assert.equal(eol.get("skills/oneezy/own-one/notes/crlf.txt"), "i/crlf w/crlf");
    assert.equal(cliIn(clone, "refresh", "--frozen", "--quiet").status, 0, "the snapshot and working set from the lock");
    const r = cliIn(clone, "build", "--artifacts", "--json");
    assert.equal(r.status, 0, r.stderr);
    const built = filesIn(path.join(clone, "artifacts"));
    for (const id of ["oneezy", "up"]) {
      const name = `${id}-${version}.zip`;
      assert.ok(built.has(name), `core.autocrlf=${autocrlf}: ${name} among ${[...built.keys()].join(", ")}`);
      const want = new Map(unzip(first.get(name)!).map((e) => [e.name, e.data]));
      const differ = unzip(built.get(name)!).filter((e) => !want.get(e.name)?.equals(e.data)).map((e) => e.name);
      assert.deepEqual(differ, [], `core.autocrlf=${autocrlf}: entries of ${name} that differ from the first build's`);
    }
    assert.ok(same(built, first), `core.autocrlf=${autocrlf}: the same archives and releases.json, byte for byte`);
    assert.equal(cliIn(clone, "build", "--check").status, 0, "and the clone is as built");
    assert.equal(at.git("status", "--porcelain"), "");

    const own = new Map(unzip(built.get(`oneezy-${version}.zip`)!).map((e) => [e.name, e.data]));
    assert.equal(own.get("oneezy/skills/own-one/scripts/run.sh")!.toString("utf8"), "#!/bin/sh\necho ünïcode\n", "a script reaches Linux with LF");
    assert.equal(own.get("oneezy/skills/own-one/SKILL.md")!.toString("utf8"), "---\nname: own-one\ndescription: own-one skill\nmetadata:\n  internal: true\n---\nbody\n");
    assert.equal(own.get("oneezy/LICENSE")!.toString("utf8"), MIT);
    assert.equal(own.get("oneezy/skills/own-one/notes/crlf.txt")!.toString("utf8"), "one\ntwo\n", "committed with CRLF: LF in the package");
    assert.equal(own.get("oneezy/skills/own-one/notes/mixed.txt")!.toString("utf8"), "one\r\ntwo\nthree\r\n", "mixed line endings: as it is");
    assert.ok(own.get("oneezy/skills/own-one/assets/dot.bin")!.equals(bin), "a binary file: as it is, its CR LF pair too");
    assert.ok(own.get("oneezy/skills/own-one/assets/controls.bin")!.equals(controls), "and one without a NUL byte");
    const source = new Map(unzip(built.get(`up-${version}.zip`)!).map((e) => [e.name, e.data]));
    assert.equal(source.get("up/skills/a/windows.txt")!.toString("utf8"), "upstream\nwith CRLF\n", "a third-party file committed with CRLF: LF in the package");
  }
  // the committed package is the same form: what an archive holds is what plugins/<id> holds
  assert.equal(files("plugins/oneezy").get("skills/own-one/notes/crlf.txt")!.toString("utf8"), "one\ntwo\n");
  assert.equal(files("plugins/up").get("skills/a/windows.txt")!.toString("utf8"), "upstream\nwith CRLF\n");
});

test("artifacts/releases.json records per plugin its archive, sha256, version, source commit, entries and the last release the config records (null without one); artifacts/<id>.changes.md appears only when that release's files name a file the new archive lacks, lists them and says the upload must be a new plugin, not an overlay; it goes once the record names no such file", () => {
  const sha = "a".repeat(64);
  const recorded = { plugin_id: "plugin_up", release_id: "rel_7", sha256: sha, scope: "personal", date: "2026-09-30", files: ["up/plugin.json", "up/skills/a/SKILL.md", "up/skills/old-name/SKILL.md", "skills/b/SKILL.md", "skills/removed/notes.md"] };
  const own = { plugin_id: "plugin_own", release_id: "rel_1", sha256: sha, scope: "personal", date: "2026-09-30" };
  config({ releases: { up: recorded, oneezy: own } });
  const head = library.commit("releases");
  assert.equal(cli(...ALL, "--quiet").status, 0);
  const version = `0.1.0+${library.git("rev-parse", "--short=12", "HEAD")}`;
  assert.deepEqual(artifacts(), [`oneezy-${version}.zip`, "releases.json", `up-${version}.zip`, "up.changes.md"]);

  const record = json("artifacts/releases.json");
  assert.deepEqual(Object.keys(record), ["plugins"]);
  assert.deepEqual(Object.keys(record.plugins), ["oneezy", "up"]);
  for (const id of ["oneezy", "up"]) {
    const r = record.plugins[id];
    assert.deepEqual(Object.keys(r), ["archive", "sha256", "version", "commit", "files", "release"]);
    assert.equal(r.archive, `artifacts/${id}-${version}.zip`);
    const bytes = fs.readFileSync(path.join(root, r.archive));
    assert.equal(r.sha256, sha256(bytes));
    assert.equal(r.version, json(`plugins/${id}/plugin.json`).version);
    assert.deepEqual(r.files, unzip(bytes).map((e) => e.name));
  }
  assert.equal(record.plugins.up.commit, up.git("rev-parse", "HEAD"), "a source plugin: the upstream commit");
  assert.equal(record.plugins.oneezy.commit, head, "an own plugin: the library commit it was built at");
  assert.deepEqual(record.plugins.up.release, recorded);
  assert.deepEqual(record.plugins.oneezy.release, own);

  const note = fs.readFileSync(path.join(root, "artifacts", "up.changes.md"), "utf8");
  assert.deepEqual(note.split("\n").filter((l) => l.startsWith("- ")), ["- `skills/removed/notes.md`", "- `up/skills/old-name/SKILL.md`"], "only the files the archive lacks; a recorded path counts with or without the <id>/ folder");
  assert.match(note, /plugin_up/);
  assert.match(note, /rel_7/);
  assert.ok(note.includes(`artifacts/up-${version}.zip`), "names the archive to upload");
  assert.match(note, /new plugin/);
  assert.match(note, /not as an update/);
  assert.match(note, /overlay/);
  assert.ok(!fs.existsSync(path.join(root, "artifacts", "oneezy.changes.md")), "a release without files, or with every file still there, gets no note");

  // the record corrected: nothing lacking, the note goes; a plugin without a recorded release says null
  config({ releases: { up: { ...recorded, files: ["up/plugin.json", "skills/a/SKILL.md"] } } });
  const fixed = cli("build", "--artifacts", "--json");
  assert.equal(fixed.status, 0, fixed.stderr);
  assert.deepEqual(artifacts(), [`oneezy-${version}.zip`, "releases.json", `up-${version}.zip`]);
  assert.deepEqual(changes(fixed).map((a) => `${a.kind} ${path.basename(a.path)}`).sort(), ["delete up.changes.md", "write releases.json"]);
  assert.equal(json("artifacts/releases.json").plugins.oneezy.release, null);
});

test("artifacts are upload material, apart from the committed form: --artifacts alone writes no package and no catalog; a check never reads or writes artifacts/; --plan writes nothing; generate.plugins false writes nothing; a link inside a skill folder is left out of the archive with a report line; an older archive or a stale note goes, any other file in artifacts/ is left alone", () => {
  const alone = cli("build", "--artifacts", "--json");
  assert.equal(alone.status, 0, alone.stderr);
  const version = `0.1.0+${library.git("rev-parse", "--short=12", "HEAD")}`;
  assert.deepEqual(artifacts(), [`oneezy-${version}.zip`, "releases.json", `up-${version}.zip`]);
  assert.ok(!fs.existsSync(path.join(root, "plugins")), "--artifacts alone builds no package");
  assert.ok(!fs.existsSync(path.join(root, ".claude-plugin")), "and no catalog");
  const archive = () => unzip(fs.readFileSync(path.join(root, "artifacts", `oneezy-${version}.zip`))).map((e) => e.name);
  assert.ok(archive().includes("oneezy/plugin.json") && archive().includes("oneezy/skills/own-one/scripts/run.sh"), "the archive holds the package build would write");

  // a check: artifacts/ is neither drift nor touched, whatever it holds
  assert.equal(cli("build", "--quiet").status, 0);
  write("artifacts/releases.json", "{}\n");
  fs.rmSync(path.join(root, "artifacts", `up-${version}.zip`));
  write("artifacts/notes.txt", "mine");
  const before = files("artifacts");
  for (const args of [["build", "--check"], ["build", "--check", "--artifacts"], ["check"]]) {
    const r = cli(...args);
    assert.equal(r.status, 0, `${args.join(" ")}: ${r.stdout}`);
    assert.doesNotMatch(r.stdout + r.stderr, /artifacts[\\/]/, `${args.join(" ")} names nothing under artifacts/`);
    assert.ok(same(files("artifacts"), before), `${args.join(" ")} wrote nothing under artifacts/`);
  }
  assert.deepEqual(JSON.parse(cli("build", "--check", "--artifacts", "--json").stdout).drift, []);

  // --plan says what it would write and writes nothing
  fs.rmSync(path.join(root, "artifacts"), { recursive: true });
  const plan = cli("build", "--artifacts", "--plan");
  assert.equal(plan.status, 0, plan.stderr);
  assert.ok(plan.stdout.includes(`oneezy-${version}.zip`) && /^plan: 3 would change/m.test(plan.stdout), plan.stdout);
  assert.deepEqual(artifacts(), []);

  // the plugin form switched off: nothing is built, so there is nothing to archive
  config({ generate: { skills: true, plugins: false } });
  assert.equal(cli("build", "--artifacts").status, 0);
  assert.deepEqual(artifacts(), []);
  config();

  // a link inside a skill folder: never followed, so not in the archive; one report line says so
  const link = path.join(root, "skills", "oneezy", "own-two", "linked");
  fs.symlinkSync(path.join(root, "skills", "oneezy", "own-one", "scripts"), link, "junction");
  const linked = cli("build", "--artifacts", "--json");
  assert.equal(linked.status, 0, linked.stderr);
  assert.ok((JSON.parse(linked.stdout).actions as Array<{ kind: string; path: string; note?: string }>).some((a) => a.kind === "note" && a.path === link && /a link; not copied/.test(a.note ?? "")), linked.stdout);
  assert.ok(!archive().some((n) => n.startsWith("oneezy/skills/own-two/linked")), "the link's files are not in the archive");
  assert.ok(archive().includes("oneezy/skills/own-two/SKILL.md"));
  fs.rmSync(link);

  // what the build owns in artifacts/ and no longer produces goes; anything else stays
  write("artifacts/oneezy-0.0.0+nogit.zip", "an older archive");
  write("artifacts/gone-0.7.0+0123456789ab.zip", "a plugin no longer in the config");
  write("artifacts/gone.changes.md", "a stale note");
  write("artifacts/notes.txt", "mine");
  write("artifacts/backup.zip", "not an archive of the rule");
  const pruned = cli("build", "--artifacts", "--json");
  assert.equal(pruned.status, 0, pruned.stderr);
  assert.deepEqual(artifacts(), ["backup.zip", "notes.txt", `oneezy-${version}.zip`, "releases.json", `up-${version}.zip`]);
  assert.deepEqual(changes(pruned).filter((a) => a.kind === "delete").map((a) => path.basename(a.path)).sort(), ["gone-0.7.0+0123456789ab.zip", "gone.changes.md", "oneezy-0.0.0+nogit.zip"]);

  // a plugin of the config that cannot be built this run (its snapshot is not there) keeps the archive it has, as its package is kept
  fs.rmSync(path.join(root, "upstream"), { recursive: true });
  const partial = cli("build", "--artifacts", "--json");
  assert.equal(partial.status, 1, "a package that cannot be built fails the run");
  assert.deepEqual(artifacts(), ["backup.zip", "notes.txt", `oneezy-${version}.zip`, "releases.json", `up-${version}.zip`]);
  assert.deepEqual(Object.keys(json("artifacts/releases.json").plugins), ["oneezy"], "the record names what this run built");
});
