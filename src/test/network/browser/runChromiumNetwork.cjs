#!/usr/bin/env node
/**
 * Chromium runner of the network stage (test only). Starts the test-owned loopback
 * forwarder (which serves the page, the release worker bundle, the disposable seed wallet and the
 * daemon routes), runs the page in the installed headless Chromium with mandatory containment and
 * collects the posted report, the forwarder's counts and Chromium's net-log. Only the processes
 * started here are terminated.
 *
 * Containment: every non-loopback request goes to a closed local proxy port and every
 * non-loopback host name maps to NOTFOUND, in a new isolated profile. The browser can reach
 * nothing but 127.0.0.1; the forwarder alone contacts the permitted upstream.
 *
 * Usage: runChromiumNetwork.cjs --root <page dir> --seed <seed dir> --out <dir> --checks N01,...
 *                               --upstream <permitted url> [--chromium <binary>] [--timeout-ms N]
 */
"use strict";
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const args = process.argv.slice(2);
const arg = (n, d) => { const i = args.indexOf("--" + n); return i >= 0 ? args[i + 1] : d; };
const ROOT = path.resolve(arg("root"));
const SEED = path.resolve(arg("seed"));
const OUT = path.resolve(arg("out"));
const CHECKS = arg("checks");
const UPSTREAM = arg("upstream");
const CHROMIUM = arg("chromium", "chromium");
const TIMEOUT = Number(arg("timeout-ms", "1800000"));
const MARKER = arg("marker", "MARKERnodetext");

