// A stand-in for api.github.com, started in-process by a test and named to the CLI through SKILLS_SYNC_GITHUB_API.
// It serves the REST calls the machine commands make (the latest release and its assets, a release by tag, a file at
// a commit) from a fixture: a small library whose release.json is computed in the real schema-3 shape, with real
// sha256 digests of the fixture bytes. Every request is recorded (method, path, the headers that matter) so a test
// can say "status only read" or "--plan wrote nothing". Assets redirect like GitHub's do, so the client's redirect
// following is exercised too.
import { createHash } from "node:crypto";
import http from "node:http";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/**
 * One release of a fixture library, as .github/scripts/release.mjs in oneezy/skills would cut it. `plugins` maps a
 * plugin id to { version (a string, or null for an unversioned source), skills (folder names), files (extra
 * path -> text) }. The bytes of every file are kept so a test can lay the same plugin down on the pretend machine.
 * `toolVersion` (release-18 on) is the skills-sync version the release was built with, written as tool.version; left
 * undefined, the release carries the older tool.commit shape of release-17 and before.
 */
export function fixtureRelease({ repo = "oneezy/skills", number, previous = null, commit, plugins, toolVersion }) {
  const tag = `release-${number}`;
  const out = {};
  const built = {};
  for (const [id, p] of Object.entries(plugins)) {
    const files = new Map();
    const version = p.version ?? null;
    const manifest = {
      $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
      name: id,
      ...(version ? { version } : {}),
      description: `${id} plugin`,
    };
    files.set("plugin.json", Buffer.from(JSON.stringify(manifest, null, 2) + "\n"));
    // the library's Claude manifest carries no version, so `claude plugin list` prints "unknown" for it
    files.set(".claude-plugin/plugin.json", Buffer.from(JSON.stringify({ name: id, description: `${id} plugin` }, null, 2) + "\n"));
    files.set(
      ".codex-plugin/plugin.json",
      Buffer.from(JSON.stringify({ name: id, ...(version ? { version } : {}), skills: "./skills/" }, null, 2) + "\n"),
    );
    files.set("NOTICE.md", Buffer.from(`# ${id}\n\nBuilt by skills-sync from ${repo}.\n`));
    for (const s of p.skills)
      files.set(
        `skills/${s}/SKILL.md`,
        Buffer.from(`---\nname: ${s}\ndescription: ${s} skill\nmetadata:\n  internal: true\n---\n${s} body (${version ?? "unversioned"})\n`),
      );
    for (const [rel, text] of Object.entries(p.files ?? {})) files.set(rel, Buffer.from(text));
    const digests = Object.fromEntries(
      [...files].sort(([a], [b]) => a.localeCompare(b)).map(([rel, bytes]) => [rel, sha256(bytes)]),
    );
    const content = sha256(JSON.stringify(digests));
    out[id] = {
      version,
      versionScheme: p.versionScheme ?? "authored",
      commit,
      archive: `${id}-${version ?? "unversioned"}.zip`,
      sha256: sha256(`zip:${id}:${content}`),
      content,
      files: digests,
    };
    built[id] = { files };
  }
  const json = {
    schema: 3,
    release: tag,
    number,
    previous,
    source: { repo, commit, tree: sha256(`tree:${commit}`) },
    tool:
      toolVersion === undefined
        ? { repo: "oneezy/tools", package: "@oneezy/skills-sync", commit: sha256(`tool:${number}`) }
        : { repo: "oneezy/tools", package: "@oneezy/skills-sync", version: toolVersion },
    digests: { "skills-sync.json": sha256(`config:${number}`), "skills-sync.lock.json": sha256(`lock:${number}`) },
    content: sha256(JSON.stringify(Object.values(out).map((p) => p.content))),
    changes: { added: [], changed: Object.keys(plugins), removed: [] },
    plugins: out,
  };
  return { tag, number, commit, json, plugins: built };
}

/**
 * The default fixture library: three plugins with a couple of skills each, released twice. release-16 is the older
 * cut; release-17 bumps oneezy and matt-pocock and leaves play as it was, so a machine on release-16 is behind.
 */
export function fixtureLibrary(repo = "oneezy/skills") {
  const r16 = fixtureRelease({
    repo,
    number: 16,
    previous: "release-15",
    commit: "1616161616161616161616161616161616161616",
    plugins: {
      oneezy: { version: "0.43.0", skills: ["oneezy-merge", "oneezy-status"] },
      "matt-pocock": { version: "1.3.0", skills: ["grilling", "tdd"] },
      play: { version: "0.43.0", skills: ["play-unslop"] },
    },
  });
  const r17 = fixtureRelease({
    repo,
    number: 17,
    previous: "release-16",
    commit: "1717171717171717171717171717171717171717",
    plugins: {
      oneezy: { version: "0.43.1", skills: ["oneezy-merge", "oneezy-status"] },
      "matt-pocock": { version: "1.3.1", skills: ["grilling", "tdd"] },
      play: { version: "0.43.0", skills: ["play-unslop"] },
    },
  });
  return { repo, releases: [r16, r17], contents: {} };
}

