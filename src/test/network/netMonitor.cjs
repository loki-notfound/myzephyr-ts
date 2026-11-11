/**
 * Test-only Node preload (node --require) for the network tests: records every outbound socket
 * connection and DNS lookup in the main thread and in worker threads, allows only the configured
 * test daemons (testEndpoints.cjs) and test-owned loopback listeners (127.0.0.1), and blocks
 * everything else before it connects. One JSON line per event (no payloads) is appended to
 * $NETWORK_MONITOR_LOG.
 */
"use strict";
const fs = require("fs");
const net = require("net");
const dns = require("dns");
const { threadId, isMainThread } = require("worker_threads");
const LOG = process.env.NETWORK_MONITOR_LOG;
const appendFileSync = fs.appendFileSync;
function emit(kind, target, allowed) {
  if (!LOG) return;
  appendFileSync(LOG, JSON.stringify({ threadId, pid: process.pid, kind, target, allowed }) + "\n");
}
emit("start", isMainThread ? "main" : "worker", true);
// the configured test daemons (testEndpoints.cjs) and loopback; nothing else
const ENDPOINTS = require("./testEndpoints.cjs").requireTestEndpoints().all;
const ALLOWED_HOSTS = new Map();
for (const e of ENDPOINTS) { if (!ALLOWED_HOSTS.has(e.host)) ALLOWED_HOSTS.set(e.host, new Set()); ALLOWED_HOSTS.get(e.host).add(e.port); }
const ALLOWED_NAMES = new Set(ENDPOINTS.map((e) => e.host).filter((h) => net.isIP(h) === 0));
function allowedTarget(host, port) {
  if (host === "127.0.0.1") return true;
  const ports = ALLOWED_HOSTS.get(host);
  return ports !== undefined && ports.has(Number(port));
}
function blocked(kind) { const e = new Error("blocked by network monitor: " + kind); e.code = "EMONITORBLOCKED"; return e; }
const origConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const a = args[0];
  const opts = Array.isArray(a) ? a[0] : a;
  let host, port;
  if (typeof opts === "object" && opts !== null) {
    if (opts.path) return origConnect.apply(this, args);
    host = opts.host || "localhost"; port = opts.port;
  } else { port = opts; host = typeof args[1] === "string" ? args[1] : "localhost"; }
  const ok = allowedTarget(String(host), port);
  emit("connect", String(host) + ":" + String(port), ok);
  if (!ok) { this.destroy(blocked("connect")); return this; }
  return origConnect.apply(this, args);
};
for (const name of ["lookup", "resolve", "resolve4", "resolve6"]) {
  const orig = dns[name];
  dns[name] = function (host, ...rest) {
    const ok = ALLOWED_NAMES.has(String(host));
    emit("dns", String(host), ok);
    if (!ok) { const cb = rest[rest.length - 1]; if (typeof cb === "function") process.nextTick(cb, blocked("dns")); return undefined; }
    return orig.call(this, host, ...rest);
  };
}
if (typeof globalThis.fetch === "function") {
  globalThis.fetch = async function (input) { emit("fetch", typeof input === "string" ? input.substring(0, 80) : "request", false); throw blocked("fetch"); };
}
