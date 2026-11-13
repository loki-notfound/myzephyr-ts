#!/usr/bin/env node
/**
 * Test-owned loopback forwarder for the read-only network tests. Test tooling, not
 * SDK code. Every listener binds 127.0.0.1 only. Requests to the permitted upstream daemon are
 * forwarded only for an allowlist of read-only endpoint paths and JSON-RPC method names; anything
 * else is answered 403 locally and counted. At most two upstream requests run at once (all
 * listeners together). Counts per listener, mount, endpoint and method, bytes and time are kept;
 * request and response bodies are never stored or logged (only SHA-256 digests of binary
 * endpoint bodies, to compare identical requests across upstreams).
 *
 * Listeners (each a separate origin for the browser):
 *   daemon  mounts "" (forward), "/rpc" (forward under a base path), "/slow" (forward, each binary
 *           request delayed), "/fake/status", "/fake/malformed", "/fake/nodestatus" (local fake
 *           daemons whose failures carry a marker text); with --page also the static consumer
 *           (index.html, bundles, nested asset directories) under an explicit CSP, POST /result and
 *           POST /csp-report; with --app instead of --page the consumer's pages come from a local
 *           development server (a loopback origin), relayed with the same CSP, websocket upgrades
 *           included
 *   allow   mount "" (forward) with CORS headers that allow the daemon listener's origin
 *   deny    answers the CORS preflight without CORS headers and every other request 403 locally
 *   silent  accepts connections and never answers (raw TCP)
 *   closed  a port that was bound and closed again (connection refused)
 *
 * Usage: forwarder.cjs --upstream <url> --out <dir> [--page <dir> | --app <http://127.0.0.1:port>]
 *                      [--seed <dir>] [--slow-ms N] [--marker TEXT] [--fake-height N] [--checks N01,...]
 * With --page, GET /targets.json gives the page its targets (this forwarder's loopback origins),
 * the marker and the check list, and GET /seed/{keys,cache,password} the disposable seed wallet.
 * Every page request is counted with its Sec-Fetch-Dest; the SHA-256 of each worker script and
 * WebAssembly module served is recorded, so that a run can show which files the page used.
 * Prints one line {"ready":true,"ports":{...}} when listening. SIGTERM writes <out>/forwarder.json.
 */
"use strict";
const http = require("http");
const https = require("https");
const net = require("net");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const args = process.argv.slice(2);
const arg = (n, d) => { const i = args.indexOf("--" + n); return i >= 0 ? args[i + 1] : d; };
// the upstream must be one of the configured test daemons (testEndpoints.cjs)
const PERMITTED_UPSTREAMS = require("./testEndpoints.cjs").requireTestEndpoints().all.map((e) => e.url);
const UPSTREAM = arg("upstream");
if (!PERMITTED_UPSTREAMS.includes(UPSTREAM)) { process.stderr.write("upstream is not a configured test daemon\n"); process.exit(2); }
const OUT = path.resolve(arg("out"));
const PAGE = arg("page") ? path.resolve(arg("page")) : undefined;
const SEED = arg("seed") ? path.resolve(arg("seed")) : undefined;
const APP = arg("app") ? new URL(arg("app")) : undefined;
if (APP !== undefined && (APP.protocol !== "http:" || APP.hostname !== "127.0.0.1" || PAGE !== undefined)) { process.stderr.write("--app must be a loopback http origin and excludes --page\n"); process.exit(2); }
const SLOW_MS = Number(arg("slow-ms", "1500"));
const MARKER = arg("marker", "MARKERnodetext");
const FAKE_HEIGHT = Number(arg("fake-height", "1000"));
const CHECKS = arg("checks", "").split(",").filter((c) => /^N[0-9]{2}$/.test(c));
const MAX_UPSTREAM = 2;

// read-only daemon surface used by wallet refresh, the explicit pool refresh (/gettransactions: the pool
// transactions the wallet has not scanned yet) and building a transaction without relay (output
// distributions and ring members, the pool's backlog, recent block headers, and the chain's circulating supply
// and pricing record history, which the core reads for every transaction it constructs); everything else is refused
// locally and counted
const ALLOWED_PATHS = new Set(["/json_rpc", "/getheight", "/get_height", "/getinfo", "/get_info", "/getblocks.bin", "/get_blocks.bin",
  "/gethashes.bin", "/get_hashes.bin", "/get_transaction_pool_hashes.bin", "/get_o_indexes.bin", "/gettransactions", "/get_outs.bin",
  "/get_output_distribution.bin"]);