/**
 * Start the server on a free local port. `fixture.repo` is the one repository it knows; `fixture.releases` the
 * releases (the highest number is the latest); `fixture.contents[<ref>][<path>]` the files GET /contents serves;
 * `fixture.token`, when set, is the only bearer token accepted. A release with `noReleaseJson: true` is cut without
 * its release.json asset. The server is live: a test may push a release or set a flag between CLI runs.
 */
export async function startFakeGithub(fixture = fixtureLibrary()) {
  const requests = [];
  const repoPath = `/repos/${fixture.repo}`;
  const assetsOf = (rel) => {
    const list = [];
    if (!rel.noReleaseJson) list.push({ name: "release.json", type: "application/json", bytes: Buffer.from(JSON.stringify(rel.json, null, 2) + "\n") });
    for (const [id, p] of Object.entries(rel.json.plugins)) list.push({ name: p.archive, type: "application/zip", bytes: Buffer.from(`zip:${id}`) });
    return list.map((a, i) => ({ ...a, id: rel.number * 1000 + i + 1 }));
  };
  const releaseJson = (rel, base) => ({
    id: rel.number * 1000,
    tag_name: rel.tag,
    name: rel.tag,
    draft: false,
    prerelease: false,
    target_commitish: rel.commit,
    html_url: `https://github.com/${fixture.repo}/releases/tag/${rel.tag}`,
    assets: assetsOf(rel).map((a) => ({
      id: a.id,
      name: a.name,
      content_type: a.type,
      size: a.bytes.length,
      url: `${base}${repoPath}/releases/assets/${a.id}`,
      browser_download_url: `https://github.com/${fixture.repo}/releases/download/${rel.tag}/${a.name}`,
    })),
  });
  const findAsset = (id) => {
    for (const rel of fixture.releases) for (const a of assetsOf(rel)) if (a.id === id) return a;
    return null;
  };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://fake");
    requests.push({
      method: req.method,
      path: req.url,
      headers: {
        accept: req.headers.accept,
        authorization: req.headers.authorization,
        "user-agent": req.headers["user-agent"],
      },
    });
    const send = (status, body, headers = {}) => {
      const bytes = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body, null, 2));
      res.writeHead(status, {
        "content-type": Buffer.isBuffer(body) ? "application/octet-stream" : "application/json; charset=utf-8",
        "content-length": bytes.length,
        ...headers,
      });
      res.end(bytes);
    };
    const notFound = () => send(404, { message: "Not Found", documentation_url: "https://docs.github.com/rest" });
    if (fixture.token && req.headers.authorization !== `Bearer ${fixture.token}`)
      return send(401, { message: "Bad credentials", documentation_url: "https://docs.github.com/rest" });
    if (req.method !== "GET") return send(405, { message: "Method Not Allowed" });
    const base = `http://${req.headers.host}`;
    const download = /^\/_download\/(\d+)$/.exec(url.pathname);
    if (download) {
      const a = findAsset(Number(download[1]));
      return a ? send(200, a.bytes) : notFound();
    }
    if (!url.pathname.startsWith(repoPath + "/")) return notFound();
    const rest = url.pathname.slice(repoPath.length);
    const sorted = [...fixture.releases].sort((a, b) => b.number - a.number);
    if (rest === "/releases/latest") return sorted.length ? send(200, releaseJson(sorted[0], base)) : notFound();
    const byTag = /^\/releases\/tags\/([^/]+)$/.exec(rest);
    if (byTag) {
      const rel = fixture.releases.find((r) => r.tag === byTag[1]);
      return rel ? send(200, releaseJson(rel, base)) : notFound();
    }
    const asset = /^\/releases\/assets\/(\d+)$/.exec(rest);
    if (asset) {
      const a = findAsset(Number(asset[1]));
      if (!a) return notFound();
      // GitHub answers an octet-stream request with a redirect to its object store; anything else gets the metadata
      if ((req.headers.accept ?? "").includes("application/octet-stream"))
        return send(302, { message: "redirect" }, { location: `${base}/_download/${a.id}` });
      return send(200, { id: a.id, name: a.name, content_type: a.type, size: a.bytes.length });
    }
    const contents = /^\/contents\/(.+)$/.exec(rest);
    if (contents) {
      const ref = url.searchParams.get("ref") ?? "main";
      const text = fixture.contents?.[ref]?.[contents[1]];
      if (text === undefined) return notFound();
      const bytes = Buffer.from(text);
      return send(200, {
        type: "file",
        encoding: "base64",
        size: bytes.length,
        name: contents[1].split("/").pop(),
        path: contents[1],
        sha: sha256(bytes),
        content: bytes.toString("base64"),
      });
    }
    return notFound();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    url,
    requests,
    fixture,
    addRelease: (rel) => fixture.releases.push(rel),
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
