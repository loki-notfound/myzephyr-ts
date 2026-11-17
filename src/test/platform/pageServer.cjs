"use strict";
/**
 * Loopback page server of the platform tests and the Electron consumer: serves one built browser
 * consumer (a directory with index.html and nested asset directories) on 127.0.0.1 under the page
 * policy of docs/DEPLOYMENT.md, receives the page's results at POST /result and policy violation
 * reports at POST /csp-report, and records every request (method, path, fetch destination, status)
 * with the SHA-256 of each WebAssembly module and worker script it serves. Test tooling, no
 * dependency; bodies of the page's results are kept, nothing else is stored.
 *
 *   const s = await startPageServer({ root, info, extraRoutes });
 *   s.origin, s.waitFor(phase, timeoutMs), s.snapshot(), await s.close()
 *
 * The worker script response gets its own policy (DEPLOYMENT.md: the policy of the worker script
 * governs the wallet's requests). A worker script is recognised by "Sec-Fetch-Dest: worker", or by
 * its name where a browser does not send that header.
 * info: an object served at GET /info.json (for example the tarball's SHA-256 shown by the page).
 * extraRoutes(req, res, url, body) may answer a request itself and return true.
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PAGE_POLICY = ["default-src 'none'", "script-src 'self' 'wasm-unsafe-eval'", "worker-src 'self'", "connect-src 'self'",
  "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'", "report-uri /csp-report"].join("; ");
// script-src 'wasm-unsafe-eval' in the worker's policy: Firefox requires it to instantiate the module
// the page compiled and posted (Chromium does not); no script source is allowed
const WORKER_POLICY = ["default-src 'none'", "script-src 'wasm-unsafe-eval'", "connect-src 'self'", "report-uri /csp-report"].join("; ");
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json", ".map": "application/json", ".wasm": "application/wasm", ".txt": "text/plain; charset=utf-8" };

function listFiles(root) {
  const files = new Map();
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && /^[A-Za-z0-9._-]+$/.test(e.name)) files.set("/" + path.relative(root, p).split(path.sep).join("/"), p);
    }
  };
  walk(root);
  return files;
}

/** The progress marks a page may post to /progress: loaded, the offline checks started, one check done. */
const PROGRESS_MARK = /^(page loaded|offline checks started|K[0-9]{2} (pass|fail))$/;

