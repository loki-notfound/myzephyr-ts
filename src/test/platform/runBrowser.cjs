#!/usr/bin/env node
"use strict";
/**
 * Runs the offline checks of the built Vite consumer (?offline: the wallet in a worker) in one
 * browser, served from loopback under the page policy of docs/DEPLOYMENT.md (pageServer.cjs), and
 * judges the result. No dependency: a Chromium-family browser is started directly (headless, with
 * the network contained as in the lifecycle runner), any other browser through the WebDriver
 * endpoint of its installed driver (chromedriver, msedgedriver, geckodriver, safaridriver), spoken
 * with Node's own fetch. Only the processes started here are ended, by their process ids.
 *
 * Usage: runBrowser.cjs --root <built consumer dir> --out <dir> --wasm-sha256 <hex> [--tarball-sha256 <hex>]
 *          (--launch <browser binary> | --webdriver <driver binary>|auto --browser chrome|msedge|firefox|safari
 *           [--browser-binary <path>]) [--timeout-ms N] [--page-policy <policy>] [--worker-policy <policy>]
 * --webdriver auto takes the driver the machine provides: the directory named by CHROMEWEBDRIVER,
 * EDGEWEBDRIVER or GECKOWEBDRIVER (as the hosted runner images set them), else chromedriver,
 * msedgedriver or geckodriver on the PATH; for Safari /usr/bin/safaridriver.
 * --page-policy and --worker-policy replace the policy of the page and its scripts and of the worker script
 * response (policy tests only).
 * Writes <out>/report.json (the page's result) and <out>/summary.json (browser, server log, problems);
 * exits 0 only if every check passed and the server log is as expected.
 *
 * When the page gives no result, summary.json records what is known instead (noResult): how far the page
 * got (the last progress mark it posted: page loaded, checks started, one mark per check), whether the
 * browser process (with WebDriver: the driver process, and whether the session still answers) was alive
 * when the wait ended and its exit status, and the browser's output reduced to counts per category of a
 * fixed set (outputSummary): no line of its text, so no path, address or wallet text reaches a log.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const net = require("net");
const { spawn, spawnSync } = require("child_process");
const { startPageServer, judgeRun } = require("./pageServer.cjs");

const args = process.argv.slice(2);
const arg = (n, d) => { const i = args.indexOf("--" + n); return i >= 0 ? args[i + 1] : d; };
const ROOT = path.resolve(arg("root"));
const OUT = path.resolve(arg("out"));
const WASM_SHA = arg("wasm-sha256");
const TARBALL_SHA = arg("tarball-sha256", "");
const LAUNCH = arg("launch");
const BROWSER0 = arg("browser");
const DRIVER = locateDriver(arg("webdriver"), BROWSER0);

function locateDriver(given, browser) {
  if (given !== "auto") return given;
  const exe = process.platform === "win32" ? ".exe" : "";
  const name = { chrome: "chromedriver", msedge: "msedgedriver", firefox: "geckodriver", safari: "safaridriver" }[browser];
  if (name === undefined) return undefined;
  if (browser === "safari") return "/usr/bin/safaridriver";
  const dir = process.env[{ chrome: "CHROMEWEBDRIVER", msedge: "EDGEWEBDRIVER", firefox: "GECKOWEBDRIVER" }[browser]];
  const candidates = (dir ? [dir] : []).concat(String(process.env.PATH || "").split(path.delimiter));
  for (const d of candidates) { const f = path.join(d, name + exe); if (d && fs.existsSync(f)) return f; }
  return undefined;
}
const BROWSER = BROWSER0 || (LAUNCH ? "chromium" : undefined);
const BROWSER_BINARY = arg("browser-binary");
const TIMEOUT = Number(arg("timeout-ms", "900000"));
const PAGE_POLICY = arg("page-policy");
const WORKER_POLICY = arg("worker-policy");
const IDS = ["K01", "K02", "K03", "K04", "K05", "K06", "K07", "K08", "K09", "K10", "K11"];
if (arg("webdriver") === "auto" && DRIVER === undefined) { process.stderr.write("no WebDriver for " + BROWSER0 + " on this machine\n"); process.exit(2); }
if (!/^[0-9a-f]{64}$/.test(String(WASM_SHA)) || (!LAUNCH && !DRIVER) || (DRIVER && !["chrome", "msedge", "firefox", "safari"].includes(BROWSER))) {
  process.stderr.write("usage: runBrowser.cjs --root <dir> --out <dir> --wasm-sha256 <hex> (--launch <binary> | --webdriver <driver> --browser chrome|msedge|firefox|safari)\n");
  process.exit(2);
}
fs.mkdirSync(OUT, { recursive: true });
const profile = fs.mkdtempSync(path.join(OUT, "profile-"));

const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const children = [];

function start(cmd, argv, opts) {
  const child = spawn(cmd, argv, Object.assign({ stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" }, opts || {}));
  const rec = { child, exited: false, stderr: "", exitCode: null, exitSignal: null };
  child.stderr.on("data", (d) => { rec.stderr = (rec.stderr + d.toString()).slice(-65536); });
  child.stdout.on("data", (d) => { rec.stderr = (rec.stderr + d.toString()).slice(-65536); });
  child.on("exit", (code, signal) => { rec.exited = true; rec.exitCode = code; rec.exitSignal = signal; });
  child.on("error", (e) => { rec.exited = true; rec.stderr += "\nstart failed: " + e.code; });
  children.push(rec);
  return rec;
}

async function stop(rec) {
  if (rec.exited) return;
  const pid = rec.child.pid;
  if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(pid), "/t", "/f"], { stdio: "ignore" }); // the process and the children it started
  else { try { process.kill(-pid, "SIGTERM"); } catch (e) { /* gone */ } }
  for (let i = 0; i < 50 && !rec.exited; i++) await sleep(100);
  if (!rec.exited && process.platform !== "win32") { try { process.kill(-pid, "SIGKILL"); } catch (e) { /* gone */ } }
}

