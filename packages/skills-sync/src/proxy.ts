// GitHub behind a proxy. Node's global fetch ignores HTTPS_PROXY and HTTP_PROXY unless NODE_USE_ENV_PROXY=1 is set
// (and only on a Node new enough to read it), and the cloud setup line sets neither: a run there went straight to
// GitHub and was refused. So the machine commands honour the variables themselves, on every Node from 20.11 on and on
// Windows alike, with Node's own modules only: HTTPS_PROXY (or https_proxy) for an https URL, HTTP_PROXY (or
// http_proxy) for an http one, NO_PROXY (or no_proxy) naming the hosts that are reached directly. An https request goes
// through a CONNECT tunnel, TLS end to end with the host (so NODE_EXTRA_CA_CERTS and the host's certificate check apply
// as they do without a proxy); an http one is sent to the proxy in absolute form. A user:password in the proxy URL is
// sent as Proxy-Authorization. Redirects are followed here, each hop deciding afresh whether it goes through the proxy.
// No proxy for a URL: the global fetch, as before.
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";

type Env = NodeJS.ProcessEnv | Record<string, string | undefined>;

/** The first variable of `names` that is set and not empty. */
function first(env: Env, names: string[]): string | undefined {
  for (const n of names) {
    const v = env[n]?.trim();
    if (v) return v;
  }
  return undefined;
}

/** An IPv4 address as a number; null for anything else. */
function ipv4(host: string): number | null {
  if (net.isIPv4(host)) return host.split(".").reduce((n, part) => n * 256 + Number(part), 0);
  return null;
}

/**
 * Does NO_PROXY's list reach `host` directly? Entries are comma or space separated: `*` (every host), a name (that
 * host and its subdomains), `.name` or `*.name` (its subdomains, and the name itself), `name:port` (that port only), an
 * IP address, or an IPv4 CIDR range (`10.0.0.0/8`).
 */
export function noProxy(host: string, port: number, list: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  for (const raw of list.split(/[\s,]+/)) {
    let entry = raw.trim().toLowerCase();
    if (!entry) continue;
    if (entry === "*") return true;
    const cidr = /^(\d+\.\d+\.\d+\.\d+)\/(\d{1,2})$/.exec(entry);
    if (cidr) {
      const ip = ipv4(h);
      const base = ipv4(cidr[1]);
      const bits = Number(cidr[2]);
      if (ip === null || base === null || bits > 32) continue;
      // the same network: the addresses agree in their first `bits` bits
      const size = 2 ** (32 - bits);
      if (Math.floor(ip / size) === Math.floor(base / size)) return true;
      continue;
    }
    const withPort = /^(.+):(\d+)$/.exec(entry);
    if (withPort && !net.isIPv6(entry)) {
      if (Number(withPort[2]) !== port) continue;
      entry = withPort[1];
    }
    entry = entry.replace(/^\*?\./, "");
    if (h === entry || h.endsWith(`.${entry}`)) return true;
  }
  return false;
}

/** The proxy a request to `url` goes through, from the environment; null for none (or a host NO_PROXY names). */
export function proxyFor(url: URL, env: Env = process.env): URL | null {
  const value =
    url.protocol === "https:"
      ? first(env, ["https_proxy", "HTTPS_PROXY"])
      : url.protocol === "http:"
        ? first(env, ["http_proxy", "HTTP_PROXY"])
        : undefined;
  if (!value) return null;
  const port = Number(url.port) || (url.protocol === "https:" ? 443 : 80);
  if (noProxy(url.hostname, port, first(env, ["no_proxy", "NO_PROXY"]) ?? "")) return null;
  try {
    return new URL(value.includes("://") ? value : `http://${value}`);
  } catch {
    return null;
  }
}

interface Init {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

/** A fetch that honours the proxy variables of `env` (the subset of fetch github.ts uses). */
export function proxyFetch(env: Env = process.env, direct: typeof fetch = fetch): typeof fetch {
  return (async (input: string | URL | Request, init: Init = {}) => {
    let url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    let method = init.method ?? "GET";
    let body = init.body;
    for (let hop = 0; hop < 10; hop++) {
      const proxy = proxyFor(url, env);
      // no proxy for this hop: the global fetch takes it from here, redirects and all
      if (!proxy) return direct(url, { ...init, method, body, redirect: "follow" } as RequestInit);
      const res = await viaProxy(url, proxy, { ...init, method, body });
      const location = res.headers.get("location");
      if (![301, 302, 303, 307, 308].includes(res.status) || !location) return res;
      url = new URL(location, url);
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === "POST")) {
        method = "GET";
        body = undefined;
      }
    }
    throw new TypeError("fetch failed", { cause: { message: "too many redirects" } });
  }) as typeof fetch;
}

/** One request through `proxy`: CONNECT and TLS for https, the absolute form for http. */
function viaProxy(url: URL, proxy: URL, init: Init): Promise<Response> {
  const auth = proxy.username
    ? {
        "proxy-authorization": `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString("base64")}`,
      }
    : {};
  const proxyModule = proxy.protocol === "https:" ? https : http;
  const proxyPort = Number(proxy.port) || (proxy.protocol === "https:" ? 443 : 80);
  const headers: Record<string, string> = { ...init.headers, host: url.host };
  if (init.body !== undefined) headers["content-length"] = String(Buffer.byteLength(init.body));
  return new Promise<Response>((resolve, reject) => {
    const fail = (error: unknown) => reject(new TypeError("fetch failed", { cause: error }));
    const answer = (res: http.IncomingMessage) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("error", fail);
      res.on("end", () => {
        const out = new Headers();
        for (const [k, v] of Object.entries(res.headers))
          for (const one of Array.isArray(v) ? v : v === undefined ? [] : [v]) out.append(k, one);
        const status = res.statusCode ?? 502;
        const bytes = Buffer.concat(chunks);
        resolve(
          new Response(status === 204 || status === 304 ? null : bytes, {
            status,
            statusText: res.statusMessage ?? "",
            headers: out,
          }),
        );
      });
    };
    if (url.protocol === "http:") {
      const req = proxyModule.request(
        {
          host: proxy.hostname,
          port: proxyPort,
          method: init.method,
          path: url.href,
          headers: { ...headers, ...auth },
          signal: init.signal,
        },
        answer,
      );
      req.on("error", fail);
      req.end(init.body);
      return;
    }
    const port = Number(url.port) || 443;
    const target = `${url.hostname.replace(/^\[|\]$/g, "")}:${port}`;
    const connect = proxyModule.request({
      host: proxy.hostname,
      port: proxyPort,
      method: "CONNECT",
      path: url.hostname.includes(":") ? `[${url.hostname.replace(/^\[|\]$/g, "")}]:${port}` : target,
      headers: { host: target, ...auth },
      signal: init.signal,
    });
    connect.on("error", fail);
    connect.on("connect", (res: http.IncomingMessage, socket: net.Socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        return fail(
          Object.assign(new Error(`proxy answered ${res.statusCode} to CONNECT ${target}`), { code: "EPROXY" }),
        );
      }
      const host = url.hostname.replace(/^\[|\]$/g, "");
      const secure = tls.connect({ socket, host, ...(net.isIP(host) ? {} : { servername: host }) });
      secure.on("error", fail);
      const req = http.request(
        {
          host,
          port,
          method: init.method,
          path: url.pathname + url.search,
          headers,
          signal: init.signal,
          createConnection: () => secure,
        },
        answer,
      );
      req.on("error", fail);
      req.end(init.body);
    });
    connect.end();
  });
}