function startPageServer(opts) {
  const root = path.resolve(opts.root);
  const files = listFiles(root);
  if (!files.has("/index.html")) throw new Error("no index.html in the served directory");
  const pagePolicy = opts.pagePolicy || PAGE_POLICY;
  const workerPolicy = opts.workerPolicy || WORKER_POLICY;
  const requests = [];
  const cspReports = [];
  const results = new Map();
  const waiters = new Map();
  // how far the page got: the last progress mark it posted, from a fixed set only (no text of the page is kept)
  const progress = { last: undefined, marks: 0, unrecognized: 0 };
  const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
  const server = http.createServer((req, res) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => { size += c.length; if (size <= 4 * 1024 * 1024) chunks.push(c); });
    req.on("end", () => {
      const url = new URL(req.url, "http://127.0.0.1");
      const body = Buffer.concat(chunks);
      const dest = String(req.headers["sec-fetch-dest"] || "");
      const entry = { method: req.method, path: url.pathname.substring(0, 120), dest, status: 0 };
      requests.push(entry);
      const isWorker = dest === "worker" || (dest === "" && /zephyr\.worker[^/]*\.js$/.test(url.pathname));
      const headers = { "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store", "Cross-Origin-Opener-Policy": "same-origin",
        "Content-Security-Policy": isWorker ? workerPolicy : pagePolicy };
      const send = (status, extra, data) => { entry.status = status; res.writeHead(status, Object.assign(headers, extra || {})); res.end(data); };
      try {
        if (opts.extraRoutes && opts.extraRoutes(req, res, url, body, entry)) return;
        if (req.method === "POST" && url.pathname === "/result") {
          let r;
          try { r = JSON.parse(body.toString("utf8")); } catch (e) { r = { phase: "unparseable" }; }
          const phase = typeof r.phase === "string" ? r.phase : "offline";
          results.set(phase, r);
          send(204);
          for (const w of waiters.get(phase) || []) w(r);
          waiters.delete(phase);
        } else if (req.method === "POST" && url.pathname === "/progress") {
          const mark = body.toString("utf8").trim();
          if (PROGRESS_MARK.test(mark)) { progress.last = mark; progress.marks++; } else progress.unrecognized++;
          send(204);
        } else if (req.method === "POST" && url.pathname === "/csp-report") {
          let r;
          try { r = JSON.parse(body.toString("utf8")); } catch (e) { r = { unparseable: true }; }
          const b = r["csp-report"] || (Array.isArray(r) && r[0] && r[0].body) || r;
          cspReports.push({ directive: b["effective-directive"] || b.effectiveDirective || b["violated-directive"], blocked: String(b["blocked-uri"] || b.blockedURL || "").substring(0, 80) });
          send(204);
        } else if (req.method === "GET" && url.pathname === "/info.json") {
          send(200, { "Content-Type": "application/json" }, JSON.stringify(opts.info || {}));
        } else if (req.method === "GET" && (url.pathname === "/" || files.has(url.pathname))) {
          const file = files.get(url.pathname === "/" ? "/index.html" : url.pathname);
          const data = fs.readFileSync(file);
          if (/\.wasm$/.test(file) || isWorker) entry.sha256 = sha(data);
          if (isWorker) entry.worker = true;
          send(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" }, data);
        } else {
          send(404);
        }
      } catch (e) {
        if (!res.headersSent) send(500); else res.end();
      }
    });
  });
  server.keepAliveTimeout = 5000;
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port || 0, "127.0.0.1", () => {
      const origin = "http://127.0.0.1:" + server.address().port;
      resolve({
        origin,
        server,
        waitFor(phase, timeoutMs) {
          if (results.has(phase)) return Promise.resolve(results.get(phase));
          return new Promise((res) => {
            const t = setTimeout(() => res(undefined), timeoutMs);
            const list = waiters.get(phase) || [];
            list.push((r) => { clearTimeout(t); res(r); });
            waiters.set(phase, list);
          });
        },
        snapshot() {
          return { origin, pagePolicy, workerPolicy, requests: requests.slice(), cspReports: cspReports.slice(), phases: Array.from(results.keys()), progress: Object.assign({}, progress) };
        },
        close() { return new Promise((r) => { server.closeAllConnections && server.closeAllConnections(); server.close(() => r()); }); }
      });
    });
  });
}

/**
 * Checks of a finished page run that do not depend on the browser: the expected check ids all
 * passed, the page loaded exactly one WebAssembly module, the one of the package, started its
 * worker script, and no policy violation was reported. Returns a list of problems (empty: passed).
 */
function judgeRun(result, snapshot, expect) {
  const problems = [];
  if (!result) return ["no result from the page"];
  const checks = Array.isArray(result.checks) ? result.checks : [];
  const ids = checks.map((c) => c.id).join();
  if (ids !== expect.ids.join()) problems.push("check ids " + ids + ", expected " + expect.ids.join());
  for (const c of checks) if (c.status !== "pass") problems.push(c.id + " " + c.status + ": " + (c.notes || []).slice(-1).join(""));
  const wasm = snapshot.requests.filter((r) => /\.wasm$/.test(r.path) && r.status === 200);
  if (wasm.length !== 1) problems.push("WebAssembly module loaded " + wasm.length + " times");
  else if (expect.wasmSha256 && wasm[0].sha256 !== expect.wasmSha256) problems.push("the served WebAssembly module is not the package's");
  const workers = snapshot.requests.filter((r) => r.worker && r.status === 200);
  if (workers.length < 1) problems.push("no worker script was served");
  // a browser's own request for /favicon.ico (an image the page never names) is blocked by default-src 'none'
  const reports = snapshot.cspReports.filter((r) => !(r.directive === "img-src" && /\/favicon\.ico$/.test(r.blocked)));
  if (reports.length > 0) problems.push("policy reports: " + JSON.stringify(reports));
  const unexpected = snapshot.requests.filter((r) => r.status === 404 && r.path !== "/favicon.ico");
  if (unexpected.length > 0) problems.push("requests for missing files: " + unexpected.map((r) => r.path).join(" "));
  return problems;
}

module.exports = { startPageServer, judgeRun, PAGE_POLICY, WORKER_POLICY };