const ALLOWED_METHODS = new Set(["get_version", "get_info", "getinfo", "get_block_count", "getblockcount", "hard_fork_info", "get_fee_estimate",
  "get_last_block_header", "getlastblockheader", "get_block_header_by_height", "getblockheaderbyheight", "get_output_distribution",
  "get_txpool_backlog", "getblockheadersrange", "get_block_headers_range", "get_output_histogram", "get_circulating_supply", "get_pricing_record_history"]);
// requests that would submit or relay a transaction or a block: refused like every request outside the
// allowlist, and counted separately (a run must show zero)
const RELAY_PATHS = new Set(["/sendrawtransaction", "/send_raw_transaction", "/start_mining", "/stop_mining"]);
const RELAY_METHODS = new Set(["relay_tx", "submit_block", "submitblock", "send_raw_transaction", "sendrawtransaction"]);
const MOUNTS = ["/fake/nodestatus", "/fake/malformed", "/fake/status", "/rpc", "/slow"]; // longest first; "" is the root

const stats = { started: new Date().toISOString(), upstream: UPSTREAM, routes: {}, denied: {}, binDigests: [], maxConcurrentUpstream: 0, upstreamRequests: 0,
  upstreamErrors: 0, pageRequests: [], cspReports: [], preflights: {}, relayRequests: 0 };
let active = 0;
const waiters = [];
const acquire = () => new Promise((resolve) => { if (active < MAX_UPSTREAM) { active++; stats.maxConcurrentUpstream = Math.max(stats.maxConcurrentUpstream, active); resolve(); } else waiters.push(resolve); });
const releaseSlot = () => { const next = waiters.shift(); if (next) { stats.maxConcurrentUpstream = Math.max(stats.maxConcurrentUpstream, active); next(); } else active--; };
const upstreamUrl = new URL(UPSTREAM);
const agent = upstreamUrl.protocol === "https:" ? new https.Agent({ keepAlive: true, maxSockets: MAX_UPSTREAM }) : new http.Agent({ keepAlive: true, maxSockets: MAX_UPSTREAM });
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");

function record(key, reqBytes, respBytes, ms, status) {
  const r = stats.routes[key] || (stats.routes[key] = { count: 0, requestBytes: 0, responseBytes: 0, ms: 0, statuses: {} });
  r.count++; r.requestBytes += reqBytes; r.responseBytes += respBytes; r.ms += ms; r.statuses[status] = (r.statuses[status] || 0) + 1;
}

function rpcMethod(endpoint, body) {
  if (endpoint !== "/json_rpc") return "-";
  try { const m = JSON.parse(body.toString("utf8")).method; return typeof m === "string" && /^[A-Za-z0-9_]{1,64}$/.test(m) ? m : "?"; } catch (e) { return "?"; }
}

function forward(listener, mount, endpoint, method, req, body, res, extraHeaders, delayMs) {
  const t0 = Date.now();
  const key = listener + " " + (mount || "/") + " " + endpoint + " " + method;
  const go = async () => {
    await acquire();
    if (delayMs > 0 && endpoint.endsWith(".bin")) await new Promise((r) => setTimeout(r, delayMs));
    stats.upstreamRequests++;
    const headers = { "content-length": body.length, host: upstreamUrl.host };
    if (req.headers["content-type"]) headers["content-type"] = req.headers["content-type"];
    const up = (upstreamUrl.protocol === "https:" ? https : http).request({ protocol: upstreamUrl.protocol, hostname: upstreamUrl.hostname, port: upstreamUrl.port || undefined,
      method: req.method, path: endpoint, headers, agent, timeout: 150000 }, (ur) => {
      const chunks = [];
      ur.on("data", (c) => chunks.push(c));
      ur.on("end", () => {
        releaseSlot();
        const out = Buffer.concat(chunks);
        const h = Object.assign({ "content-type": ur.headers["content-type"] || "application/octet-stream", "content-length": out.length, "cache-control": "no-store" }, extraHeaders);
        res.writeHead(ur.statusCode, h); res.end(out);
        record(key, body.length, out.length, Date.now() - t0, ur.statusCode);
        if (endpoint.endsWith(".bin")) stats.binDigests.push({ listener, mount, endpoint, request: sha(body), response: sha(out), status: ur.statusCode });
      });
      ur.on("error", () => { releaseSlot(); stats.upstreamErrors++; if (!res.headersSent) { res.writeHead(502, extraHeaders); res.end(); } record(key, body.length, 0, Date.now() - t0, 502); });
    });
    up.on("timeout", () => up.destroy(new Error("timeout")));
    up.on("error", () => { if (!up.res) { releaseSlot(); stats.upstreamErrors++; if (!res.headersSent) { res.writeHead(502, extraHeaders); res.end(); } record(key, body.length, 0, Date.now() - t0, 502); } });
    up.end(body);
  };
  go();
}

