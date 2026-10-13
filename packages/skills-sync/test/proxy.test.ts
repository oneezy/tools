// GitHub behind a proxy without NODE_USE_ENV_PROXY: the machine commands honour HTTPS_PROXY / HTTP_PROXY and NO_PROXY
// themselves (Node's fetch ignores them unless that variable is set, and a cloud setup line does not set it). A test
// stands up the three parts in this process: the fake GitHub (plain HTTP), an HTTPS front for it with the test
// certificate in fixtures/tls (made for these tests only, valid for 127.0.0.1, trusted through NODE_EXTRA_CA_CERTS), and
// a CONNECT proxy that records what it tunnels. The CLI runs as a process; the tests assert the block it wrote, the
// tunnels the proxy saw and the NO_PROXY rules.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import path from "node:path";
import { afterEach, test } from "vite-plus/test";
import { noProxy, proxyFetch, proxyFor } from "../src/proxy.js";
import { BLOCK_BODY } from "../src/block.js";
import { fixtureLibrary, startFakeGithub, type FakeGithub } from "./fixtures/fake-github/fake-github.mjs";
import { cli, destroy, globalFile, pretendMachine, type PretendMachine } from "./machine.js";

const TLS = path.resolve(import.meta.dirname, "fixtures", "tls");

const closers: Array<() => Promise<void>> = [];
const machines: PretendMachine[] = [];
afterEach(async () => {
  for (const m of machines.splice(0)) destroy(m);
  for (const close of closers.splice(0)) await close();
});