function analyzeNetLog(file) {
  let text = "";
  try { text = fs.readFileSync(file, "utf8"); } catch (e) { return { readable: false }; }
  const urls = new Map();
  for (const m of text.matchAll(/"url":"([^"]{1,300})"/g)) {
    let u = m[1];
    if (u.startsWith("data:")) u = "data:(...)";
    try { const p = new URL(u); u = p.protocol + "//" + p.host + p.pathname; } catch (e) { /* keep */ }
    urls.set(u, (urls.get(u) || 0) + 1);
  }
  const hosts = new Set();
  for (const u of urls.keys()) { try { hosts.add(new URL(u).host); } catch (e) { hosts.add(u.substring(0, 20)); } }
  const sockets = new Set();
  for (const m of text.matchAll(/"address":"([^"]{1,80})"/g)) sockets.add(m[1]);
  return { readable: true, bytes: text.length, distinctUrls: Array.from(urls.entries()).map(([u, n]) => u + " x" + n), hosts: Array.from(hosts), socketAddresses: Array.from(sockets) };
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const fwdOut = path.join(OUT, "fwd");
  const fwd = spawn(process.execPath, [path.join(__dirname, "..", "forwarder.cjs"), "--upstream", UPSTREAM, "--out", fwdOut, "--page", ROOT, "--seed", SEED, "--checks", CHECKS, "--marker", MARKER],
    { stdio: ["ignore", "pipe", "pipe"] });
  let fwdStdout = "";
  let fwdExit;
  fwd.on("exit", (code, signal) => { fwdExit = { code, signal }; });
  const ready = new Promise((resolve, reject) => {
    fwd.stdout.on("data", (d) => { fwdStdout += d.toString(); const line = fwdStdout.split("\n").find((l) => l.startsWith("{\"ready\"")); if (line) resolve(JSON.parse(line).ports); });
    fwd.on("exit", () => reject(new Error("forwarder exited")));
    setTimeout(() => reject(new Error("forwarder not ready")), 10000);
  });
  const ports = await ready;
  const userData = path.join(OUT, "chromium-profile");
  const netLog = path.join(OUT, "netlog.json");
  if (fs.existsSync(userData)) throw new Error("profile directory must be new");
  const flags = ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--disable-background-networking",
    "--disable-component-update", "--disable-sync", "--disable-default-apps", "--disable-extensions", "--metrics-recording-only",
    "--disable-domain-reliability", "--disable-breakpad", "--disable-client-side-phishing-detection",
    "--disable-features=OptimizationHints,MediaRouter,Translate,AutofillServerCommunication,CertificateTransparencyComponentUpdater",
    "--proxy-server=http://127.0.0.1:9", "--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1",
    "--user-data-dir=" + userData, "--log-net-log=" + netLog, "--net-log-capture-mode=Default",
    "http://127.0.0.1:" + ports.daemon + "/index.html"];
  const started = new Date().toISOString();
  const child = spawn(CHROMIUM, flags, { stdio: ["ignore", "pipe", "pipe"], detached: true });
  let stderr = "";
  child.stderr.on("data", (d) => { stderr += d.toString(); if (stderr.length > 20000) stderr = stderr.slice(-20000); });
  let chromiumExit;
  child.on("exit", (code, signal) => { chromiumExit = { code, signal }; });
  const reportFile = path.join(fwdOut, "report.json");
  const t0 = Date.now();
  while (!fs.existsSync(reportFile) && Date.now() - t0 < TIMEOUT && chromiumExit === undefined && fwdExit === undefined) await new Promise((r) => setTimeout(r, 250));
  await new Promise((r) => setTimeout(r, 1500)); // late CSP reports
  const killGroup = (sig) => { try { process.kill(-child.pid, sig); } catch (e) { /* group already gone */ } };
  if (chromiumExit === undefined) killGroup("SIGTERM");
  await new Promise((r) => { if (chromiumExit !== undefined) r(); else child.on("exit", () => r()); setTimeout(r, 10000); });
  killGroup("SIGKILL");
  const fwdEarly = fwdExit; // a forwarder that ended before the runner stopped it failed the run
  const fwdDone = new Promise((r) => { if (fwdExit !== undefined) r(); else fwd.on("exit", r); });
  if (fwdExit === undefined) fwd.kill("SIGTERM");
  await fwdDone;
  if (fwdEarly !== undefined) { process.stderr.write("forwarder ended early: " + JSON.stringify(fwdEarly) + "\n"); process.exit(1); }
  const version = await new Promise((r) => { const v = spawn(CHROMIUM, ["--version"]); let o = ""; v.stdout.on("data", (d) => { o += d; }); v.on("exit", () => r(o.trim())); });
  let report;
  try { report = JSON.parse(fs.readFileSync(reportFile, "utf8")); } catch (e) { report = { fatal: "no result within timeout" }; }
  fs.writeFileSync(path.join(OUT, "report.json"), JSON.stringify(report, null, 2) + "\n");
  const forwarder = JSON.parse(fs.readFileSync(path.join(fwdOut, "forwarder.json"), "utf8"));
  const summary = { chromium: version, started, finished: new Date().toISOString(), ports, networkContainment: true, chromiumFlags: flags.map((f) => f.replace(OUT, "<out>")),
    resultReceived: report.fatal === undefined, chromiumExit: chromiumExit || "terminated by runner", netLog: analyzeNetLog(netLog), chromiumStderrTail: stderr.split("\n").slice(-15).join("\n") };
  fs.writeFileSync(path.join(OUT, "browser-summary.json"), JSON.stringify(summary, null, 2) + "\n");
  const checks = Array.isArray(report.checks) ? report.checks : [];
  process.stdout.write("checks: " + checks.map((c) => c.id + "=" + c.status).join(" ") + "\n");
  const want = CHECKS.split(",").length;
  const failed = report.fatal !== undefined || checks.length !== want || checks.some((c) => c.status !== "pass" && c.status !== "not-run") || forwarder.cspReports.length > 0;
  process.exit(failed ? 1 : checks.every((c) => c.status === "pass") ? 0 : 3); // 3: every check that ran passed, at least one was not run
})().catch((e) => { process.stderr.write("runner failed: " + (e && e.message) + "\n"); process.exit(1); });
