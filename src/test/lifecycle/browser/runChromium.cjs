#!/usr/bin/env node
/**
 * Serve the static lifecycle consumer on loopback with an explicit same-origin CSP, run it in
 * the installed headless Chromium, and collect the posted report, CSP reports, the server's
 * request log and Chromium's net-log. Only the Chromium process started here is terminated.
 *
 * Network containment is always on: every non-loopback request goes to a closed local proxy
 * port and every non-loopback host name maps to NOTFOUND, in a new isolated profile. Chromium
 * runs in its own process group, which is the only one the runner terminates.
 *
 * Usage: runChromium.cjs --root <dir with index.html, consumer.js and the worker bundle>
 *                        --out <dir> [--chromium <binary>] [--timeout-ms N]
 *                        [--query <page query>] [--marks]
 *                        [--csp-page <policy>] [--csp-worker <policy>] [--record]
 *
 * With --marks, GET /mark?label=X makes the runner sample the memory and thread names of
 * every process of the test-owned Chromium process group (from /proc) before it answers; the
 * samples are written to marks.json (measurement runs only, not the acceptance suites).
 *
 * --csp-page and --csp-worker replace the policy sent with the page and its scripts, and with the
 * worker scripts (*.worker.js), for the policy tests of the WebAssembly module. With --record the
 * runner exits 0 whenever it could run Chromium; the caller judges the recorded outcome.
 *
 * With --redirect the runner also starts the two loopback servers of the redirect checks
 * (src/test/transport/redirectServers.cjs), adds both origins to connect-src (so that a followed
 * redirect would reach its target rather than be stopped by the policy), serves their origin to the
 * page at GET /redirect-targets.json (with the marker text of the pool daemons) and writes the servers'
 * counts to the summary.
 */
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const args = process.argv.slice(2);
const arg = (n, d) => { const i = args.indexOf("--" + n); return i >= 0 ? args[i + 1] : d; };
const ROOT = path.resolve(arg("root"));
const OUT = path.resolve(arg("out"));
const CHROMIUM = arg("chromium", "chromium");
const TIMEOUT = Number(arg("timeout-ms", "1800000"));
const CONTAIN = true; // mandatory; there is no option to disable it
const QUERY = arg("query", "");
const MARKS = args.includes("--marks");
const RECORD = args.includes("--record");
const REDIRECT = args.includes("--redirect");
let redirectServers;
const marks = [];
let chromiumPid;

function procFields(text, names) {
  const out = {};
  for (const line of text.split("\n")) { const m = /^([A-Za-z_]+):\s+(\d+)/.exec(line); if (m && names.includes(m[1])) out[m[1]] = Number(m[2]); }
  return out;
}

// memory and thread names of every process in the test-owned Chromium process group
function sampleProcesses(pgid) {
  const byType = {};
  for (const d of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const stat = fs.readFileSync("/proc/" + d + "/stat", "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      if (Number(fields[2]) !== pgid) continue;
      const cmd = fs.readFileSync("/proc/" + d + "/cmdline", "utf8").split(/[\0 ]/); // Chromium may rewrite its title with spaces
      const typeArg = cmd.find((a) => a.startsWith("--type="));
      const type = typeArg ? typeArg.substring(7) + (cmd.includes("--utility-sub-type=network.mojom.NetworkService") ? ":network" : "") : "browser";
      const status = procFields(fs.readFileSync("/proc/" + d + "/status", "utf8"), ["VmRSS", "Threads"]);
      let pss = 0;
      try { pss = procFields(fs.readFileSync("/proc/" + d + "/smaps_rollup", "utf8"), ["Pss"]).Pss || 0; } catch (e) { pss = 0; }
      let workerThreads = 0;
      for (const t of fs.readdirSync("/proc/" + d + "/task")) { try { if (fs.readFileSync("/proc/" + d + "/task/" + t + "/comm", "utf8").startsWith("DedicatedWorker")) workerThreads++; } catch (e) { /* thread ended */ } }
      const agg = byType[type] || (byType[type] = { processes: 0, rssKb: 0, pssKb: 0, threads: 0, dedicatedWorkerThreads: 0 });
      agg.processes++; agg.rssKb += status.VmRSS || 0; agg.pssKb += pss; agg.threads += status.Threads || 0; agg.dedicatedWorkerThreads += workerThreads;
    } catch (e) { /* process ended while sampling */ }
  }
  return byType;
}

