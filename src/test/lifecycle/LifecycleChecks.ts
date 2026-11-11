/**
 * Offline lifecycle checks of the supported wallet surface, release
 * module suite. The instrumented suite (InstrumentedChecks.ts) runs against the test module.
 *
 * Runs unchanged in direct Node, Node with proxyToWorker and a browser worker. Uses only
 * disposable wallets generated during the run. Results contain outcomes and sanitized error
 * codes only: never recovery material, passwords, keys or wallet bytes.
 */
import * as F from "../../main/ts/index";
import * as Internal from "../../main/ts/wallet/ZephyrWallet"; // not exported by the package entry
import LibraryUtils from "../../main/ts/common/LibraryUtils";
import ZephyrWalletError, { bridgeErrorOf, bridgePasswordErrorOf } from "../../main/ts/common/ZephyrWalletError";
import { RawWorker, channelOf, combinedGuard, installGuardLedger, newMessageId, postRawWorkerMessage, sanitize, skipGuardRead, walletIdOf } from "./testSupport";
import ZephyrWalletFull from "../../main/ts/wallet/ZephyrWalletFull";
import ZephyrWalletConfig from "../../main/ts/wallet/model/ZephyrWalletConfig";

export type CheckStatus = "pass" | "fail" | "not-run";

export interface CheckResult {
  readonly id: string;
  readonly title: string;
  status: CheckStatus;
  readonly notes: string[];
}

export interface LifecycleReport {
  readonly suite: "release" | "instrumented";
  readonly env: string;
  readonly proxyToWorker: boolean;
  readonly startedUtc: string;
  finishedUtc: string;
  readonly checks: CheckResult[];
  networkGuard: Internal.ZephyrNetworkGuardReport | undefined;
  workerProof: unknown;
  nativeCloseCalls: number | undefined;
  /** Guard report of a live wallet's own worker (proof of a real, separate wallet worker) */
  walletWorkerProof?: unknown;
  /** SDK worker accounting at the end of the run (counts only) */
  workerAccounting?: unknown;
  /** Independent worker counts (Node worker_threads monitor or the page's Worker wrapper) */
  workerMonitor?: unknown;
}

export interface LifecycleCheckOptions {
  readonly env: string;
  readonly proxyToWorker: boolean;
  readonly log?: (line: string) => void;
  /** Called with sanitized progress lines only. */
  readonly deadlineMs?: number;
}

export class CheckFailure extends Error {}

export function expect(condition: boolean, what: string): void {
  if (!condition) throw new CheckFailure(what);
}

export function codeOf(err: unknown): string {
  if (err !== null && typeof err === "object" && "code" in err) return String((err as { code: unknown }).code);
  return "NO_CODE:" + (err instanceof Error ? err.name : typeof err);
}

export function diagnosticOf(err: unknown): string {
  return err instanceof F.ZephyrWalletError && err.diagnostic !== undefined ? "/" + err.diagnostic : "";
}

export async function expectCode(promise: Promise<unknown>, code: string, what: string, notes: string[], diagnostic?: string): Promise<F.ZephyrWalletError> {
  try {
    await promise;
  } catch (err) {
    const actual = codeOf(err);
    const isTyped = err instanceof F.ZephyrWalletError;
    notes.push(what + " -> " + actual + diagnosticOf(err) + (isTyped ? "" : " (untyped)"));
    expect(actual === code && isTyped, what + ": expected " + code + ", got " + actual);
    if (diagnostic !== undefined) expect((err as F.ZephyrWalletError).diagnostic === diagnostic, what + ": expected diagnostic " + diagnostic + ", got " + diagnosticOf(err));
    return err as F.ZephyrWalletError;
  }
  notes.push(what + " -> resolved");
  throw new CheckFailure(what + ": expected " + code + " but the call succeeded");
}

export function withDeadline<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new CheckFailure("deadline exceeded: " + what)), ms);
    promise.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
  });
}

export function randomPassword(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function copyBytes(b: Uint8Array): Uint8Array {
  return new Uint8Array(b);
}

export function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Which of the given passwords open saved bytes (exactly one is expected). */
export async function openingPasswords(data: F.ZephyrWalletData, passwords: readonly string[], proxy: boolean): Promise<number[]> {
  const opened: number[] = [];
  for (let i = 0; i < passwords.length; i++) {
    try {
      const w = await F.openWalletData({ networkType: 0, password: passwords[i], keysData: copyBytes(data.keys), cacheData: copyBytes(data.cache), proxyToWorker: proxy });
      await w.close();
      opened.push(i);
    } catch (err) {
      if (codeOf(err) !== "WRONG_PASSWORD") throw err;
    }
  }
  return opened;
}

/** Text of every field of an error or value, lower-cased, for synthetic-marker scans. */
export function scanText(value: unknown): string {
  const parts: string[] = [];
  if (value instanceof Error) parts.push(value.message, String(value.stack ?? ""), value.name, String(value));
  if (typeof value === "string") parts.push(value);
  if (value !== null && typeof value === "object") {
    try { parts.push(JSON.stringify(value)); } catch (e) { parts.push("unserializable"); }
    for (const k of Object.getOwnPropertyNames(value)) { try { parts.push(String((value as Record<string, unknown>)[k])); } catch (e) { parts.push("unreadable"); } }
  }
  return parts.join("\n").toLowerCase();
}

/** Native close counter for direct mode (spy on the bridge export, test-only). */
function installNativeCloseSpy(): { count: () => number } | undefined {
  const module = LibraryUtils.getWasmModule();
  if (!module || typeof module.close !== "function") return undefined;
  if (!module.__lifecycleCloseSpy) {
    const original = module.close;
    module.__lifecycleCloseCount = 0;
    module.close = function(...args: unknown[]) { module.__lifecycleCloseCount++; return original.apply(module, args); };
    module.__lifecycleCloseSpy = true;
  }
  return { count: () => module.__lifecycleCloseCount as number };
}

/** Count calls to native bridge exports while fn runs (direct mode only, test-only). */
/**
 * A 25-word seed whose checksum word is replaced by another of its words with a different
 * three-letter prefix, so the core's checksum test must reject it (deterministic).
 */
export function brokenChecksumSeed(seed: string, variant: number): string {
  const words = seed.split(" ");
  if (words.length !== 25) throw new CheckFailure("expected a 25-word seed");
  const prefix = (w: string) => w.substring(0, 3);
  for (let k = 0; k < 24; k++) {
    const candidate = words[(variant + k) % 24];
    if (prefix(candidate) !== prefix(words[24])) return words.slice(0, 24).concat([candidate]).join(" ");
  }
  throw new CheckFailure("no replacement checksum word");
}

/** Poll a condition (bounded); true if it became true. */
export async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > end) return false;
    await new Promise((r) => setTimeout(r, 2));
  }
  return true;
}

export async function countNativeCalls(fn: () => Promise<void>): Promise<number | undefined> {
  const module = LibraryUtils.getWasmModule();
  if (!module) return undefined;
  const names = Object.keys(module).filter((k) => typeof module[k] === "function" && /^[a-z][a-z_]+$/.test(k));
  let calls = 0;
  const originals: Record<string, unknown> = {};
  for (const name of names) {
    originals[name] = module[name];
    const original = module[name];
    module[name] = function(...args: unknown[]) { calls++; return original.apply(module, args); };
  }
  try { await fn(); } finally { for (const name of names) module[name] = originals[name]; }
  return calls;
}

/** Independent worker counts: the Node worker_threads monitor or the page's Worker wrapper; undefined in direct runs without either. */
export interface WorkerMonitorCounts { readonly created: number; readonly ended: number; readonly live: number; readonly source: string }
export function workerMonitor(): WorkerMonitorCounts | undefined {
  const g = globalThis as unknown as { __lifecycleWorkerThreads?: () => { created: number; exited: number }; __lifecyclePageWorkers?: () => { created: number; terminated: number } };
  if (typeof g.__lifecycleWorkerThreads === "function") { const t = g.__lifecycleWorkerThreads(); return { created: t.created, ended: t.exited, live: t.created - t.exited, source: "node worker_threads exit events" }; }
  if (typeof g.__lifecyclePageWorkers === "function") { const t = g.__lifecyclePageWorkers(); return { created: t.created, ended: t.terminated, live: t.created - t.terminated, source: "page Worker constructor and terminate() calls" }; }
  return undefined;
}

/** Wait (bounded) until the independent live worker count reaches a value; returns the final counts. */
export async function waitWorkerMonitor(live: number, timeoutMs: number): Promise<WorkerMonitorCounts | undefined> {
  const end = Date.now() + timeoutMs;
  let m = workerMonitor();
  while (m !== undefined && m.live !== live && Date.now() < end) { await new Promise((r) => setTimeout(r, 10)); m = workerMonitor(); }
  return m;
}

