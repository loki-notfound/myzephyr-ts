"use strict";
// Minimal Electron consumer of the packed package (platform tests, bin/test_platform_electron.sh).
// Runs the offline checks of ../vite/src/offlineChecks.js
//   * in the main process through the Node.js entry (require), directly and with a worker per wallet;
//   * in a sandboxed renderer (context isolation, no Node.js integration) that loads the Vite build of
//     the browser consumer at ?offline from the privileged scheme app:// under the page policy of
//     docs/DEPLOYMENT.md, with the wallet in a worker.
// No daemon is configured; the main thread blocks and counts network access (offlineGuard.cjs) and
// the session cancels and counts every renderer request outside app://.
//
// Usage: electron main.cjs --checks <offlineChecks.js> --root <built Vite consumer> --guard <offlineGuard.cjs>
//                          --page-server <pageServer.cjs> --out <dir> [--timeout-ms N]
// Writes <out>/electron-main-direct.json, electron-main-worker.json (with .guard.json each) and
// electron-renderer.json, electron-renderer-summary.json; exits 0 only if every check passed.
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { pathToFileURL } = require("url");

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf("--" + n); return i >= 0 ? argv[i + 1] : d; };
const OUT = path.resolve(arg("out"));
const ROOT = path.resolve(arg("root"));
const guard = require(path.resolve(arg("guard")));
const { judgeRun, PAGE_POLICY, WORKER_POLICY, PROGRESS_MARK } = require(path.resolve(arg("page-server")));
const CHECKS_FILE = path.resolve(arg("checks"));
const TIMEOUT = Number(arg("timeout-ms", "900000"));
const { app, BrowserWindow, protocol, session } = require("electron");

protocol.registerSchemesAsPrivileged([{ scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);
app.disableHardwareAcceleration();
app.on("window-all-closed", () => undefined);

const sha256 = (b) => crypto.createHash("sha256").update(b).digest("hex");
const env = () => ({ electron: process.versions.electron, chrome: process.versions.chrome, node: process.version, v8: process.versions.v8, platform: process.platform,
  arch: process.arch, osType: os.type(), osRelease: os.release(), osVersion: typeof os.version === "function" ? os.version() : undefined });

async function mainProcessChecks(z, runOfflineChecks, mode) {
  const before = Object.assign({}, guard.counts);
  const started = new Date().toISOString();
  const report = await runOfflineChecks(z, { proxyToWorker: mode === "worker", log: (line) => process.stdout.write("main " + mode + ": " + line + "\n") });
  const wasm = require.resolve("@loki-notfound/zephyr-ts/zephyr.wasm");
  const result = { phase: "offline", loader: "require", mode, process: "electron-main", started, finished: new Date().toISOString(), env: env(),
    package: { wasmSha256: sha256(fs.readFileSync(wasm)) }, checks: report.checks };
  const file = path.join(OUT, "electron-main-" + mode + ".json");
  fs.writeFileSync(file, JSON.stringify(result, null, 1) + "\n");
  const counts = {}; for (const k of Object.keys(guard.counts)) counts[k] = guard.counts[k] - before[k];
  fs.writeFileSync(file.replace(/\.json$/, ".guard.json"), JSON.stringify({ guard: "loaded", scope: "main thread", counts }) + "\n");
  process.stdout.write("main " + mode + " checks: " + report.checks.map((c) => c.id + "=" + c.status).join(" ") + "\n");
  return report.checks.every((c) => c.status === "pass");
}

function servePage() {
  const files = new Map();
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else files.set("/" + path.relative(ROOT, p).split(path.sep).join("/"), p); } };
  walk(ROOT);
  const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".wasm": "application/wasm", ".json": "application/json" };
  const state = { requests: [], cspReports: [], result: undefined, resolve: undefined, progress: { last: undefined, marks: 0, unrecognized: 0 } };
  const done = new Promise((r) => { state.resolve = r; });
  protocol.handle("app", async (request) => {
    const url = new URL(request.url);
    const entry = { method: request.method, path: url.pathname, dest: "", status: 0 };
    state.requests.push(entry);
    const isWorker = /zephyr\.worker[^/]*\.js$/.test(url.pathname);
    const headers = { "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store", "Content-Security-Policy": isWorker ? WORKER_POLICY : PAGE_POLICY };
    if (request.method === "POST" && url.pathname === "/result") {
      try { state.result = JSON.parse(await request.text()); } catch (e) { state.result = { phase: "unparseable" }; }
      entry.status = 204; state.resolve();
      return new Response(null, { status: 204, headers });
    }
    if (request.method === "POST" && url.pathname === "/csp-report") {
      try { const r = JSON.parse(await request.text()); const b = r["csp-report"] || r; state.cspReports.push({ directive: b["effective-directive"] || b["violated-directive"], blocked: String(b["blocked-uri"] || "").substring(0, 80) }); } catch (e) { state.cspReports.push({ unparseable: true }); }
      entry.status = 204;
      return new Response(null, { status: 204, headers });
    }
    if (request.method === "POST" && url.pathname === "/progress") {
      // how far the page got: the last mark of the fixed set the page server knows; no other text of the page is kept
      const mark = (await request.text()).trim();
      if (PROGRESS_MARK.test(mark)) { state.progress.last = mark; state.progress.marks++; } else state.progress.unrecognized++;
      entry.status = 204;
      return new Response(null, { status: 204, headers });
    }
    if (request.method === "GET" && url.pathname === "/info.json") {
      entry.status = 200;
      return new Response(JSON.stringify({ runner: "electron" }), { status: 200, headers: Object.assign({ "Content-Type": "application/json" }, headers) });
    }
    const file = files.get(url.pathname === "/" ? "/index.html" : url.pathname);
    if (request.method !== "GET" || file === undefined) { entry.status = 404; return new Response(null, { status: 404, headers }); }
    const data = fs.readFileSync(file);
    if (/\.wasm$/.test(file) || isWorker) entry.sha256 = sha256(data);
    if (isWorker) entry.worker = true;
    entry.status = 200;
    return new Response(data, { status: 200, headers: Object.assign({ "Content-Type": types[path.extname(file)] || "application/octet-stream" }, headers) });
  });
  return { state, done };
}