const CSP = [
  "default-src 'none'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "worker-src 'self'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "report-uri /csp-report"
].join("; ");
let CSP_PAGE = arg("csp-page", CSP);
let CSP_WORKER = arg("csp-worker", CSP_PAGE);
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".map": "application/json", ".wasm": "application/wasm" }; // .wasm: the separately served module
const SERVED = new Set(fs.readdirSync(ROOT).filter((f) => /^[A-Za-z0-9._-]+$/.test(f)).map((f) => "/" + f));

fs.mkdirSync(OUT, { recursive: true });
const requestLog = [];
const cspReports = [];
let result;
let resolveResult;
const resultPromise = new Promise((r) => { resolveResult = r; });

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks);
    let status = 200;
    const policy = (url.pathname.endsWith(".worker.js") ? CSP_WORKER : CSP_PAGE).split("{port}").join(String(server.address().port));
    const headers = { "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store", "Cross-Origin-Opener-Policy": "same-origin" };
    if (policy !== "none") headers["Content-Security-Policy"] = policy;
    if (req.method === "POST" && url.pathname === "/result") {
      try { result = JSON.parse(body.toString("utf8")); } catch (e) { result = { fatal: "unparseable result" }; }
      res.writeHead(204, headers); res.end(); resolveResult();
    } else if (MARKS && req.method === "GET" && url.pathname === "/mark") {
      marks.push({ label: String(url.searchParams.get("label")).substring(0, 40), at: new Date().toISOString(), processes: chromiumPid ? sampleProcesses(chromiumPid) : {} });
      res.writeHead(204, headers); res.end();
    } else if (REDIRECT && req.method === "GET" && url.pathname === "/redirect-targets.json") {
      headers["Content-Type"] = "application/json";
      res.writeHead(200, headers); res.end(JSON.stringify({ first: redirectServers.first, second: redirectServers.second, marker: require(path.join(__dirname, "../../transport/redirectServers.cjs")).POOL_MARKER }));
    } else if (req.method === "POST" && url.pathname === "/csp-report") {
      try { cspReports.push(JSON.parse(body.toString("utf8"))); } catch (e) { cspReports.push({ unparseable: true }); }
      res.writeHead(204, headers); res.end();
    } else if (req.method === "GET" && (url.pathname === "/" || SERVED.has(url.pathname))) {
      const file = path.join(ROOT, url.pathname === "/" ? "index.html" : url.pathname.substring(1));
      const data = fs.readFileSync(file);
      headers["Content-Type"] = TYPES[path.extname(file)] || "application/octet-stream";
      res.writeHead(200, headers); res.end(data);
    } else {
      status = 404; res.writeHead(404, headers); res.end();
    }
    requestLog.push({ method: req.method, path: url.pathname, status: req.method === "POST" && url.pathname === "/result" ? 204 : req.method === "POST" ? 204 : status, bytes: body.length });
  });
});

function analyzeNetLog(file) {
  // net-log JSON may be truncated if the browser was killed; extract URLs by pattern
  let text = "";
  try { text = fs.readFileSync(file, "utf8"); } catch (e) { return { readable: false }; }
  const urls = new Map();
  for (const m of text.matchAll(/"url":"([^"]{1,300})"/g)) {
    let u = m[1];
    if (u.startsWith("data:")) u = "data:(...)";
    urls.set(u, (urls.get(u) || 0) + 1);
  }
  const hosts = new Set();
  for (const u of urls.keys()) { try { hosts.add(new URL(u).host); } catch (e) { hosts.add(u.substring(0, 20)); } }
  return { readable: true, bytes: text.length, distinctUrls: Array.from(urls.entries()).map(([u, n]) => u + " x" + n), hosts: Array.from(hosts) };
}

(REDIRECT ? require(path.join(__dirname, "../../transport/redirectServers.cjs")).startRedirectServers() : Promise.resolve(undefined)).then((rs) => {
  redirectServers = rs;
  if (rs !== undefined) {
    const allow = (p) => p.replace("connect-src 'self'", "connect-src 'self' " + rs.first + " " + rs.second);
    CSP_PAGE = allow(CSP_PAGE); CSP_WORKER = allow(CSP_WORKER);
  }
  server.listen(0, "127.0.0.1", () => run());
});

