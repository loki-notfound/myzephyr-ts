/**
 * Read-only network checks (test only), shared by the Node runner and the Chromium
 * page. Disposable wallets only; no funds. Results hold codes, counts, heights and timings only:
 * never recovery material, passwords, keys, wallet bytes, request or response bodies.
 *
 * Load rules are enforced here as well as in the runners: every sync starts at most
 * 2,000 blocks below the daemon height (fresh restores use exactly height - 2,000, reopened seed
 * wallets start at their own height), syncs run one at a time, no background sync is started, and
 * every sync call is recorded with its target kind so the validator can count the syncs that
 * reached a configured daemon.
 */
import * as F from "../../main/ts/index";
import * as Internal from "../../main/ts/wallet/ZephyrWallet"; // not exported by the package entry
import LibraryUtils from "../../main/ts/common/LibraryUtils";
import HttpClient from "../../main/ts/common/HttpClient";
import { parseDaemonAddress } from "../../main/ts/common/ZephyrDaemonAddress";
import { CheckFailure, CheckResult, codeOf, diagnosticOf, expect, expectCode, randomPassword, withDeadline } from "../lifecycle/LifecycleChecks";
import { GUARD_LEDGER, channelOf, combinedGuard, installGuardLedger, readGuardInto } from "../lifecycle/testSupport";

/** Thrown by a check whose optional configuration is absent: the check is reported as not run. */
export class CheckNotRun extends Error {}

/** Sync budget of one run: syncs that reach a configured daemon. */
export const MAX_REAL_SYNCS = 12;
/** Blocks below the daemon height at which a fresh restore starts (the upper bound of a sync). */
export const FRESH_SYNC_BLOCKS = 2000;

export type TargetKind = "real" | "fake" | "unreachable";

export interface NetworkTargets {
  /** form 1 in Node: the configured daemon addressed directly (ZEPHYR_TS_TEST_DAEMON) */
  readonly direct?: string;
  /** the configured daemon over HTTPS (ZEPHYR_TS_TEST_DAEMON_HTTPS, optional: without it N03 is not run) */
  readonly lb?: string;
  /** forwarder root on loopback (form 1 in the browser: the page's own origin, no path) */
  readonly root?: string;
  /** forwarder base path on the same listener (form 2) */
  readonly base?: string;
  /** separate origin that sends CORS headers allowing the page (form 3, allowed) */
  readonly allow?: string;
  /** separate origin without CORS headers (form 3, blocked) */
  readonly deny?: string;
  /** forwarder mount whose binary requests are delayed (lifecycle during an active sync) */
  readonly slow?: string;
  readonly fakeStatus?: string;
  readonly fakeMalformed?: string;
  readonly fakeNodeStatus?: string;
  /** a closed loopback port */
  readonly closed?: string;
  /** a loopback port that accepts and never answers */
  readonly silent?: string;
}

export interface SeedWallet {
  readonly keys: Uint8Array;
  readonly cache: Uint8Array;
  readonly password: string;
}

export interface NetworkOptions {
  readonly env: "node-direct" | "node-worker" | "chromium-worker";
  readonly proxyToWorker: boolean;
  readonly targets: NetworkTargets;
  readonly marker: string;
  readonly checks: readonly string[];
  /** seed wallet saved by an earlier run (reopened wallets sync a few blocks only) */
  readonly seed?: SeedWallet;
  /** where a fresh measured restore stores its wallet for later runs */
  readonly saveSeed?: (seed: SeedWallet) => Promise<void>;
  /** test-side request recorder of the calling context (direct mode only) */
  readonly recorder?: RequestRecorder;
  readonly log?: (line: string) => void;
  readonly deadlineMs?: number;
}

export interface SyncRecord {
  readonly check: string;
  readonly target: string;
  readonly kind: TargetKind;
  readonly outcome: string;
  readonly numBlocksFetched?: number;
  readonly startBelowDaemonHeight?: number;
  /** the first sync of a new or freshly restored wallet: the core first downloads every block hash (about 29 MB) */
  readonly firstSync: boolean;
  readonly ms: number;
}

export interface NetworkReport {
  readonly suite: "network";
  readonly env: string;
  readonly proxyToWorker: boolean;
  readonly startedUtc: string;
  finishedUtc: string;
  readonly checks: CheckResult[];
  readonly syncs: SyncRecord[];
  readonly measurements: Record<string, unknown>;
  networkGuard?: unknown;
  workerAccounting?: unknown;
}

/** Per-request recorder installed on the context's HttpClient (direct mode, test only). */
export interface RequestRecorder {
  reset(): void;
  snapshot(): { requests: number; requestBytes: number; responseBytes: number; byRoute: Record<string, { count: number; requestBytes: number; responseBytes: number; ms: number }>; digests: Array<{ route: string; request: string; response: string; withoutTip: string | undefined }>; hosts: string[] };
  /** chain segments of the binary answers since the last reset, by route and request digest (memory only) */
  segments(): Map<string, ChainSegment | undefined>;
}

type Digest = (bytes: Uint8Array) => Promise<string>;

/**
 * Canonical text of an epee portable-storage body (the daemon's binary RPC format) without the
 * top-level fields that describe the daemon's moving tip or clock, or undefined if the body does not
 * parse. Answers of /gethashes.bin and /getblocks.bin carry current_height and top_hash (rpc access
 * base), /getblocks.bin also daemon_time; two syncs a few seconds apart may see another tip.
 * Everything else of an answer to an identical request must be equal across upstreams.
 */
export const TIP_FIELDS: readonly string[] = ["current_height", "top_hash", "daemon_time"];
export function epeeWithoutTip(bytes: Uint8Array): string | undefined {
  const root = parseEpee(bytes);
  if (root === undefined) return undefined;
  for (const f of TIP_FIELDS) delete root[f];
  const canonical = (v: unknown): unknown => Array.isArray(v) ? v.map(canonical) : v !== null && typeof v === "object" ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, canonical((v as Record<string, unknown>)[k])])) : v;
  return JSON.stringify(canonical(root));
}

/**
 * Chain content of a binary answer for comparison across upstreams: the start height and the
 * sequence of block hashes (/gethashes.bin) or block blobs (/getblocks.bin). An answer reaches up to
 * the daemon's tip, so two answers to an identical request are equal when they start at the same
 * height and the shorter sequence is a prefix of the longer one (equal below both tips).
 */
export interface ChainSegment { readonly start: string; readonly items: readonly string[]; readonly status: unknown }

export function chainSegment(route: string, bytes: Uint8Array): ChainSegment | undefined {
  const root = parseEpee(bytes);
  if (root === undefined) return undefined;
  if (route.endsWith("/gethashes.bin")) {
    const ids = root.m_block_ids;
    if (typeof ids !== "string" || ids.length % 64 !== 0) return undefined;
    const items: string[] = [];
    for (let i = 0; i < ids.length; i += 64) items.push(ids.substring(i, i + 64));
    return { start: String(root.start_height), items, status: root.status };
  }
  if (route.endsWith("/getblocks.bin")) {
    const blocks = root.blocks === undefined ? [] : root.blocks; // an answer without new blocks omits the field
    if (!Array.isArray(blocks)) return undefined;
    return { start: String(root.start_height), items: blocks.map((b) => String((b as Record<string, unknown>).block)), status: root.status };
  }
  return undefined;
}

