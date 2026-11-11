#!/usr/bin/env node
/**
 * Two-way offline byte cross-open, reference side (test only): runs the zephyr-javascript
 * JS layer and its shipped WASM from a local copy, without a daemon.
 *
 *   --zj <zephyr-javascript copy> --dir <wallet dir> --phase import-export | final
 *
 * import-export: open SDK-written wallets, compare, re-save copies for the SDK, and create
 *                disposable reference wallets (random and seed with restore height).
 * final:         open the SDK's re-saved copies of reference wallets.
 * Prints outcomes only; secrets stay in the 0600 files of --dir.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const args = process.argv.slice(2);
const arg = (n) => { const i = args.indexOf("--" + n); if (i < 0) throw new Error("missing --" + n); return args[i + 1]; };
const ZJ = path.resolve(arg("zj")); const DIR = path.resolve(arg("dir")); const PHASE = arg("phase");
// The reference library predates a global fetch in Node.js and takes a browser code path when one
// exists; remove it (also the monitor's blocking replacement) before the library is loaded.
delete globalThis.fetch;
if (typeof globalThis.fetch !== "undefined") throw new Error("global fetch could not be removed");
const m = require(path.join(ZJ, "index.js"));
const sha = (f) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
const readMeta = () => JSON.parse(fs.readFileSync(path.join(DIR, "meta.json"), "utf8"));
const writeMeta = (meta) => fs.writeFileSync(path.join(DIR, "meta.json"), JSON.stringify(meta, null, 1), { mode: 0o600 });
const writePrivate = (f, d) => fs.writeFileSync(path.join(DIR, f), d, { mode: 0o600 });
const bytes = (v) => Buffer.from(v.buffer ? new Uint8Array(v.buffer, v.byteOffset, v.byteLength) : v);

async function open(entry, password) {
  return m.openWalletFull({ networkType: entry.networkType, password: password === undefined ? entry.password : password, keysData: fs.readFileSync(path.join(DIR, entry.keysFile)), cacheData: fs.readFileSync(path.join(DIR, entry.cacheFile)), proxyToWorker: false });
}
async function compare(w, entry) {
  return { addressMatch: (await w.getPrimaryAddress()) === entry.address, networkMatch: Number(await w.getNetworkType()) === entry.networkType,
           restoreHeightMatch: (await w.getRestoreHeight()) === entry.restoreHeight, seedMatch: (await w.getMnemonic()) === entry.seed };
}
async function save(meta, w, entry) {
  const [keys, cache] = await w.getData();
  const e = Object.assign({}, entry, { keysFile: entry.id + ".keys", cacheFile: entry.id + ".cache" });
  writePrivate(e.keysFile, bytes(keys)); writePrivate(e.cacheFile, bytes(cache)); meta.push(e); return e;
}

(async () => {
  const out = { zjWasmSha256: sha(path.join(ZJ, "dist", "monero_wallet_full.wasm")), zjKeysWasmSha256: sha(path.join(ZJ, "dist", "monero_wallet_keys.wasm")), results: {} };
  const meta = readMeta();
  const sources = PHASE === "final" ? meta.filter((e) => e.origin === "sdk-resaved-zj") : meta.filter((e) => e.origin === "sdk");
  for (const entry of sources) {
    const r = {};
    const w = await open(entry);
    Object.assign(r, await compare(w, entry));
    if (PHASE !== "final") {
      const resaved = await save(meta, w, Object.assign({}, entry, { id: entry.id.replace(/^sdk-/, "zj-resaved-sdk-"), origin: "zj-resaved-sdk" }));
      const w2 = await open(resaved);
      r.zjReopenAfterResave = (await w2.getPrimaryAddress()) === entry.address && (await w2.getRestoreHeight()) === entry.restoreHeight;
      await w2.close();
    }
    await w.close();
    try { const bad = await open(entry, entry.password + "x"); r.wrongPassword = "opened"; await bad.close(); } catch (e) { r.wrongPassword = String(e && e.message || e).slice(0, 40).replace(/[0-9a-f]{16,}/g, "<hex>"); }
    out.results[entry.id] = r;
  }
  if (PHASE !== "final") {
    const pw = () => crypto.randomBytes(16).toString("hex");
    const p1 = pw();
    const w1 = await m.createWalletFull({ networkType: "mainnet", password: p1, proxyToWorker: false });
    const seed1 = await w1.getMnemonic();
    await save(meta, w1, { id: "zj-mainnet-random", origin: "zj", networkType: 0, password: p1, seed: seed1, address: await w1.getPrimaryAddress(), restoreHeight: await w1.getRestoreHeight() });
    await w1.close();
    const p2 = pw();
    const w2 = await m.createWalletFull({ networkType: "mainnet", password: p2, mnemonic: seed1, restoreHeight: 333333, proxyToWorker: false });
    await save(meta, w2, { id: "zj-mainnet-seed", origin: "zj", networkType: 0, password: p2, seed: seed1, address: await w2.getPrimaryAddress(), restoreHeight: await w2.getRestoreHeight() });
    out.results["zj-mainnet-seed-created"] = { restoreHeight333333: (await w2.getRestoreHeight()) === 333333 };
    await w2.close();
    const p3 = pw();
    const w3 = await m.createWalletFull({ networkType: "testnet", password: p3, proxyToWorker: false });
    await save(meta, w3, { id: "zj-testnet-random", origin: "zj", networkType: 1, password: p3, seed: await w3.getMnemonic(), address: await w3.getPrimaryAddress(), restoreHeight: await w3.getRestoreHeight() });
    await w3.close();
    writeMeta(meta);
  }
  process.stdout.write("RESULT " + JSON.stringify({ phase: PHASE, out }) + "\n", () => process.exit(0));
})().catch((e) => { process.stderr.write("FAILED " + String(e && e.message || e).slice(0, 80).replace(/[0-9a-f]{16,}/g, "<hex>") + "\n", () => process.exit(1)); });