async function run() {
  const port = server.address().port;
  const userData = path.join(OUT, "chromium-profile");
  const netLog = path.join(OUT, "netlog.json");
  const flags = ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--disable-background-networking",
    "--disable-component-update", "--disable-sync", "--disable-default-apps", "--disable-extensions", "--metrics-recording-only",
    "--disable-domain-reliability", "--disable-breakpad", "--disable-client-side-phishing-detection",
    "--disable-features=OptimizationHints,MediaRouter,Translate,AutofillServerCommunication,CertificateTransparencyComponentUpdater",
    ...(CONTAIN ? ["--proxy-server=http://127.0.0.1:9", "--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1"] : []),
    "--user-data-dir=" + userData, "--log-net-log=" + netLog, "--net-log-capture-mode=Default",
    "http://127.0.0.1:" + port + "/index.html" + (QUERY ? "?" + QUERY : "")];
  const started = new Date().toISOString();
  if (fs.existsSync(userData)) throw new Error("profile directory must be new");
  const child = spawn(CHROMIUM, flags, { stdio: ["ignore", "pipe", "pipe"], detached: true }); // own process group
  chromiumPid = child.pid;
  let stderr = "";
  child.stderr.on("data", (d) => { stderr += d.toString(); if (stderr.length > 20000) stderr = stderr.slice(-20000); });
  let chromiumExit;
  child.on("exit", (code, signal) => { chromiumExit = { code, signal }; });
  const timer = setTimeout(() => resolveResult(), TIMEOUT);
  await resultPromise;
  clearTimeout(timer);
  await new Promise((r) => setTimeout(r, 1500)); // allow late CSP reports
  const killGroup = (sig) => { try { process.kill(-child.pid, sig); } catch (e) { /* group already gone */ } };
  if (chromiumExit === undefined) killGroup("SIGTERM");
  await new Promise((r) => { if (chromiumExit !== undefined) r(); else child.on("exit", () => r()); setTimeout(r, 10000); });
  killGroup("SIGKILL"); // remaining helper processes of this test-owned group only
  server.close();
  let redirectCounts;
  if (redirectServers !== undefined) {
    const st = redirectServers.snapshot();
    const total = (b) => Object.values(b).reduce((n, v) => n + v.requests, 0);
    redirectCounts = { redirectsSent: st.redirectsSent, firstRequests: total(st.first), secondRequests: total(st.second), landedRequests: total(st.landed), preflights: st.preflights };
    await redirectServers.close();
  }
  const version = await new Promise((r) => { const v = spawn(CHROMIUM, ["--version"]); let o = ""; v.stdout.on("data", (d) => { o += d; }); v.on("exit", () => r(o.trim())); });
  const summary = {
    chromium: version, started, finished: new Date().toISOString(), port, csp: CSP_PAGE, cspWorker: CSP_WORKER, networkContainment: CONTAIN, chromiumFlags: flags.map((f) => f.replace(OUT, "<out>")),
    resultReceived: result !== undefined, chromiumExit: chromiumExit || "terminated by runner",
    requestLog, cspReports: cspReports.map((r) => { const b = r["csp-report"] || r; return { directive: b["effective-directive"] || b["violated-directive"], blocked: String(b["blocked-uri"] || "").startsWith("data") ? "data" : b["blocked-uri"], source: b["source-file"] ? String(b["source-file"]).replace(/^https?:\/\/127\.0\.0\.1:\d+/, "") : undefined }; }),
    netLog: analyzeNetLog(netLog),
    redirectServers: redirectCounts,
    chromiumStderrTail: stderr.split("\n").slice(-15).join("\n")
  };
  fs.writeFileSync(path.join(OUT, "report.json"), JSON.stringify(result === undefined ? { fatal: "no result within timeout" } : result, null, 2) + "\n");
  fs.writeFileSync(path.join(OUT, "browser-summary.json"), JSON.stringify(summary, null, 2) + "\n");
  if (MARKS) fs.writeFileSync(path.join(OUT, "marks.json"), JSON.stringify(marks, null, 2) + "\n");
  const checks = result && Array.isArray(result.checks) ? result.checks : [];
  process.stdout.write("checks: " + checks.map((c) => c.id + "=" + c.status).join(" ") + "\n");
  if (RECORD) process.exit(0);
  const failed = MARKS
    ? !result || result.fatal !== undefined || result.result === undefined || cspReports.length > 0 // measurement run: a result, no fatal error, no CSP report
    : !result || checks.length === 0 || checks.some((c) => c.status === "fail") || cspReports.length > 0;
  process.exit(failed ? 1 : 0);
}