export async function runLifecycleChecks(opts: LifecycleCheckOptions): Promise<LifecycleReport> {
  const log = opts.log ?? (() => undefined);
  const proxy = opts.proxyToWorker;
  const report: LifecycleReport = { suite: "release", env: opts.env, proxyToWorker: proxy, startedUtc: new Date().toISOString(), finishedUtc: "", checks: [], networkGuard: undefined, workerProof: undefined, nativeCloseCalls: undefined };
  const deadline = opts.deadlineMs ?? 180000;
  installGuardLedger(); // Guard counts of each proxied wallet's worker are read by the test layer before its close

  async function check(id: string, title: string, fn: (notes: string[]) => Promise<void>, enabled = true): Promise<void> {
    const result: CheckResult = { id, title, status: "not-run", notes: [] };
    report.checks.push(result);
    if (!enabled) { result.notes.push("not applicable in this environment"); return; }
    try {
      await withDeadline(fn(result.notes), deadline, id);
      result.status = "pass";
    } catch (err) {
      result.status = "fail";
      result.notes.push("FAILED: " + (err instanceof CheckFailure ? err.message : codeOf(err) + diagnosticOf(err) + (err instanceof F.ZephyrWalletError ? "" : " " + sanitize(err instanceof Error ? err.name : typeof err))));
    }
    log(id + " " + result.status);
  }

  // shared disposable state (memory only)
  const pw = randomPassword();
  let base: F.ZephyrWallet | undefined;
  let address = "";
  let seed = "";
  let pubView = "";
  let pubSpend = "";
  let privView = "";
  let privSpend = "";

  await check("C01", "Random create yields a valid Zephyr address (mainnet, testnet, stagenet)", async (notes) => {
    base = await F.createRandomWallet({ networkType: "mainnet", password: pw, proxyToWorker: proxy });
    address = await base.getPrimaryAddress();
    expect(address.length === 101 && address.startsWith("ZEPH"), "mainnet standard address shape");
    await F.validateAddress(address, "mainnet", proxy);
    expect((await base.getNetworkType()) === 0, "network type mainnet");
    notes.push("mainnet address length " + address.length + ", prefix " + address.substring(0, 4));
    const estimate = await base.getRestoreHeight();
    expect(Number.isSafeInteger(estimate) && estimate > 0, "random wallet has the core's date-based restore-height estimate");
    notes.push("random-wallet restore height " + estimate + " (core date-based estimate without a daemon; not a daemon observation)");
    for (const [name, net] of [["testnet", 1], ["stagenet", 2]] as const) {
      const w = await F.createRandomWallet({ networkType: name, password: pw, proxyToWorker: proxy });
      const a = await w.getPrimaryAddress();
      await F.validateAddress(a, name, proxy);
      expect((await w.getNetworkType()) === net, name + " network type");
      await expectCode(F.validateAddress(a, "mainnet", proxy), "INVALID_ADDRESS", name + " address on mainnet", notes);
      notes.push(name + " address prefix " + a.substring(0, 4));
      await w.close();
    }
  });

  await check("C02", "Generated recovery material is captured privately (memory only)", async (notes) => {
    expect(base !== undefined, "base wallet");
    const w = base as F.ZephyrWallet;
    seed = await w.getSeed();
    expect(seed.split(" ").length === 25, "25-word seed");
    expect((await w.getSeedLanguage()) === "English", "seed language");
    pubView = await w.getPublicViewKey(); pubSpend = await w.getPublicSpendKey();
    privView = await w.getPrivateViewKey(); privSpend = await w.getPrivateSpendKey();
    for (const k of [pubView, pubSpend, privView, privSpend]) expect(/^[0-9a-f]{64}$/.test(k), "64-hex key");
    expect(!(await w.isViewOnly()), "not view-only");
    notes.push("seed 25 words, four 64-hex keys held in memory only");
  });

  await check("C03", "Fresh keys-only and full wallets restored from the seed match", async (notes) => {
    const k = await F.createKeysWallet({ networkType: 0, seed, proxyToWorker: proxy });
    expect((await k.getPrimaryAddress()) === address, "keys-only address");
    expect((await k.getPublicViewKey()) === pubView && (await k.getPublicSpendKey()) === pubSpend, "keys-only public keys");
    expect((await k.getSeed()) === seed, "keys-only seed round trip");
    expect((await k.getAddress(0, 1)) === (await (base as F.ZephyrWallet).getAddress(0, 1)), "subaddress (0,1)");
    await k.close();
    const f = await F.restoreWalletFromSeed({ networkType: 0, password: pw, seed, proxyToWorker: proxy });
    expect((await f.getPrimaryAddress()) === address, "full address");
    expect((await f.getPublicViewKey()) === pubView && (await f.getPublicSpendKey()) === pubSpend, "full public keys");
    expect((await f.getSeed()) === seed, "full seed round trip");
    expect((await f.getRestoreHeight()) === 0, "seed restore without restoreHeight starts at 0");
    await f.close();
    const spaced = await F.restoreWalletFromSeed({ networkType: 0, password: pw, seed: "  " + seed.split(" ").join("   ") + " ", proxyToWorker: proxy });
    expect((await spaced.getPrimaryAddress()) === address, "whitespace-normalized seed");
    await spaced.close();
    const o1 = await F.restoreWalletFromSeed({ networkType: 0, password: pw, seed, seedOffset: "offset-a", proxyToWorker: proxy });
    const o2 = await F.createKeysWallet({ networkType: 0, seed, seedOffset: "offset-a", proxyToWorker: proxy });
    const oa = await o1.getPrimaryAddress();
    expect(oa !== address && oa === (await o2.getPrimaryAddress()), "seed offset derives a different, deterministic wallet");
    await o1.close(); await o2.close();
    notes.push("keys-only, full, whitespace-normalized and offset restores consistent");
  });

  await check("C04", "Restore from freshly derived keys (full, keys-only, view-only) agrees", async (notes) => {
    const f = await F.restoreWalletFromKeys({ networkType: 0, password: pw, primaryAddress: address, privateViewKey: privView, privateSpendKey: privSpend, restoreHeight: 1000, proxyToWorker: proxy });
    expect((await f.getPrimaryAddress()) === address, "full from keys address");
    expect((await f.getPublicSpendKey()) === pubSpend, "full from keys public spend");
    expect((await f.getRestoreHeight()) === 1000, "full from keys restore height");
    await f.close();
    const s = await F.restoreWalletFromKeys({ networkType: 0, password: pw, privateSpendKey: privSpend, proxyToWorker: proxy });
    expect((await s.getPrimaryAddress()) === address, "spend-key-only restore address");
    expect((await s.getSeed()) === seed, "spend-key-only restore regenerates the seed");
    await s.close();
    const v = await F.restoreWalletFromKeys({ networkType: 0, password: pw, primaryAddress: address, privateViewKey: privView, proxyToWorker: proxy });
    expect((await v.getPrimaryAddress()) === address && (await v.isViewOnly()), "view-only restore");
    await v.close();
    const k = await F.createKeysWallet({ networkType: 0, primaryAddress: address, privateViewKey: privView, privateSpendKey: privSpend, proxyToWorker: proxy });
    expect((await k.getPrimaryAddress()) === address, "keys-only from keys");
    await k.close();
    notes.push("full (address+view+spend, restoreHeight 1000), spend-only, view-only and keys-only restores agree");
  });

  let savedKeys = new Uint8Array(0);
  let savedCache = new Uint8Array(0);
  await check("C05", "getData save/reopen from byte copies preserves address, network and restore height", async (notes) => {
    const r = await F.restoreWalletFromSeed({ networkType: 0, password: pw, seed, restoreHeight: 123456, proxyToWorker: proxy });
    expect((await r.getRestoreHeight()) === 123456, "restore height before save");
    const data = await r.getData();
    expect(data.keys instanceof Uint8Array && data.cache instanceof Uint8Array, "Uint8Array bytes");
    expect(data.keys.length > 0 && data.cache.length > 0, "non-empty bytes");
    savedKeys = copyBytes(data.keys); savedCache = copyBytes(data.cache);
    await r.close();
    const o = await F.openWalletData({ networkType: 0, password: pw, keysData: copyBytes(savedKeys), cacheData: copyBytes(savedCache), proxyToWorker: proxy });
    expect((await o.getPrimaryAddress()) === address, "reopened address");
    expect((await o.getNetworkType()) === 0, "reopened network");
    expect((await o.getRestoreHeight()) === 123456, "reopened restore height");
    expect((await o.getSeed()) === seed, "reopened seed");
    const again = await o.getData();
    await o.close();
    const o2 = await F.openWalletData({ networkType: 0, password: pw, keysData: again.keys, cacheData: again.cache, proxyToWorker: proxy });
    expect((await o2.getRestoreHeight()) === 123456 && (await o2.getPrimaryAddress()) === address, "second-generation reopen");
    await o2.close();
    const t = await F.createRandomWallet({ networkType: "testnet", password: pw, proxyToWorker: proxy });
    const ta = await t.getPrimaryAddress(); const td = await t.getData(); await t.close();
    const t2 = await F.openWalletData({ networkType: "testnet", password: pw, keysData: td.keys, cacheData: td.cache, proxyToWorker: proxy });
    expect((await t2.getNetworkType()) === 1 && (await t2.getPrimaryAddress()) === ta, "testnet reopen");
    await t2.close();
    notes.push("keys " + savedKeys.length + " B, cache " + savedCache.length + " B; mainnet and testnet reopen preserved identity; restore height 123456 preserved over two generations");
  });

  await check("C06", "Wrong password and malformed data reject with stable codes (no abort)", async (notes) => {
    await expectCode(F.openWalletData({ networkType: 0, password: pw + "x", keysData: copyBytes(savedKeys), cacheData: copyBytes(savedCache), proxyToWorker: proxy }), "WRONG_PASSWORD", "wrong password", notes);
    await expectCode(F.openWalletData({ networkType: 0, password: "", keysData: copyBytes(savedKeys), cacheData: copyBytes(savedCache), proxyToWorker: proxy }), "WRONG_PASSWORD", "empty password", notes);
    await expectCode(F.openWalletData({ networkType: 0, password: pw, keysData: savedKeys.slice(0, Math.floor(savedKeys.length / 2)), cacheData: copyBytes(savedCache), proxyToWorker: proxy }), "INVALID_WALLET_DATA", "truncated keys", notes);
    const junk = new Uint8Array(1024); globalThis.crypto.getRandomValues(junk);
    await expectCode(F.openWalletData({ networkType: 0, password: pw, keysData: junk, cacheData: new Uint8Array(0), proxyToWorker: proxy }), "INVALID_WALLET_DATA", "random keys bytes", notes);
    await expectCode(F.openWalletData({ networkType: 0, password: pw, keysData: new Uint8Array(0), cacheData: copyBytes(savedCache), proxyToWorker: proxy }), "INVALID_WALLET_DATA", "empty keys bytes", notes);
    await expectCode(F.openWalletData({ networkType: 0, password: pw, keysData: "not-bytes", proxyToWorker: proxy }), "INVALID_WALLET_DATA", "string instead of bytes", notes);
    const badCache = copyBytes(savedCache); for (let i = 0; i < badCache.length; i += 7) badCache[i] ^= 0x5a;
    try {
      const w = await F.openWalletData({ networkType: 0, password: pw, keysData: copyBytes(savedKeys), cacheData: badCache, proxyToWorker: proxy });
      notes.push("corrupted cache with valid keys -> opened (address match " + ((await w.getPrimaryAddress()) === address) + ", restore height " + (await w.getRestoreHeight()) + ")");
      await w.close();
    } catch (err) {
      notes.push("corrupted cache with valid keys -> " + codeOf(err));
      expect(err instanceof F.ZephyrWalletError, "typed error for corrupted cache");
    }
    try {
      const w = await F.openWalletData({ networkType: 1, password: pw, keysData: copyBytes(savedKeys), cacheData: copyBytes(savedCache), proxyToWorker: proxy });
      notes.push("mainnet bytes opened as testnet -> opened, reported network " + (await w.getNetworkType()));
      await w.close();
    } catch (err) {
      notes.push("mainnet bytes opened as testnet -> " + codeOf(err));
      expect(err instanceof F.ZephyrWalletError, "typed error for network mismatch");
    }
    const ok = await F.openWalletData({ networkType: 0, password: pw, keysData: copyBytes(savedKeys), cacheData: copyBytes(savedCache), proxyToWorker: proxy });
    expect((await ok.getPrimaryAddress()) === address, "module still usable after failures");
    await ok.close();
  });

  await check("C07", "Empty/invalid/conflicting recovery configs and unknown options reject before creation", async (notes) => {
    // invalid checksum: replace the checksum word with a seed word of a different 3-letter prefix
    const words = seed.split(" ");
    const replacement = words.slice(0, 24).find((w) => w.substring(0, 3) !== words[24].substring(0, 3));
    expect(replacement !== undefined, "checksum replacement word");
    const bad25 = words.slice(0, 24).concat([replacement as string]).join(" ");
    for (const rh of [undefined, 77]) {
      const suffix = rh === undefined ? " (no restoreHeight)" : " (restoreHeight " + rh + ")";
      const extra = rh === undefined ? {} : { restoreHeight: rh };
      await expectCode(Internal.createWallet({ networkType: 0, seed: "", ...extra, proxyToWorker: proxy }), "INVALID_RECOVERY_MATERIAL", "empty seed" + suffix, notes);
      await expectCode(Internal.createWallet({ networkType: 0, seed: "   ", ...extra, proxyToWorker: proxy }), "INVALID_RECOVERY_MATERIAL", "blank seed" + suffix, notes);
      await expectCode(Internal.createWallet({ networkType: 0, seed: "abbey abbey", ...extra, proxyToWorker: proxy }), "INVALID_RECOVERY_MATERIAL", "two-word seed" + suffix, notes);
      await expectCode(Internal.createWallet({ networkType: 0, seed: bad25, ...extra, proxyToWorker: proxy }), "INVALID_RECOVERY_MATERIAL", "25 words, bad checksum" + suffix, notes);
      await expectCode(F.createKeysWallet({ networkType: 0, seed: bad25, proxyToWorker: proxy }), "INVALID_RECOVERY_MATERIAL", "keys-only bad checksum" + suffix, notes);
      await expectCode(Internal.createWallet({ networkType: 0, primaryAddress: "", ...extra, proxyToWorker: proxy }), "INVALID_RECOVERY_MATERIAL", "empty primaryAddress" + suffix, notes);
      await expectCode(Internal.createWallet({ networkType: 0, primaryAddress: address, privateViewKey: "", ...extra, proxyToWorker: proxy }), "INVALID_RECOVERY_MATERIAL", "empty privateViewKey" + suffix, notes);
      await expectCode(Internal.createWallet({ networkType: 0, primaryAddress: address, privateViewKey: "zz", ...extra, proxyToWorker: proxy }), "INVALID_RECOVERY_MATERIAL", "non-hex privateViewKey" + suffix, notes);
      await expectCode(Internal.createWallet({ networkType: 0, privateViewKey: privView, ...extra, proxyToWorker: proxy }), "INVALID_RECOVERY_MATERIAL", "view key without address" + suffix, notes);
      await expectCode(Internal.createWallet({ networkType: 0, primaryAddress: address, privateViewKey: privSpend, ...extra, proxyToWorker: proxy }), "INVALID_RECOVERY_MATERIAL", "view key not matching address" + suffix, notes);
      // the last character is replaced by a different base58 character (appending "x" instead kept the address unchanged when it already ended in "x")
      const badChecksumAddress = address.substring(0, 100) + (address.charAt(100) === "x" ? "y" : "x");
      expect(badChecksumAddress !== address, "bad-checksum vector differs from the address");
      await expectCode(Internal.createWallet({ networkType: 0, primaryAddress: badChecksumAddress, privateViewKey: privView, ...extra, proxyToWorker: proxy }), "INVALID_RECOVERY_MATERIAL", "bad-checksum address" + suffix, notes);
      await expectCode(Internal.createWallet({ networkType: 0, seed, primaryAddress: address, ...extra, proxyToWorker: proxy }), "INVALID_CONFIG", "seed and keys" + suffix, notes);
      await expectCode(Internal.createWallet({ networkType: 0, foo: 1, ...extra, proxyToWorker: proxy }), "INVALID_CONFIG", "unknown field" + suffix, notes);
      await expectCode(F.restoreWalletFromSeed({ networkType: 0, ...extra, proxyToWorker: proxy }), "INVALID_CONFIG", "seed mode without seed" + suffix, notes);
      await expectCode(F.restoreWalletFromKeys({ networkType: 0, ...extra, proxyToWorker: proxy }), "INVALID_CONFIG", "keys mode without keys" + suffix, notes);
    }
    await expectCode(Internal.createWallet({ networkType: 0, restoreHeight: 5, proxyToWorker: proxy }), "INVALID_CONFIG", "random with restoreHeight", notes);
    await expectCode(F.createRandomWallet({ networkType: 0, seed, proxyToWorker: proxy }), "INVALID_CONFIG", "random mode with seed", notes);
    await expectCode(Internal.createWallet({ networkType: 0, seedOffset: "x", proxyToWorker: proxy }), "INVALID_CONFIG", "seedOffset without seed", notes);
    await expectCode(Internal.createWallet({ networkType: 0, seed, language: "English", proxyToWorker: proxy }), "INVALID_CONFIG", "language with seed", notes);
    await expectCode(Internal.createWallet({ password: pw, proxyToWorker: proxy }), "INVALID_CONFIG", "missing networkType", notes);
    await expectCode(Internal.createWallet({ networkType: 7, proxyToWorker: proxy }), "INVALID_CONFIG", "invalid networkType", notes);
    await expectCode(Internal.createWallet({ networkType: 0, restoreHeight: -1, seed, proxyToWorker: proxy }), "INVALID_CONFIG", "negative restoreHeight", notes);
    await expectCode(Internal.createWallet({ networkType: 0, accountLookahead: 5, proxyToWorker: proxy }), "INVALID_CONFIG", "lookahead pair incomplete", notes);
    await expectCode(Internal.createWallet(null), "INVALID_CONFIG", "null config", notes);
    await expectCode(F.createKeysWallet({ networkType: 0, seed, restoreHeight: 9, proxyToWorker: proxy }), "UNSUPPORTED_CAPABILITY", "keys-only wallet with restoreHeight", notes);
    for (const [field, value] of [["isTrustedDaemon", false], ["regtest", true], ["isMultisig", true], ["saveCurrent", true], ["path", "wallet-file"], ["connectionManager", {}], ["fs", {}], ["cmd", ["x"]]] as const) {
      await expectCode(Internal.createWallet({ networkType: 0, [field]: value, proxyToWorker: proxy }), "UNSUPPORTED_CAPABILITY", "unsupported " + field, notes);
    }
    // A daemon address is accepted at construction; these settings are rejected before any native or worker call (no request)
    for (const [label, server, code, diagnostic] of [
      ["server with credentials", "http://user:secret@127.0.0.1:1", "UNSUPPORTED_CAPABILITY", "DAEMON_CREDENTIALS"],
      ["server object with a password", { uri: "http://127.0.0.1:1", password: "secret" }, "UNSUPPORTED_CAPABILITY", "DAEMON_CREDENTIALS"],
      ["server object with a proxy", { uri: "http://127.0.0.1:1", proxyUri: "socks5://127.0.0.1:2" }, "UNSUPPORTED_CAPABILITY", "DAEMON_PROXY"],
      ["server object untrusted", { uri: "http://127.0.0.1:1", trusted: false }, "UNSUPPORTED_CAPABILITY", "UNTRUSTED_DAEMON"],
      ["server object with a certificate setting", { uri: "https://127.0.0.1:1", rejectUnauthorized: false }, "UNSUPPORTED_CAPABILITY", "CONFIG_FIELD"],
      ["server with another scheme", "ftp://127.0.0.1:1", "INVALID_CONFIG", "DAEMON_ADDRESS"],
      ["server with a query", "http://127.0.0.1:1/rpc?x=1", "INVALID_CONFIG", "DAEMON_ADDRESS"],
      ["server without a host", "http://:1", "INVALID_CONFIG", "DAEMON_ADDRESS"],
      ["server with dot segments", "http://127.0.0.1:1/a/../rpc", "INVALID_CONFIG", "DAEMON_ADDRESS"]
    ] as const) {
      await expectCode(Internal.createWallet({ networkType: 0, server, proxyToWorker: proxy }), code, "create, " + label, notes, diagnostic);
      await expectCode(F.openWalletData({ networkType: 0, password: pw, keysData: savedKeys, cacheData: savedCache, server, proxyToWorker: proxy }), code, "open, " + label, notes, diagnostic);
    }
    await expectCode(Internal.createWallet({ networkType: 0, server: "http://127.0.0.1:1", isTrustedDaemon: false, proxyToWorker: proxy }), "UNSUPPORTED_CAPABILITY", "server with isTrustedDaemon false", notes, "UNTRUSTED_DAEMON");
    await expectCode(F.createKeysWallet({ networkType: 0, seed, server: "http://127.0.0.1:1", proxyToWorker: proxy }), "UNSUPPORTED_CAPABILITY", "keys-only wallet with a server", notes, "KEYS_ONLY_DAEMON");
    const trusted = await F.createRandomWallet({ networkType: 0, isTrustedDaemon: true, proxyToWorker: proxy });
    notes.push("isTrustedDaemon true without a server -> accepted");
    await trusted.close();
    const exact = await F.restoreWalletFromSeed({ networkType: 0, password: pw, seed, restoreHeight: 77, proxyToWorker: proxy });
    expect((await exact.getPrimaryAddress()) === address && (await exact.getRestoreHeight()) === 77, "valid seed with restoreHeight restores the intended wallet");
    await exact.close();
  });

  await check("C08", "Pathless password change (wrong old rejects; new reopens; old rejected)", async (notes) => {
    const w = await F.openWalletData({ networkType: 0, password: pw, keysData: copyBytes(savedKeys), cacheData: copyBytes(savedCache), proxyToWorker: proxy });
    await expectCode(w.changePassword(pw + "-wrong", "new-" + pw), "WRONG_PASSWORD", "wrong old password", notes);
    const stillOld = await w.getData();
    const reopenOld = await F.openWalletData({ networkType: 0, password: pw, keysData: stillOld.keys, cacheData: stillOld.cache, proxyToWorker: proxy });
    expect((await reopenOld.getPrimaryAddress()) === address, "original password still valid after failed change");
    await reopenOld.close();
    const newPw = randomPassword();
    await w.changePassword(pw, newPw);
    const changed = await w.getData();
    await w.close();
    const reopenNew = await F.openWalletData({ networkType: 0, password: newPw, keysData: copyBytes(changed.keys), cacheData: copyBytes(changed.cache), proxyToWorker: proxy });
    expect((await reopenNew.getPrimaryAddress()) === address && (await reopenNew.getRestoreHeight()) === 123456, "reopen with new password");
    await reopenNew.close();
    await expectCode(F.openWalletData({ networkType: 0, password: pw, keysData: copyBytes(changed.keys), cacheData: copyBytes(changed.cache), proxyToWorker: proxy }), "WRONG_PASSWORD", "old password after change", notes);
    expect(!sameBytes(changed.keys, savedKeys), "keys bytes re-encrypted");
    const k = await F.createKeysWallet({ networkType: 0, seed, proxyToWorker: proxy });
    await expectCode(k.changePassword(pw, newPw), "UNSUPPORTED_CAPABILITY", "keys-only changePassword", notes);
    await k.close();
  });

  await check("C09", "Repeated open/close, double close, use after close, close with queued/active work", async (notes) => {
    const spy = proxy ? undefined : installNativeCloseSpy();
    const before = spy ? spy.count() : 0;
    for (let i = 0; i < 5; i++) {
      const w = await F.openWalletData({ networkType: 0, password: pw, keysData: copyBytes(savedKeys), cacheData: copyBytes(savedCache), proxyToWorker: proxy });
      expect((await w.getPrimaryAddress()) === address, "cycle " + i);
      await w.close();
    }
    const w = await F.openWalletData({ networkType: 0, password: pw, keysData: copyBytes(savedKeys), cacheData: copyBytes(savedCache), proxyToWorker: proxy });
    const pending: Promise<unknown>[] = [];
    for (let i = 0; i < 6; i++) pending.push(w.getData());
    for (let i = 0; i < 4; i++) pending.push(w.getPrimaryAddress());
    pending.push(w.changePassword(pw, pw));
    const c1 = w.close();
    const c2 = w.close();
    expect(c1 === c2, "double close returns the same promise");
    const settled = await Promise.allSettled(pending);
    await c1; await c2;
    let fulfilled = 0; let closedRejects = 0; let other = 0;
    for (const s of settled) {
      if (s.status === "fulfilled") fulfilled++;
      else if (codeOf(s.reason) === "WALLET_CLOSED") closedRejects++;
      else other++;
    }
    notes.push("work issued before close: " + fulfilled + " fulfilled, " + closedRejects + " WALLET_CLOSED, " + other + " other");
    expect(other === 0, "every queued/active call settled as success or WALLET_CLOSED");
    expect(w.isClosed(), "isClosed after close");
    await expectCode(w.getPrimaryAddress(), "WALLET_CLOSED", "getPrimaryAddress after close", notes);
    await expectCode(w.getData(), "WALLET_CLOSED", "getData after close", notes);
    await expectCode(w.changePassword(pw, pw), "WALLET_CLOSED", "changePassword after close", notes);
    await w.close();
    notes.push("third close after completion resolved");
    if (spy) {
      const calls = spy.count() - before;
      report.nativeCloseCalls = calls;
      expect(calls === 6, "native close called exactly once per wallet (6), got " + calls);
      notes.push("native close calls for 6 wallets: " + calls);
    }
  });

  await check("C10", "Bad address/checksum/network vectors reject; subaddress validates", async (notes) => {
    const sub = await (base as F.ZephyrWallet).getAddress(0, 1);
    await F.validateAddress(sub, "mainnet", proxy);
    const lastChar = address.charAt(address.length - 1);
    const flipped = address.substring(0, address.length - 1) + (lastChar === "A" ? "B" : "A");
    const vectors: Array<[string, unknown, F.ZephyrNetworkTypeInput]> = [
      ["checksum (last char changed)", flipped, "mainnet"],
      ["truncated", address.substring(0, 95), "mainnet"],
      ["non-base58 character", "0" + address.substring(1), "mainnet"],
      ["mainnet address as testnet", address, "testnet"],
      ["mainnet address as stagenet", address, "stagenet"],
      ["empty", "", "mainnet"],
      ["not a string", 12345, "mainnet"]
    ];
    for (const [name, value, net] of vectors) await expectCode(F.validateAddress(value, net, proxy), "INVALID_ADDRESS", name, notes);
    await expectCode(F.validateAddress(address, 9 as unknown as F.ZephyrNetworkTypeInput, proxy), "INVALID_CONFIG", "invalid network type", notes);
    notes.push("subaddress (0,1) validates on mainnet");
  });

  await check("C11", "Worker message contract: malformed messages, structured clone of bytes and errors", async (notes) => {
    const ping = async (): Promise<void> => { const r = await postRawWorkerMessage([newMessageId(), "getNetworkGuardReport", newMessageId()], 10000); expect(r.replied && r.error === undefined, "worker alive"); };
    const unroutable: unknown[] = ["not-an-array", 42, null, { a: 1 }, [newMessageId()], [newMessageId(), "getAddress"], [newMessageId(), "getAddress", 7],
      ["bad id with spaces", "getAddress", newMessageId()], [newMessageId(), "getAddress", "x".repeat(65)], ["__proto__", "getAddress", newMessageId()]];
    for (const m of unroutable) {
      const r = await postRawWorkerMessage(m, 1500);
      expect(!r.replied, "no reply to unroutable message");
      await ping();
    }
    notes.push(unroutable.length + " unroutable messages: no reply, worker stayed alive");
    const routed: Array<[string, unknown[], string]> = [
      ["function name not a string", [newMessageId(), 42, newMessageId()], "MALFORMED_MESSAGE"],
      ["empty function name", [newMessageId(), "", newMessageId()], "MALFORMED_MESSAGE"],
      ["unsupported getBalance", [newMessageId(), "getBalance", newMessageId()], "UNSUPPORTED_CAPABILITY"],
      ["unsupported daemonGetHeight", [newMessageId(), "daemonGetHeight", newMessageId()], "UNSUPPORTED_CAPABILITY"],
      ["unsupported httpRequest", [newMessageId(), "httpRequest", newMessageId(), { uri: "http://127.0.0.1:1" }], "UNSUPPORTED_CAPABILITY"],
      ["prototype name constructor", [newMessageId(), "constructor", newMessageId()], "UNSUPPORTED_CAPABILITY"],
      ["unknown wallet id", [newMessageId(), "getAddress", newMessageId(), 0, 0], "WALLET_CLOSED"],
      ["raw create with empty seed", [newMessageId(), "createWalletFull", newMessageId(), { networkType: 0, seed: "" }], "INVALID_RECOVERY_MATERIAL"],
      ["raw create with server", [newMessageId(), "createWalletFull", newMessageId(), { networkType: 0, server: "http://127.0.0.1:1" }], "UNSUPPORTED_CAPABILITY"],
      ["raw create with unknown field", [newMessageId(), "createWalletFull", newMessageId(), { networkType: 0, foo: true }], "INVALID_CONFIG"],
      ["raw create config not an object", [newMessageId(), "createWalletFull", newMessageId(), 17], "INVALID_CONFIG"],
      ["raw open with string bytes", [newMessageId(), "openWalletData", newMessageId(), "", "pw", 0, "abc", "def", undefined, undefined], "INVALID_WALLET_DATA"]
    ];
    for (const [name, message, code] of routed) {
      const r = await postRawWorkerMessage(message, 30000);
      const got = r.error ? String(r.error.code) : r.replied ? "RESULT" : "NO_REPLY";
      notes.push(name + " -> " + got + (r.error && r.error.diagnostic ? "/" + String(r.error.diagnostic) : ""));
      expect(r.replied && got === code && r.error !== undefined && r.error.type === "ZephyrWalletError", name + ": expected " + code + ", got " + got);
      const keys = Object.keys(r.error as object).sort().join(",");
      expect(keys === "code,type" || keys === "code,diagnostic,type", name + ": envelope carries only type, code and diagnostic (" + keys + ")");
      await ping();
    }
    // structured clone: worker bytes reopen in the main-thread module and main-thread bytes in the worker
    const ww = await F.openWalletData({ networkType: 0, password: pw, keysData: copyBytes(savedKeys), cacheData: copyBytes(savedCache), proxyToWorker: true });
    const wd = await ww.getData();
    expect(Object.prototype.toString.call(wd.keys) === "[object Uint8Array]" && Object.prototype.toString.call(wd.cache) === "[object Uint8Array]", "worker bytes are Uint8Array after clone");
    await ww.close();
    const md = await F.openWalletData({ networkType: 0, password: pw, keysData: copyBytes(wd.keys), cacheData: copyBytes(wd.cache), proxyToWorker: false });
    expect((await md.getPrimaryAddress()) === address && (await md.getRestoreHeight()) === 123456, "worker bytes open in the main-thread module");
    const mdd = await md.getData();
    await md.close();
    const back = await F.openWalletData({ networkType: 0, password: pw, keysData: mdd.keys, cacheData: mdd.cache, proxyToWorker: true });
    expect((await back.getPrimaryAddress()) === address, "main-thread bytes open in the worker");
    await back.close();
    try {
      await F.openWalletData({ networkType: 0, password: "wrong", keysData: copyBytes(savedKeys), cacheData: copyBytes(savedCache), proxyToWorker: true });
      throw new CheckFailure("wrong password opened through worker");
    } catch (err) {
      expect(err instanceof F.ZephyrWalletError && err.code === "WRONG_PASSWORD" && err.message === "Wrong wallet password", "typed error with fixed message survives the worker boundary");
      expect(Object.keys(err as object).every((k) => ["code", "diagnostic", "name"].includes(k)), "no extra error fields");
      notes.push("worker error fields: code " + codeOf(err) + diagnosticOf(err) + ", fixed message");
    }
  }, proxy);

  await check("C12", "Unsupported calls reject as UNSUPPORTED_CAPABILITY before native access", async (notes) => {
    const w = await F.openWalletData({ networkType: 0, password: pw, keysData: copyBytes(savedKeys), cacheData: copyBytes(savedCache), proxyToWorker: proxy });
    const calls: Array<[string, () => Promise<unknown>]> = [
      ["startSyncing", () => w.startSyncing()], ["getTxs", () => w.getTxs()],
      ["createTxs", () => w.createTxs()], ["addListener", () => w.addListener()],
      ["getReserveProofWallet", () => w.getReserveProofWallet()], ["rescanSpent", () => w.rescanSpent()], ["importKeyImages", () => w.importKeyImages()],
      ["asset-less getBalance(account, subaddress)", () => (w.getBalance as unknown as (a: number, b: number) => Promise<unknown>)(0, 0)]
    ];
    const native = await countNativeCalls(async () => {
      for (const [name, fn] of calls) await expectCode(fn(), "UNSUPPORTED_CAPABILITY", name, notes);
    });
    if (!proxy) {
      expect(native === 0, "no native export called, got " + native);
      notes.push("native export calls during unsupported calls: " + native);
      const module = LibraryUtils.getWasmModule();
      let backstop = "none";
      try { module.get_balance_subaddress(0); } catch (err) { backstop = codeOf(err) + diagnosticOf(err); }
      expect(backstop === "UNSUPPORTED_CAPABILITY/NATIVE_EXPORT", "absent inherited export is a typed error, got " + backstop);
      notes.push("absent inherited export get_balance_subaddress -> " + backstop);
    } else {
      const r = await postRawWorkerMessage([newMessageId(), "getBalance", newMessageId()], 10000);
      expect(r.replied && r.error !== undefined && r.error.code === "UNSUPPORTED_CAPABILITY", "worker gate rejects getBalance");
      notes.push("worker gate getBalance -> UNSUPPORTED_CAPABILITY");
    }
    const k = await F.createKeysWallet({ networkType: 0, seed, proxyToWorker: proxy });
    await expectCode(k.getData(), "UNSUPPORTED_CAPABILITY", "keys-only getData", notes);
    await expectCode(k.getRestoreHeight(), "UNSUPPORTED_CAPABILITY", "keys-only getRestoreHeight", notes);
    // Network calls are full-wallet only and reject before any native or worker call
    for (const [label, fn] of [["setDaemonConnection", () => k.setDaemonConnection("http://127.0.0.1:1")], ["isConnectedToDaemon", () => k.isConnectedToDaemon()],
      ["getDaemonHeight", () => k.getDaemonHeight()], ["getHeight", () => k.getHeight()], ["sync", () => k.sync()], ["getBalance", () => k.getBalance()]] as const) {
      await expectCode(fn(), "UNSUPPORTED_CAPABILITY", "keys-only " + label, notes, "KEYS_ONLY_DAEMON");
    }
    await k.close();
    await w.close();
  });

  await check("C13", "Logging shim: set_log_level reaches epee without error (direct or worker)", async (notes) => {
    await LibraryUtils.setLogLevel(1);
    await LibraryUtils.setLogLevel(0);
    expect(LibraryUtils.getLogLevel() === 0, "log level restored");
    if (!proxy) {
      const module = LibraryUtils.getWasmModule();
      module.set_log_level(2); module.set_log_level(0);
      notes.push("native set_log_level(2), set_log_level(0) returned");
    } else {
      notes.push("setLogLevel applied in the main context and forwarded to the worker");
    }
  });

  await check("C14", "Restore height and lookahead domains: exact large heights, pre-dispatch rejection", async (notes) => {
    const heights = [2147483648, 4294967296, 4294967297, Number.MAX_SAFE_INTEGER];
    for (const h of heights) {
      const w = await F.restoreWalletFromSeed({ networkType: 0, password: pw, seed, restoreHeight: h, proxyToWorker: proxy });
      expect((await w.getRestoreHeight()) === h, "restore height " + h + " exact after restore");
      const d = await w.getData();
      await w.close();
      const o = await F.openWalletData({ networkType: 0, password: pw, keysData: d.keys, cacheData: d.cache, proxyToWorker: proxy });
      expect((await o.getRestoreHeight()) === h && (await o.getPrimaryAddress()) === address, "restore height " + h + " exact after save/reopen");
      const d2 = await o.getData();
      await o.close();
      const o2 = await F.openWalletData({ networkType: 0, password: pw, keysData: d2.keys, cacheData: d2.cache, proxyToWorker: !proxy && LibraryUtils.WORKER !== undefined });
      expect((await o2.getRestoreHeight()) === h, "restore height " + h + " exact after a second generation");
      await o2.close();
      const k = await F.restoreWalletFromKeys({ networkType: 0, password: pw, primaryAddress: address, privateViewKey: privView, privateSpendKey: privSpend, restoreHeight: h, proxyToWorker: proxy });
      expect((await k.getRestoreHeight()) === h, "keys restore height " + h + " exact");
      await k.close();
    }
    notes.push("restore heights 2^31, 2^32, 2^32+1 and 2^53-1 exact through restore, two save/reopen generations and keys restore");
    const bad: Array<[string, unknown]> = [["2^53", 9007199254740992], ["2^64", 18446744073709551616], ["fraction", 1.5], ["NaN", NaN], ["Infinity", Infinity],
      ["-Infinity", -Infinity], ["negative", -1], ["decimal string", "123"], ["bigint", BigInt(123)], ["null", null], ["boolean", true], ["object", {}]];
    const rejected = await countNativeCalls(async () => {
      for (const [name, value] of bad) await expectCode(F.restoreWalletFromSeed({ networkType: 0, password: pw, seed, restoreHeight: value, proxyToWorker: proxy }), "INVALID_CONFIG", "restoreHeight " + name, notes, "RESTORE_HEIGHT_RANGE");
      const lookaheads: Array<[string, unknown, unknown]> = [["zero", 0, 1], ["2^32", 4294967296, 1], ["2^32+1", 1, 4294967297], ["2^53-1", Number.MAX_SAFE_INTEGER, 1],
        ["fraction", 1.5, 1], ["NaN", NaN, 1], ["negative", -1, 1], ["string", "5", 1], ["bigint", BigInt(5), 1]];
      for (const [name, a, b] of lookaheads) await expectCode(F.restoreWalletFromSeed({ networkType: 0, password: pw, seed, accountLookahead: a, subaddressLookahead: b, proxyToWorker: proxy }), "INVALID_CONFIG", "lookahead " + name, notes, "LOOKAHEAD_RANGE");
    });
    if (!proxy) {
      expect(rejected === 0, "no native call for rejected numeric inputs, got " + rejected);
      notes.push("native export calls during numeric rejections: 0");
    }
    const small = await F.restoreWalletFromSeed({ networkType: 0, password: pw, seed, accountLookahead: 2, subaddressLookahead: 3, proxyToWorker: proxy });
    expect((await small.getPrimaryAddress()) === address, "small valid lookahead accepted");
    await small.close();
    if (proxy) {
      const m = await F.restoreWalletFromSeed({ networkType: 0, password: pw, seed, restoreHeight: 4294967297, proxyToWorker: false });
      const md = await m.getData();
      await m.close();
      const wk = await F.openWalletData({ networkType: 0, password: pw, keysData: md.keys, cacheData: md.cache, proxyToWorker: true });
      expect((await wk.getRestoreHeight()) === 4294967297, "main-thread bytes keep height 2^32+1 in the worker");
      await wk.close();
      notes.push("direct/worker parity: 2^32+1 written in the main thread reads exactly in the worker and vice versa");
    }
  });

  await check("C15", "Address index domains: uint32 accepted exactly, wider values rejected before dispatch", async (notes) => {
    const w = base as F.ZephyrWallet;
    const a31 = await w.getAddress(0, 2147483648);
    const aMax = await w.getAddress(4294967295, 4294967295);
    const a0 = await w.getAddress(0, 0);
    expect(a31 !== a0 && aMax !== a0 && aMax !== a31 && a0 === address, "distinct subaddresses at 2^31 and 2^32-1");
    if (proxy) {
      const direct = await F.openWalletData({ networkType: 0, password: pw, keysData: copyBytes(savedKeys), cacheData: copyBytes(savedCache), proxyToWorker: false });
      expect((await direct.getAddress(0, 2147483648)) === a31 && (await direct.getAddress(4294967295, 4294967295)) === aMax, "direct/worker parity for 2^31 and 2^32-1");
      await direct.close();
      notes.push("worker and main-thread module agree at 2^31 and 2^32-1");
    }
    const bad: Array<[string, unknown]> = [["2^32", 4294967296], ["2^32+1", 4294967297], ["2^53-1", Number.MAX_SAFE_INTEGER], ["2^53", 9007199254740992], ["fraction", 0.5],
      ["NaN", NaN], ["Infinity", Infinity], ["negative", -1], ["negative 2^32", -4294967296], ["string", "1"], ["bigint", BigInt(1)], ["null", null], ["undefined", undefined]];
    const calls = await countNativeCalls(async () => {
      for (const [name, value] of bad) {
        await expectCode(w.getAddress(value as number, 0), "INVALID_CONFIG", "account index " + name, notes, "ADDRESS_INDEX_RANGE");
        await expectCode(w.getAddress(0, value as number), "INVALID_CONFIG", "subaddress index " + name, notes, "ADDRESS_INDEX_RANGE");
      }
    });
    if (!proxy) expect(calls === 0, "no native call for rejected indices, got " + calls);
    if (proxy) {
      for (const [name, value] of [["2^32", 4294967296], ["fraction", 0.5], ["string", "1"]] as const) {
        const r = await postRawWorkerMessage([walletIdOf(w), "getAddress", newMessageId(), value, 0], 10000, w); // the wallet's own worker
        expect(r.replied && r.error !== undefined && r.error.code === "INVALID_CONFIG", "raw worker getAddress " + name + " rejected");
      }
      notes.push("raw worker getAddress with 2^32, fraction and string rejected by the worker table");
    }
    expect((await w.getAddress(0, 1)) === (await w.getAddress(0, 1)), "wallet usable after rejections");
  });

  await check("C16", "Secret-free errors: synthetic markers never appear in errors or envelopes", async (notes) => {
    // seed markers start with "xqz", which is no word prefix of any seed language, so the core must reject them
    const markers = ["Pw-MARKER-q7Zr1", "xqzseedmarker", "\u00c4\u00df\u03a9-\u043c\u0430\u0440\u043a-\u5bc6\u7801", "XQZ-MiXeDcAsE-Token-9"];
    const hexMarker = "ab".repeat(32);
    const leaks: string[] = [];
    const scan = (label: string, err: unknown): void => {
      const parts: string[] = [];
      if (err instanceof Error) parts.push(err.message, String(err.stack ?? ""), err.name, String(err));
      if (err !== null && typeof err === "object") { try { parts.push(JSON.stringify(err)); } catch (e) { parts.push("unserializable"); } for (const k of Object.keys(err)) parts.push(String((err as Record<string, unknown>)[k])); }
      const text = parts.join("\n").toLowerCase();
      for (const m of markers.concat([hexMarker])) if (text.includes(m.toLowerCase())) leaks.push(label);
    };
    const attempt = async (label: string, p: Promise<unknown>): Promise<void> => {
      let value: unknown;
      try { value = await p; } catch (err) { notes.push(label + " -> " + codeOf(err) + diagnosticOf(err)); scan(label, err); return; }
      notes.push(label + " -> resolved (marker input was expected to be rejected)");
      if (value instanceof F.ZephyrWallet) await value.close();
      throw new CheckFailure(label + ": marker input was not rejected");
    };
    await attempt("unknown language echoed by the core", F.createRandomWallet({ networkType: 0, password: pw, language: markers[0], proxyToWorker: proxy }));
    await attempt("unknown language non-Latin", F.createRandomWallet({ networkType: 0, password: pw, language: markers[2], proxyToWorker: proxy }));
    await attempt("seed of marker words", F.restoreWalletFromSeed({ networkType: 0, password: pw, seed: Array(25).fill(markers[1]).join(" "), proxyToWorker: proxy }));
    await attempt("keys-only seed of marker words", F.createKeysWallet({ networkType: 0, seed: Array(25).fill(markers[3]).join(" "), proxyToWorker: proxy }));
    await attempt("wrong password marker", F.openWalletData({ networkType: 0, password: markers[0], keysData: copyBytes(savedKeys), cacheData: copyBytes(savedCache), proxyToWorker: proxy }));
    await attempt("spend key marker (not hex)", F.restoreWalletFromKeys({ networkType: 0, password: pw, privateSpendKey: markers[3] + hexMarker, proxyToWorker: proxy }));
    await attempt("view key marker", F.restoreWalletFromKeys({ networkType: 0, password: pw, primaryAddress: address, privateViewKey: hexMarker, proxyToWorker: proxy }));
    await attempt("address marker", F.validateAddress("ZEPH" + markers[3], "mainnet", proxy));
    await attempt("server URL with credentials and query", F.createRandomWallet({ networkType: 0, password: pw, server: "https://user:" + markers[0] + "@node.invalid:1/json_rpc?token=" + markers[3], proxyToWorker: proxy }));
    await attempt("unknown config field named by a marker", F.createRandomWallet({ networkType: 0, password: pw, [markers[2]]: markers[0], proxyToWorker: proxy }));
    const w = base as F.ZephyrWallet;
    await attempt("wrong old password marker", w.changePassword(markers[0], markers[3]));
    if (proxy) {
      for (const name of ["getBalance" + markers[0], markers[2], "__proto__", "toString", "hasOwnProperty"]) {
        const r = await postRawWorkerMessage([newMessageId(), name, newMessageId()], 10000);
        expect(r.replied && r.error !== undefined && r.error.code === "UNSUPPORTED_CAPABILITY", "raw function name rejected");
        scan("raw function name", r.raw);
      }
      const raw = new RawWorker(); // a fresh worker, so the raw construction reaches the core (one construction per worker)
      const r = await postRawWorkerMessage([newMessageId(), "createWalletFull", newMessageId(), { networkType: 0, password: markers[0], language: markers[1] }], 30000, raw);
      raw.terminate();
      expect(r.replied && r.error !== undefined, "raw create with marker language rejected");
      notes.push("raw create with marker language -> " + String(r.error?.code) + "/" + String(r.error?.diagnostic));
      scan("raw create envelope", r.raw);
      notes.push("raw worker function names with markers, prototype names: UNSUPPORTED_CAPABILITY, name not echoed");
    }
    expect(leaks.length === 0, "marker found in: " + leaks.join(", "));
    notes.push("no marker (password, seed, key, mixed-case, non-Latin, URL credential/query) in any message, stack, field or envelope");
  });

  await check("C17", "Worker request validation: ids, arity, types, unsupported options; wallets stay usable", async (notes) => {
    const keep = await F.openWalletData({ networkType: 0, password: pw, keysData: copyBytes(savedKeys), cacheData: copyBytes(savedCache), proxyToWorker: true });
    const keepId = walletIdOf(keep);
    const keysW = await F.createKeysWallet({ networkType: 0, seed, proxyToWorker: true });
    const keysId = walletIdOf(keysW);
    const usable = async (): Promise<void> => { expect((await keep.getPrimaryAddress()) === address && (await keysW.getPrimaryAddress()) === address, "existing wallets usable and unchanged"); };
    const cases: Array<[string, unknown[], string, string | undefined]> = [
      ["duplicate wallet id (open)", [keepId, "openWalletData", newMessageId(), "", pw, 0, copyBytes(savedKeys), copyBytes(savedCache), undefined, undefined], "MALFORMED_MESSAGE", "DUPLICATE_WALLET_ID"],
      ["duplicate wallet id (create)", [keepId, "createWalletFull", newMessageId(), { networkType: 0, password: pw }], "MALFORMED_MESSAGE", "DUPLICATE_WALLET_ID"],
      ["duplicate wallet id (keys)", [keysId, "createWalletKeys", newMessageId(), { networkType: 0 }], "MALFORMED_MESSAGE", "DUPLICATE_WALLET_ID"],
      ["prototype function hasOwnProperty", [keepId, "hasOwnProperty", newMessageId()], "UNSUPPORTED_CAPABILITY", "WORKER_FUNCTION"],
      ["prototype function valueOf", [keepId, "valueOf", newMessageId()], "UNSUPPORTED_CAPABILITY", "WORKER_FUNCTION"],
      ["inherited worker function getCloseData", [keepId, "getCloseData", newMessageId()], "UNSUPPORTED_CAPABILITY", "WORKER_FUNCTION"],
      ["prototype name as wallet id", ["constructor", "getSeed", newMessageId()], "WALLET_CLOSED", undefined],
      ["prototype name as wallet id (toString)", ["toString", "getData", newMessageId()], "WALLET_CLOSED", undefined],
      ["too many arguments", [keepId, "getSeed", newMessageId(), 1], "MALFORMED_MESSAGE", "ARGUMENT_COUNT"],
      ["too few arguments", [keepId, "getAddress", newMessageId(), 0], "MALFORMED_MESSAGE", "ARGUMENT_COUNT"],
      ["open with too few arguments", [newMessageId(), "openWalletData", newMessageId(), "", pw, 0], "MALFORMED_MESSAGE", "ARGUMENT_COUNT"],
      ["password not a string", [keepId, "changePassword", newMessageId(), 5, "x"], "INVALID_CONFIG", "PASSWORD_TYPE"],
      ["address index wrong type", [keepId, "getAddress", newMessageId(), "0", 0], "INVALID_CONFIG", "ADDRESS_INDEX_RANGE"],
      ["log level out of range", [newMessageId(), "setLogLevel", newMessageId(), 2147483648], "INVALID_CONFIG", "LOG_LEVEL_RANGE"],
      ["raw create with a path", [newMessageId(), "createWalletFull", newMessageId(), { networkType: 0, password: pw, path: "wallet-file" }], "UNSUPPORTED_CAPABILITY", "FILE_PATH"],
      ["raw keys create with a path", [newMessageId(), "createWalletKeys", newMessageId(), { networkType: 0, path: "wallet-file" }], "UNSUPPORTED_CAPABILITY", "FILE_PATH"],
      ["raw open with a path", [newMessageId(), "openWalletData", newMessageId(), "wallet-file", pw, 0, copyBytes(savedKeys), copyBytes(savedCache), undefined, undefined], "UNSUPPORTED_CAPABILITY", "FILE_PATH"],
      ["raw open with a daemon", [newMessageId(), "openWalletData", newMessageId(), "", pw, 0, copyBytes(savedKeys), copyBytes(savedCache), { uri: "http://127.0.0.1:1" }, undefined], "UNSUPPORTED_CAPABILITY", "DAEMON_CONNECTION"],
      ["raw open with regtest", [newMessageId(), "openWalletData", newMessageId(), "", pw, 0, copyBytes(savedKeys), copyBytes(savedCache), undefined, true], "UNSUPPORTED_CAPABILITY", "REGTEST"],
      ["raw open with network 3", [newMessageId(), "openWalletData", newMessageId(), "", pw, 3, copyBytes(savedKeys), copyBytes(savedCache), undefined, undefined], "INVALID_CONFIG", "NETWORK_TYPE"],
      ["raw create with lookahead 2^32", [newMessageId(), "createWalletFull", newMessageId(), { networkType: 0, password: pw, seed, accountLookahead: 4294967296, subaddressLookahead: 1 }], "INVALID_CONFIG", "LOOKAHEAD_RANGE"],
      ["raw create with restore height 2^53", [newMessageId(), "createWalletFull", newMessageId(), { networkType: 0, password: pw, seed, restoreHeight: 9007199254740992 }], "INVALID_CONFIG", "RESTORE_HEIGHT_RANGE"],
      ["close with save", [keepId, "close", newMessageId(), true], "UNSUPPORTED_CAPABILITY", "SAVE_ON_CLOSE"],
      ["keys wallet getRestoreHeight", [keysId, "getRestoreHeight", newMessageId()], "UNSUPPORTED_CAPABILITY", "KEYS_ONLY_RESTORE_HEIGHT"],
      ["keys wallet getData", [keysId, "getData", newMessageId()], "UNSUPPORTED_CAPABILITY", "KEYS_ONLY_DATA"],
      ["keys wallet changePassword", [keysId, "changePassword", newMessageId(), "", "x"], "UNSUPPORTED_CAPABILITY", "KEYS_ONLY_PASSWORD"],
      // A wallet worker admits one construction only (its first message); valid constructions are rejected after validation
      ["second construction in a wallet worker (create)", [newMessageId(), "createWalletFull", newMessageId(), { networkType: 0, password: pw }], "UNSUPPORTED_CAPABILITY", "WORKER_FUNCTION"],
      ["second construction in a wallet worker (open)", [newMessageId(), "openWalletData", newMessageId(), "", pw, 0, copyBytes(savedKeys), copyBytes(savedCache), undefined, undefined], "UNSUPPORTED_CAPABILITY", "WORKER_FUNCTION"],
      ["second construction in a keys wallet worker", [newMessageId(), "createWalletKeys", newMessageId(), { networkType: 0, seed }], "UNSUPPORTED_CAPABILITY", "WORKER_FUNCTION"]
    ];
    for (const [name, message, code, diagnostic] of cases) {
      const target = (message[0] === keysId || name.includes("keys wallet worker")) ? keysW : keep; // each wallet owns its worker
      const r = await postRawWorkerMessage(message, 30000, target);
      const got = r.error ? String(r.error.code) + (r.error.diagnostic ? "/" + String(r.error.diagnostic) : "") : r.replied ? "RESULT" : "NO_REPLY";
      notes.push(name + " -> " + got);
      expect(r.replied && r.error !== undefined && r.error.code === code && (diagnostic === undefined || r.error.diagnostic === diagnostic), name + ": expected " + code + (diagnostic ? "/" + diagnostic : "") + ", got " + got);
      await usable();
    }
    expect((await keep.getRestoreHeight()) === 123456, "duplicate-id attempts did not replace the existing wallet");
    const u = await postRawWorkerMessage([newMessageId(), "createWalletFull", newMessageId(), { networkType: 0, password: pw }], 30000); // the utility worker
    notes.push("construction in the utility worker -> " + String(u.error?.code) + "/" + String(u.error?.diagnostic));
    expect(u.replied && u.error !== undefined && u.error.code === "UNSUPPORTED_CAPABILITY" && u.error.diagnostic === "WORKER_FUNCTION", "the utility worker never owns a wallet");
    await keep.close(); await keysW.close();
    notes.push(cases.length + " rejected requests; both existing wallets remained usable and unchanged after each");
  }, proxy);

  await check("C18", "Serialized password changes followed by getData and reopen", async (notes) => {
    const w = await F.openWalletData({ networkType: 0, password: pw, keysData: copyBytes(savedKeys), cacheData: copyBytes(savedCache), proxyToWorker: proxy });
    const p1 = randomPassword(); const p2 = randomPassword(); const p3 = randomPassword();
    await w.changePassword(pw, p1);
    await w.changePassword(p1, p2);
    await w.changePassword(p2, p3);
    const d = await w.getData();
    await w.close();
    const o = await F.openWalletData({ networkType: 0, password: p3, keysData: copyBytes(d.keys), cacheData: copyBytes(d.cache), proxyToWorker: proxy });
    expect((await o.getPrimaryAddress()) === address && (await o.getRestoreHeight()) === 123456, "reopen with the last password");
    await o.close();
    for (const [label, old] of [["original", pw], ["first", p1], ["second", p2]] as const) {
      await expectCode(F.openWalletData({ networkType: 0, password: old, keysData: copyBytes(d.keys), cacheData: copyBytes(d.cache), proxyToWorker: proxy }), "WRONG_PASSWORD", label + " password after three changes", notes);
    }
    notes.push("three sequential changes; only the last password opens the saved bytes");
  });


  await check("C20", "Queued password changes: unawaited A-B and B-C chain in order; getData, failures and superseded passwords stay consistent", async (notes) => {
    const w = await F.openWalletData({ networkType: 0, password: pw, keysData: copyBytes(savedKeys), cacheData: copyBytes(savedCache), proxyToWorker: proxy });
    const pB = randomPassword(); const pC = randomPassword(); const pD = randomPassword(); const pE = randomPassword(); const pF = randomPassword();
    // 1. A-B and B-C issued without awaiting, getData queued behind them
    const order: string[] = [];
    const ab = w.changePassword(pw, pB).then(() => { order.push("A-B"); });
    const bc = w.changePassword(pB, pC).then(() => { order.push("B-C"); });
    const gd = w.getData().then((d) => { order.push("getData"); return d; });
    await Promise.all([ab, bc]);
    const d1 = await gd;
    notes.push("unawaited A-B, B-C, getData settled in order: " + order.join(" > "));
    expect(order.join(",") === "A-B,B-C,getData", "queued operations settled in submission order");
    let opened = await openingPasswords(d1, [pw, pB, pC], proxy);
    expect(opened.join(",") === "2", "getData queued behind both changes opens only with C, got " + opened.join(","));
    // 2. a failed change, then a valid change and getData, all issued without awaiting
    const failed = w.changePassword(pB, pD).then(() => "fulfilled", (err) => codeOf(err) + diagnosticOf(err)); // B was superseded by C
    const valid = w.changePassword(pC, pD).then(() => "fulfilled", (err) => codeOf(err));
    const gd2 = w.getData();
    const failedOutcome = await failed; const validOutcome = await valid; const d2 = await gd2;
    notes.push("superseded old password B -> " + failedOutcome + "; valid C-D -> " + validOutcome);
    expect(failedOutcome === "WRONG_PASSWORD", "change with a superseded password rejects WRONG_PASSWORD");
    expect(validOutcome === "fulfilled", "a valid change queued behind a failed one succeeds");
    opened = await openingPasswords(d2, [pw, pB, pC, pD], proxy);
    expect(opened.join(",") === "3", "getData after failed and valid changes opens only with D, got " + opened.join(","));
    // 3. two changes from the same old password: the second is superseded by the first
    const first = w.changePassword(pD, pE).then(() => "fulfilled", (err) => codeOf(err));
    const second = w.changePassword(pD, pF).then(() => "fulfilled", (err) => codeOf(err));
    const gd3 = w.getData();
    const firstOutcome = await first; const secondOutcome = await second; const d3 = await gd3;
    notes.push("D-E -> " + firstOutcome + "; D-F (superseded) -> " + secondOutcome);
    expect(firstOutcome === "fulfilled" && secondOutcome === "WRONG_PASSWORD", "the second change from D is rejected after D-E");
    opened = await openingPasswords(d3, [pD, pE, pF], proxy);
    expect(opened.join(",") === "1", "bytes open only with E, got " + opened.join(","));
    // 4. type errors reject at admission and leave the queue state unchanged
    const typeRejects = await countNativeCalls(async () => {
      await expectCode(w.changePassword(5 as unknown as string, pF), "INVALID_CONFIG", "non-string old password at admission", notes, "PASSWORD_TYPE");
      await expectCode(w.changePassword(pE, undefined as unknown as string), "INVALID_CONFIG", "missing new password at admission", notes, "PASSWORD_TYPE");
    });
    if (!proxy) expect(typeRejects === 0, "admission type checks make no native call, got " + typeRejects);
    // 5. wrong old password: the TypeScript check in the queue task rejects before any native call
    const wrongCalls = await countNativeCalls(async () => {
      await expectCode(w.changePassword(pE + "-wrong", pF), "WRONG_PASSWORD", "wrong old password inside the queue task", notes);
    });
    if (!proxy) expect(wrongCalls === 0, "a wrong old password makes no native call, got " + wrongCalls);
    await w.changePassword(pE, pF);
    const d4 = await w.getData();
    opened = await openingPasswords(d4, [pE, pF], proxy);
    expect(opened.join(",") === "1", "a valid change after the rejections applies, got " + opened.join(","));
    // 6. close with password changes queued behind other work: work not started by close rejects
    const busy: Promise<unknown>[] = [];
    for (let i = 0; i < 3; i++) busy.push(w.getData());
    const late = w.changePassword(pF, randomPassword()).then(() => "fulfilled", (err) => codeOf(err));
    const closing = w.close();
    const lateOutcome = await late;
    const busyOutcomes = await Promise.allSettled(busy);
    await closing;
    notes.push("change queued behind three getData calls at close -> " + lateOutcome + "; getData outcomes " + busyOutcomes.map((r) => r.status === "fulfilled" ? "fulfilled" : codeOf(r.reason)).join(","));
    expect(lateOutcome === "fulfilled" || lateOutcome === "WALLET_CLOSED", "a queued change at close settles as success or WALLET_CLOSED");
    expect(busyOutcomes.every((r) => r.status === "fulfilled" || codeOf(r.reason) === "WALLET_CLOSED"), "queued work at close settles as success or WALLET_CLOSED");
    await expectCode(w.changePassword(pF, pE), "WALLET_CLOSED", "change after close", notes);
    notes.push("deterministic active-close ordering for password changes is covered by T07 with a native barrier");
  });

  await check("C21", "Fixed bridge error identifiers and strict envelopes: native failures carry no text; malformed envelopes reject", async (notes) => {
    const marker = "Zq-MARKER-r4-" + randomPassword().substring(0, 8);
    const leaks: string[] = [];
    const scanFor = (label: string, value: unknown, secrets: readonly string[]): void => {
      const text = scanText(value);
      for (const m of secrets) if (m.length > 0 && text.includes(m.toLowerCase())) leaks.push(label);
    };
    const secrets = [marker, pw, seed.split(" ").slice(0, 3).join(" "), privSpend, privView];
    const expectFixed = async (label: string, p: Promise<unknown>, code: string, diagnostic: string): Promise<void> => {
      const err = await expectCode(p, code, label, notes, diagnostic);
      scanFor(label, err, secrets);
    };
    // native failures through the supported surface: exact codes and fixed bridge identifiers
    await expectFixed("wrong password (typed core invalid_password)", F.openWalletData({ networkType: 0, password: marker, keysData: copyBytes(savedKeys), cacheData: copyBytes(savedCache), proxyToWorker: proxy }), "WRONG_PASSWORD", "CORE_INVALID_PASSWORD");
    const truncated = savedKeys.slice(0, Math.floor(savedKeys.length / 2));
    await expectFixed("truncated keys bytes", F.openWalletData({ networkType: 0, password: pw, keysData: truncated, cacheData: copyBytes(savedCache), proxyToWorker: proxy }), "INVALID_WALLET_DATA", "CORE_WALLET_DATA");
    const junk = new Uint8Array(512); globalThis.crypto.getRandomValues(junk);
    await expectFixed("random keys bytes", F.openWalletData({ networkType: 0, password: pw, keysData: junk, proxyToWorker: proxy }), "INVALID_WALLET_DATA", "CORE_WALLET_DATA");
    const words = seed.split(" ");
    const replacement = words.slice(0, 24).find((x) => x.substring(0, 3) !== words[24].substring(0, 3)) as string;
    await expectFixed("bad-checksum seed (full)", F.restoreWalletFromSeed({ networkType: 0, password: marker, seed: words.slice(0, 24).concat([replacement]).join(" "), proxyToWorker: proxy }), "INVALID_RECOVERY_MATERIAL", "CORE_INVALID_MNEMONIC");
    await expectFixed("bad-checksum seed (keys-only)", F.createKeysWallet({ networkType: 0, seed: words.slice(0, 24).concat([replacement]).join(" "), proxyToWorker: proxy }), "INVALID_RECOVERY_MATERIAL", "CORE_INVALID_MNEMONIC");
    await expectFixed("view key not matching the address", F.restoreWalletFromKeys({ networkType: 0, password: marker, primaryAddress: address, privateViewKey: privSpend, proxyToWorker: proxy }), "INVALID_RECOVERY_MATERIAL", "CORE_INVALID_ADDRESS");
    await expectFixed("unknown language with a marker", F.createRandomWallet({ networkType: 0, password: pw, language: marker, proxyToWorker: proxy }), "INVALID_CONFIG", "CORE_UNKNOWN_LANGUAGE");
    await expectFixed("unknown language (keys-only)", F.createKeysWallet({ networkType: 0, language: marker, proxyToWorker: proxy }), "INVALID_CONFIG", "CORE_UNKNOWN_LANGUAGE");
    const lastChar = address.charAt(address.length - 1);
    await expectFixed("bad-checksum address", F.validateAddress(address.substring(0, address.length - 1) + (lastChar === "A" ? "B" : "A"), "mainnet", proxy), "INVALID_ADDRESS", "CORE_INVALID_ADDRESS");
    await expectFixed("address of another network", F.validateAddress(address, "testnet", proxy), "INVALID_ADDRESS", "CORE_INVALID_ADDRESS");
    // raw bridge results in this context's module: exact fixed tokens, never native text
    await LibraryUtils.loadWasmModule();
    const module = LibraryUtils.getWasmModule();
    const raw: Array<[string, unknown, string]> = [
      ["validate_address(marker)", module.validate_address(marker, 0), '{"error":"CORE_INVALID_ADDRESS"}'],
      ["get_integrated_address_util(marker)", module.get_integrated_address_util(0, marker, ""), '{"error":"CORE_INVALID_ADDRESS"}'],
      ["get_integrated_address_util(bad payment id)", module.get_integrated_address_util(0, address, marker), '{"error":"CORE_UNCLASSIFIED"}'],
      ["set_log_level(0)", module.set_log_level(0), ""]
    ];
    for (const [label, value, want] of raw) {
      notes.push("raw " + label + " -> " + (value === "" ? "\"\"" : String(value)));
      expect(value === want, "raw " + label + ": expected " + want);
      scanFor("raw " + label, value, secrets);
    }
    // synchronous embind argument conversion failures happen in JavaScript and can quote the value;
    // the supported layers validate types before any native call, and the fixed fallback discards text
    let conversion: unknown = undefined;
    try { module.get_network_type(marker); } catch (err) { conversion = err; }
    const quoted = conversion !== undefined && scanText(conversion).includes(marker.toLowerCase());
    const mapped = ZephyrWalletError.fromUnknown("other", conversion);
    expect(conversion !== undefined && mapped.code === "NATIVE_ERROR" && mapped.diagnostic === "UNCLASSIFIED_ERROR", "embind conversion failure maps to the fixed fallback");
    scanFor("embind conversion failure after mapping", mapped, [marker]);
    notes.push("raw embind conversion failure " + (quoted ? "quotes" : "does not quote") + " the argument; mapped -> " + mapped.code + "/" + String(mapped.diagnostic) + " without text");
    let backstop = "none";
    try { module.get_exception_message(0); } catch (err) { backstop = codeOf(err) + diagnosticOf(err); }
    expect(backstop === "UNSUPPORTED_CAPABILITY/NATIVE_EXPORT", "get_exception_message is not exported (typed backstop), got " + backstop);
    notes.push("get_exception_message -> " + backstop + " (binding removed from the release module)");
    // strict protocol parsing
    const badResults: Array<[string, string]> = [["unapproved identifier", '{"error":"NOT_APPROVED"}'], ["extra field", '{"error":"CORE_UNCLASSIFIED","text":"x"}'],
      ["whitespace", '{"error": "CORE_UNCLASSIFIED"}'], ["lower case", '{"error":"core_unclassified"}'], ["text after", '{"error":"CORE_UNCLASSIFIED"} ' + marker]];
    for (const [label, value] of badResults) {
      let got = "accepted";
      try { bridgeErrorOf(value); } catch (err) { got = codeOf(err) + diagnosticOf(err); }
      expect(got === "NATIVE_ERROR/UNEXPECTED_RESULT", "malformed bridge result (" + label + ") rejects UNEXPECTED_RESULT, got " + got);
    }
    expect(bridgeErrorOf('{"error":"CORE_WALLET_DATA"}') === "CORE_WALLET_DATA" && bridgeErrorOf("ZEPH") === undefined && bridgeErrorOf("") === undefined, "valid bridge error and non-error results parse");
    let pwBad = "accepted";
    try { bridgePasswordErrorOf('{"error":"CORE_UNCLASSIFIED","passwordState":"maybe"}'); } catch (err) { pwBad = codeOf(err) + diagnosticOf(err); }
    expect(pwBad === "NATIVE_ERROR/UNEXPECTED_RESULT", "invalid password state rejects");
    notes.push(badResults.length + " malformed bridge results and an invalid password state rejected with NATIVE_ERROR/UNEXPECTED_RESULT");
    // strict envelopes and worker replies
    class Shaped { type = "ZephyrWalletError"; code = "WRONG_PASSWORD"; }
    const withHidden = { type: "ZephyrWalletError", code: "WRONG_PASSWORD" }; Object.defineProperty(withHidden, "message", { value: marker, enumerable: false });
    const envelopes: Array<[string, unknown]> = [["extra message field", { type: "ZephyrWalletError", code: "WRONG_PASSWORD", message: marker }],
      ["extra stack field", { type: "ZephyrWalletError", code: "NATIVE_ERROR", stack: marker }], ["extra cause field", { type: "ZephyrWalletError", code: "NATIVE_ERROR", cause: { message: marker } }],
      ["invalid diagnostic", { type: "ZephyrWalletError", code: "NATIVE_ERROR", diagnostic: marker }], ["diagnostic present but undefined", { type: "ZephyrWalletError", code: "NATIVE_ERROR", diagnostic: undefined }],
      ["unknown code", { type: "ZephyrWalletError", code: marker }], ["wrong type", { type: "Error", code: "NATIVE_ERROR" }], ["class instance", new Shaped()],
      ["non-enumerable extra field", withHidden], ["array", ["ZephyrWalletError", "NATIVE_ERROR"]], ["null", null], ["string", marker]];
    for (const [label, value] of envelopes) {
      const e = ZephyrWalletError.fromEnvelope(value);
      expect(e.code === "MALFORMED_MESSAGE" && e.diagnostic === "MESSAGE_SHAPE", "envelope (" + label + ") rejects MALFORMED_MESSAGE, got " + e.code);
      scanFor("envelope " + label, e, [marker]);
    }
    const valid = ZephyrWalletError.fromEnvelope({ type: "ZephyrWalletError", code: "INVALID_ADDRESS", diagnostic: "CORE_INVALID_ADDRESS" });
    expect(valid.code === "INVALID_ADDRESS" && valid.diagnostic === "CORE_INVALID_ADDRESS", "valid envelope accepted");
    expect(ZephyrWalletError.fromEnvelope({ type: "ZephyrWalletError", code: "WALLET_CLOSED" }).code === "WALLET_CLOSED", "valid envelope without diagnostic accepted");
    const replies: Array<[string, unknown, string]> = [["extra reply field", { result: 1, extra: marker }, "MALFORMED_MESSAGE"], ["result and error", { result: 1, error: { type: "ZephyrWalletError", code: "NATIVE_ERROR" } }, "MALFORMED_MESSAGE"],
      ["unknown reply field", { value: 1 }, "MALFORMED_MESSAGE"], ["empty reply object", {}, "MALFORMED_MESSAGE"], ["error envelope with message", { error: { type: "ZephyrWalletError", code: "NATIVE_ERROR", message: marker } }, "MALFORMED_MESSAGE"],
      ["reply not an object", marker, "MALFORMED_MESSAGE"], ["valid error reply", { error: { type: "ZephyrWalletError", code: "WRONG_PASSWORD" } }, "WRONG_PASSWORD"], ["valid result reply", { result: 7 }, "RESULT:7"]];
    for (const [label, value, want] of replies) {
      const got = await new Promise<string>((resolve) => LibraryUtils.settleWorkerReply(value, (r) => resolve("RESULT:" + String(r)), (e) => { scanFor("reply " + label, e, [marker]); resolve(codeOf(e)); }));
      expect(got === want, "worker reply (" + label + "): expected " + want + ", got " + got);
    }
    notes.push(envelopes.length + " malformed envelopes and " + (replies.length - 2) + " malformed worker replies rejected MALFORMED_MESSAGE; valid envelopes and replies accepted");
    // fixed fallback for failures that are neither wallet errors nor bridge results
    for (const [ctx, code] of [["open", "INVALID_WALLET_DATA"], ["restore", "INVALID_RECOVERY_MATERIAL"], ["address", "INVALID_ADDRESS"], ["close", "NATIVE_ERROR"], ["other", "NATIVE_ERROR"]] as const) {
      const e = ZephyrWalletError.fromUnknown(ctx, new Error("wrong password " + marker));
      expect(e.code === code && (e.diagnostic === "UNCLASSIFIED_ERROR" || (ctx === "close" && e.diagnostic === "CORE_CLOSE_FAILED")), "fromUnknown(" + ctx + ") gives " + code + " without reading the text, got " + e.code + diagnosticOf(e));
      scanFor("fromUnknown " + ctx, e, [marker]);
    }
    expect(leaks.length === 0, "marker or secret found in: " + leaks.join(", "));
    notes.push("no marker, password, seed fragment or key in any error, raw bridge result, envelope or reply");
  });

  await check("C22", "Lookahead policy: each value and the product at most 20,000; exact limit accepted; over-limit rejects LOOKAHEAD_LIMIT before dispatch; ABI errors unchanged; opening bytes is not creation", async (notes) => {
    // exact limit accepted (20,000 entries) in each creation/restore path
    const w1 = await F.restoreWalletFromSeed({ networkType: 0, password: pw, seed, accountLookahead: 100, subaddressLookahead: 200, proxyToWorker: proxy });
    expect((await w1.getPrimaryAddress()) === address, "seed restore 100 x 200 accepted");
    const sub = await w1.getAddress(99, 199);
    const d1 = await w1.getData();
    await w1.close();
    const w2 = await F.restoreWalletFromKeys({ networkType: 0, password: pw, primaryAddress: address, privateViewKey: privView, privateSpendKey: privSpend, accountLookahead: 1, subaddressLookahead: 20000, proxyToWorker: proxy });
    expect((await w2.getPrimaryAddress()) === address && (await w2.getAddress(99, 199)) === sub, "keys restore 1 x 20000 accepted and agrees");
    await w2.close();
    const w3 = await F.createRandomWallet({ networkType: 0, password: pw, accountLookahead: 20000, subaddressLookahead: 1, proxyToWorker: proxy });
    expect((await w3.getPrimaryAddress()).length > 0, "random 20000 x 1 accepted");
    await w3.close();
    notes.push("exact limit accepted: seed restore 100 x 200, keys restore 1 x 20000, random 20000 x 1");
    // just over the limit, multiplication overflow and ABI/type errors, before any native call
    const over: Array<[string, number, number]> = [["20001 x 1", 20001, 1], ["1 x 20001", 1, 20001], ["101 x 200", 101, 200], ["200 x 101", 200, 101], ["141 x 142", 141, 142],
      ["20000 x 2", 20000, 2], ["2^32-1 x 2^32-1", 4294967295, 4294967295], ["2^31 x 2^31", 2147483648, 2147483648], ["2^16 x 2^16", 65536, 65536]];
    const abi: Array<[string, unknown, unknown, string]> = [["0 x 1", 0, 1, "LOOKAHEAD_RANGE"], ["2^32 x 1", 4294967296, 1, "LOOKAHEAD_RANGE"], ["2^32 x 20001", 4294967296, 20001, "LOOKAHEAD_RANGE"],
      ["fraction", 1.5, 1, "LOOKAHEAD_RANGE"], ["decimal string", "100", 1, "LOOKAHEAD_RANGE"], ["NaN", NaN, 1, "LOOKAHEAD_RANGE"], ["Infinity", Infinity, 1, "LOOKAHEAD_RANGE"],
      ["negative", -1, 20001, "LOOKAHEAD_RANGE"], ["20001 alone", 20001, undefined, "LOOKAHEAD_PAIR"]];
    const started = Date.now();
    let rejections = 0;
    const calls = await countNativeCalls(async () => {
      for (const [label, a, b] of over) {
        await expectCode(F.createRandomWallet({ networkType: 0, password: pw, accountLookahead: a, subaddressLookahead: b, proxyToWorker: proxy }), "INVALID_CONFIG", "random " + label, notes, "LOOKAHEAD_LIMIT");
        await expectCode(F.restoreWalletFromSeed({ networkType: 0, password: pw, seed, accountLookahead: a, subaddressLookahead: b, proxyToWorker: proxy }), "INVALID_CONFIG", "seed restore " + label, notes, "LOOKAHEAD_LIMIT");
        await expectCode(F.restoreWalletFromKeys({ networkType: 0, password: pw, primaryAddress: address, privateViewKey: privView, accountLookahead: a, subaddressLookahead: b, proxyToWorker: proxy }), "INVALID_CONFIG", "view-only keys restore " + label, notes, "LOOKAHEAD_LIMIT");
        await expectCode(Internal.createWallet({ networkType: 0, password: pw, seed, accountLookahead: a, subaddressLookahead: b, proxyToWorker: proxy }), "INVALID_CONFIG", "createWallet " + label, notes, "LOOKAHEAD_LIMIT");
        await expectCode(ZephyrWalletFull.createWallet(new ZephyrWalletConfig({ networkType: 0, password: pw, seed, accountLookahead: a, subaddressLookahead: b, proxyToWorker: proxy })), "INVALID_CONFIG", "inherited ZephyrWalletFull.createWallet " + label, notes, "LOOKAHEAD_LIMIT");
        rejections += 5;
      }
      for (const [label, a, b, diagnostic] of abi) {
        await expectCode(F.restoreWalletFromSeed({ networkType: 0, password: pw, seed, accountLookahead: a, subaddressLookahead: b, proxyToWorker: proxy }), "INVALID_CONFIG", "ABI/type " + label, notes, diagnostic);
        rejections++;
      }
      await expectCode(F.createKeysWallet({ networkType: 0, password: pw, accountLookahead: 20001, subaddressLookahead: 1, proxyToWorker: proxy }), "UNSUPPORTED_CAPABILITY", "keys-only wallet with 20001 x 1", notes, "KEYS_ONLY_LOOKAHEAD");
      await expectCode(F.createKeysWallet({ networkType: 0, password: pw, accountLookahead: 1, subaddressLookahead: 1, proxyToWorker: proxy }), "UNSUPPORTED_CAPABILITY", "keys-only wallet with 1 x 1", notes, "KEYS_ONLY_LOOKAHEAD");
      rejections += 2;
    });
    const elapsed = Date.now() - started;
    notes.push(rejections + " pre-dispatch rejections " + (elapsed < 5000 ? "under 5 s" : "over 5 s") + (proxy ? "" : "; native export calls " + String(calls)));
    if (!proxy) expect(calls === 0, "no native call for lookahead rejections, got " + String(calls));
    expect(elapsed < 30000, "rejections complete without table allocation");
    if (proxy) {
      const raw: Array<[string, unknown[], string, string]> = [
        ["raw createWalletFull 20001 x 1", [newMessageId(), "createWalletFull", newMessageId(), { networkType: 0, password: pw, seed, accountLookahead: 20001, subaddressLookahead: 1 }], "INVALID_CONFIG", "LOOKAHEAD_LIMIT"],
        ["raw createWalletFull 101 x 200", [newMessageId(), "createWalletFull", newMessageId(), { networkType: 0, password: pw, accountLookahead: 101, subaddressLookahead: 200 }], "INVALID_CONFIG", "LOOKAHEAD_LIMIT"],
        ["raw createWalletFull 2^32-1 x 2^32-1", [newMessageId(), "createWalletFull", newMessageId(), { networkType: 0, password: pw, seed, accountLookahead: 4294967295, subaddressLookahead: 4294967295 }], "INVALID_CONFIG", "LOOKAHEAD_LIMIT"],
        ["raw createWalletFull 2^32 x 1", [newMessageId(), "createWalletFull", newMessageId(), { networkType: 0, password: pw, seed, accountLookahead: 4294967296, subaddressLookahead: 1 }], "INVALID_CONFIG", "LOOKAHEAD_RANGE"],
        ["raw createWalletKeys 20001 x 1", [newMessageId(), "createWalletKeys", newMessageId(), { networkType: 0, password: pw, accountLookahead: 20001, subaddressLookahead: 1 }], "UNSUPPORTED_CAPABILITY", "KEYS_ONLY_LOOKAHEAD"]];
      for (const [label, message, code, diagnostic] of raw) {
        const r = await postRawWorkerMessage(message, 30000);
        notes.push(label + " -> " + String(r.error ? r.error.code + "/" + String(r.error.diagnostic) : "no error"));
        expect(r.replied && r.error !== undefined && r.error.code === code && r.error.diagnostic === diagnostic, label + ": expected " + code + "/" + diagnostic);
      }
    }
    // opening bytes is not creation: keys bytes without cache reopen with the pair stored in the keys file
    const o = await F.openWalletData({ networkType: 0, password: pw, keysData: copyBytes(d1.keys), cacheData: new Uint8Array(0), proxyToWorker: proxy });
    expect((await o.getPrimaryAddress()) === address && (await o.getAddress(99, 199)) === sub, "keys bytes without cache reopen the 100 x 200 wallet");
    await o.close();
    await expectCode(F.openWalletData({ networkType: 0, password: pw, keysData: copyBytes(d1.keys), cacheData: copyBytes(d1.cache), accountLookahead: 1, subaddressLookahead: 1, proxyToWorker: proxy }), "INVALID_CONFIG", "open config with lookahead fields", notes, "UNKNOWN_FIELD");
    notes.push("keys bytes without cache reopen a full wallet from the lookahead pair stored in the keys file (the creation limit does not bound it); open configs take no lookahead; keys-only wallet objects reject any lookahead");
  });

  await check("C23", "Dedicated wallet workers: one worker per construction, failure cleanup, two FIFO construction slots, construction-only abort, worker failures", async (notes) => {
    const acc = () => LibraryUtils.getWorkerAccounting();
    const openCfg = (password: string) => ({ networkType: 0, password, keysData: copyBytes(savedKeys), cacheData: copyBytes(savedCache), proxyToWorker: proxy });
    // construction options are validated before any worker or native call
    await expectCode(F.createRandomWallet({ networkType: 0, password: pw, proxyToWorker: proxy }, { signal: "abort" } as unknown as F.ZephyrWalletConstructionOptions), "INVALID_CONFIG", "signal that is not an AbortSignal", notes, "FIELD_TYPE");
    await expectCode(F.openWalletData(openCfg(pw), { timeoutMs: 5 } as unknown as F.ZephyrWalletConstructionOptions), "INVALID_CONFIG", "unknown construction option", notes, "UNKNOWN_FIELD");
    await expectCode(F.createKeysWallet({ networkType: 0, seed, proxyToWorker: proxy }, null as unknown as F.ZephyrWalletConstructionOptions), "INVALID_CONFIG", "options not an object", notes, "CONFIG_TYPE");
    // a pre-aborted signal rejects before any slot, worker or native call
    const pre = new AbortController(); pre.abort();
    const a0 = acc();
    const preCalls = await countNativeCalls(async () => {
      await expectCode(F.openWalletData(openCfg(pw), { signal: pre.signal }), "NATIVE_ERROR", "pre-aborted open", notes, "CONSTRUCTION_ABORTED");
      await expectCode(F.restoreWalletFromSeed({ networkType: 0, password: pw, seed, proxyToWorker: proxy }, { signal: pre.signal }), "NATIVE_ERROR", "pre-aborted seed restore", notes, "CONSTRUCTION_ABORTED");
      await expectCode(F.createKeysWallet({ networkType: 0, seed, proxyToWorker: proxy }, { signal: pre.signal }), "NATIVE_ERROR", "pre-aborted keys-only creation", notes, "CONSTRUCTION_ABORTED");
    });
    expect(acc().workersStarted === a0.workersStarted, "no worker started for pre-aborted constructions");
    if (!proxy) {
      expect(preCalls === 0, "no native call for pre-aborted constructions, got " + String(preCalls));
      notes.push("direct mode: one shared instance in this context, no worker isolation; only an already aborted signal is honored (no native call)");
      return;
    }
    const b0 = acc();
    // earlier checks' workers may still be exiting: wait until the independent count equals the open SDK workers plus nothing else
    const m0 = await waitWorkerMonitor(b0.utilityWorkers + b0.walletWorkers + b0.constructionWorkers, 10000);
    if (m0 !== undefined) expect(m0.live === b0.utilityWorkers + b0.walletWorkers + b0.constructionWorkers, "independent monitor agrees with the open SDK workers before C23 (" + m0.live + ")");
    // a live wallet in its own worker
    const live = await F.openWalletData(openCfg(pw));
    const liveChannel = channelOf(live);
    let a = acc();
    expect(a.walletWorkers === b0.walletWorkers + 1 && a.constructionWorkers === 0 && a.activeConstructions === 0 && a.workersStarted === b0.workersStarted + 1, "the open started one worker, now owned by the wallet");
    const liveUsable = async (label: string): Promise<void> => {
      const d = await live.getData();
      expect((await live.getPrimaryAddress()) === address && d.keys.length > 0 && liveChannel.isOpen(), "live wallet usable after " + label);
    };
    // ten wrong-password opens, each in a fresh worker that is discarded
    for (let i = 0; i < 10; i++) {
      const before = acc();
      await expectCode(F.openWalletData(openCfg(pw + "-wrong-" + i)), "WRONG_PASSWORD", "wrong-password open " + (i + 1), i === 0 ? notes : []);
      a = acc();
      expect(a.workersStarted === before.workersStarted + 1 && a.workersTerminated === before.workersTerminated + 1, "wrong-password open " + (i + 1) + " started and discarded exactly one worker");
      expect(a.constructionWorkers === 0 && a.activeConstructions === 0 && a.queuedConstructions === 0 && a.walletWorkers === b0.walletWorkers + 1, "no construction worker or slot remains after failure " + (i + 1));
    }
    await liveUsable("ten wrong-password opens");
    // ten invalid recovery inputs reaching the core: five seeds with a broken checksum, five keys that do not match the address
    const aux = await F.createRandomWallet({ networkType: 0, password: pw, proxyToWorker: proxy });
    const otherSpend = await aux.getPrivateSpendKey();
    await aux.close();
    for (let i = 0; i < 5; i++) {
      await expectCode(F.restoreWalletFromSeed({ networkType: 0, password: pw, seed: brokenChecksumSeed(seed, i * 5), proxyToWorker: proxy }), "INVALID_RECOVERY_MATERIAL", "seed with a broken checksum " + (i + 1), i === 0 ? notes : []);
      await expectCode(F.restoreWalletFromKeys({ networkType: 0, password: pw, primaryAddress: address, privateSpendKey: otherSpend, proxyToWorker: proxy }), "INVALID_RECOVERY_MATERIAL", "spend key of another wallet " + (i + 1), i === 0 ? notes : []);
    }
    a = acc();
    expect(a.constructionWorkers === 0 && a.activeConstructions === 0 && a.walletWorkers === b0.walletWorkers + 1, "no construction worker remains after the invalid restores");
    await liveUsable("ten invalid restores");
    const m1 = await waitWorkerMonitor(m0 === undefined ? 0 : m0.live + 1, 10000);
    if (m0 !== undefined && m1 !== undefined) {
      expect(m1.live === m0.live + 1, "independent monitor: only the live wallet's worker remains (" + m1.live + " live, baseline " + m0.live + ")");
      notes.push("independent monitor (" + m1.source + "): " + (m1.created - m0.created) + " workers started and " + (m1.ended - m0.ended) + " ended for 1 live wallet, 10 wrong-password opens, 10 invalid restores and 1 auxiliary wallet");
    }
    // two FIFO construction slots: five unawaited constructions never run more than two at once
    let maxActive = 0; let maxConstructionWorkers = 0; let maxQueued = 0;
    const sampler = setInterval(() => { const x = acc(); maxActive = Math.max(maxActive, x.activeConstructions); maxConstructionWorkers = Math.max(maxConstructionWorkers, x.constructionWorkers); maxQueued = Math.max(maxQueued, x.queuedConstructions); }, 2);
    const five = [0, 1, 2, 3, 4].map(() => F.openWalletData(openCfg(pw)));
    const opened = await Promise.all(five);
    clearInterval(sampler);
    a = acc();
    const channels = new Set(opened.map((w) => channelOf(w)));
    notes.push("five unawaited opens: at most " + maxActive + " active and " + maxConstructionWorkers + " construction workers, up to " + maxQueued + " queued; " + channels.size + " distinct wallet workers");
    expect(maxActive <= 2 && maxConstructionWorkers <= 2 && maxActive >= 1, "never more than two concurrent constructions");
    expect(channels.size === 5 && !channels.has(liveChannel) && a.walletWorkers === b0.walletWorkers + 6, "each wallet owns its own worker");
    for (const w of opened) expect((await w.getPrimaryAddress()) === address, "each constructed wallet usable");
    for (const w of opened) await w.close();
    a = acc();
    expect(a.walletWorkers === b0.walletWorkers + 1 && opened.every((w) => !channelOf(w).isOpen()), "closing terminated exactly those five workers");
    // queued abort: with both slots taken, the third construction is aborted while it waits
    const qa = new AbortController();
    const startedBefore = acc().workersStarted;
    const pA = F.openWalletData(openCfg(pw)); const pB = F.openWalletData(openCfg(pw));
    const pC = F.openWalletData(openCfg(pw), { signal: qa.signal }).then((w) => { void w.close(); return "fulfilled"; }, (err) => codeOf(err) + diagnosticOf(err));
    const queuedSeen = await waitUntil(() => acc().queuedConstructions === 1, 10000);
    qa.abort();
    const cOutcome = await pC;
    const startedAtAbort = acc().workersStarted - startedBefore;
    const [wA, wB] = await Promise.all([pA, pB]);
    notes.push("queued abort: queued " + queuedSeen + ", outcome " + cOutcome + ", workers started for the three constructions " + (acc().workersStarted - startedBefore));
    expect(queuedSeen && cOutcome === "NATIVE_ERROR/CONSTRUCTION_ABORTED", "a construction aborted while queued rejects CONSTRUCTION_ABORTED");
    expect(startedAtAbort <= 2 && acc().workersStarted - startedBefore === 2 && acc().queuedConstructions === 0, "the aborted queued construction never started a worker");
    await wA.close(); await wB.close();
    // active abort: a bounded synchronous native workload (20,000-entry lookahead) is stopped by terminating its worker
    const aa = new AbortController();
    const terminatedBefore = acc().workersTerminated;
    const active = F.createRandomWallet({ networkType: 0, password: pw, accountLookahead: 20000, subaddressLookahead: 1, proxyToWorker: proxy }, { signal: aa.signal }).then((w) => { void w.close(); return "fulfilled"; }, (err) => codeOf(err) + diagnosticOf(err));
    await waitUntil(() => acc().constructionWorkers === 1, 10000);
    await new Promise((r) => setTimeout(r, 1500)); // module start, then native table generation (about 4 s on this VM)
    const abortedAt = Date.now();
    aa.abort();
    const activeOutcome = await active;
    const settleMs = Date.now() - abortedAt;
    a = acc();
    notes.push("active abort during construction: " + activeOutcome + " " + settleMs + " ms after abort; construction workers " + a.constructionWorkers + ", active slots " + a.activeConstructions);
    expect(activeOutcome === "NATIVE_ERROR/CONSTRUCTION_ABORTED" && a.constructionWorkers === 0 && a.activeConstructions === 0 && a.workersTerminated === terminatedBefore + 1, "an active construction is aborted by terminating only its worker");
    // success, then abort: the signal is detached once the wallet is returned
    const sa = new AbortController();
    const kept = await F.restoreWalletFromSeed({ networkType: 0, password: pw, seed, proxyToWorker: proxy }, { signal: sa.signal });
    sa.abort();
    await new Promise((r) => setTimeout(r, 50));
    expect((await kept.getPrimaryAddress()) === address && channelOf(kept).isOpen(), "abort after success does not affect the returned wallet");
    await kept.close();
    // worker start failures: a throwing loader and a loader returning no worker
    const loader = LibraryUtils.WORKER_LOADER;
    for (const [label, l] of [["throwing loader", () => { throw new Error("no worker"); }], ["loader without a worker", () => ({}) as unknown as Worker]] as Array<[string, () => Worker]>) {
      const before = acc();
      LibraryUtils.setWorkerLoader(l);
      try { await expectCode(F.openWalletData(openCfg(pw)), "NATIVE_ERROR", "start failure: " + label, notes, "WORKER_FAILED"); } finally { LibraryUtils.setWorkerLoader(loader); }
      a = acc();
      expect(a.activeConstructions === 0 && a.constructionWorkers === 0 && a.startFailures === before.startFailures + 1 && a.workersStarted === before.workersStarted, label + ": slot released, start failure counted, no worker registered");
    }
    if (typeof process !== "undefined" && typeof process.versions === "object" && process.versions.node !== undefined && LibraryUtils.WORKER_LOADER === undefined) {
      const path = LibraryUtils.WORKER_DIST_PATH;
      LibraryUtils.setWorkerDistPath(path + ".missing");
      try { await expectCode(F.openWalletData(openCfg(pw)), "NATIVE_ERROR", "start failure: missing worker script (Node)", notes, "WORKER_FAILED"); } finally { LibraryUtils.setWorkerDistPath(path); }
      // unexpected worker death with pending requests: the thread is terminated behind the SDK's back
      const victim = await F.openWalletData(openCfg(pw));
      const vc = channelOf(victim);
      const failedBefore = acc().workersFailed;
      const pending = [victim.getData(), victim.getPrimaryAddress(), victim.changePassword(pw, randomPassword())].map((p) => p.then(() => "fulfilled", (err) => codeOf(err) + diagnosticOf(err)));
      vc.worker.terminate(); // not through the SDK: the worker exits unexpectedly
      const outcomes = await Promise.all(pending);
      await waitUntil(() => !vc.isOpen(), 10000);
      a = acc();
      notes.push("unexpected worker exit (Node): pending -> " + outcomes.join(",") + "; channel " + vc.state + ", pending requests left " + vc.pendingCount());
      expect(outcomes.every((o) => o === "fulfilled" || o === "NATIVE_ERROR/WORKER_FAILED") && outcomes.some((o) => o === "NATIVE_ERROR/WORKER_FAILED"), "pending requests settle once each with WORKER_FAILED (or their earlier reply)");
      expect(vc.state === "failed" && vc.pendingCount() === 0 && a.workersFailed === failedBefore + 1, "the failed worker is removed with no pending request");
      await expectCode(victim.getData(), "NATIVE_ERROR", "call after the worker died", notes, "WORKER_FAILED");
      await victim.close();
      expect(victim.isClosed(), "close resolves for a wallet whose worker died (no reachable native handle)");
    } else {
      notes.push("missing-script and external-termination cases are Node-only (a browser reports neither); the instrumented suite injects worker crashes in every worker context");
    }
    await liveUsable("start failures, aborts and worker death");
    await live.close();
    a = acc();
    expect(!liveChannel.isOpen() && a.walletWorkers === b0.walletWorkers && a.constructionWorkers === 0 && a.activeConstructions === 0 && a.queuedConstructions === 0, "closing the live wallet terminated its worker; no worker or slot remains");
    const m2 = await waitWorkerMonitor(m0 === undefined ? 0 : m0.live, 10000);
    if (m0 !== undefined && m2 !== undefined) {
      expect(m2.live === m0.live, "independent monitor: back to the baseline worker count");
      notes.push("independent monitor at the end of C23: " + (m2.created - m0.created) + " started, " + (m2.ended - m0.ended) + " ended, live delta " + (m2.live - m0.live));
    }
    notes.push("accounting: started " + (a.workersStarted - b0.workersStarted) + ", terminated " + (a.workersTerminated - b0.workersTerminated) + ", failed " + (a.workersFailed - b0.workersFailed) + ", start failures " + (a.startFailures - b0.startFailures));
  });

  await check("C25", "A worker that never answers a utility message: a failed construction settles and frees its slot, close resolves", async (notes) => {
    const acc = () => LibraryUtils.getWorkerAccounting();
    const bound = async <T>(p: Promise<T>, ms: number): Promise<{ settled: boolean; value?: T; error?: unknown }> => {
      let timer: ReturnType<typeof setTimeout> | undefined = undefined;
      const timeout = new Promise<{ settled: boolean }>((resolve) => { timer = setTimeout(() => resolve({ settled: false }), ms); });
      const r = await Promise.race([p.then((value) => ({ settled: true, value }), (error) => ({ settled: true, error })), timeout]);
      if (timer !== undefined) clearTimeout(timer);
      return r;
    };
    // every worker started now drops the utility (global-scope) messages posted to it; wallet messages pass
    const utility = new Set(["setLogLevel", "getNetworkGuardReport", "zephyrUtilsValidateAddress", "zephyrUtilsGetIntegratedAddress"]);
    let dropped = 0;
    const prior = LibraryUtils.WORKER_LOADER;
    const dropping = (): Worker => {
      let w: Worker;
      if (prior) w = prior();
      else { LibraryUtils.WORKER_LOADER = undefined; try { w = LibraryUtils.newWorkerInstance() as unknown as Worker; } finally { LibraryUtils.WORKER_LOADER = dropping; } }
      const post = w.postMessage.bind(w);
      (w as unknown as { postMessage: (m: unknown) => void }).postMessage = (m: unknown) => { if (Array.isArray(m) && utility.has(m[1] as string)) { dropped++; return; } post(m); };
      return w;
    };
    LibraryUtils.setWorkerLoader(dropping);
    try {
      const b0 = acc();
      const failed = await bound(F.openWalletData({ networkType: 0, password: "wrong " + randomPassword(), keysData: copyBytes(savedKeys), cacheData: copyBytes(savedCache), proxyToWorker: proxy }), 20000);
      const a1 = acc();
      expect(failed.settled && failed.error instanceof F.ZephyrWalletError && failed.error.code === "WRONG_PASSWORD", "the failed construction settled with its own error");
      expect(a1.activeConstructions === 0 && a1.constructionWorkers === 0 && a1.workersStarted === b0.workersStarted + 1 && a1.workersTerminated === b0.workersTerminated + 1, "its slot is free and its worker terminated");
      notes.push("failed open in a dropping worker -> " + (failed.settled ? codeOf(failed.error) + diagnosticOf(failed.error) : "PENDING after 20 s") + "; active slots " + a1.activeConstructions);
      const live = await F.openWalletData({ networkType: 0, password: pw, keysData: copyBytes(savedKeys), cacheData: copyBytes(savedCache), proxyToWorker: proxy });
      const lc = channelOf(live);
      const control = await postRawWorkerMessage([newMessageId(), "getNetworkGuardReport", newMessageId()], 2000, live);
      expect(!control.replied && dropped === 1, "positive control: the wallet's worker does not answer a utility message");
      skipGuardRead(live); // the test layer's own read would only wait for its bound here
      const closing = await bound(live.close(), 20000);
      const a2 = acc();
      expect(closing.settled && closing.error === undefined, "close resolved");
      expect(!lc.isOpen() && a2.walletWorkers === b0.walletWorkers, "close terminated the wallet's worker");
      notes.push("close of a live wallet in a dropping worker -> " + (closing.settled ? (closing.error === undefined ? "resolved" : codeOf(closing.error)) : "PENDING after 20 s"));
      expect(dropped === 1, "the SDK sent no utility message to these workers (dropped " + dropped + ", the control only)");
      notes.push("utility messages dropped: " + dropped + " (the positive control)");
    } finally {
      LibraryUtils.setWorkerLoader(prior);
    }
  }, proxy);

  if (base && proxy) {
    const walletProof = await postRawWorkerMessage([newMessageId(), "getNetworkGuardReport", newMessageId()], 10000, base); // the base wallet's own worker
    report.walletWorkerProof = walletProof.result;
  }
  if (base) await base.close();
  if (proxy) await F.validateAddress(address, "mainnet", true); // a utility call: the utility worker runs the module
  report.networkGuard = combinedGuard(await Internal.getNetworkGuardReport()); // open workers now plus the test layer's reads before each close
  if (proxy) {
    const proof = await postRawWorkerMessage([newMessageId(), "getNetworkGuardReport", newMessageId()], 10000);
    report.workerProof = proof.result;
  }
  await check("C19", "Offline lifecycle made zero HttpClient requests (bridge rejects the unset daemon host)", async (notes) => {
    const g = report.networkGuard as ReturnType<typeof combinedGuard>;
    notes.push("main context blocked requests " + g.mainBlockedRequests + ", allowed " + g.mainAllowedRequests + (proxy ? "; workers blocked " + String(g.workerBlockedRequests) + ", allowed " + String(g.workerAllowedRequests) + " over " + g.workerReports + " reports (" + g.ledgerReports + " read before close), " + g.workersUnreported + " unreported" : ""));
    expect(g.mainBlockedRequests === 0 && Object.keys(g.mainBlockedSummary).length === 0, "no request reached HttpClient in the main context");
    expect(g.mainAllowedRequests === 0 && Object.keys(g.mainAllowedSummary).length === 0, "no request was sent from the main context");
    if (proxy) {
      expect(g.workerBlockedRequests === 0 && g.workerBlockedSummary !== undefined && Object.keys(g.workerBlockedSummary).length === 0, "no request reached HttpClient in the workers");
      expect(g.workerAllowedRequests === 0 && g.workerAllowedSummary !== undefined && Object.keys(g.workerAllowedSummary).length === 0, "no request was sent from a worker");
      expect(g.ledgerReports >= 1, "the test layer read wallet workers before their close");
    }
  });
  await check("C24", "After every wallet closed no construction slot, queued construction, wallet worker, pending request or wallet callback remains", async (notes) => {
    const a = LibraryUtils.getWorkerAccounting();
    report.workerAccounting = a;
    report.workerMonitor = await waitWorkerMonitor(a.utilityWorkers, 10000); // exit events of the last closed workers may still be pending
    notes.push("utility " + a.utilityWorkers + ", construction " + a.constructionWorkers + ", wallet " + a.walletWorkers + ", active " + a.activeConstructions + ", queued " + a.queuedConstructions + ", pending " + a.pendingRequests + ", objects " + a.registeredObjects + ", callbacks " + a.registeredCallbacks + "; started " + a.workersStarted + ", terminated " + a.workersTerminated + ", failed " + a.workersFailed + ", start failures " + a.startFailures);
    expect(a.constructionWorkers === 0 && a.walletWorkers === 0 && a.activeConstructions === 0 && a.queuedConstructions === 0 && a.pendingRequests === 0 && a.registeredCallbacks === 0 && a.registeredObjects === 0, "nothing remains");
    expect(a.utilityWorkers <= 1 && (proxy || a.workersStarted === 0), proxy ? "at most the utility worker remains" : "direct mode started no worker");
    expect(a.workersStarted === a.workersTerminated + a.workersFailed + a.utilityWorkers, "every started worker ended, except the utility worker");
  });
  report.checks.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)); // C19 runs last (it reports the guard counts of the whole run)
  report.finishedUtc = new Date().toISOString();
  return report;
}
