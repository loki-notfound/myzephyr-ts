/**
 * Two-way offline byte cross-open, SDK side (test only).
 *
 *   --phase export   create disposable SDK wallets and write keys/cache copies + metadata
 *   --phase import   open every wallet written by the reference implementation, compare
 *                    address/network/restore height/seed, re-save and reopen, and write
 *                    re-saved copies for the reference implementation's final reopen
 *
 * Wallet files and the metadata (which holds the disposable passwords and seeds) stay in
 * --dir with mode 0600; the printed result contains outcomes only.
 */
import fs from "fs";
import path from "path";
import crypto from "crypto";
import * as F from "../../main/ts/index";
import * as Internal from "../../main/ts/wallet/ZephyrWallet"; // not exported by the package entry

interface WalletMeta {
  id: string;
  origin: "sdk" | "zj" | "sdk-resaved-zj" | "zj-resaved-sdk";
  networkType: 0 | 1 | 2;
  password: string;
  seed: string;
  address: string;
  restoreHeight: number;
  keysFile: string;
  cacheFile: string;
}

function arg(name: string): string {
  const i = process.argv.indexOf("--" + name);
  if (i < 0 || process.argv[i + 1] === undefined) throw new Error("missing --" + name);
  return process.argv[i + 1];
}

function writePrivate(file: string, data: Uint8Array | string): void {
  fs.writeFileSync(file, data, { mode: 0o600 });
}

function readMeta(dir: string): WalletMeta[] {
  const file = path.join(dir, "meta.json");
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) as WalletMeta[] : [];
}

async function saveWallet(dir: string, meta: WalletMeta[], w: F.ZephyrWallet, entry: Omit<WalletMeta, "keysFile" | "cacheFile">): Promise<void> {
  const data = await w.getData();
  const keysFile = entry.id + ".keys";
  const cacheFile = entry.id + ".cache";
  writePrivate(path.join(dir, keysFile), data.keys);
  writePrivate(path.join(dir, cacheFile), data.cache);
  meta.push(Object.assign({}, entry, { keysFile, cacheFile }));
}

async function exportPhase(dir: string): Promise<Record<string, unknown>> {
  const meta = readMeta(dir);
  const pw = (): string => crypto.randomBytes(16).toString("hex");
  const a = await F.createRandomWallet({ networkType: 0, password: pw(), proxyToWorker: false });
  const aSeed = await a.getSeed();
  const pa = pw();
  const a2 = await F.restoreWalletFromSeed({ networkType: 0, password: pa, seed: aSeed, restoreHeight: 222222, proxyToWorker: false });
  await saveWallet(dir, meta, a2, { id: "sdk-mainnet-seed", origin: "sdk", networkType: 0, password: pa, seed: aSeed, address: await a2.getPrimaryAddress(), restoreHeight: await a2.getRestoreHeight() });
  await a2.close();
  const pr = pw();
  const r = await F.createRandomWallet({ networkType: 0, password: pr, proxyToWorker: false });
  await saveWallet(dir, meta, r, { id: "sdk-mainnet-random", origin: "sdk", networkType: 0, password: pr, seed: await r.getSeed(), address: await r.getPrimaryAddress(), restoreHeight: await r.getRestoreHeight() });
  await r.close(); await a.close();
  const pt = pw();
  const t = await F.createRandomWallet({ networkType: 1, password: pt, proxyToWorker: false });
  await saveWallet(dir, meta, t, { id: "sdk-testnet-random", origin: "sdk", networkType: 1, password: pt, seed: await t.getSeed(), address: await t.getPrimaryAddress(), restoreHeight: await t.getRestoreHeight() });
  await t.close();
  fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify(meta, null, 1), { mode: 0o600 });
  return { exported: meta.filter((m) => m.origin === "sdk").map((m) => m.id) };
}

async function importPhase(dir: string): Promise<Record<string, unknown>> {
  const meta = readMeta(dir);
  const results: Record<string, unknown> = {};
  for (const m of meta.filter((x) => x.origin === "zj" || x.origin === "zj-resaved-sdk")) {
    const r: Record<string, unknown> = {};
    const keys = new Uint8Array(fs.readFileSync(path.join(dir, m.keysFile)));
    const cache = new Uint8Array(fs.readFileSync(path.join(dir, m.cacheFile)));
    for (const proxy of [false, true]) {
      const w = await F.openWalletData({ networkType: m.networkType, password: m.password, keysData: keys, cacheData: cache, proxyToWorker: proxy });
      const label = proxy ? "worker" : "direct";
      r[label + "AddressMatch"] = (await w.getPrimaryAddress()) === m.address;
      r[label + "NetworkMatch"] = (await w.getNetworkType()) === m.networkType;
      r[label + "RestoreHeightMatch"] = (await w.getRestoreHeight()) === m.restoreHeight;
      r[label + "SeedMatch"] = (await w.getSeed()) === m.seed;
      if (!proxy && m.origin === "zj") {
        const id = m.id.replace(/^zj-/, "sdk-resaved-zj-");
        await saveWallet(dir, meta, w, { id, origin: "sdk-resaved-zj", networkType: m.networkType, password: m.password, seed: m.seed, address: m.address, restoreHeight: m.restoreHeight });
        const again = meta[meta.length - 1];
        const w2 = await F.openWalletData({ networkType: m.networkType, password: m.password, keysData: new Uint8Array(fs.readFileSync(path.join(dir, again.keysFile))), cacheData: new Uint8Array(fs.readFileSync(path.join(dir, again.cacheFile))), proxyToWorker: false });
        r.sdkReopenAfterResave = (await w2.getPrimaryAddress()) === m.address && (await w2.getRestoreHeight()) === m.restoreHeight;
        await w2.close();
      }
      await w.close();
    }
    try {
      await F.openWalletData({ networkType: m.networkType, password: m.password + "x", keysData: keys, cacheData: cache, proxyToWorker: false });
      r.wrongPassword = "opened";
    } catch (err) {
      r.wrongPassword = err instanceof F.ZephyrWalletError ? err.code : "untyped";
    }
    results[m.id] = r;
  }
  fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify(meta, null, 1), { mode: 0o600 });
  return results;
}

async function main(): Promise<void> {
  const dir = arg("dir");
  const phase = arg("phase");
  const out = phase === "export" ? await exportPhase(dir) : phase === "import" ? await importPhase(dir) : { error: "unknown phase" };
  const guard = await Internal.getNetworkGuardReport();
  await F.terminateWorker();
  process.stdout.write("RESULT " + JSON.stringify({ phase, out, networkGuard: guard }) + "\n", () => process.exit(0));
}

main().catch((err) => { process.stderr.write("FAILED " + (err instanceof F.ZephyrWalletError ? err.code : err instanceof Error ? err.name : "unknown") + "\n", () => process.exit(1)); });
