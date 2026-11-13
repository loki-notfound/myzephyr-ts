/**
 * Loopback servers of the redirect checks (test only). Two HTTP servers on 127.0.0.1:
 *
 *   first   answers under these base paths (one per case, <s> is 301, 302, 303, 307 or 308):
 *             /r<s>        every request: status <s> with a Location to the second server (same path)
 *             /same<s>     every request: status <s> with a Location to this server under /landed
 *             /bin<s>      a minimal daemon for JSON requests (a valid get_version and get_info),
 *                          status <s> with a Location to the second server for every binary request
 *             /landed      the target of the same-origin redirects: counted, answered 404
 *             /ok          a minimal daemon for JSON requests (positive control: the daemon is reached)
 *             /poolempty   the /ok daemon whose pool is empty (/get_transaction_pool_hashes.bin)
 *             /poolfull    the /ok daemon with two constructed pool hashes; /gettransactions answers them
 *                          with transactions that do not parse (the wallet must skip them)
 *             /poolstatus  the /ok daemon whose pool request answers a node status carrying a marker text
 *   second  the target of the other redirects: every request is counted and answered 404
 *
 * Both answer the CORS preflight and add CORS headers for any origin, so that the browser page (a
 * loopback origin of its own) can reach them and a redirect is not masked by a CORS failure. Counts
 * are kept per server, base path, method and endpoint, with the number of request body bytes; the
 * Location values and bodies are never stored, logged or returned (of a /gettransactions request only
 * the number of requested hashes and the request's field names are kept). GET /__stats on either server
 * returns the counts of both (only used by the tests, never by the SDK).
 */
"use strict";
const http = require("http");

const STATUSES = [301, 302, 303, 307, 308];
const FAKE_HEIGHT = 1000;
// constructed pool hashes whose 32 bytes are printable ASCII, so the daemon's JSON blob form needs no escape
const POOL_HASH_BYTES = ["ZEPHYRTSPOOLREFRESHCHECKHASHONE1", "ZEPHYRTSPOOLREFRESHCHECKHASHTWO2"];
const POOL_HASHES = POOL_HASH_BYTES.map((s) => Buffer.from(s, "latin1").toString("hex"));
const POOL_MARKER = "MARKERpoolnodetext";

