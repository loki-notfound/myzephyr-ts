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
 *           (index.html, bundles) under an explicit CSP, POST /result and POST /csp-report
 *   allow   mount "" (forward) with CORS headers that allow the daemon listener's origin
 *   deny    answers the CORS preflight without CORS headers and every other request 403 locally
 *   silent  accepts connections and never answers (raw TCP)
 *   closed  a port that was bound and closed again (connection refused)
 *
 * Usage: forwarder.cjs --upstream <url> --out <dir> [--page <dir>] [--seed <dir>] [--slow-ms N]
 *                      [--marker TEXT] [--fake-height N] [--checks N01,...]
 * With --page, GET /targets.json gives the page its targets (this forwarder's loopback origins),
 * the marker and the check list, and GET /seed/{keys,cache,password} the disposable seed wallet.
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
const SLOW_MS = Number(arg("slow-ms", "1500"));
const MARKER = arg("marker", "MARKERnodetext");
const FAKE_HEIGHT = Number(arg("fake-height", "1000"));
const CHECKS = arg("checks", "").split(",").filter((c) => /^N[0-9]{2}$/.test(c));
const MAX_UPSTREAM = 2;

// read-only daemon surface used by wallet refresh; everything else is refused locally
const ALLOWED_PATHS = new Set(["/json_rpc", "/getheight", "/get_height", "/getinfo", "/get_info", "/getblocks.bin", "/get_blocks.bin",
  "/gethashes.bin", "/get_hashes.bin", "/get_transaction_pool_hashes.bin", "/get_o_indexes.bin"]);
const ALLOWED_METHODS = new Set(["get_version", "get_info", "getinfo", "get_block_count", "getblockcount", "hard_fork_info", "get_fee_estimate",
  "get_last_block_header", "getlastblockheader", "get_block_header_by_height", "getblockheaderbyheight"]);
const MOUNTS = ["/fake/nodestatus", "/fake/malformed", "/fake/status", "/rpc", "/slow"]; // longest first; "" is the root

const stats = { started: new Date().toISOString(), upstream: UPSTREAM, routes: {}, denied: {}, binDigests: [], maxConcurrentUpstream: 0, upstreamRequests: 0,
  upstreamErrors: 0, pageRequests: [], cspReports: [], preflights: {} };
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
  const k = listener + " " + endpoint + " " + method;
  stats.denied[k] = (stats.denied[k] || 0) + 1;
  res.writeHead(403, headers); res.end();
}

let ports = {};
const CSP = () => ["default-src 'none'", "script-src 'self' 'wasm-unsafe-eval'", "worker-src 'self'",
  "connect-src 'self' http://127.0.0.1:" + ports.allow + " http://127.0.0.1:" + ports.deny + " http://127.0.0.1:" + ports.closed,
  "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'", "report-uri /csp-report"].join("; ");
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".map": "application/json", ".bin": "application/octet-stream", ".wasm": "application/wasm" };
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
      if (listener === "daemon" && PAGE !== undefined && !daemonPath) {
        const headers = { "Content-Security-Policy": CSP(), "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store", "Cross-Origin-Opener-Policy": "same-origin" };
        let status = 404;
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
        } else if (req.method === "GET" && (url.pathname === "/" || /^\/[A-Za-z0-9._-]+$/.test(url.pathname)) && fs.existsSync(path.join(PAGE, url.pathname === "/" ? "index.html" : url.pathname.substring(1)))) {
          const file = path.join(PAGE, url.pathname === "/" ? "index.html" : url.pathname.substring(1));
          headers["Content-Type"] = TYPES[path.extname(file)] || "application/octet-stream";
          res.writeHead(200, headers); res.end(fs.readFileSync(file)); status = 200;
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
  process.stdout.write(JSON.stringify({ ready: true, ports }) + "\n");
  const stop = () => {
    stats.finished = new Date().toISOString();
    stats.ports = ports;
    fs.writeFileSync(path.join(OUT, "forwarder.json"), JSON.stringify(stats, null, 1) + "\n");
    for (const s of Object.values(servers)) s.close();
    silent.close(); for (const s of silentSockets) s.destroy();
    agent.destroy();
    process.exit(0);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
})();
