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
import { noProxy, proxyFor } from "../src/proxy.js";
import { fixtureLibrary, startFakeGithub, type FakeGithub } from "./fixtures/fake-github/fake-github.mjs";
import { cli, destroy, globalFile, pretendMachine, type PretendMachine } from "./machine.js";

const TLS = path.resolve(import.meta.dirname, "fixtures", "tls");
const SHARED = "# How Justin works\n\nThrough a proxy.\n";

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

/** The fake GitHub with SHARED.md at its latest release, and an HTTPS front that forwards every request to it. */
async function httpsGithub(): Promise<{ gh: FakeGithub; url: string }> {
  const fixture = fixtureLibrary();
  fixture.contents![fixture.releases[1].commit]["SHARED.md"] = SHARED;
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

/** A CONNECT proxy: every tunnel it opens, as host:port. */
async function connectProxy(): Promise<{ url: string; tunnels: string[] }> {
  const tunnels: string[] = [];
  const proxy = http.createServer((_req, res) => res.writeHead(405).end());
  proxy.on("connect", (req: http.IncomingMessage, socket: net.Socket, head: Buffer) => {
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
  return { url: `http://127.0.0.1:${port}`, tunnels };
}

test("behind HTTPS_PROXY, without NODE_USE_ENV_PROXY, a cloud sync reads the release through the proxy and writes SHARED.md", async () => {
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
  assert.ok(fs.readFileSync(globalFile(m, "claude-code"), "utf8").includes(SHARED), r.stdout);
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
