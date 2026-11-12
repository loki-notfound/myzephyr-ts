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

/** Accounts and subaddresses of a wallet: per account, its subaddresses' addresses and labels in index order. */
type AccountsRecord = Array<Array<{ address: string; label: string }>>;

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
  /** set for the wallet that carries accounts, subaddresses and labels across both libraries */
  accounts?: AccountsRecord;
}

/** Disposable labels: ASCII, an empty label, and text whose UTF-8 form takes two, three and four bytes per character. */
function testLabel(kind: string): string {
  return kind + "-" + crypto.randomBytes(4).toString("hex") + " \u00e9\u20ac\ud83d\ude00";
}

/** The wallet's accounts and subaddresses as the SDK reports them (getAccounts with subaddresses). */
async function accountsRecord(w: F.ZephyrWallet): Promise<AccountsRecord> {
  const accounts = await w.getAccounts({ includeSubaddresses: true });
  return accounts.map((a) => (a.subaddresses ?? []).map((s) => ({ address: s.address, label: s.label })));
}

/** Compare the SDK's view of a wallet with a record: structure, labels, every address equal to getAddress, the account label of subaddress 0. */
async function compareAccounts(w: F.ZephyrWallet, want: AccountsRecord): Promise<Record<string, boolean>> {
  const accounts = await w.getAccounts({ includeSubaddresses: true });
  let addressesMatch = accounts.length === want.length, labelsMatch = accounts.length === want.length, getAddressMatch = true, accountFieldsMatch = true;
  for (let a = 0; a < accounts.length && a < want.length; a++) {
    const subs = accounts[a].subaddresses ?? [];
    if (subs.length !== want[a].length || accounts[a].subaddressCount !== want[a].length) { addressesMatch = false; labelsMatch = false; continue; }
    if (accounts[a].primaryAddress !== subs[0].address || accounts[a].label !== subs[0].label || accounts[a].index !== a) accountFieldsMatch = false;
    for (let i = 0; i < subs.length; i++) {
      if (subs[i].address !== want[a][i].address) addressesMatch = false;
      if (subs[i].label !== want[a][i].label) labelsMatch = false;
      if ((await w.getAddress(a, i)) !== subs[i].address) getAddressMatch = false;
      const idx = await w.getAddressIndex(subs[i].address);
      if (idx.accountIndex !== a || idx.subaddressIndex !== i) getAddressMatch = false;
    }
  }
  return { accountsAddressesMatch: addressesMatch, accountsLabelsMatch: labelsMatch, accountsGetAddressMatch: getAddressMatch, accountsFieldsMatch: accountFieldsMatch };
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
  // accounts, subaddresses and labels: created, changed and cleared here, read and extended by the reference library
  const pc = pw();
  const c = await F.createRandomWallet({ networkType: 0, password: pc, proxyToWorker: false });
  await c.createAccount(testLabel("account"));
  await c.createSubaddress(0, testLabel("sub"));
  await c.createSubaddress(1, testLabel("sub"));
  await c.createSubaddress(1, "");
  await c.createSubaddress(1, testLabel("cleared"));
  await c.setSubaddressLabel(0, 1, testLabel("changed"));
  await c.setSubaddressLabel(1, 3, "");
  await saveWallet(dir, meta, c, { id: "sdk-mainnet-accounts", origin: "sdk", networkType: 0, password: pc, seed: await c.getSeed(), address: await c.getPrimaryAddress(), restoreHeight: await c.getRestoreHeight(), accounts: await accountsRecord(c) });
  await c.close();
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
      if (m.accounts !== undefined) for (const [k, v] of Object.entries(await compareAccounts(w, m.accounts))) r[label + k.charAt(0).toUpperCase() + k.substring(1)] = v;
      if (!proxy && m.accounts !== undefined && m.origin === "zj-resaved-sdk") {
        // extend the reference library's changes once more and hand the bytes back for its final reopen
        await w.createSubaddress(2, testLabel("sdk"));
        await w.setSubaddressLabel(2, 0, testLabel("account"));
        const id = "sdk-resaved-zj-accounts";
        await saveWallet(dir, meta, w, { id, origin: "sdk-resaved-zj", networkType: m.networkType, password: m.password, seed: m.seed, address: m.address, restoreHeight: m.restoreHeight, accounts: await accountsRecord(w) });
        const again = meta[meta.length - 1];
        const w2 = await F.openWalletData({ networkType: m.networkType, password: m.password, keysData: new Uint8Array(fs.readFileSync(path.join(dir, again.keysFile))), cacheData: new Uint8Array(fs.readFileSync(path.join(dir, again.cacheFile))), proxyToWorker: false });
        r.sdkAccountsAfterResave = Object.values(await compareAccounts(w2, again.accounts as AccountsRecord)).every((x) => x === true);
        await w2.close();
      }
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