// ------------------------------------------------------------------- what is known without a result
// Categories of a browser's output lines, first match wins; only the counts are kept, never a line's text.
const OUTPUT_CATEGORIES = [
  ["crash", /crash|minidump|segmentation fault|sigsegv|sigabrt|sigbus|sigill|trace\/breakpoint|aborted|fatal/i],
  ["out of memory", /out of memory|\boom\b|cannot allocate|allocation fail/i],
  ["killed", /\bkilled\b|sigkill|sigterm/i],
  ["gpu", /\bgpu\b|\bviz\b|\begl\b|\bgl\b|vulkan|mesa|drm/i],
  ["sandbox", /sandbox|namespace|seccomp/i],
  ["system bus", /dbus|d-bus|bus\.cc/i],
  ["fonts", /fontconfig|font/i],
  ["WebAssembly", /wasm|webassembly/i],
  ["worker", /worker/i],
  ["network", /net::|network|socket|connection/i],
  ["error", /error/i],
  ["warning", /warn/i]
];
function outputSummary(text) {
  const lines = String(text || "").split(/\r?\n/).filter((l) => l.trim().length > 0);
  const category = (l) => { for (const [name, re] of OUTPUT_CATEGORIES) if (re.test(l)) return name; return "other"; };
  const counts = {};
  for (const l of lines) { const c = category(l); counts[c] = (counts[c] || 0) + 1; }
  return { lines: lines.length, counts, lastLines: lines.slice(-8).map(category) };
}
/** Mark the state of a process when the wait for the page's result ended (before the runner stops it). */
function markEnd(rec) {
  rec.atEnd = rec.exited ? { alive: false, exitCode: rec.exitCode, exitSignal: rec.exitSignal } : { alive: true, exitCode: null, exitSignal: null };
}
function processState(rec, label) {
  const e = rec.atEnd || { alive: !rec.exited, exitCode: rec.exitCode, exitSignal: rec.exitSignal };
  return { process: label, aliveWhenTheWaitEnded: e.alive, exitCode: e.exitCode, exitSignal: e.exitSignal };
}