// --- fake daemons: a valid get_version, then a failure that carries the marker text ---
function epeeStatus(text) {
  const b = Buffer.from(text, "utf8");
  if (b.length > 63) throw new Error("marker too long");
  return Buffer.concat([Buffer.from([0x01, 0x11, 0x01, 0x01, 0x01, 0x01, 0x02, 0x01, 0x01, 0x04, 0x06]), Buffer.from("status"), Buffer.from([0x0a, b.length << 2]), b]);
}
function fake(kind, endpoint, method, body, res, extraHeaders) {
  let id = "0";
  try { const j = JSON.parse(body.toString("utf8")); if (typeof j.id === "string" || typeof j.id === "number") id = j.id; } catch (e) { /* binary body */ }
  const send = (status, type, payload, reason) => { const p = Buffer.from(payload); res.writeHead(status, reason || http.STATUS_CODES[status], Object.assign({ "content-type": type, "content-length": p.length }, extraHeaders)); res.end(p); return p.length; };
  if (method === "get_version") return send(200, "application/json", JSON.stringify({ jsonrpc: "2.0", id, result: { version: 196621, release: true, status: "OK", untrusted: false, current_height: FAKE_HEIGHT, target_height: 0, hard_forks: [] } }));
  if (kind === "status") return send(500, "text/plain", MARKER + " status body", MARKER + " reason");
  if (kind === "malformed") return send(200, endpoint.endsWith(".bin") ? "application/octet-stream" : "application/json", MARKER + " {malformed");
  if (endpoint.endsWith(".bin")) return send(200, "application/octet-stream", epeeStatus(MARKER));
  if (method === "get_info" || method === "getinfo") return send(200, "application/json", JSON.stringify({ jsonrpc: "2.0", id, error: { code: -1, message: MARKER + " rpc error" } }));
  return send(200, "application/json", JSON.stringify({ jsonrpc: "2.0", id, result: { status: MARKER + " status" } }));
}

function splitMount(pathname) {
  for (const m of MOUNTS) if (pathname === m || pathname.startsWith(m + "/")) return { mount: m, endpoint: pathname.substring(m.length) };
  return { mount: "", endpoint: pathname };
}

function deny(listener, endpoint, method, res, headers) {
  if (RELAY_PATHS.has(endpoint.toLowerCase()) || RELAY_METHODS.has(String(method).toLowerCase())) stats.relayRequests++;
  const k = listener + " " + endpoint + " " + method;
  stats.denied[k] = (stats.denied[k] || 0) + 1;
  res.writeHead(403, headers); res.end();
}

let ports = {};
const CSP = () => ["default-src 'none'", "script-src 'self' 'wasm-unsafe-eval'", "worker-src 'self'",
  "connect-src 'self' http://127.0.0.1:" + ports.allow + " http://127.0.0.1:" + ports.deny + " http://127.0.0.1:" + ports.closed,
  "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'", "report-uri /csp-report"].join("; ");
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".map": "application/json",
  ".bin": "application/octet-stream", ".wasm": "application/wasm" };
