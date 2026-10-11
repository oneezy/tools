// A stand-in for api.github.com, started in-process by a test and named to the CLI through SKILLS_SYNC_GITHUB_API.
// It serves the REST calls the machine commands make (the latest release and its assets, a release by tag, a file at
// a commit; and for `branches`: a repository's branches, pull requests, a compare, git refs read, made and deleted,
// the token's repositories) from a fixture: a small library whose release.json is computed in the real schema-3 shape,
// with real sha256 digests of the fixture bytes, and repositories whose branch and pull request state a test writes as
// a small object. Every request is recorded (method, path, the headers that matter, the JSON body of a write) so a test
// can say "status only read" or "--plan wrote nothing". Assets redirect like GitHub's do, so the client's redirect
// following is exercised too; lists page like GitHub's do (per_page, page, a Link header), so the paging is too.
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
 * The library's committed skills-sync.json as the release's commit carries it, in the real file's shape (version,
 * library, generate, sources, plugins), with `version` as library.version and `extra` merged in (a `machines` key, say).
 * The CLI reads it from GET /contents/skills-sync.json?ref=<commit>; a test narrows what a machine installs through it.
 */
export function fixtureConfig(repo = "oneezy/skills", version = "0.43.1", extra = {}) {
  const [owner, name] = repo.split("/");
  const config = {
    version: 1,
    library: { name, owner, homepage: `https://github.com/${repo}`, version },
    generate: { skills: true, plugins: true },
    sources: {
      "matt-pocock": {
        repo: "mattpocock/skills",
        ref: "main",
        root: "skills",
        skills: ["grilling", "tdd"],
        attribution: ["LICENSE"],
      },
    },
    plugins: {
      oneezy: { displayName: "Oneezy", description: "the library's own skills", group: "oneezy" },
      "matt-pocock": { displayName: "Matt Pocock", description: "Matt Pocock's skills", source: "matt-pocock" },
      play: { displayName: "Play", description: "the playground", group: "play" },
    },
    ...extra,
  };
  return JSON.stringify(config, null, 2) + "\n";
}

/**
 * The default fixture library: three plugins with a couple of skills each, released twice. release-16 is the older
 * cut; release-17 bumps oneezy and matt-pocock and leaves play as it was, so a machine on release-16 is behind. Each
 * release's commit carries the library's skills-sync.json (fixtureConfig) at that version.
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
  const contents = {
    [r16.commit]: { "skills-sync.json": fixtureConfig(repo, "0.43.0") },
    [r17.commit]: { "skills-sync.json": fixtureConfig(repo, "0.43.1") },
  };
  return { repo, releases: [r16, r17], contents, repos: {} };
}

/** A 40-character commit sha a test can read: the seed repeated. */
export const sha = (seed) => seed.repeat(40).slice(0, 40);

const readBody = (req) =>
  new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });

/**
 * Start the server on a free local port. `fixture.repo` is the one repository with releases; `fixture.releases` the
 * releases (the highest number is the latest); `fixture.contents[<ref>][<path>]` the files GET /contents serves;
 * `fixture.token`, when set, is the only bearer token accepted. A release with `noReleaseJson: true` is cut without
 * its release.json asset.
 *
 * `fixture.repos["owner/name"]` is a repository `branches` works on: { branches: { <name>: { sha, protected?, ahead?,
 * movedTo? } }, pulls: [{ number, head, base?, state, merged?, sha? }], tags: { "archive/<name>": sha }, writable?,
 * archived?, defaultBranch? }. `ahead` is what compare dev...<name> answers as ahead_by (default: 0 when the sha is
 * dev's, else 1); `movedTo` is the sha a single-ref read answers while the listing still says `sha` (a push between
 * the two); a pull's `base` defaults to dev and its `sha` to the head branch's; `writable: false` answers 403 to every
 * write; `defaultBranch` defaults to main. The server is live: a test writes `fixture.repos` before a run and reads it
 * after. `fixture.pageSize` caps per_page, so a test can make the client turn pages.
 */
