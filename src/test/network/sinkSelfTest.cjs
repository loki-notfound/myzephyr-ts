#!/usr/bin/env node
/**
 * Test of the forwarder's sink alone (test only, no daemon): starts a counting HTTP server on loopback as the
 * forwarder's upstream (forwarder.cjs --selftest), sends every submit or relay request form to every mount (the
 * plain forwarding mounts, which refuse them, and two sink mounts, which answer them locally), plus read requests
 * as the positive control, and requires that the upstream received no submit or relay request at all and every read.
 *
 *   node sinkSelfTest.cjs --out result.json
 *
 * Exit code 0 only if every assertion holds. The result records counts only.
 */
"use strict";
const http = require("http");
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");
const sink = require("./relaySink.cjs");

const out = (() => { const i = process.argv.indexOf("--out"); return i >= 0 ? process.argv[i + 1] : undefined; })();
if (out === undefined) { process.stderr.write("usage: sinkSelfTest.cjs --out result.json\n"); process.exit(2); }

const upstream = { requests: 0, submits: 0, reads: 0, keys: {} };
const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks);
    upstream.requests++;
    let method = "-";
    try { const j = JSON.parse(body.toString("utf8")); if (typeof j.method === "string") method = j.method.substring(0, 40); } catch (e) { /* not JSON */ }
    const key = req.method + " " + req.url.substring(0, 60) + " " + method;
    upstream.keys[key] = (upstream.keys[key] || 0) + 1;
    if (sink.isSubmit(new URL(req.url, "http://x").pathname, method)) upstream.submits++; else upstream.reads++;
    const p = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: "0", result: { status: "OK" } }));
    res.writeHead(200, { "content-type": "application/json", "content-length": p.length });
    res.end(p);
  });
});

function post(port, p, body) {
  return new Promise((resolve) => {
    const b = Buffer.from(body);
    const req = http.request({ host: "127.0.0.1", port, method: "POST", path: p, headers: { "content-type": "application/json", "content-length": b.length } }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode));
    });
    req.on("error", () => resolve(-1));
    req.end(b);
  });
}

(async () => {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const upstreamUrl = "http://127.0.0.1:" + server.address().port;
  const dir = fs.mkdtempSync(path.join(path.dirname(path.resolve(out)), "sink-selftest-")); // beside the result, removed at the end
  const fwd = spawn(process.execPath, [path.join(__dirname, "forwarder.cjs"), "--selftest", "--upstream", upstreamUrl, "--out", dir], { stdio: ["ignore", "pipe", "inherit"] });
  const ports = await new Promise((resolve, reject) => {
    let text = "";
    fwd.stdout.on("data", (c) => { text += c.toString("utf8"); const line = text.split("\n").find((l) => l.startsWith("{")); if (line) resolve(JSON.parse(line).ports); });
    fwd.on("exit", () => reject(new Error("forwarder exited")));
  });
  const failures = [];
  const results = [];
  const submitForms = [];
  for (const p of ["/sendrawtransaction", "/send_raw_transaction", "/SendRawTransaction", "/x/sendrawtransaction"]) submitForms.push([p, JSON.stringify({ tx_as_hex: "00", do_not_relay: false, do_sanity_checks: true })]);
  for (const m of sink.SUBMIT_METHODS) submitForms.push(["/json_rpc", JSON.stringify({ jsonrpc: "2.0", id: "0", method: m, params: {} })]);
  let toSink = 0, toPlain = 0;
  for (const [listener, mounts] of [["daemon", ["", "/rpc", "/slow", "/sink/accept", "/sink/reject-double_spend"]], ["allow", [""]]]) {
    for (const mount of mounts) {
      for (const [p, body] of submitForms) {
        const status = await post(ports[listener], mount + p, body);
        const sinkMount = mount.startsWith("/sink/");
        if (sinkMount) toSink++; else toPlain++;
        results.push({ listener, mount: mount || "/", path: p, status });
        if (sinkMount ? status !== 200 : status !== 403) failures.push(listener + " " + (mount || "/") + p + ": status " + status);
      }
    }
  }
  // positive control: reads are forwarded, also through a sink mount
  const reads = [["", "/json_rpc"], ["/sink/accept", "/json_rpc"], ["/rpc", "/json_rpc"]];
  for (const [mount, p] of reads) {
    const status = await post(ports.daemon, mount + p, JSON.stringify({ jsonrpc: "2.0", id: "0", method: "get_info", params: {} }));
    if (status !== 200) failures.push("read " + (mount || "/") + p + ": status " + status);
  }
  const stats = await new Promise((resolve) => http.get("http://127.0.0.1:" + ports.daemon + "/__stats", (res) => { const c = []; res.on("data", (x) => c.push(x)); res.on("end", () => resolve(JSON.parse(Buffer.concat(c).toString("utf8")))); }));
  fwd.kill("SIGTERM");
  await new Promise((r) => fwd.on("exit", r));
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
  if (upstream.submits !== 0) failures.push("the upstream received " + upstream.submits + " submit or relay requests");
  if (upstream.reads !== reads.length) failures.push("the upstream received " + upstream.reads + " reads, expected " + reads.length);
  if (stats.sink.requests !== toSink) failures.push("the sink answered " + stats.sink.requests + " of " + toSink);
  if (stats.relayRequests !== toPlain) failures.push("the plain mounts refused " + stats.relayRequests + " submit requests of " + toPlain);
  const result = { status: failures.length === 0 ? "OK" : "FAIL", failures, upstream: { requests: upstream.requests, submits: upstream.submits, reads: upstream.reads },
    sink: { requests: stats.sink.requests, byMode: stats.sink.byMode }, refusedByPlainMounts: stats.relayRequests, submitForms: submitForms.length, sent: { toSink, toPlain } };
  fs.writeFileSync(out, JSON.stringify(result, null, 1) + "\n");
  process.stdout.write(JSON.stringify({ status: result.status, upstreamSubmits: upstream.submits, sink: stats.sink.requests, refused: stats.relayRequests }) + "\n");
  process.exit(failures.length === 0 ? 0 : 1);
})().catch((err) => { process.stderr.write("sink self-test failed: " + (err && err.name) + "\n"); process.exit(1); });