// a static page path: segments of safe characters, no dot segments; resolved inside the page directory
const pageFile = (pathname) => {
  if (pathname === "/") return path.join(PAGE, "index.html");
  if (!/^(\/[A-Za-z0-9_-][A-Za-z0-9._-]*)+$/.test(pathname)) return undefined;
  const file = path.join(PAGE, pathname.substring(1));
  return file.startsWith(PAGE + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile() ? file : undefined;
};
// relay one page request to the development server; its answer gets this forwarder's page headers
function relayApp(req, body, headers, done) {
  const h = Object.assign({}, req.headers, { host: APP.host });
  delete h["accept-encoding"]; // plain bodies, so that served files can be digested
  const up = http.request({ hostname: APP.hostname, port: APP.port, method: req.method, path: req.url, headers: h }, (ur) => {
    const chunks = [];
    ur.on("data", (c) => chunks.push(c));
    ur.on("end", () => {
      const out = Buffer.concat(chunks);
      const rh = Object.assign({}, ur.headers);
      for (const k of Object.keys(rh)) if (/^(content-security-policy|content-length|transfer-encoding|connection|keep-alive)$/i.test(k)) delete rh[k];
      done(ur.statusCode, Object.assign(rh, headers, { "content-length": out.length }), out);
    });
    ur.on("error", () => done(502, headers, Buffer.alloc(0)));
  });
  up.on("error", () => done(502, headers, Buffer.alloc(0)));
  up.end(body);
}
let resultResolve;

function handler(listener) {
  return (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const { mount, endpoint } = splitMount(url.pathname);
      const daemonPath = ALLOWED_PATHS.has(endpoint) || endpoint.endsWith(".bin") || endpoint === "/json_rpc";
      const pageOrigin = "http://127.0.0.1:" + ports.daemon;
      if (url.pathname === "/__stats" && req.method === "GET") { res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(stats)); return; }
      if (listener === "deny") {
        if (req.method === "OPTIONS") { stats.preflights.deny = (stats.preflights.deny || 0) + 1; res.writeHead(204); res.end(); return; }
        return deny("deny", endpoint, "-", res, {});
      }
      const cors = listener === "allow" ? { "access-control-allow-origin": pageOrigin, "vary": "Origin" } : {};
      if (listener === "allow" && req.method === "OPTIONS") {
        stats.preflights.allow = (stats.preflights.allow || 0) + 1;
        res.writeHead(204, Object.assign({ "access-control-allow-methods": "POST, GET", "access-control-allow-headers": "content-type", "access-control-max-age": "600" }, cors)); res.end(); return;
      }
      if (listener === "daemon" && (PAGE !== undefined || APP !== undefined) && !daemonPath) {
        const headers = { "Content-Security-Policy": CSP(), "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store", "Cross-Origin-Opener-Policy": "same-origin" };
        let status = 404;
        const dest = typeof req.headers["sec-fetch-dest"] === "string" ? req.headers["sec-fetch-dest"].substring(0, 20) : "-";
        const served = (code, h, out) => {
          const entry = { method: req.method, path: url.pathname, status: code, bytes: body.length, dest, responseBytes: out.length };
          if (code === 200 && (dest === "worker" || url.pathname.endsWith(".wasm"))) {
            entry.sha256 = sha(out);
            // a development server may append an inline source map to a script it serves; the digest
            // without that last comment line identifies the file it started from
            const text = dest === "worker" ? out.toString("latin1") : "";
            const m = text.match(/\n\/\/# sourceMappingURL=data:[^\n]*\n?$/);
            if (m) entry.sha256WithoutInlineMap = sha(out.subarray(0, m.index));
          }
          stats.pageRequests.push(entry);
          res.writeHead(code, h); res.end(out);
        };
        if (req.method === "POST" && url.pathname === "/result") {
          try { fs.writeFileSync(path.join(OUT, "report.json"), body); } catch (e) { /* reported by the runner */ }
          res.writeHead(204, headers); res.end(); status = 204; if (resultResolve) resultResolve();
        } else if (req.method === "POST" && url.pathname === "/csp-report") {
          try { stats.cspReports.push(JSON.parse(body.toString("utf8"))); } catch (e) { stats.cspReports.push({ unparseable: true }); }
          res.writeHead(204, headers); res.end(); status = 204;
        } else if (req.method === "GET" && SEED !== undefined && /^\/seed\/(keys|cache|password)$/.test(url.pathname)) {
          const name = url.pathname.substring(6);
          const file = path.join(SEED, name === "password" ? "password.txt" : name + ".bin");
          if (fs.existsSync(file)) { headers["Content-Type"] = "application/octet-stream"; res.writeHead(200, headers); res.end(fs.readFileSync(file)); status = 200; }
          else { res.writeHead(404, headers); res.end(); status = 404; } // a run without the measured seed wallet
        } else if (req.method === "GET" && url.pathname === "/targets.json") {
          const root = "http://127.0.0.1:" + ports.daemon;
          const targets = { root, base: root + "/rpc", slow: root + "/slow", fakeStatus: root + "/fake/status", fakeMalformed: root + "/fake/malformed", fakeNodeStatus: root + "/fake/nodestatus",
            allow: "http://127.0.0.1:" + ports.allow, deny: "http://127.0.0.1:" + ports.deny, closed: "http://127.0.0.1:" + ports.closed };
          headers["Content-Type"] = "application/json"; res.writeHead(200, headers); res.end(JSON.stringify({ targets, marker: MARKER, checks: CHECKS })); status = 200;
        } else if (APP !== undefined) {
          relayApp(req, body, headers, served);
          return;
        } else if (req.method === "GET" && pageFile(url.pathname) !== undefined) {
          const file = pageFile(url.pathname);
          headers["Content-Type"] = TYPES[path.extname(file)] || "application/octet-stream";
          served(200, headers, fs.readFileSync(file));
          return;
        } else { res.writeHead(404, headers); res.end(); }
        stats.pageRequests.push({ method: req.method, path: url.pathname.startsWith("/seed/") ? "/seed/*" : url.pathname, status, bytes: body.length });
        return;
      }
      if (!ALLOWED_PATHS.has(endpoint) || (req.method !== "POST" && req.method !== "GET")) return deny(listener, endpoint, "-", res, cors);
      const method = rpcMethod(endpoint, body);
      if (endpoint === "/json_rpc" && !ALLOWED_METHODS.has(method)) return deny(listener, endpoint, method, res, cors);
      if (mount.startsWith("/fake/")) {
        const n = fake(mount.substring(6), endpoint, method, body, res, cors);
        record(listener + " " + mount + " " + endpoint + " " + method, body.length, n, 0, "fake");
        return;
      }
      forward(listener, mount, endpoint, method, req, body, res, cors, mount === "/slow" ? SLOW_MS : 0);
    });
  };
}