function startRedirectServers() {
  const stats = { first: {}, second: {}, landed: {}, preflights: 0, redirectsSent: 0, poolTxRequests: [] };
  const ports = {};
  const count = (bucket, key, bytes) => { const e = bucket[key] || (bucket[key] = { requests: 0, bodyBytes: 0 }); e.requests++; e.bodyBytes += bytes; };
  const cors = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, POST", "access-control-allow-headers": "content-type", "access-control-max-age": "0", "cache-control": "no-store" };
  const send = (res, status, headers, payload) => { const p = Buffer.from(payload || ""); res.writeHead(status, Object.assign({ "content-length": p.length }, cors, headers)); res.end(p); };
  const rpc = (body) => { try { const j = JSON.parse(body.toString("utf8")); return { id: typeof j.id === "string" || typeof j.id === "number" ? j.id : "0", method: typeof j.method === "string" && /^[A-Za-z0-9_]{1,64}$/.test(j.method) ? j.method : "?" }; } catch (e) { return { id: "0", method: "-" }; } };
  const daemonJson = (res, endpoint, body) => {
    const { id, method } = rpc(body);
    const result = (r) => send(res, 200, { "content-type": "application/json" }, JSON.stringify({ jsonrpc: "2.0", id, result: r }));
    if (endpoint === "/json_rpc" && method === "get_version") return result({ version: 196621, release: true, status: "OK", untrusted: false, current_height: FAKE_HEIGHT, target_height: 0, hard_forks: [] });
    if (endpoint === "/json_rpc" && (method === "get_info" || method === "getinfo")) return result({ status: "OK", height: FAKE_HEIGHT, target_height: 0, synchronized: true, untrusted: false, mainnet: true, nettype: "mainnet", version: "2.3.0" });
    if (endpoint === "/getheight" || endpoint === "/get_height") return send(res, 200, { "content-type": "application/json" }, JSON.stringify({ height: FAKE_HEIGHT, status: "OK", untrusted: false }));
    return send(res, 404, {}, "");
  };
  // the pool daemons: /get_transaction_pool_hashes.bin is a JSON request despite its name (the core's
  // update_pool_state); the hashes travel as one blob string of their raw bytes
  const poolDaemon = (res, kind, endpoint, body) => {
    const json = (o) => send(res, 200, { "content-type": "application/json" }, JSON.stringify(o));
    if (endpoint === "/get_transaction_pool_hashes.bin") {
      if (kind === "poolstatus") return json({ status: POOL_MARKER + " status", untrusted: false });
      return json({ status: "OK", untrusted: false, tx_hashes: kind === "poolfull" ? POOL_HASH_BYTES.join("") : "" });
    }
    if (endpoint === "/gettransactions") {
      let fields = [], hashes = -1;
      try { const j = JSON.parse(body.toString("utf8")); fields = Object.keys(j).sort(); hashes = Array.isArray(j.txs_hashes) ? j.txs_hashes.length : -1; } catch (e) { fields = ["(unparsed)"]; }
      stats.poolTxRequests.push({ kind, fields, hashes });
      if (kind !== "poolfull") return send(res, 404, {}, "");
      return json({ status: "OK", untrusted: false, missed_tx: [], txs: POOL_HASHES.map((h) => ({ tx_hash: h, as_hex: "00ff00ff", pruned_as_hex: "", prunable_as_hex: "", prunable_hash: "",
        in_pool: true, double_spend_seen: false, block_height: 0, block_timestamp: 0, output_indices: [], asset_type_output_indices: [] })) });
    }
    return daemonJson(res, endpoint, body);
  };
  const keyOf = (req, base, endpoint, body) => req.method + " " + base + endpoint + (endpoint === "/json_rpc" ? " " + rpc(body).method : "");

  const first = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const url = new URL(req.url, "http://127.0.0.1");
      if (req.method === "OPTIONS") { stats.preflights++; return send(res, 204, {}, ""); }
      if (req.method === "GET" && url.pathname === "/__stats") return send(res, 200, { "content-type": "application/json" }, JSON.stringify(stats));
      const m = /^\/(r|same|bin)(\d{3})(\/.*)$/.exec(url.pathname) || /^\/(ok|landed|poolempty|poolfull|poolstatus)(\/.*)$/.exec(url.pathname);
      if (m === null) { count(stats.first, req.method + " (unknown path)", body.length); return send(res, 404, {}, ""); }
      if (m[1] === "landed") { count(stats.landed, keyOf(req, "/landed", m[2], body), body.length); return send(res, 404, {}, ""); }
      if (m[1] === "ok") { count(stats.first, keyOf(req, "/ok", m[2], body), body.length); return daemonJson(res, m[2], body); }
      if (m[1].startsWith("pool")) { count(stats.first, keyOf(req, "/" + m[1], m[2], body), body.length); return poolDaemon(res, m[1], m[2], body); }
      const status = Number(m[2]);
      const endpoint = m[3];
      const base = "/" + m[1] + m[2];
      count(stats.first, keyOf(req, base, endpoint, body), body.length);
      if (!STATUSES.includes(status)) return send(res, 404, {}, "");
      if (m[1] === "bin" && !endpoint.endsWith(".bin")) return daemonJson(res, endpoint, body);
      const location = m[1] === "same" ? "http://127.0.0.1:" + ports.first + "/landed" + endpoint : "http://127.0.0.1:" + ports.second + base + endpoint;
      stats.redirectsSent++;
      return send(res, status, { location, "content-type": "text/plain" }, "redirected");
    });
  });
  const second = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const url = new URL(req.url, "http://127.0.0.1");
      if (req.method === "OPTIONS") { count(stats.second, "OPTIONS " + url.pathname.substring(0, 40), 0); return send(res, 204, {}, ""); }
      if (req.method === "GET" && url.pathname === "/__stats") return send(res, 200, { "content-type": "application/json" }, JSON.stringify(stats));
      count(stats.second, req.method + " " + url.pathname.substring(0, 60), body.length);
      return send(res, 404, {}, "");
    });
  });
  const listen = (s) => new Promise((resolve) => s.listen(0, "127.0.0.1", () => resolve(s.address().port)));
  return (async () => {
    ports.first = await listen(first);
    ports.second = await listen(second);
    const sockets = new Set();
    for (const s of [first, second]) s.on("connection", (c) => { sockets.add(c); c.on("close", () => sockets.delete(c)); });
    return {
      ports, stats, statuses: STATUSES,
      first: "http://127.0.0.1:" + ports.first,
      second: "http://127.0.0.1:" + ports.second,
      snapshot: () => JSON.parse(JSON.stringify(stats)),
      close: () => new Promise((resolve) => { for (const c of sockets) c.destroy(); let n = 2; const done = () => { if (--n === 0) resolve(); }; first.close(done); second.close(done); })
    };
  })();
}

module.exports = { startRedirectServers, STATUSES, POOL_HASHES, POOL_MARKER };
