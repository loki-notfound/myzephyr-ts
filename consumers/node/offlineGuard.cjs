"use strict";
// Preloaded (node --require) by the offline platform checks of the Node consumer: every attempt to
// open a network connection, resolve a name or fetch fails at once and is counted, in the main
// thread and in every worker thread (workers inherit the preload). At exit the main thread writes
// the counts of all threads to OFFLINE_GUARD_OUT; a passing run has none. Electron's main process
// requires this file instead of preloading it; there it covers the main thread only.
const net = require("net");
const dns = require("dns");
const fs = require("fs");
const { isMainThread, BroadcastChannel } = require("worker_threads");
const counts = { connect: 0, dns: 0, fetch: 0 };
const channel = new BroadcastChannel("zephyr-ts-offline-guard");
channel.unref();
const blocked = (kind) => { counts[kind]++; if (!isMainThread) channel.postMessage(kind); const e = new Error("network access blocked by the offline guard"); e.code = "OFFLINE_GUARD"; return e; };
const origConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const o = args[0];
  // an IPC pipe or a Unix socket of the runtime itself is not network access
  if ((o && typeof o === "object" && typeof o.path === "string") || (typeof o === "string" && !/^\d+$/.test(o))) return origConnect.apply(this, args);
  const e = blocked("connect");
  process.nextTick(() => this.destroy(e));
  return this;
};
for (const name of ["lookup", "resolve", "resolve4", "resolve6"]) dns[name] = (...a) => { const cb = a[a.length - 1]; const e = blocked("dns"); if (typeof cb === "function") process.nextTick(() => cb(e)); };
if (typeof globalThis.fetch === "function") globalThis.fetch = async () => { throw blocked("fetch"); };
if (isMainThread) {
  const listen = new BroadcastChannel("zephyr-ts-offline-guard");
  listen.unref();
  listen.onmessage = (m) => { if (counts[m.data] !== undefined) counts[m.data]++; };
  if (process.env.OFFLINE_GUARD_OUT) process.on("exit", () => { fs.writeFileSync(process.env.OFFLINE_GUARD_OUT, JSON.stringify({ guard: "loaded", counts }) + "\n"); });
}
module.exports = { counts }; // read by a host that requires the guard itself (the Electron consumer)
