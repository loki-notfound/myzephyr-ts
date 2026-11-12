/**
 * Test-only Node preload (node --require): records and blocks every outbound socket, DNS
 * lookup and fetch, and records host file writes, in the main thread and in worker threads. The only
 * connections let through are those to the loopback addresses named in
 * $LIFECYCLE_MONITOR_ALLOW_CONNECT (host:port, comma-separated), recorded with the kind "loopback";
 * with $LIFECYCLE_MONITOR_LOOPBACK_LISTEN=1 the local lookup of the literal 127.0.0.1 (which a server
 * makes when it listens on that address) passes too.
 * Each thread appends a start line, then one JSON line per observation (no payloads), to
 * $LIFECYCLE_MONITOR_LOG as it happens (worker 'exit' events are not reliable on terminate).
 */
"use strict";
const fs = require("fs");
const net = require("net");
const dns = require("dns");
const { threadId } = require("worker_threads");
const LOG = process.env.LIFECYCLE_MONITOR_LOG;
const ALLOW_WRITE = new Set((process.env.LIFECYCLE_MONITOR_ALLOW_WRITE || "").split(":").filter(Boolean));
const ALLOW_WRITE_DIR = process.env.LIFECYCLE_MONITOR_ALLOW_WRITE_DIR ? process.env.LIFECYCLE_MONITOR_ALLOW_WRITE_DIR.replace(/\/$/, "") + "/" : undefined;
if (LOG) ALLOW_WRITE.add(LOG);
let emitting = false;
const appendFileSync = fs.appendFileSync;
function emit(kind, target) {
  if (!LOG || emitting) return;
  emitting = true; // appendFileSync opens the log through the patched fs.openSync
  try { appendFileSync(LOG, JSON.stringify({ threadId, pid: process.pid, kind, target }) + "\n"); } finally { emitting = false; }
}
const found = { connects: { push: (t) => emit("connect", t) }, dnsLookups: { push: (t) => emit("dns", t) }, fetches: { push: (t) => emit("fetch", t) }, writes: { push: (t) => emit("write", t) } };
emit("start", require("worker_threads").isMainThread ? "main" : "worker");

// Independent worker-thread accounting in the main thread (created, and ended by an 'exit'
// event, whether terminated or crashed); read by the lifecycle checks, never part of the SDK
if (require("worker_threads").isMainThread) {
  const wt = require("worker_threads");
  const OriginalWorker = wt.Worker;
  let created = 0;
  let exited = 0;
  class MonitoredWorker extends OriginalWorker {
    constructor(...args) { super(...args); created++; this.once("exit", () => { exited++; }); }
  }
  wt.Worker = MonitoredWorker;
  globalThis.__lifecycleWorkerThreads = () => ({ created, exited });
}

function blocked(kind) { const e = new Error("blocked by lifecycle network monitor: " + kind); e.code = "EMONITORBLOCKED"; return e; }
const origConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const a = args[0];
  const target = Array.isArray(a) ? a[0] : a;
  const desc = typeof target === "object" && target !== null ? (target.path ? "unix:" + target.path : (target.host || "localhost") + ":" + target.port) : String(target) + (args[1] !== undefined && typeof args[1] !== "function" ? ":" + args[1] : "");
  if (typeof desc === "string" && desc.startsWith("unix:")) return origConnect.apply(this, args);
  // loopback servers a test started itself (read at every connect: the runner sets it after listening)
  const allowed = (process.env.LIFECYCLE_MONITOR_ALLOW_CONNECT || "").split(",").filter(Boolean);
  if (allowed.includes(desc)) { emit("loopback", desc); return origConnect.apply(this, args); }
  found.connects.push(desc);
  this.destroy(blocked("connect"));
  return this;
};
for (const name of ["lookup", "resolve", "resolve4", "resolve6"]) {
  const orig = dns[name];
  dns[name] = function (host, ...rest) {
    // the literal loopback address of servers a test starts itself (no query leaves the machine)
    if (name === "lookup" && host === "127.0.0.1" && process.env.LIFECYCLE_MONITOR_LOOPBACK_LISTEN === "1") { emit("loopback", "lookup"); return orig.call(this, host, ...rest); }
    found.dnsLookups.push(String(host)); const cb = rest[rest.length - 1]; if (typeof cb === "function") process.nextTick(cb, blocked("dns")); return undefined; };
  void orig;
}
if (typeof globalThis.fetch === "function") {
  globalThis.fetch = async function (input) { found.fetches.push(typeof input === "string" ? input.substring(0, 80) : "request"); throw blocked("fetch"); };
}
function recordWrite(path, flags) {
  const p = typeof path === "string" ? path : path instanceof URL ? path.pathname : Buffer.isBuffer(path) ? path.toString() : typeof path === "number" ? "fd:" + path : String(path);
  if (typeof flags === "string" && !/[wa+]/.test(flags)) return;
  if (typeof flags === "number" && (flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT)) === 0) return;
  if (emitting || ALLOW_WRITE.has(p) || (ALLOW_WRITE_DIR !== undefined && p.startsWith(ALLOW_WRITE_DIR))) return;
  found.writes.push(p);
}
for (const [name, flagArg] of [["writeFileSync", -1], ["writeFile", -1], ["appendFileSync", -1], ["appendFile", -1], ["createWriteStream", -1], ["mkdirSync", -1], ["mkdir", -1], ["renameSync", -1], ["rename", -1], ["copyFileSync", -1], ["copyFile", -1], ["openSync", 1], ["open", 1]]) {
  const orig = fs[name];
  if (typeof orig !== "function") continue;
  fs[name] = function (path, ...rest) { recordWrite(path, flagArg >= 0 ? (rest[flagArg - 1] === undefined ? "r" : rest[flagArg - 1]) : "w"); return orig.call(this, path, ...rest); };
}
for (const name of ["writeFile", "appendFile", "mkdir", "rename", "copyFile"]) {
  const orig = fs.promises[name];
  fs.promises[name] = function (path, ...rest) { recordWrite(path, "w"); return orig.call(this, path, ...rest); };
}
const origPromOpen = fs.promises.open;
fs.promises.open = function (path, flags, ...rest) { recordWrite(path, flags === undefined ? "r" : flags); return origPromOpen.call(this, path, flags, ...rest); };