// ------------------------------------------------------------------------------- WebDriver
async function wd(base, method, p, body) {
  const r = await fetch(base + p, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json;
  try { json = JSON.parse(text); } catch (e) { json = { value: { error: "unparseable", message: text.substring(0, 200) } }; }
  if (!r.ok || (json.value && json.value.error)) throw new Error("WebDriver " + method + " " + p + ": " + JSON.stringify(json.value).substring(0, 400));
  return json.value;
}

// msedgedriver on Windows does not always find the browser by itself: name the binary of a standard installation
function edgeOnWindows() {
  if (process.platform !== "win32") return undefined;
  for (const base of [process.env["ProgramFiles(x86)"], process.env.ProgramFiles]) {
    if (!base) continue;
    const p = path.join(base, "Microsoft", "Edge", "Application", "msedge.exe");
    if (fs.existsSync(p)) return p;
  }
  return undefined;
}

function capabilities() {
  const headless = process.env.PLATFORM_TEST_HEADED === "1" ? [] : null;
  if (BROWSER === "chrome" || BROWSER === "msedge") {
    const key = BROWSER === "chrome" ? "goog:chromeOptions" : "ms:edgeOptions";
    const o = { args: (headless || ["--headless=new"]).concat(["--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-component-update",
      "--disable-sync", "--disable-extensions", "--disable-default-apps", "--user-data-dir=" + profile]) };
    const binary = BROWSER_BINARY || (BROWSER === "msedge" ? edgeOnWindows() : undefined);
    if (binary) o.binary = binary;
    return { browserName: BROWSER, [key]: o };
  }
  if (BROWSER === "firefox") {
    const o = { args: (headless || ["-headless"]).concat(["-profile", profile]), prefs: { "browser.shell.checkDefaultBrowser": false, "app.update.enabled": false,
      "datareporting.policy.dataSubmissionEnabled": false, "toolkit.telemetry.enabled": false, "network.captive-portal-service.enabled": false } };
    if (BROWSER_BINARY) o.binary = BROWSER_BINARY;
    return { browserName: "firefox", "moz:firefoxOptions": o };
  }
  return { browserName: "safari" };
}

async function runWebDriver(url, server) {
  const port = await freePort();
  const argv = BROWSER === "safari" ? ["--port", String(port)] : BROWSER === "firefox" ? ["--port", String(port), "--host", "127.0.0.1"] : ["--port=" + port];
  const driver = start(DRIVER, argv);
  const base = "http://127.0.0.1:" + port;
  let ready = false;
  for (let i = 0; i < 150 && !driver.exited; i++) {
    try { const s = await wd(base, "GET", "/status"); if (s && s.ready !== false) { ready = true; break; } } catch (e) { /* not listening yet */ }
    await sleep(200);
  }
  if (!ready) { await stop(driver); throw new Error("the driver did not start: " + driver.stderr.split("\n").slice(-5).join(" | ")); }
  let session;
  const info = { driver: path.basename(DRIVER) };
  try {
    const s = await wd(base, "POST", "/session", { capabilities: { alwaysMatch: capabilities() } });
    session = s.sessionId;
    info.browserName = s.capabilities.browserName;
    info.browserVersion = s.capabilities.browserVersion;
    info.platformName = s.capabilities.platformName;
    await wd(base, "POST", "/session/" + session + "/url", { url });
    info.result = await server.waitFor("offline", TIMEOUT);
    if (info.result === undefined) {
      markEnd(driver);
      let answers = false;
      try { await Promise.race([wd(base, "GET", "/session/" + session + "/url"), sleep(10000).then(() => { throw new Error("no answer"); })]); answers = true; } catch (e) { answers = false; }
      info.sessionAnswers = answers;
    }
    try { info.status = String(await wd(base, "POST", "/session/" + session + "/execute/sync", { script: "return document.getElementById('status').textContent", args: [] })).substring(0, 40); } catch (e) { info.status = "unreadable"; }
  } finally {
    if (session) { try { await wd(base, "DELETE", "/session/" + session); } catch (e) { info.deleteError = String(e.message).substring(0, 200); } }
    await stop(driver);
  }
  if (info.result === undefined) info.processes = [Object.assign(processState(driver, "driver " + path.basename(DRIVER)), { sessionAnswers: info.sessionAnswers })], info.output = outputSummary(driver.stderr);
  return info;
}

// ------------------------------------------------------------------------- direct Chromium
async function runLaunch(url, server) {
  const flags = ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--disable-background-networking",
    "--disable-component-update", "--disable-sync", "--disable-default-apps", "--disable-extensions", "--disable-breakpad",
    "--disable-features=OptimizationHints,MediaRouter,Translate,AutofillServerCommunication,CertificateTransparencyComponentUpdater",
    "--proxy-server=http://127.0.0.1:9", "--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1",
    "--user-data-dir=" + profile, url];
  const browser = start(LAUNCH, flags);
  const info = { launched: path.basename(LAUNCH) };
  try {
    info.result = await Promise.race([server.waitFor("offline", TIMEOUT), (async () => { while (!browser.exited) await sleep(500); return undefined; })()]);
    if (info.result === undefined) markEnd(browser);
  } finally {
    await stop(browser);
  }
  const v = spawnSync(LAUNCH, ["--version"], { encoding: "utf8" });
  info.browserName = "chromium";
  info.browserVersion = (v.stdout || "").trim().substring(0, 80);
  if (info.result === undefined) info.processes = [processState(browser, "browser")], info.output = outputSummary(browser.stderr);
  return info;
}