export async function startFakeGithub(fixture = fixtureLibrary()) {
  const requests = [];
  fixture.repos ??= {};
  const releaseRepoPath = `/repos/${fixture.repo}`;
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
      url: `${base}${releaseRepoPath}/releases/assets/${a.id}`,
      browser_download_url: `https://github.com/${fixture.repo}/releases/download/${rel.tag}/${a.name}`,
    })),
  });
  const findAsset = (id) => {
    for (const rel of fixture.releases) for (const a of assetsOf(rel)) if (a.id === id) return a;
    return null;
  };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://fake");
    const rawBody = req.method === "GET" || req.method === "HEAD" ? "" : await readBody(req);
    let body = null;
    try {
      body = rawBody ? JSON.parse(rawBody) : null;
    } catch {
      /* not JSON: recorded as null */
    }
    requests.push({
      method: req.method,
      path: req.url,
      headers: {
        accept: req.headers.accept,
        authorization: req.headers.authorization,
        "user-agent": req.headers["user-agent"],
      },
      body,
    });
    const send = (status, payload, headers = {}) => {
      if (payload === undefined) {
        res.writeHead(status, headers);
        return res.end();
      }
      const bytes = Buffer.isBuffer(payload) ? payload : Buffer.from(JSON.stringify(payload, null, 2));
      res.writeHead(status, {
        "content-type": Buffer.isBuffer(payload) ? "application/octet-stream" : "application/json; charset=utf-8",
        "content-length": bytes.length,
        ...headers,
      });
      res.end(bytes);
    };
    const docs = "https://docs.github.com/rest";
    const notFound = () => send(404, { message: "Not Found", documentation_url: docs });
    if (fixture.token && req.headers.authorization !== `Bearer ${fixture.token}`)
      return send(401, { message: "Bad credentials", documentation_url: docs });
    const base = `http://${req.headers.host}`;
    /** One page of a list, with GitHub's Link header when more pages follow. */
    const page = (items) => {
      const asked = Number(url.searchParams.get("per_page") ?? 30);
      const size = Math.max(1, Math.min(asked, fixture.pageSize ?? asked));
      const n = Math.max(1, Number(url.searchParams.get("page") ?? 1));
      const slice = items.slice((n - 1) * size, n * size);
      const headers = {};
      if (n * size < items.length) {
        const next = new URL(url.pathname + url.search, base);
        next.searchParams.set("page", String(n + 1));
        headers.link = `<${next.href}>; rel="next"`;
      }
      return send(200, slice, headers);
    };

    if (url.pathname === "/user/repos") {
      if (req.method !== "GET") return notFound();
      if (!req.headers.authorization) return send(401, { message: "Requires authentication", documentation_url: docs });
      const list = Object.entries(fixture.repos)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([full, r], i) => ({
          id: i + 1,
          name: full.split("/")[1],
          full_name: full,
          owner: { login: full.split("/")[0] },
          private: false,
          fork: false,
          archived: !!r.archived,
          default_branch: "main",
          permissions: { admin: r.writable !== false, push: r.writable !== false, pull: true },
        }));
      return page(list);
    }
    const download = /^\/_download\/(\d+)$/.exec(url.pathname);
    if (download) {
      if (req.method !== "GET") return notFound();
      const a = findAsset(Number(download[1]));
      return a ? send(200, a.bytes) : notFound();
    }
    const repoMatch = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(url.pathname);
    if (!repoMatch) return notFound();
    const full = `${repoMatch[1]}/${repoMatch[2]}`;
    // the rest of the path, percent-decoded, so a branch named feat/x matches whether its slash was encoded or not
    const rest = decodeURIComponent(repoMatch[3] ?? "");
    const repo = fixture.repos[full];
    if (repo) {
      repo.tags ??= {};
      repo.pulls ??= [];
      const forbidden = () =>
        send(403, { message: "Resource not accessible by personal access token", documentation_url: docs });
      const branchJson = ([name, b]) => ({
        name,
        commit: { sha: b.sha, url: `${base}/repos/${full}/commits/${b.sha}` },
        protected: !!b.protected,
      });
      const pullJson = (p) => {
        const headSha = p.sha ?? repo.branches[p.head]?.sha ?? sha("0");
        const merged = !!p.merged;
        const state = p.state ?? (merged ? "closed" : "open");
        return {
          number: p.number,
          state,
          title: p.title ?? `${p.head} into ${p.base ?? "dev"}`,
          merged_at: merged ? "2026-10-10T00:00:00Z" : null,
          closed_at: state === "closed" ? "2026-10-10T00:00:00Z" : null,
          merge_commit_sha: merged ? sha(String(p.number)) : null,
          base: { ref: p.base ?? "dev", sha: repo.branches[p.base ?? "dev"]?.sha ?? sha("0") },
          head: { ref: p.head, sha: headSha, repo: { full_name: full } },
          html_url: `https://github.com/${full}/pull/${p.number}`,
        };
      };
      const refJson = (ref, s) => ({
        ref,
        node_id: sha256(ref).slice(0, 20),
        url: `${base}/repos/${full}/git/${ref}`,
        object: { sha: s, type: "commit", url: `${base}/repos/${full}/git/commits/${s}` },
      });
      if (req.method === "GET") {
        if (rest === "")
          return send(200, {
            id: 1,
            name: repoMatch[2],
            full_name: full,
            owner: { login: repoMatch[1] },
            private: false,
            fork: false,
            archived: !!repo.archived,
            default_branch: repo.defaultBranch ?? "main",
            permissions: { admin: repo.writable !== false, push: repo.writable !== false, pull: true },
          });
        if (rest === "/branches")
          return page(
            Object.entries(repo.branches)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(branchJson),
          );
        if (rest === "/pulls") {
          const state = url.searchParams.get("state") ?? "open";
          const head = url.searchParams.get("head");
          const baseRef = url.searchParams.get("base");
          return page(
            repo.pulls
              .map(pullJson)
              .filter((p) => state === "all" || p.state === state)
              .filter((p) => !head || `${repoMatch[1]}:${p.head.ref}` === head)
              .filter((p) => !baseRef || p.base.ref === baseRef),
          );
        }
        const compare = /^\/compare\/(.+)\.\.\.(.+)$/.exec(rest);
        if (compare) {
          const b = repo.branches[compare[1]];
          const h = repo.branches[compare[2]];
          if (!b || !h) return notFound();
          const ahead = h.ahead ?? (h.sha === b.sha ? 0 : 1);
          return send(200, {
            status: ahead === 0 ? "identical" : "ahead",
            ahead_by: ahead,
            behind_by: 0,
            total_commits: ahead,
            commits: [],
          });
        }
        const ref = /^\/git\/ref\/(tags|heads)\/(.+)$/.exec(rest);
        if (ref) {
          // a branch's `movedTo` is a push that landed after the listing: the ref read answers it, the listing did not
          const b = repo.branches[ref[2]];
          const s = ref[1] === "tags" ? repo.tags[ref[2]] : (b?.movedTo ?? b?.sha);
          return s ? send(200, refJson(`refs/${ref[1]}/${ref[2]}`, s)) : notFound();
        }
        // the release repo keeps its release routes beside its branch routes (the hook reads both)
        if (full !== fixture.repo) return notFound();
      }
      if (req.method === "POST" && rest === "/git/refs") {
        if (repo.writable === false) return forbidden();
        const m = /^refs\/(tags|heads)\/(.+)$/.exec(body?.ref ?? "");
        if (!m || typeof body?.sha !== "string")
          return send(422, { message: "Validation Failed", documentation_url: docs });
        const store = m[1] === "tags" ? repo.tags : repo.branches;
        if (store[m[2]]) return send(422, { message: "Reference already exists", documentation_url: docs });
        if (m[1] === "tags") repo.tags[m[2]] = body.sha;
        else repo.branches[m[2]] = { sha: body.sha };
        return send(201, refJson(body.ref, body.sha));
      }
      const del = req.method === "DELETE" && /^\/git\/refs\/(tags|heads)\/(.+)$/.exec(rest);
      if (del) {
        if (repo.writable === false) return forbidden();
        const store = del[1] === "tags" ? repo.tags : repo.branches;
        if (!store[del[2]]) return send(422, { message: "Reference does not exist", documentation_url: docs });
        delete store[del[2]];
        return send(204);
      }
      if (full !== fixture.repo || req.method !== "GET") return notFound();
    }
    if (full !== fixture.repo || req.method !== "GET") return notFound();
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