async function rendererChecks(wasmSha256) {
  const blocked = [];
  session.defaultSession.webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, (d, cb) => {
    if (d.url.startsWith("app://") || d.url.startsWith("devtools://")) return cb({});
    blocked.push(d.url.substring(0, 80)); cb({ cancel: true });
  });
  const { state, done } = servePage();
  const win = new BrowserWindow({ show: false, width: 1000, height: 800, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  let crashed;
  win.webContents.on("render-process-gone", (e, d) => { crashed = d.reason; state.resolve(); });
  await win.loadURL("app://bundle/index.html?offline");
  const timer = setTimeout(() => state.resolve(), TIMEOUT);
  await done;
  clearTimeout(timer);
  await new Promise((r) => setTimeout(r, 1000)); // late policy reports
  const userAgent = crashed ? undefined : await win.webContents.executeJavaScript("navigator.userAgent").catch(() => undefined);
  win.destroy();
  const result = state.result;
  if (result) { result.renderer = true; result.env = Object.assign({}, result.env, { electron: process.versions.electron, chrome: process.versions.chrome, platform: process.platform, arch: process.arch }); }
  const snapshot = { requests: state.requests, cspReports: state.cspReports };
  const problems = result ? judgeRun(result, snapshot, { ids: result.checks.map((c) => c.id).length ? ["K01", "K02", "K03", "K04", "K05", "K06", "K07", "K08", "K09", "K10", "K11"] : ["none"], wasmSha256 }) : ["no result from the renderer" + (crashed ? " (renderer gone: " + crashed + ")" : "") + "; last progress " + (state.progress.last === undefined ? "none" : state.progress.last) + " (" + state.progress.marks + " marks)"];
  if (blocked.length) problems.push("renderer requests outside app:// cancelled: " + blocked.join(" "));
  fs.writeFileSync(path.join(OUT, "electron-renderer.json"), JSON.stringify(result || { fatal: "no result" }, null, 1) + "\n");
  fs.writeFileSync(path.join(OUT, "electron-renderer-summary.json"), JSON.stringify({ userAgent, scheme: "app://bundle", pagePolicy: PAGE_POLICY, workerPolicy: WORKER_POLICY,
    requests: state.requests, cspReports: state.cspReports, progress: state.progress, blocked, problems, passed: problems.length === 0 }, null, 1) + "\n");
  process.stdout.write("renderer checks: " + (result ? result.checks.map((c) => c.id + "=" + c.status).join(" ") : "none") + "\n");
  if (userAgent) process.stdout.write("renderer user agent: " + userAgent + "\n");
  for (const p of problems) process.stdout.write("renderer problem: " + p + "\n");
  return problems.length === 0;
}

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  process.stdout.write("electron " + process.versions.electron + " (chromium " + process.versions.chrome + ", node " + process.version + ") on " + process.platform + "-" + process.arch + "\n");
  const z = require("@loki-notfound/zephyr-ts");
  const { runOfflineChecks } = await import(pathToFileURL(CHECKS_FILE).href);
  let ok = true;
  for (const mode of ["direct", "worker"]) ok = (await mainProcessChecks(z, runOfflineChecks, mode)) && ok;
  await z.terminateWorker();
  const wasmSha256 = sha256(fs.readFileSync(require.resolve("@loki-notfound/zephyr-ts/zephyr.wasm")));
  ok = (await rendererChecks(wasmSha256)) && ok;
  app.exit(ok ? 0 : 1);
}).catch((e) => {
  process.stderr.write("electron consumer failed: " + (e && e.message ? e.message : e) + "\n");
  app.exit(1);
});