/** Listen on a free port; the server and every socket it took (tunnels included) go when the test ends. */
async function listen(server: http.Server | net.Server): Promise<number> {
  const sockets = new Set<net.Socket>();
  server.on("connection", (s: net.Socket) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  closers.push(
    () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  );
  return (server.address() as net.AddressInfo).port;
}

/** The fake GitHub, and an HTTPS front that forwards every request to it. */
async function httpsGithub(): Promise<{ gh: FakeGithub; url: string }> {
  const fixture = fixtureLibrary();
  const gh = await startFakeGithub(fixture);
  closers.push(() => gh.close());
  const back = new URL(gh.url);
  const front = https.createServer(
    { key: fs.readFileSync(path.join(TLS, "key.pem")), cert: fs.readFileSync(path.join(TLS, "cert.pem")) },
    (req, res) => {
      const out = http.request(
        { host: back.hostname, port: back.port, path: req.url, method: req.method, headers: req.headers },
        (answer) => {
          const headers = { ...answer.headers };
          // the fake's asset redirect names its own scheme: the front is the one GitHub here
          if (typeof headers.location === "string") headers.location = headers.location.replace(/^http:/, "https:");
          res.writeHead(answer.statusCode ?? 502, headers);
          answer.pipe(res);
        },
      );
      req.pipe(out);
    },
  );
  const port = await listen(front);
  return { gh, url: `https://127.0.0.1:${port}` };
}

/**
 * A CONNECT proxy: every tunnel it opens, as host:port, and the Proxy-Authorization each CONNECT carried. `refuse`
 * answers every CONNECT with that status instead (407: the proxy wants credentials).
 */
async function connectProxy(
  refuse?: number,
): Promise<{ url: string; tunnels: string[]; auth: Array<string | undefined> }> {
  const tunnels: string[] = [];
  const auth: Array<string | undefined> = [];
  const proxy = http.createServer((_req, res) => res.writeHead(405).end());
  proxy.on("connect", (req: http.IncomingMessage, socket: net.Socket, head: Buffer) => {
    auth.push(req.headers["proxy-authorization"]);
    if (refuse) {
      socket.end(`HTTP/1.1 ${refuse} Proxy Authentication Required\r\nProxy-Authenticate: Basic\r\n\r\n`);
      return;
    }
    tunnels.push(req.url ?? "");
    const [host, port] = (req.url ?? "").split(":");
    const upstream = net.connect(Number(port), host, () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
  });
  const port = await listen(proxy);
  return { url: `http://127.0.0.1:${port}`, tunnels, auth };
}

test("behind HTTPS_PROXY, without NODE_USE_ENV_PROXY, a cloud sync reads the release through the proxy and writes the block", async () => {
  const { url } = await httpsGithub();
  const proxy = await connectProxy();
  const m = pretendMachine({ clis: [] });
  machines.push(m);
  const env = {
    SKILLS_SYNC_GITHUB_API: url,
    HTTPS_PROXY: proxy.url,
    NO_PROXY: "",
    NODE_EXTRA_CA_CERTS: path.join(TLS, "cert.pem"),
    CLAUDE_CODE_REMOTE: "true",
  };
  const r = await cli(m, ["--quiet"], env);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(fs.readFileSync(globalFile(m, "claude-code"), "utf8").includes(BLOCK_BODY), r.stdout);
  // every request went through the tunnel, the redirected asset download too
  const host = new URL(url).host;
  assert.ok(proxy.tunnels.length >= 4 && proxy.tunnels.every((t) => t === host), proxy.tunnels.join(", "));
  // NO_PROXY names the host: straight to it, the proxy sees nothing
  const before = proxy.tunnels.length;
  const direct = await cli(m, ["status", "--json"], { ...env, NO_PROXY: "localhost,127.0.0.0/8" });
  assert.equal(direct.status, 0, direct.stdout + direct.stderr);
  assert.equal(proxy.tunnels.length, before);
});

test("NO_PROXY: names, leading dots, wildcards, ports, CIDR ranges and *", () => {
  const list = "localhost,.example.com,*.svc.cluster.local,10.0.0.0/8,github.internal:8443,api.anthropic.com";
  assert.equal(noProxy("localhost", 443, list), true);
  assert.equal(noProxy("a.example.com", 443, list), true);
  assert.equal(noProxy("example.com", 443, list), true);
  assert.equal(noProxy("x.svc.cluster.local", 443, list), true);
  assert.equal(noProxy("10.20.30.40", 443, list), true);
  assert.equal(noProxy("11.0.0.1", 443, list), false);
  assert.equal(noProxy("github.internal", 8443, list), true);
  assert.equal(noProxy("github.internal", 443, list), false);
  assert.equal(noProxy("api.github.com", 443, list), false);
  assert.equal(noProxy("api.github.com", 443, "*"), true);
  assert.equal(noProxy("api.github.com", 443, ""), false);
  // the variable each scheme reads, lower case first, and NO_PROXY over both
  const env = { https_proxy: "http://p:1", HTTP_PROXY: "http://q:2", no_proxy: "internal" };
  assert.equal(proxyFor(new URL("https://api.github.com/x"), env)?.href, "http://p:1/");
  assert.equal(proxyFor(new URL("http://api.github.com/x"), env)?.href, "http://q:2/");
  assert.equal(proxyFor(new URL("https://internal/x"), env), null);
  assert.equal(proxyFor(new URL("https://api.github.com/x"), {}), null);
});

/**
 * A plain HTTP proxy that answers absolute-form requests itself: every request it saw, with its headers. a.test
 * redirects /same to /final on itself and /away to b.test; anything else answers 200.
 */
async function answeringProxy(): Promise<{
  url: string;
  seen: Array<{ url: string; headers: http.IncomingHttpHeaders }>;
}> {
  const seen: Array<{ url: string; headers: http.IncomingHttpHeaders }> = [];
  const proxy = http.createServer((req, res) => {
    seen.push({ url: req.url ?? "", headers: req.headers });
    if (req.url === "http://a.test/same") return res.writeHead(302, { location: "/final" }).end();
    if (req.url === "http://a.test/away") return res.writeHead(302, { location: "http://b.test/landing" }).end();
    res.writeHead(200, { "content-type": "text/plain" }).end("ok");
  });
  const port = await listen(proxy);
  return { url: `http://127.0.0.1:${port}`, seen };
}

test("a redirect to another origin drops Authorization and Cookie, through the proxy and past it; one to the same origin keeps them", async () => {
  const proxy = await answeringProxy();
  const headers = { authorization: "Bearer secret", Cookie: "session=1", accept: "text/plain" };
  const viaProxy = proxyFetch({ HTTP_PROXY: proxy.url });
  // same origin: the token goes along
  assert.equal(await (await viaProxy("http://a.test/same", { headers })).text(), "ok");
  assert.deepEqual(
    proxy.seen.map((s) => [s.url, s.headers.authorization, s.headers.cookie]),
    [
      ["http://a.test/same", "Bearer secret", "session=1"],
      ["http://a.test/final", "Bearer secret", "session=1"],
    ],
  );
  // another origin: neither the token nor the cookie reaches it; the other headers do
  proxy.seen.length = 0;
  assert.equal(await (await viaProxy("http://a.test/away", { headers })).text(), "ok");
  assert.deepEqual(
    proxy.seen.map((s) => [s.url, s.headers.authorization, s.headers.cookie, s.headers.accept]),
    [
      ["http://a.test/away", "Bearer secret", "session=1", "text/plain"],
      ["http://b.test/landing", undefined, undefined, "text/plain"],
    ],
  );
  // another origin NO_PROXY sends straight to: the global fetch gets the request without them too
  proxy.seen.length = 0;
  const direct: Array<[string, Record<string, string>]> = [];
  const pastProxy = proxyFetch({ HTTP_PROXY: proxy.url, NO_PROXY: "b.test" }, (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    direct.push([
      input instanceof Request ? input.url : String(input),
      { ...(init?.headers as Record<string, string>) },
    ]);
    return new Response("direct");
  }) as typeof fetch);
  assert.equal(await (await pastProxy("http://a.test/away", { headers })).text(), "direct");
  assert.deepEqual(direct, [["http://b.test/landing", { accept: "text/plain" }]]);
});

test("a proxy answering CONNECT with 407 fails the request with the status named; the user:password in the proxy URL is sent as Proxy-Authorization", async () => {
  const refusing = await connectProxy(407);
  const fetchVia = proxyFetch({ HTTPS_PROXY: `http://justin:p%40ss@${new URL(refusing.url).host}`, NO_PROXY: "" });
  await assert.rejects(
    fetchVia("https://api.github.test/repos/x"),
    (error: Error & { cause?: { message?: string } }) => {
      assert.equal(error.message, "fetch failed");
      assert.match(error.cause?.message ?? "", /proxy answered 407 to CONNECT api\.github\.test:443/);
      return true;
    },
  );
  assert.deepEqual(refusing.auth, [`Basic ${Buffer.from("justin:p@ss").toString("base64")}`]);
  assert.deepEqual(refusing.tunnels, []);
  // with no credentials in the URL there is no Proxy-Authorization at all
  const bare = await connectProxy(407);
  await assert.rejects(proxyFetch({ HTTPS_PROXY: bare.url, NO_PROXY: "" })("https://api.github.test/x"));
  assert.deepEqual(bare.auth, [undefined]);
});

test("through a tunnel, the proxy URL's credentials reach the proxy and the sync still writes the block", async () => {
  const { url } = await httpsGithub();
  const proxy = await connectProxy();
  const m = pretendMachine({ clis: [] });
  machines.push(m);
  const withAuth = new URL(proxy.url);
  withAuth.username = "justin";
  withAuth.password = "s3cret";
  const r = await cli(m, ["--quiet"], {
    SKILLS_SYNC_GITHUB_API: url,
    HTTPS_PROXY: withAuth.href,
    NO_PROXY: "",
    NODE_EXTRA_CA_CERTS: path.join(TLS, "cert.pem"),
    CLAUDE_CODE_REMOTE: "true",
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(fs.readFileSync(globalFile(m, "claude-code"), "utf8").includes(BLOCK_BODY), r.stdout);
  assert.ok(proxy.auth.length >= 4, proxy.auth.join(", "));
  assert.ok(proxy.auth.every((a) => a === `Basic ${Buffer.from("justin:s3cret").toString("base64")}`));
});