(async () => {
  const server = await startPageServer({ root: ROOT, pagePolicy: PAGE_POLICY, workerPolicy: WORKER_POLICY, info: { tarballSha256: TARBALL_SHA, wasmSha256: WASM_SHA, runner: "automated" } });
  const url = server.origin + "/index.html?offline";
  const started = new Date().toISOString();
  let info;
  let fatal;
  try {
    info = LAUNCH ? await runLaunch(url, server) : await runWebDriver(url, server);
  } catch (e) {
    fatal = String(e && e.message ? e.message : e).substring(0, 600);
  }
  await sleep(1000); // late policy reports
  const snapshot = server.snapshot();
  await server.close();
  for (const c of children) await stop(c);
  const result = info && info.result;
  const problems = fatal ? ["runner: " + fatal] : judgeRun(result, snapshot, { ids: IDS, wasmSha256: WASM_SHA });
  // without a result: how far the page got, the browser's (or driver's) state and its output in counts
  const noResult = result ? undefined : {
    lastProgress: snapshot.progress.last === undefined ? "none" : snapshot.progress.last, progressMarks: snapshot.progress.marks, unrecognizedMarks: snapshot.progress.unrecognized,
    processes: info && info.processes, output: info && info.output, fatal: fatal ? true : undefined
  };
  const summary = {
    browser: BROWSER, browserName: info && info.browserName, browserVersion: info && info.browserVersion, platformName: info && info.platformName,
    via: LAUNCH ? "direct launch" : "WebDriver (" + path.basename(DRIVER) + ")", host: { platform: process.platform, arch: process.arch, release: os.release(), node: process.version },
    userAgent: result && result.env ? result.env.userAgent : undefined, tarballSha256: TARBALL_SHA, wasmSha256: WASM_SHA,
    started, finished: new Date().toISOString(), pageStatus: info && info.status, requests: snapshot.requests, cspReports: snapshot.cspReports,
    pagePolicy: snapshot.pagePolicy, workerPolicy: snapshot.workerPolicy, progress: snapshot.progress, noResult, problems, passed: problems.length === 0
  };
  fs.writeFileSync(path.join(OUT, "report.json"), JSON.stringify(result || { fatal: fatal || "no result within the timeout" }, null, 1) + "\n");
  fs.writeFileSync(path.join(OUT, "summary.json"), JSON.stringify(summary, null, 1) + "\n");
  fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
  const checks = result && Array.isArray(result.checks) ? result.checks : [];
  process.stdout.write("browser: " + [summary.browserName, summary.browserVersion, summary.platformName].filter(Boolean).join(" ") + " via " + summary.via + "\n");
  if (summary.userAgent) process.stdout.write("user agent: " + summary.userAgent + "\n");
  process.stdout.write("checks: " + checks.map((c) => c.id + "=" + c.status).join(" ") + "\n");
  for (const p of problems) process.stdout.write("problem: " + p + "\n");
  if (noResult) {
    const ps = (noResult.processes || []).map((p) => p.process + (p.aliveWhenTheWaitEnded ? " still running" : " ended, exit code " + p.exitCode + ", signal " + p.exitSignal) + (p.sessionAnswers === undefined ? "" : ", session answers " + p.sessionAnswers)).join("; ");
    const o = noResult.output;
    process.stdout.write("no result: last progress " + noResult.lastProgress + " (" + noResult.progressMarks + " marks); " + (ps || "no process state") + "; output "
      + (o ? o.lines + " lines: " + Object.keys(o.counts).sort().map((k) => k + " " + o.counts[k]).join(", ") + "; last lines: " + o.lastLines.join(", ") : "not recorded") + "\n");
  }
  process.exit(problems.length === 0 ? 0 : 1);
})().catch(async (e) => {
  process.stderr.write("runner failed: " + (e && e.message ? e.message : e) + "\n");
  for (const c of children) await stop(c);
  process.exit(1);
});