function listen(server) { return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port))); }

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const closedServer = net.createServer();
  ports.closed = await listen(closedServer);
  await new Promise((r) => closedServer.close(r));
  const silentSockets = [];
  const silent = net.createServer((s) => { silentSockets.push(s); s.on("error", () => undefined); setTimeout(() => s.destroy(), 200000); });
  ports.silent = await listen(silent);
  const servers = {};
  for (const name of ["daemon", "allow", "deny"]) { servers[name] = http.createServer(handler(name)); servers[name].keepAliveTimeout = 5000; ports[name] = await listen(servers[name]); }
  // websocket upgrades of the development server (its reload channel), relayed unchanged on the page origin
  const upgrades = [];
  servers.daemon.on("upgrade", (req, socket, head) => {
    if (APP === undefined) { socket.destroy(); return; }
    stats.upgrades = (stats.upgrades || 0) + 1;
    const up = net.connect(Number(APP.port), APP.hostname, () => {
      const lines = [req.method + " " + req.url + " HTTP/1.1"];
      for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(req.rawHeaders[i] + ": " + (/^host$/i.test(req.rawHeaders[i]) ? APP.host : req.rawHeaders[i + 1]));
      up.write(lines.join("\r\n") + "\r\n\r\n"); if (head && head.length) up.write(head);
      up.pipe(socket); socket.pipe(up);
    });
    upgrades.push(up, socket);
    up.on("error", () => socket.destroy()); socket.on("error", () => up.destroy());
  });
  process.stdout.write(JSON.stringify({ ready: true, ports }) + "\n");
  const stop = () => {
    stats.finished = new Date().toISOString();
    stats.ports = ports;
    fs.writeFileSync(path.join(OUT, "forwarder.json"), JSON.stringify(stats, null, 1) + "\n");
    for (const s of Object.values(servers)) s.close();
    for (const u of upgrades) u.destroy();
    silent.close(); for (const s of silentSockets) s.destroy();
    agent.destroy();
    process.exit(0);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
})();