function parseEpee(bytes: Uint8Array): Record<string, unknown> | undefined {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 0;
  const need = (n: number) => { if (pos + n > bytes.length) throw new Error("short"); };
  const varint = (): number => {
    need(1);
    const size = bytes[pos] & 3;
    const len = [1, 2, 4, 8][size];
    need(len);
    let v = 0;
    for (let i = len - 1; i >= 0; i--) v = v * 256 + bytes[pos + i];
    pos += len;
    return Math.floor(v / 4);
  };
  const hex = (n: number): string => { need(n); let h = ""; for (let i = 0; i < n; i++) h += bytes[pos + i].toString(16).padStart(2, "0"); pos += n; return h; };
  const value = (type: number): unknown => {
    switch (type) {
      case 1: need(8); pos += 8; return dv.getBigInt64(pos - 8, true).toString();
      case 2: need(4); pos += 4; return dv.getInt32(pos - 4, true);
      case 3: need(2); pos += 2; return dv.getInt16(pos - 2, true);
      case 4: need(1); pos += 1; return dv.getInt8(pos - 1);
      case 5: need(8); pos += 8; return dv.getBigUint64(pos - 8, true).toString();
      case 6: need(4); pos += 4; return dv.getUint32(pos - 4, true);
      case 7: need(2); pos += 2; return dv.getUint16(pos - 2, true);
      case 8: need(1); pos += 1; return dv.getUint8(pos - 1);
      case 9: need(8); pos += 8; return dv.getFloat64(pos - 8, true);
      case 10: return hex(varint());
      case 11: need(1); pos += 1; return bytes[pos - 1] !== 0;
      case 12: return section();
      default: throw new Error("type");
    }
  };
  const section = (): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    const count = varint();
    for (let i = 0; i < count; i++) {
      need(1);
      const nameLen = bytes[pos++];
      need(nameLen);
      let name = "";
      for (let j = 0; j < nameLen; j++) name += String.fromCharCode(bytes[pos + j]);
      pos += nameLen;
      need(1);
      const type = bytes[pos++];
      if (type & 0x80) {
        const n = varint();
        const arr: unknown[] = [];
        for (let k = 0; k < n; k++) arr.push(value(type & 0x7f));
        out[name] = arr;
      } else out[name] = value(type);
    }
    return out;
  };
  try {
    const sig = [0x01, 0x11, 0x01, 0x01, 0x01, 0x01, 0x02, 0x01, 0x01];
    need(sig.length);
    for (let i = 0; i < sig.length; i++) if (bytes[i] !== sig[i]) return undefined;
    pos = sig.length;
    const root = section();
    if (pos !== bytes.length) return undefined;
    return root;
  } catch (err) {
    return undefined;
  }
}

/** Wrap HttpClient.request of this context to count requests per route, bytes, time and body digests. */
export function installRequestRecorder(digest: Digest): RequestRecorder {
  let state = fresh();
  function fresh() { return { requests: 0, requestBytes: 0, responseBytes: 0, byRoute: {} as Record<string, { count: number; requestBytes: number; responseBytes: number; ms: number }>, digests: [] as Array<{ route: string; request: string; response: string; withoutTip: string | undefined }>, hosts: new Set<string>(), segments: new Map<string, ChainSegment | undefined>() }; }
  const client = HttpClient as unknown as { request: (req: Record<string, unknown>) => Promise<Record<string, unknown>> };
  const original = client.request.bind(HttpClient);
  client.request = async (req: Record<string, unknown>) => {
    const t0 = Date.now();
    const body = req.body;
    const reqBytes = body instanceof Uint8Array ? body : typeof body === "string" ? new TextEncoder().encode(body) : new Uint8Array(0);
    let route = "?";
    let host = "?";
    try { const u = new URL(String(req.uri)); route = u.pathname.replace(/^.*\/(?=[^/]+$)/, "/"); host = u.host; } catch (err) { route = "?"; }
    const method = typeof body === "string" ? (/"method"\s*:\s*"([A-Za-z0-9_]{1,64})"/.exec(body) ?? [])[1] ?? "-" : "-";
    const key = String(req.method) + " " + route + " " + method;
    const resp = await original(req);
    const rb = resp.body instanceof Uint8Array ? resp.body : typeof resp.body === "string" ? new TextEncoder().encode(resp.body) : new Uint8Array(0);
    const r = state.byRoute[key] ?? (state.byRoute[key] = { count: 0, requestBytes: 0, responseBytes: 0, ms: 0 });
    r.count++; r.requestBytes += reqBytes.length; r.responseBytes += rb.length; r.ms += Date.now() - t0;
    state.requests++; state.requestBytes += reqBytes.length; state.responseBytes += rb.length; state.hosts.add(host);
    if (route.endsWith(".bin")) {
      const tipless = epeeWithoutTip(rb);
      const requestDigest = await digest(reqBytes);
      state.digests.push({ route, request: requestDigest, response: await digest(rb), withoutTip: tipless === undefined ? undefined : await digest(new TextEncoder().encode(tipless)) });
      state.segments.set(route + " " + requestDigest, chainSegment(route, rb));
    }
    return resp;
  };
  return {
    reset() { state = fresh(); },
    snapshot() { return { requests: state.requests, requestBytes: state.requestBytes, responseBytes: state.responseBytes, byRoute: JSON.parse(JSON.stringify(state.byRoute)), digests: state.digests.slice(), hosts: Array.from(state.hosts) }; },
    segments() { return state.segments; }
  };
}

/** Every string reachable from an error object (own properties, message, stack, serialization). */
function errorTexts(err: unknown): string[] {
  const out: string[] = [String(err)];
  try { out.push(JSON.stringify(err)); } catch (e) { out.push("unserializable"); }
  if (err !== null && typeof err === "object") {
    for (const name of Object.getOwnPropertyNames(err)) out.push(String((err as Record<string, unknown>)[name]));
    const e = err as { message?: unknown; stack?: unknown; cause?: unknown };
    out.push(String(e.message), String(e.stack), String(e.cause));
  }
  return out;
}

