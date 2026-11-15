#!/usr/bin/env node
"use strict";
/**
 * Helpers of the platform test scripts (bin/platform_prepare.sh, bin/test_platform_*.sh), in Node.js
 * so that they behave the same on Linux, macOS and Windows. No dependency.
 *
 *   platformTool.cjs verify <tarball> <sha256 file>   the tarball's SHA-256 equals the first field of the file
 *   platformTool.cjs wasm-sha256 <tarball>            SHA-256 of package/dist/zephyr.wasm inside the tarball
 *   platformTool.cjs installed <tarball> <dir>        the installed package directory equals the tarball, file by file
 *   platformTool.cjs env                              system, architecture and runtime versions (printed)
 *   platformTool.cjs judge <tarball> <report.json>... every report: the exact offline check ids, all passed,
 *                                                     the package's module, and (Node.js) no blocked network access
 *   platformTool.cjs electron-archive <electron package dir> <cache dir>
 *                                                     the SHA-256 of the Electron archive the package's installer
 *                                                     downloaded for this platform, compared with the package's
 *                                                     checksums.json (the installer verifies it too)
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const crypto = require("crypto");
const { spawnSync } = require("child_process");

const IDS = ["K01", "K02", "K03", "K04", "K05", "K06", "K07", "K08", "K09", "K10", "K11"];
const sha256 = (b) => crypto.createHash("sha256").update(b).digest("hex");

function tarEntries(tgz) {
  const tar = zlib.gunzipSync(fs.readFileSync(tgz));
  const files = new Map();
  for (let off = 0; off + 512 <= tar.length;) {
    const h = tar.subarray(off, off + 512);
    const name = h.toString("utf8", 0, 100).replace(/\0.*$/s, "");
    if (!name) break;
    const prefix = h.toString("utf8", 345, 500).replace(/\0.*$/s, "");
    const size = parseInt(h.toString("utf8", 124, 136).replace(/\0.*$/s, "").trim() || "0", 8);
    if (h[156] === 48 || h[156] === 0) files.set((prefix ? prefix + "/" : "") + name, tar.subarray(off + 512, off + 512 + size));
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

function wasmSha(tgz) {
  const f = tarEntries(tgz).get("package/dist/zephyr.wasm");
  if (!f) throw new Error("the tarball has no package/dist/zephyr.wasm");
  return sha256(f);
}

function fail(msg) { process.stdout.write(msg + "\n"); process.exit(1); }

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === "verify") {
  const [tgz, file] = rest;
  const want = fs.readFileSync(file, "utf8").trim().split(/\s+/)[0];
  const got = sha256(fs.readFileSync(tgz));
  if (!/^[0-9a-f]{64}$/.test(want)) fail("no SHA-256 in " + path.basename(file));
  process.stdout.write("tarball: " + got + "  " + path.basename(tgz) + "\n");
  if (got !== want) fail("the tarball's SHA-256 differs from the recorded " + want);
  process.stdout.write("tarball SHA-256 verified\n");
} else if (cmd === "wasm-sha256") {
  process.stdout.write(wasmSha(rest[0]) + "\n");
} else if (cmd === "installed") {
  const [tgz, dir] = rest;
  let n = 0;
  for (const [name, data] of tarEntries(tgz)) {
    const file = path.join(dir, name.replace(/^package\//, ""));
    if (!fs.existsSync(file) || Buffer.compare(fs.readFileSync(file), data) !== 0) fail("differs: " + name);
    n++;
  }
  process.stdout.write("installed package equals the tarball (" + n + " files)\n");
} else if (cmd === "env") {
  const lines = ["system:   " + os.type() + " " + os.release() + (typeof os.version === "function" ? " (" + os.version() + ")" : "") + ", " + process.platform + "-" + process.arch + ", " + os.cpus().length + " cpus, " + Math.round(os.totalmem() / 1048576) + " MiB"];
  if (process.platform === "linux" && fs.existsSync("/etc/os-release")) {
    const m = /^PRETTY_NAME="?([^"\n]*)"?$/m.exec(fs.readFileSync("/etc/os-release", "utf8"));
    if (m) lines.push("distribution: " + m[1]);
  }
  if (process.platform === "darwin") {
    const v = spawnSync("sw_vers", [], { encoding: "utf8" });
    if (v.stdout) lines.push("macOS:    " + v.stdout.trim().split("\n").map((l) => l.replace(/\s+/g, " ")).join(", "));
    const a = spawnSync("uname", ["-m"], { encoding: "utf8" });
    if (a.stdout) lines.push("machine:  " + a.stdout.trim() + (process.arch === "x64" && a.stdout.trim() === "arm64" ? " (Node.js runs translated)" : ""));
  }
  const npm = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["--version"], { encoding: "utf8", shell: process.platform === "win32" });
  lines.push("node:     " + process.version + " (v8 " + process.versions.v8 + "), npm " + String(npm.stdout || "?").trim());
  process.stdout.write(lines.join("\n") + "\n");
} else if (cmd === "judge") {
  const [tgz, ...reports] = rest;
  const wantWasm = wasmSha(tgz);
  let bad = 0;
  for (const file of reports) {
    const problems = [];
    let r;
    try { r = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { r = undefined; }
    if (!r) problems.push("no readable report");
    else {
      const checks = Array.isArray(r.checks) ? r.checks : [];
      if (checks.map((c) => c.id).join() !== IDS.join()) problems.push("check ids " + checks.map((c) => c.id).join());
      for (const c of checks) if (c.status !== "pass") problems.push(c.id + " " + c.status + ": " + (c.notes || []).slice(-1).join(""));
      if (r.package && r.package.wasmSha256 !== wantWasm) problems.push("the installed module is not the tarball's");
      const guardFile = file.replace(/\.json$/, ".guard.json");
      if (fs.existsSync(guardFile)) {
        const g = JSON.parse(fs.readFileSync(guardFile, "utf8"));
        const total = g.counts.connect + g.counts.dns + g.counts.fetch;
        if (g.guard !== "loaded" || total !== 0) problems.push("network access attempted: " + JSON.stringify(g.counts));
      } else if (!r.renderer) problems.push("no record of the offline guard");
    }
    const label = path.basename(path.dirname(file)) + "/" + path.basename(file);
    process.stdout.write(label + ": " + (problems.length ? "FAIL " + problems.join("; ") : "pass" + (r.env ? " (" + [r.env.node && "Node.js " + r.env.node, r.env.electron && "Electron " + r.env.electron, r.env.platform && r.env.platform + "-" + r.env.arch].filter(Boolean).join(", ") + ")" : "")) + "\n");
    if (problems.length) bad++;
  }
  process.exit(bad === 0 && reports.length > 0 ? 0 : 1);
} else if (cmd === "electron-archive") {
  const [pkgDir, cache] = rest;
  const version = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8")).version;
  const platform = process.platform; let arch = process.arch;
  if (platform === "darwin" && arch === "x64" && String(spawnSync("sysctl", ["-in", "sysctl.proc_translated"], { encoding: "utf8" }).stdout).trim() === "1") arch = "arm64";
  const name = "electron-v" + version + "-" + platform + "-" + arch + ".zip";
  const want = JSON.parse(fs.readFileSync(path.join(pkgDir, "checksums.json"), "utf8"))[name];
  const found = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name === name) found.push(p); } };
  walk(cache);
  if (!want) fail("checksums.json names no " + name);
  if (found.length !== 1) fail("expected one " + name + " in the cache, found " + found.length);
  const got = sha256(fs.readFileSync(found[0]));
  process.stdout.write("electron archive: " + got + "  " + name + (got === want ? " (equals checksums.json)" : " DIFFERS from checksums.json " + want) + "\n");
  if (got !== want) process.exit(1);
} else {
  process.stderr.write("usage: platformTool.cjs verify|wasm-sha256|installed|env|judge|electron-archive ...\n");
  process.exit(2);
}
