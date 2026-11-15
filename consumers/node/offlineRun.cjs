"use strict";
// The offline platform checks of the packed package in Node.js (shared by offline.cjs and offline.mjs).
// The checks themselves are the browser consumer's (../vite/src/offlineChecks.js), run here against
// the module object the caller loaded, in the main thread (direct) or with a worker per wallet.
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { pathToFileURL } = require("url");

async function run(z, loader, argv) {
  const arg = (n) => { const i = argv.indexOf("--" + n); return i >= 0 ? argv[i + 1] : undefined; };
  const mode = arg("mode"); const out = arg("out");
  if ((mode !== "direct" && mode !== "worker") || !out) throw new Error("usage: offline.(cjs|mjs) --mode direct|worker --out <report.json>");
  const checksFile = arg("checks") || path.join(__dirname, "..", "vite", "src", "offlineChecks.js");
  const { runOfflineChecks } = await import(pathToFileURL(checksFile).href);
  const wasm = require.resolve("@loki-notfound/zephyr-ts/zephyr.wasm", { paths: [__dirname] });
  const pkg = JSON.parse(fs.readFileSync(path.join(path.dirname(wasm), "..", "package.json"), "utf8"));
  const started = new Date().toISOString();
  const report = await runOfflineChecks(z, { proxyToWorker: mode === "worker", log: (line) => process.stdout.write(line + "\n") });
  const result = {
    phase: "offline", loader, mode, started, finished: new Date().toISOString(),
    env: { node: process.version, v8: process.versions.v8, platform: process.platform, arch: process.arch, osType: os.type(), osRelease: os.release(),
      osVersion: typeof os.version === "function" ? os.version() : undefined, electron: process.versions.electron, cpus: os.cpus().length },
    package: { name: pkg.name, version: pkg.version, wasmSha256: crypto.createHash("sha256").update(fs.readFileSync(wasm)).digest("hex") },
    checks: report.checks
  };
  fs.writeFileSync(out, JSON.stringify(result, null, 1) + "\n");
  process.stdout.write("checks: " + report.checks.map((c) => c.id + "=" + c.status).join(" ") + "\n");
  await z.terminateWorker();
  return report.checks.length > 0 && report.checks.every((c) => c.status === "pass");
}

module.exports = { run };