async function bounded<T>(p: Promise<T>, ms: number): Promise<{ settled: boolean; value?: T; error?: unknown; ms: number }> {
  const t0 = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined = undefined;
  const timeout = new Promise<{ settled: boolean; ms: number }>((resolve) => { timer = setTimeout(() => resolve({ settled: false, ms: Date.now() - t0 }), ms); });
  const r = await Promise.race([p.then((value) => ({ settled: true, value, ms: Date.now() - t0 }), (error) => ({ settled: true, error, ms: Date.now() - t0 })), timeout]);
  if (timer !== undefined) clearTimeout(timer);
  return r;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function runNetworkChecks(opts: NetworkOptions): Promise<NetworkReport> {
  const log = opts.log ?? (() => undefined);
  const proxy = opts.proxyToWorker;
  const t = opts.targets;
  const report: NetworkReport = { suite: "network", env: opts.env, proxyToWorker: proxy, startedUtc: new Date().toISOString(), finishedUtc: "", checks: [], syncs: [], measurements: {} };
  const deadline = opts.deadlineMs ?? 600000;
  installGuardLedger();
  let seed: SeedWallet | undefined = opts.seed;
  const segmentStore = new Map<string, Map<string, ChainSegment | undefined>>(); // binary chain content per measured sync (memory only)

  async function check(id: string, title: string, fn: (notes: string[]) => Promise<void>): Promise<void> {
    if (!opts.checks.includes(id)) return;
    const result: CheckResult = { id, title, status: "not-run", notes: [] };
    report.checks.push(result);
    try {
      await withDeadline(fn(result.notes), deadline, id);
      result.status = "pass";
    } catch (err) {
      if (err instanceof CheckNotRun) { // a check without its optional configuration is reported as not run, never as passed
        result.status = "not-run";
        result.notes.push("NOT RUN: " + err.message);
      } else {
        result.status = "fail";
        result.notes.push("FAILED: " + (err instanceof CheckFailure ? err.message : codeOf(err) + diagnosticOf(err)));
      }
    }
    log(id + " " + result.status);
  }

  /** One recorded sync call. */
  async function sync(checkId: string, w: F.ZephyrWallet, target: string, kind: TargetKind, startHeight?: number, below?: number, firstSync = false): Promise<F.ZephyrWalletSyncResult> {
    if (kind === "real" && report.syncs.filter((s) => s.kind === "real").length >= MAX_REAL_SYNCS) throw new CheckFailure("sync budget of the run exhausted");
    const t0 = Date.now();
    try {
      const r = await (startHeight === undefined ? w.sync() : w.sync(startHeight));
      report.syncs.push({ check: checkId, target, kind, outcome: "ok", numBlocksFetched: r.numBlocksFetched, startBelowDaemonHeight: below, firstSync, ms: Date.now() - t0 });
      return r;
    } catch (err) {
      report.syncs.push({ check: checkId, target, kind, outcome: codeOf(err) + diagnosticOf(err), startBelowDaemonHeight: below, firstSync, ms: Date.now() - t0 });
      throw err;
    }
  }

  const openSeed = async (server: string | { uri: string } | undefined): Promise<F.ZephyrWallet> => {
    if (seed === undefined) throw new CheckFailure("no seed wallet available");
    return F.openWalletData({ networkType: 0, password: seed.password, keysData: new Uint8Array(seed.keys), cacheData: new Uint8Array(seed.cache), server, proxyToWorker: proxy });
  };

  /** Balance map shapes for a wallet without funds; returns the wallet map's keys. */
  async function balanceShapes(w: F.ZephyrWallet, notes: string[]): Promise<string[]> {
    const wallet = await w.getBalance();
    const unlocked = await w.getUnlockedBalance();
    expect(wallet instanceof Map && unlocked instanceof Map, "wallet maps are Map instances");
    const keys = Array.from(wallet.keys()).sort();
    expect(keys.length >= 1 && keys.every((k) => /^[A-Z0-9]{1,16}$/.test(k)), "wallet map keys are asset tokens");
    expect(Array.from(wallet.values()).every((v) => typeof v === "bigint" && v === BigInt(0)) && Array.from(unlocked.values()).every((v) => typeof v === "bigint" && v === BigInt(0)), "a wallet without funds has the core's zero entries (bigint 0)");
    expect(Array.from(unlocked.keys()).sort().join(",") === keys.join(","), "unlocked map has the same keys");
    const account = await w.getBalance(0);
    const accountUnlocked = await w.getUnlockedBalance(0);
    expect(account instanceof Map && accountUnlocked instanceof Map && account.size === 0 && accountUnlocked.size === 0, "account map keyed by subaddress: no subaddress entry without outputs (absent stays absent)");
    for (const asset of keys) {
      const v = await w.getBalance(asset, 0);
      const vs = await w.getBalance(asset, 0, 0);
      const u = await w.getUnlockedBalance(asset, 0);
      expect(typeof v === "bigint" && v === BigInt(0) && vs === BigInt(0) && u === BigInt(0), "asset-first scalar for " + asset + " is bigint 0");
    }
    await expectCode(w.getBalance("NOTANASSET", 0), "INVALID_CONFIG", "scalar with an asset type outside the core's list", notes, "ASSET_TYPE");
    await expectCode(w.getBalance("zeph", 0), "INVALID_CONFIG", "scalar with a lower-case asset token", notes, "ASSET_TYPE");
    await expectCode((w.getBalance as unknown as (a: number, b: number) => Promise<unknown>)(0, 0), "UNSUPPORTED_CAPABILITY", "asset-less (account, subaddress) scalar", notes, "BALANCE");
    await expectCode(w.getBalance(-1), "INVALID_CONFIG", "negative account index", notes, "ADDRESS_INDEX_RANGE");
    // accounts and subaddresses of a synced wallet without funds: empty maps (no asset without outputs), nothing used
    const accounts = await w.getAccounts({ includeSubaddresses: true });
    expect(accounts.length >= 1 && accounts.every((a) => a.balance instanceof Map && a.balance.size === 0 && a.unlockedBalance instanceof Map && a.unlockedBalance.size === 0), "account maps by asset are empty for a wallet without funds");
    const subs = accounts.flatMap((a) => Array.from(a.subaddresses ?? []));
    expect(subs.length >= 1 && subs.every((sub) => sub.balance.size === 0 && sub.unlockedBalance.size === 0 && sub.isUsed === false && sub.numUnspentOutputs === 0), "subaddress maps are empty, nothing used, no unspent output");
    await expectCode(w.getBalance(accounts.length), "INVALID_CONFIG", "account map of an account the wallet does not have", notes, "ACCOUNT_NOT_FOUND");
    notes.push("wallet map keys " + keys.join(",") + " (all 0n), account map size " + account.size + ", scalars 0n; " + accounts.length + " account(s), " + subs.length + " subaddress(es) with empty maps");
    return keys;
  }

  // ------------------------------------------------------------------ N01
  await check("N01", "Daemon address contract and request allowlist (no request is made)", async (notes) => {
    const ok: Array<[string, string, string, string]> = [
      ["http://192.0.2.10:17767", "http://192.0.2.10:17767", "http://192.0.2.10:17767", ""],
      ["https://example.org", "https://example.org", "https://example.org:443", ""],
      ["https://example.org/rpc", "https://example.org/rpc", "https://example.org:443", "/rpc"],
      ["https://example.org/rpc/", "https://example.org/rpc", "https://example.org:443", "/rpc"],
      ["HTTP://Example.ORG:8080/a/b", "http://example.org:8080/a/b", "http://example.org:8080", "/a/b"],
      ["http://[::1]:18081", "http://[::1]:18081", "http://[::1]:18081", ""]
    ];
    for (const [input, uri, origin, base] of ok) {
      const r = parseDaemonAddress(input);
      expect(r.uri === uri && r.origin === origin && r.basePath === base && r.trusted === true, "normalized " + uri);
    }
    const bad: Array<[unknown, string, string]> = [
      ["ftp://example.org", "INVALID_CONFIG", "DAEMON_ADDRESS"], ["example.org:1", "INVALID_CONFIG", "DAEMON_ADDRESS"], ["http://", "INVALID_CONFIG", "DAEMON_ADDRESS"],
      ["http://example.org/rpc?x=1", "INVALID_CONFIG", "DAEMON_ADDRESS"], ["http://example.org/#a", "INVALID_CONFIG", "DAEMON_ADDRESS"],
      ["http://example.org/a%20b", "INVALID_CONFIG", "DAEMON_ADDRESS"], ["http://example.org/a/./b", "INVALID_CONFIG", "DAEMON_ADDRESS"],
      ["http://example.org//rpc", "INVALID_CONFIG", "DAEMON_ADDRESS"], [" http://example.org", "INVALID_CONFIG", "DAEMON_ADDRESS"],
      ["http://u:p@example.org", "UNSUPPORTED_CAPABILITY", "DAEMON_CREDENTIALS"], [{ uri: "http://example.org", username: "u" }, "UNSUPPORTED_CAPABILITY", "DAEMON_CREDENTIALS"],
      [{ uri: "http://example.org", proxyUri: "socks5://127.0.0.1:9050" }, "UNSUPPORTED_CAPABILITY", "DAEMON_PROXY"],
      [{ uri: "http://example.org", trusted: false }, "UNSUPPORTED_CAPABILITY", "UNTRUSTED_DAEMON"],
      [{ uri: "http://example.org", rejectUnauthorized: false }, "UNSUPPORTED_CAPABILITY", "CONFIG_FIELD"],
      [{ uri: "http://example.org", other: 1 }, "INVALID_CONFIG", "UNKNOWN_FIELD"], [42, "INVALID_CONFIG", "FIELD_TYPE"]
    ];
    for (const [input, code, diagnostic] of bad) {
      let got = "accepted";
      try { parseDaemonAddress(input); } catch (err) { got = codeOf(err) + diagnosticOf(err); }
      expect(got === code + "/" + diagnostic, "rejected " + code + "/" + diagnostic + ", got " + got);
    }
    notes.push(ok.length + " address forms normalized, " + bad.length + " rejected with fixed codes");
    // the request allowlist of this context: nothing configured, so any request is blocked before a connection
    const before = HttpClient.BLOCKED_REQUESTS;
    let blocked = "sent";
    try { await HttpClient.request({ method: "POST", uri: "http://127.0.0.1:9/json_rpc", body: "{\"method\":\"get_info\"}" }); } catch (err) { blocked = codeOf(err) + diagnosticOf(err); }
    expect(blocked === "UNSUPPORTED_CAPABILITY/NETWORK_REQUEST" && HttpClient.BLOCKED_REQUESTS === before + 1, "a request to an unconfigured route is blocked and counted");
    HttpClient.addDaemonRoute(parseDaemonAddress("http://127.0.0.1:9/rpc"));
    let other = "sent";
    try { await HttpClient.request({ method: "POST", uri: "http://127.0.0.1:9/json_rpc", body: "{}" }); } catch (err) { other = codeOf(err) + diagnosticOf(err); }
    HttpClient.removeDaemonRoute(parseDaemonAddress("http://127.0.0.1:9/rpc"));
    expect(other === "UNSUPPORTED_CAPABILITY/NETWORK_REQUEST", "a path outside the route's base path is blocked");
    expect(HttpClient.daemonRouteCount() === 0, "no route left configured");
    HttpClient.BLOCKED_REQUESTS = before; delete HttpClient.BLOCKED_REQUEST_SUMMARY["POST get_info"]; delete HttpClient.BLOCKED_REQUEST_SUMMARY["POST -"]; // keep the run's guard counts for the SDK's own traffic
    notes.push("allowlist: unconfigured route and path outside the base path blocked before any connection");
  });

  // ------------------------------------------------------------------ N02 / N03: measured fresh syncs
  async function measuredFresh(checkId: string, target: string, label: string, notes: string[], save: boolean): Promise<void> {
    const password = randomPassword();
    const helper = await F.createRandomWallet({ networkType: 0, password, server: target, proxyToWorker: proxy });
    const seedText = await helper.getSeed();
    const daemonHeight = await helper.getDaemonHeight();
    await helper.close();
    const restoreHeight = daemonHeight - FRESH_SYNC_BLOCKS;
    expect(restoreHeight > 0, "daemon height above the sync window");
    if (opts.recorder) opts.recorder.reset();
    const w = await F.restoreWalletFromSeed({ networkType: 0, password, seed: seedText, restoreHeight, server: target, proxyToWorker: proxy });
    expect(w.getDaemonConnection()?.trusted === true && (await w.isConnectedToDaemon()) === true, "connected; trust reported as true");
    const t0 = Date.now();
    const r = await sync(checkId, w, label, "real", undefined, FRESH_SYNC_BLOCKS, true);
    const ms = Date.now() - t0;
    const height = await w.getHeight();
    const dh = await w.getDaemonHeight();
    expect(height >= daemonHeight && height <= dh && dh - height <= 1, "wallet height reached the daemon height (" + height + " / " + dh + ")");
    expect(r.numBlocksFetched >= FRESH_SYNC_BLOCKS && r.receivedMoney === false, "fetched at least the sync window, no money received");
    const keys = await balanceShapes(w, notes);
    const rec = opts.recorder ? opts.recorder.snapshot() : undefined;
    if (opts.recorder) segmentStore.set(checkId, new Map(opts.recorder.segments()));
    report.measurements[checkId] = { target: label, startHeight: restoreHeight, daemonHeightBefore: daemonHeight, walletHeightAfter: height, numBlocksFetched: r.numBlocksFetched, syncMs: ms, assetKeys: keys, requests: rec };
    notes.push(label + ": restore height daemon-" + FRESH_SYNC_BLOCKS + ", " + r.numBlocksFetched + " blocks fetched in " + ms + " ms" + (rec ? ", " + rec.requests + " requests, " + rec.requestBytes + " request bytes, " + rec.responseBytes + " response bytes" : ""));
    if (save && opts.saveSeed) {
      const d = await w.getData();
      seed = { keys: d.keys, cache: d.cache, password };
      await opts.saveSeed(seed);
      notes.push("seed wallet saved for the later runs (scratch only)");
    }
    await w.close();
  }

  /**
   * Measured sync of the saved seed wallet bytes. They already hold the block hashes, so this sync
   * fetches only the blocks above the saved height (no hash download).
   */
  async function measuredSeed(checkId: string, target: string, label: string, notes: string[]): Promise<void> {
    const w = await openSeed(target);
    expect(w.getDaemonConnection()?.trusted === true && (await w.isConnectedToDaemon()) === true, "connected; trust reported as true");
    const startHeight = await w.getHeight();
    const daemonHeight = await w.getDaemonHeight();
    expect(daemonHeight >= startHeight && daemonHeight - startHeight <= FRESH_SYNC_BLOCKS, "the saved wallet is at most " + FRESH_SYNC_BLOCKS + " blocks below the daemon height (" + startHeight + " / " + daemonHeight + ")");
    const t0 = Date.now();
    const r = await sync(checkId, w, label, "real", undefined, daemonHeight - startHeight);
    const ms = Date.now() - t0;
    const height = await w.getHeight();
    const dh = await w.getDaemonHeight();
    expect(height >= daemonHeight && height <= dh && dh - height <= 1, "wallet height reached the daemon height (" + height + " / " + dh + ")");
    expect(r.numBlocksFetched <= dh - startHeight + 1 && r.receivedMoney === false, "fetched only the blocks above the saved height, no money received");
    const keys = await balanceShapes(w, notes);
    report.measurements[checkId] = { target: label, savedWalletBytes: true, startHeight, daemonHeightBefore: daemonHeight, walletHeightAfter: height, numBlocksFetched: r.numBlocksFetched, syncMs: ms, assetKeys: keys };
    notes.push(label + ": saved wallet bytes at height " + startHeight + ", " + r.numBlocksFetched + " blocks fetched in " + ms + " ms");
    await w.close();
  }

  await check("N02", "Measured sync from at most 2,000 blocks below the daemon height (permitted endpoint), heights, balance shapes: a fresh restore in Node.js, which is saved for the later runs; the saved wallet bytes in the browser", async (notes) => {
    const target = opts.env === "chromium-worker" ? t.base : t.direct;
    if (target === undefined) throw new CheckFailure("no target");
    if (opts.env === "chromium-worker") await measuredSeed("N02", target, "forwarder base path to the configured daemon", notes);
    else await measuredFresh("N02", target, "configured daemon, direct", notes, true);
  });

  await check("N03", "Measured sync through the load-balanced node over HTTPS; answers to identical binary requests carry the same chain content below both tips", async (notes) => {
    if (t.lb === undefined) throw new CheckNotRun("ZEPHYR_TS_TEST_DAEMON_HTTPS is not configured");
    type D = { route: string; request: string; response: string; withoutTip: string | undefined };
    const directDigests = ((report.measurements.N02 as { requests?: { digests: D[] } } | undefined)?.requests?.digests) ?? [];
    await measuredFresh("N03", t.lb, "configured daemon over HTTPS", notes, false);
    const lbDigests = ((report.measurements.N03 as { requests?: { digests: D[] } }).requests?.digests) ?? [];
    const byRequest = new Map<string, D>();
    for (const d of directDigests) byRequest.set(d.route + " " + d.request, d);
    const directSegments = segmentStore.get("N02") ?? new Map<string, ChainSegment | undefined>();
    const lbSegments = segmentStore.get("N03") ?? new Map<string, ChainSegment | undefined>();
    let identical = 0, rawEqual = 0, equalWithoutTip = 0, belowTips = 0, unparsed = 0, unmatched = 0;
    const differ: Record<string, number> = {};
    let comparedItems = 0;
    for (const d of lbDigests) {
      const key = d.route + " " + d.request;
      const other = byRequest.get(key);
      if (other === undefined) { unmatched++; continue; }
      identical++;
      if (other.response === d.response) rawEqual++;
      if (d.withoutTip !== undefined && d.withoutTip === other.withoutTip) equalWithoutTip++;
      const a = directSegments.get(key), b = lbSegments.get(key);
      if (a === undefined || b === undefined) { unparsed++; continue; }
      const n = Math.min(a.items.length, b.items.length);
      let same = a.start === b.start && a.status === b.status && n > 0;
      for (let k = 0; same && k < n; k++) if (a.items[k] !== b.items[k]) same = false;
      if (same) { belowTips++; comparedItems += n; } else differ[d.route] = (differ[d.route] ?? 0) + 1;
    }
    report.measurements.binaryEquality = { identicalRequests: identical, rawEqualResponses: rawEqual, equalWithoutTipFields: equalWithoutTip, tipFields: TIP_FIELDS,
      equalBelowBothTips: belowTips, comparedItems, differentBelowTips: differ, unparsed, unmatchedRequests: unmatched };
    notes.push("binary requests identical in both syncs: " + identical + "; byte-equal answers " + rawEqual + "; equal apart from " + TIP_FIELDS.join("/") + " " + equalWithoutTip
      + "; equal below both tips (same start, chain content a prefix) " + belowTips + " over " + comparedItems + " hashes and blocks; different " + JSON.stringify(differ) + "; unparsed " + unparsed + "; unmatched " + unmatched);
    expect(identical > 0 && unparsed === 0, "the two syncs share identical binary requests and every answer parses");
    expect(belowTips === identical, "every answer to an identical request carries the same chain content below both tips");
  });

  // ------------------------------------------------------------------ N04 / N05 / N06: address forms with a reopened seed wallet
  async function formSync(checkId: string, server: string, label: string, notes: string[]): Promise<void> {
    const w = await openSeed(server);
    expect((await w.isConnectedToDaemon()) === true, label + ": connected");
    const dh = await w.getDaemonHeight();
    const h0 = await w.getHeight();
    expect(dh - h0 <= FRESH_SYNC_BLOCKS, label + ": the reopened wallet starts within the sync window");
    const r = await sync(checkId, w, label, "real", undefined, dh - h0);
    const h1 = await w.getHeight();
    expect(h1 >= h0 && (await w.getDaemonHeight()) - h1 <= 1, label + ": synced to the daemon height");
    const daemonSynced = await w.isDaemonSynced();
    expect(typeof daemonSynced === "boolean", label + ": isDaemonSynced answers a boolean");
    if (proxy) {
      const ok = await readGuardInto(channelOf(w), { reports: 0, unreported: 0, blockedRequests: 0, allowedRequests: 0, blockedSummary: {}, allowedSummary: {} });
      expect(ok, label + ": the wallet worker reports its guard counts");
    }
    const keys = await balanceShapes(w, notes);
    report.measurements[checkId] = { target: label, startHeight: h0, endHeight: h1, numBlocksFetched: r.numBlocksFetched, assetKeys: keys, daemonSynced };
    notes.push(label + ": " + r.numBlocksFetched + " blocks from height " + h0 + "; isDaemonSynced " + daemonSynced);
    await w.close();
  }
  await check("N04", "Form 2: base path through the forwarder (/rpc/json_rpc, /rpc/getblocks.bin)", async (notes) => {
    if (t.base === undefined) throw new CheckFailure("no target");
    await formSync("N04", t.base, "base path", notes);
  });
  await check("N05", "Form 1: host and port without a path (the daemon or the page's own origin)", async (notes) => {
    const target = opts.env === "chromium-worker" ? t.root : t.direct;
    if (target === undefined) throw new CheckFailure("no target");
    await formSync("N05", target, opts.env === "chromium-worker" ? "same origin, no path" : "configured daemon, direct", notes);
  });
  await check("N06", "Form 3: a separate origin whose CORS headers allow the page", async (notes) => {
    if (t.allow === undefined) throw new CheckFailure("no target");
    await formSync("N06", t.allow, "separate origin with CORS", notes);
  });

  // ------------------------------------------------------------------ N07: CORS blocked / N08 unreachable / N09 silent
  async function unreachable(checkId: string, server: string, label: string, kind: TargetKind, boundMs: number, notes: string[], expected: string): Promise<void> {
    const w = await openSeed(undefined);
    const set = await bounded(w.setDaemonConnection(server), boundMs);
    expect(set.settled && set.error === undefined, label + ": setDaemonConnection resolves (" + set.ms + " ms)");
    const c = await bounded(w.isConnectedToDaemon(), boundMs);
    expect(c.settled && c.value === false, label + ": isConnectedToDaemon false (" + c.ms + " ms)");
    const h = await bounded(w.getDaemonHeight(), boundMs);
    expect(h.settled && h.error instanceof F.ZephyrWalletError && codeOf(h.error) + diagnosticOf(h.error) === expected, label + ": getDaemonHeight -> " + (h.settled ? codeOf(h.error) + diagnosticOf(h.error) : "pending") + " (" + h.ms + " ms)");
    const ds = await bounded(w.isDaemonSynced(), boundMs);
    expect(ds.settled && ds.error instanceof F.ZephyrWalletError && codeOf(ds.error) + diagnosticOf(ds.error) === expected, label + ": isDaemonSynced -> " + (ds.settled ? codeOf(ds.error) + diagnosticOf(ds.error) : "pending") + " (" + ds.ms + " ms)");
    const t0 = Date.now();
    const s = await bounded(sync(checkId, w, label, kind), boundMs);
    expect(s.settled && s.error instanceof F.ZephyrWalletError && codeOf(s.error) + diagnosticOf(s.error) === expected, label + ": sync -> " + (s.settled ? codeOf(s.error) + diagnosticOf(s.error) : "pending") + " (" + (Date.now() - t0) + " ms)");
    notes.push(label + ": set " + set.ms + " ms, connected false in " + c.ms + " ms, height, daemon sync state and sync " + expected + " in " + h.ms + " / " + ds.ms + " / " + s.ms + " ms");
    report.measurements[checkId] = { target: label, setMs: set.ms, connectedMs: c.ms, heightMs: h.ms, syncMs: s.ms, diagnostic: expected };
    await w.close();
  }
  await check("N07", "Form 3 without CORS headers: the SDK rejects with a fixed connection diagnostic in bounded time", async (notes) => {
    if (t.deny === undefined) throw new CheckFailure("no target");
    await unreachable("N07", t.deny, "separate origin without CORS", "unreachable", 15000, notes, "DAEMON_ERROR/DAEMON_NOT_CONNECTED");
  });
  await check("N08", "Unreachable daemon (closed loopback port): fixed diagnostic in bounded time", async (notes) => {
    if (t.closed === undefined) throw new CheckFailure("no target");
    await unreachable("N08", t.closed, "closed loopback port", "unreachable", 15000, notes, "DAEMON_ERROR/DAEMON_NOT_CONNECTED");
  });
  await check("N09", "Silent daemon (accepts, never answers): the connection check ends within its bound", async (notes) => {
    if (t.silent === undefined) throw new CheckFailure("no target");
    const w = await openSeed(undefined);
    const set = await bounded(w.setDaemonConnection(t.silent), 45000);
    expect(set.settled && set.error === undefined, "setDaemonConnection resolves after the core's connection check (" + set.ms + " ms)");
    expect(set.ms <= 40000, "bounded by the core's 30 s connection timeout");
    const c = await bounded(w.isConnectedToDaemon(), 45000);
    expect(c.settled && c.value === false && c.ms <= 40000, "isConnectedToDaemon false within the bound (" + c.ms + " ms)");
    notes.push("silent port: set " + set.ms + " ms, connected false in " + c.ms + " ms");
    report.measurements.N09 = { setMs: set.ms, connectedMs: c.ms };
    await w.close();
  });

  // ------------------------------------------------------------------ N10: node text never reaches an error
  await check("N10", "Text supplied by a node (error status, malformed body, node status) never reaches an SDK error", async (notes) => {
    const cases: Array<[string, string | undefined]> = [["error status", t.fakeStatus], ["malformed body", t.fakeMalformed], ["node status text", t.fakeNodeStatus]];
    let scanned = 0;
    const inspect = (label: string, err: unknown): void => {
      expect(err instanceof F.ZephyrWalletError, label + ": a wallet error");
      const texts = errorTexts(err);
      scanned += texts.length;
      expect(!texts.some((x) => x.includes(opts.marker)), label + ": no node-supplied text in the error");
      expect(codeOf(err) + diagnosticOf(err) === "DAEMON_ERROR/DAEMON_RESPONSE" && (err as F.ZephyrWalletError).message === "Daemon request failed", label + ": DAEMON_ERROR/DAEMON_RESPONSE with the fixed message, got " + codeOf(err) + diagnosticOf(err));
      notes.push(label + " -> " + codeOf(err) + diagnosticOf(err));
    };
    const wallets: Array<[string, F.ZephyrWallet]> = [];
    for (const [label, target] of cases) {
      if (target === undefined) throw new CheckFailure("no target " + label);
      const w = await openSeed(target);
      wallets.push([label, w]);
      expect((await w.isConnectedToDaemon()) === true, label + ": the fake daemon answers get_version (connected)");
      let err: unknown = undefined;
      try { await sync("N10", w, "fake " + label, "fake"); } catch (e) { err = e; }
      if (err === undefined) throw new CheckFailure(label + ": sync resolved against a failing fake daemon");
      inspect(label + " sync", err);
    }
    // the core caches heights from get_version for 30 s; afterwards getDaemonHeight asks get_info, whose failure carries the marker
    await sleep(31000);
    for (const [label, w] of wallets) {
      let err: unknown = undefined;
      try { await w.getDaemonHeight(); } catch (e) { err = e; }
      if (err === undefined) throw new CheckFailure(label + ": getDaemonHeight resolved against a failing fake daemon");
      inspect(label + " getDaemonHeight", err);
      let syncedErr: unknown = undefined;
      try { await w.isDaemonSynced(); } catch (e) { syncedErr = e; }
      if (syncedErr === undefined) throw new CheckFailure(label + ": isDaemonSynced resolved against a failing fake daemon");
      inspect(label + " isDaemonSynced", syncedErr);
      await w.close();
    }
    expect(scanned > 0, "errors were produced and scanned");
  });

  // ------------------------------------------------------------------ N11: close during an active sync
  await check("N11", "Close issued during an active sync waits for the sync, then closes", async (notes) => {
    if (t.slow === undefined) throw new CheckFailure("no target");
    const w = await openSeed(t.slow);
    const channel = proxy ? channelOf(w) : undefined;
    let syncSettled = -1;
    let closeSettled = -1;
    const t0 = Date.now();
    const s = sync("N11", w, "slow forwarder mount", "real").then((r) => { syncSettled = Date.now() - t0; return "ok " + r.numBlocksFetched; }, (err) => { syncSettled = Date.now() - t0; return codeOf(err) + diagnosticOf(err); });
    await sleep(400);
    expect(syncSettled < 0, "the sync is still running when close is issued");
    const closeIssued = Date.now() - t0;
    const c = w.close().then(() => { closeSettled = Date.now() - t0; return "resolved"; }, (err) => { closeSettled = Date.now() - t0; return codeOf(err); });
    await expectCode(w.getHeight(), "WALLET_CLOSED", "a call issued after close", notes);
    const [so, co] = await Promise.all([s, c]);
    expect(co === "resolved" && closeSettled >= syncSettled, "close resolved after the sync settled (sync " + syncSettled + " ms, close " + closeSettled + " ms)");
    expect(so.startsWith("ok"), "the running sync completed with its own result: " + so);
    if (channel) expect(!channel.isOpen(), "the wallet's worker ended after close");
    else expect(HttpClient.daemonRouteCount() === 0, "the direct wallet's route was released");
    notes.push("close issued at " + closeIssued + " ms during the sync; sync " + so + " at " + syncSettled + " ms; close resolved at " + closeSettled + " ms");
  });

  // ------------------------------------------------------------------ N12 / N13: worker end during a sync (worker mode)
  async function endDuringSync(checkId: string, how: "shutdown" | "death", notes: string[]): Promise<void> {
    if (t.slow === undefined) throw new CheckFailure("no target");
    const w = await openSeed(t.slow);
    const other = how === "death" ? await openSeed(undefined) : undefined;
    const channel = channelOf(w);
    const settled: Record<string, number> = { sync: 0, height: 0, connected: 0, balance: 0 };
    const outcome: Record<string, string> = {};
    const track = (name: string, p: Promise<unknown>) => p.then(() => { settled[name]++; outcome[name] = "resolved"; }, (err) => { settled[name]++; outcome[name] = codeOf(err) + diagnosticOf(err); });
    const pending = [track("sync", sync(checkId, w, "slow forwarder mount", "real")), track("height", w.getHeight()), track("connected", w.isConnectedToDaemon()), track("balance", w.getBalance())];
    await sleep(400);
    expect(Object.values(settled).every((n) => n === 0), "all calls pending when the worker ends");
    if (how === "shutdown") await F.terminateWorker();
    else channel.worker.terminate(); // behind the SDK's back: an unexpected worker exit
    const all = await bounded(Promise.all(pending), 15000);
    expect(all.settled, "every pending call settled within 15 s");
    await sleep(200);
    const expected = how === "shutdown" ? "WALLET_CLOSED" : "NATIVE_ERROR/WORKER_FAILED";
    expect(Object.values(settled).every((n) => n === 1), "each pending call settled exactly once: " + JSON.stringify(settled));
    expect(Object.values(outcome).every((o) => o === expected), "every pending call rejected " + expected + ": " + JSON.stringify(outcome));
    const later = await bounded(w.getHeight(), 5000);
    expect(later.settled && later.error !== undefined && (codeOf(later.error) + diagnosticOf(later.error)).startsWith(how === "shutdown" ? "WALLET_CLOSED" : "NATIVE_ERROR/WORKER_FAILED"), "a later call rejects");
    const c = await bounded(w.close(), 5000);
    expect(c.settled && c.error === undefined, "close resolves after the worker ended");
    if (other) {
      expect(typeof (await other.getHeight()) === "number", "another wallet is unaffected");
      await other.close();
    }
    notes.push(how + " during the sync: " + JSON.stringify(outcome) + "; close resolved");
  }
  await check("N12", "Context shutdown during a sync settles every pending call exactly once", async (notes) => { await endDuringSync("N12", "shutdown", notes); });
  await check("N13", "Worker death during a sync settles every pending call exactly once; close resolves", async (notes) => { await endDuringSync("N13", "death", notes); });

  // ------------------------------------------------------------------ N18: forced stop during a stalled sync
  await check("N18", "terminate during a sync stalled by a slow daemon returns at once: the running sync and the queued call reject WALLET_CLOSED/WALLET_TERMINATED exactly once, later calls too, close resolves; another live wallet keeps working (direct: TERMINATE)", async (notes) => {
    const TERMINATED = "WALLET_CLOSED/WALLET_TERMINATED";
    if (!proxy) {
      const d = await openSeed(undefined);
      await expectCode(d.terminate(), "UNSUPPORTED_CAPABILITY", "terminate in direct mode", notes, "TERMINATE");
      await d.close();
      return;
    }
    if (t.slow === undefined) throw new CheckFailure("no target");
    const other = await openSeed(undefined);
    const otherHeight = await other.getHeight();
    const before = LibraryUtils.getWorkerAccounting();
    const w = await openSeed(t.slow);
    const channel = channelOf(w);
    const settled: Record<string, number> = { sync: 0, height: 0 };
    const outcome: Record<string, string> = {};
    const track = (name: string, p: Promise<unknown>) => p.then(() => { settled[name]++; outcome[name] = "resolved"; }, (err) => { settled[name]++; outcome[name] = codeOf(err) + diagnosticOf(err); });
    const pending = [track("sync", sync("N18", w, "slow forwarder mount", "real")), track("height", w.getHeight())];
    await sleep(400);
    expect(await readGuardInto(channel), "the wallet's worker reports its guard counts during the stalled sync"); // its requests so far, for the run's guard totals
    expect(settled.sync === 0 && settled.height === 0, "the sync is running and the height call queued when terminate is called");
    const t0 = Date.now();
    await w.terminate();
    const terminateMs = Date.now() - t0;
    const all = await bounded(Promise.all(pending), 5000);
    await sleep(100);
    expect(all.settled && settled.sync === 1 && settled.height === 1, "both pending calls settled exactly once: " + JSON.stringify(settled));
    expect(outcome.sync === TERMINATED && outcome.height === TERMINATED, "the running sync and the queued call rejected " + TERMINATED + ": " + JSON.stringify(outcome));
    expect(terminateMs < 1000, "terminate returned in " + terminateMs + " ms while each binary answer is delayed by the slow daemon");
    expect(!channel.isOpen(), "the wallet's worker ended");
    const later = await bounded(w.isDaemonSynced(), 2000);
    expect(later.settled && codeOf(later.error) + diagnosticOf(later.error) === TERMINATED, "a later call rejects " + TERMINATED);
    const c = await bounded(w.close(), 2000);
    expect(c.settled && c.error === undefined && w.isClosed(), "close resolves at once (" + c.ms + " ms)");
    const after = LibraryUtils.getWorkerAccounting();
    expect(after.walletWorkers === before.walletWorkers && after.pendingRequests === before.pendingRequests && after.registeredCallbacks === before.registeredCallbacks && after.activeConstructions === 0, "no worker, request, callback or slot of the stopped wallet remains");
    expect((await other.getHeight()) === otherHeight && channelOf(other).isOpen(), "another live wallet keeps working");
    report.measurements.N18 = { terminateMs, closeAfterTerminateMs: c.ms };
    notes.push("terminate " + terminateMs + " ms after a 400 ms head start of the sync; sync and queued getHeight -> " + outcome.sync + "; close afterwards " + c.ms + " ms; the other wallet answered");
    await other.close();
  });

  // ------------------------------------------------------------------ N14: connection changes on a live wallet
  await check("N14", "setDaemonConnection on a live wallet: change, report, clear (JSON requests only)", async (notes) => {
    const target = opts.env === "chromium-worker" ? t.root : t.base;
    if (target === undefined || t.closed === undefined) throw new CheckFailure("no target");
    const w = await openSeed(undefined);
    expect(w.getDaemonConnection() === undefined && (await w.isConnectedToDaemon()) === false, "opened without a daemon: not connected");
    await expectCode(w.getDaemonHeight(), "DAEMON_ERROR", "height without a daemon", notes, "DAEMON_NOT_CONNECTED");
    await w.setDaemonConnection(t.closed);
    expect((await w.isConnectedToDaemon()) === false, "closed port: not connected");
    await w.setDaemonConnection({ uri: target, trusted: true });
    const reported = w.getDaemonConnection();
    expect(reported !== undefined && reported.trusted === true && reported.uri === parseDaemonAddress(target).uri, "the new connection is reported (normalized, trusted true)");
    expect((await w.isConnectedToDaemon()) === true && (await w.getDaemonHeight()) > 0, "connected after the change");
    await w.setDaemonConnection(undefined);
    expect(w.getDaemonConnection() === undefined && (await w.isConnectedToDaemon()) === false, "cleared: not connected");
    await expectCode(w.setDaemonConnection("ftp://x"), "INVALID_CONFIG", "invalid address on a live wallet", notes, "DAEMON_ADDRESS");
    await expectCode(w.setDaemonConnection({ uri: target, trusted: false }), "UNSUPPORTED_CAPABILITY", "untrusted on a live wallet", notes, "UNTRUSTED_DAEMON");
    await w.close();
    if (!proxy) expect(HttpClient.daemonRouteCount() === 0, "no route left after close");
    notes.push("closed port -> base path or same origin -> cleared; invalid and untrusted rejected");
  });

  // ------------------------------------------------------------------ N15 / N16: restore height of a new random wallet
  await check("N15", "A new random wallet with a reachable daemon starts at the daemon height (no sync)", async (notes) => {
    const target = opts.env === "chromium-worker" ? t.base : t.direct;
    if (target === undefined) throw new CheckFailure("no target");
    const w = await F.createRandomWallet({ networkType: 0, password: randomPassword(), server: target, proxyToWorker: proxy });
    const restore = await w.getRestoreHeight();
    const dh = await w.getDaemonHeight();
    expect(restore <= dh && dh - restore <= 3, "restore height " + restore + " equals the daemon height " + dh + " at creation (at most 3 newer blocks)");
    report.measurements.N15 = { restoreHeight: restore, daemonHeight: dh };
    notes.push("restore height " + restore + " = daemon height " + dh);
    await w.close();
  });
  await check("N17", "The first sync of a new random wallet fetches no block below its restore height (Node.js direct; downloads the block hashes)", async (notes) => {
    if (opts.env !== "node-direct") throw new CheckFailure("Node.js direct only: the check reads this context's binary answers");
    const target = t.direct;
    if (target === undefined) throw new CheckFailure("no target");
    if (opts.recorder) opts.recorder.reset();
    const w = await F.createRandomWallet({ networkType: 0, password: randomPassword(), server: target, proxyToWorker: proxy });
    const restore = await w.getRestoreHeight();
    const dh = await w.getDaemonHeight();
    expect(restore <= dh && dh - restore <= 3, "restore height " + restore + " equals the daemon height " + dh + " at creation (at most 3 newer blocks)");
    const measurement: Record<string, unknown> = { restoreHeight: restore, daemonHeight: dh };
    {
      // one real sync of the new wallet (direct mode, so this context's recorder sees every binary answer)
      const r = await sync("N17", w, "new random wallet", "real", undefined, dh - restore, true);
      const h = await w.getHeight();
      const dh2 = await w.getDaemonHeight();
      expect(h >= restore && dh2 - h <= 1, "synced to the daemon height");
      expect(r.numBlocksFetched <= dh2 - restore + 1, r.numBlocksFetched + " blocks fetched, none below the restore height " + restore);
      // every block answer is decoded: an answer that carries blocks must start at or above the last block before the
      // restore height; an answer without blocks (the daemon has nothing newer) reports no start height of its own
      const answers: Array<{ start: number; blocks: number }> = [];
      if (opts.recorder) for (const [key, segment] of opts.recorder.segments()) if (key.startsWith("/getblocks.bin") && segment !== undefined) answers.push({ start: Number(segment.start), blocks: segment.items.length });
      const blockRequests = opts.recorder ? Object.entries(opts.recorder.snapshot().byRoute).filter(([k]) => k.includes("/getblocks.bin")).reduce((n, [, v]) => n + v.count, 0) : 0;
      expect(opts.recorder === undefined || (answers.length > 0 && answers.length === blockRequests && answers.every((a) => a.blocks === 0 || a.start >= restore - 1)), "every one of " + blockRequests + " block answers is empty or starts at or above the last block before the restore height (" + JSON.stringify(answers) + ")");
      Object.assign(measurement, { numBlocksFetched: r.numBlocksFetched, blockAnswers: answers, endHeight: h });
      notes.push("restore height " + restore + " = daemon height " + dh + "; first sync " + r.numBlocksFetched + " blocks; block answers " + JSON.stringify(answers));
    }
    report.measurements.N17 = measurement;
    await w.close();
  });
  await check("N16", "A new random wallet without a daemon, or with an unreachable one, keeps the core's date-based estimate", async (notes) => {
    const reference = opts.env === "chromium-worker" ? t.base : t.direct;
    if (t.closed === undefined || reference === undefined) throw new CheckFailure("no target");
    const offline = await F.createRandomWallet({ networkType: 0, password: randomPassword(), proxyToWorker: proxy });
    const estimate = await offline.getRestoreHeight();
    await offline.close();
    const unreachableWallet = await F.createRandomWallet({ networkType: 0, password: randomPassword(), server: t.closed, proxyToWorker: proxy });
    expect((await unreachableWallet.isConnectedToDaemon()) === false, "the closed port is not connected");
    const estimate2 = await unreachableWallet.getRestoreHeight();
    await unreachableWallet.close();
    expect(Math.abs(estimate2 - estimate) <= 1, "unreachable daemon: the estimate stays (" + estimate2 + " vs " + estimate + ")");
    const probe = await F.createRandomWallet({ networkType: 0, password: randomPassword(), server: reference, proxyToWorker: proxy });
    const dh = await probe.getDaemonHeight();
    await probe.close();
    expect(estimate > 0 && estimate < dh, "the estimate " + estimate + " lies below the daemon height " + dh);
    report.measurements.N16 = { estimate, estimateUnreachable: estimate2, daemonHeight: dh, blocksBelowDaemon: dh - estimate };
    notes.push("estimate " + estimate + " (unreachable daemon " + estimate2 + "), " + (dh - estimate) + " blocks below the daemon height " + dh);
  });

  const entryGuard = await Internal.getNetworkGuardReport();
  report.networkGuard = combinedGuard(entryGuard, GUARD_LEDGER);
  report.workerAccounting = LibraryUtils.getWorkerAccounting();
  report.finishedUtc = new Date().toISOString();
  return report;
}
