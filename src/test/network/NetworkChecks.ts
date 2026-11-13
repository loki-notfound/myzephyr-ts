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
import http from "http";
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

/**
 * Inputs of the funded history check N20, supplied from outside the public tree (never part of it):
 * the bytes of a copy of a funded test wallet and the expectations it is compared with. Without them
 * N20 is reported as not run.
 */
export interface FundedInputs {
  readonly wallet: SeedWallet;
  readonly expect: FundedExpectations;
  /** where the synced bytes are written for a later two-way comparison (optional; memory only otherwise) */
  readonly saveSynced?: (seed: SeedWallet) => Promise<void>;
}

/** Expected history of the funded wallet: every transfer by hash, and the totals per asset and account. */
export interface FundedExpectations {
  readonly transfers: ReadonlyArray<{ readonly hash: string; readonly height: number; readonly direction: "incoming" | "outgoing"; readonly asset: string; readonly amount: string; readonly accountIndex: number; readonly subaddressIndex: number }>;
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
  /** the funded history check's inputs (N20, N22); absent: they are not run */
  readonly funded?: FundedInputs;
  /** where N22 writes the bytes it synced (for N23 in a run with the test module) */
  readonly saveBuildSynced?: (seed: SeedWallet) => Promise<void>;
  /** the wallet N23 opens without a sync (the bytes N22 synced); absent: N23 is not run */
  readonly fundedSynced?: SeedWallet;
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

  async function check(id: string, title: string, fn: (notes: string[]) => Promise<void>, deadlineMs = deadline): Promise<void> {
    if (!opts.checks.includes(id)) return;
    const result: CheckResult = { id, title, status: "not-run", notes: [] };
    report.checks.push(result);
    try {
      await withDeadline(fn(result.notes), deadlineMs, id);
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

  // ------------------------------------------------------------------ N19: history sends no request
  /** Requests seen by the loopback forwarder (all listeners) and by the SDK's request allowlist of the wallet's context. */
  async function requestCounts(w: F.ZephyrWallet): Promise<{ forwarder: number; upstream: number; allowlist: number }> {
    const root = t.root as string;
    type Stats = { routes: Record<string, { count: number }>; denied: Record<string, number>; upstreamRequests: number };
    // the page reads its own origin with fetch; Node.js (whose monitor blocks fetch) uses a plain loopback request
    const st: Stats = typeof window !== "undefined" || typeof (globalThis as { importScripts?: unknown }).importScripts === "function"
      ? await (await fetch(root + "/__stats", { cache: "no-store" })).json() as Stats
      : await new Promise<Stats>((resolve, reject) => {
        http.get(root + "/__stats", (res) => { const chunks: Buffer[] = []; res.on("data", (c: Buffer) => chunks.push(c)); res.on("end", () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Stats); } catch (e) { reject(e); } }); }).on("error", reject);
      });
    const forwarder = Object.values(st.routes).reduce((n, r) => n + r.count, 0) + Object.values(st.denied).reduce((n, c) => n + c, 0);
    let allowlist: number;
    if (proxy) {
      const ledger = { reports: 0, unreported: 0, blockedRequests: 0, allowedRequests: 0, blockedSummary: {}, allowedSummary: {} };
      expect(await readGuardInto(channelOf(w), ledger), "the wallet worker reports its guard counts");
      allowlist = ledger.allowedRequests + ledger.blockedRequests;
    } else {
      allowlist = HttpClient.ALLOWED_REQUESTS + HttpClient.BLOCKED_REQUESTS;
    }
    return { forwarder, upstream: st.upstreamRequests, allowlist };
  }

  await check("N19", "History reads what the last sync stored: getTxs, getTransfers and getTx send no request (loopback forwarder and request allowlist count none)", async (notes) => {
    if (t.base === undefined || t.root === undefined) throw new CheckFailure("no target");
    const w = await openSeed(t.base);
    expect((await w.isConnectedToDaemon()) === true, "connected through the forwarder");
    const before = await requestCounts(w);
    const hash = "ab".repeat(32);
    let listed = 0;
    for (const q of [undefined, { status: "confirmed" as const }, { status: "pool" as const }, { asset: "ZPH" }, { accountIndex: 0, subaddressIndex: 0 }, { minHeight: 0 }]) {
      listed += (await w.getTxs(q)).length + (await w.getTransfers(q)).length;
    }
    await expectCode(w.getTx(hash), "INVALID_CONFIG", "getTx of a hash the wallet does not have", notes, "TX_NOT_FOUND");
    const after = await requestCounts(w);
    notes.push("requests before/after 13 history calls: forwarder " + before.forwarder + "/" + after.forwarder + ", upstream " + before.upstream + "/" + after.upstream + ", allowlist " + before.allowlist + "/" + after.allowlist + "; listed " + listed);
    expect(before.forwarder > 0 && before.allowlist > 0, "the counters saw the connection check (positive control)");
    expect(after.forwarder === before.forwarder && after.upstream === before.upstream && after.allowlist === before.allowlist, "no request during the history calls");
    expect(listed === 0, "the disposable wallet without funds has no history");
    report.measurements.N19 = { before, after, historyCalls: 13 };
    await w.close();
  });

  // ------------------------------------------------------------------ N21: explicit pool refresh
  /** Forwarder route counts by endpoint and JSON-RPC method (all listeners), and the refused requests. */
  async function forwarderRoutes(): Promise<{ routes: Record<string, number>; denied: number }> {
    const root = t.root as string;
    type Stats = { routes: Record<string, { count: number }>; denied: Record<string, number> };
    const st: Stats = typeof window !== "undefined" || typeof (globalThis as { importScripts?: unknown }).importScripts === "function"
      ? await (await fetch(root + "/__stats", { cache: "no-store" })).json() as Stats
      : await new Promise<Stats>((resolve, reject) => {
        http.get(root + "/__stats", (res) => { const chunks: Buffer[] = []; res.on("data", (c: Buffer) => chunks.push(c)); res.on("end", () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Stats); } catch (e) { reject(e); } }); }).on("error", reject);
      });
    const routes: Record<string, number> = {};
    for (const [k, v] of Object.entries(st.routes)) { const parts = k.split(" "); const key = parts.slice(2).join(" "); routes[key] = (routes[key] ?? 0) + v.count; }
    return { routes, denied: Object.values(st.denied).reduce((n, c) => n + c, 0) };
  }

  await check("N21", "Explicit pool refresh through the forwarder: only the pool hashes and the pool transactions not scanned before are requested (no key image), nothing is refused; the history of the wallet without funds stays empty and the history calls after it send no request", async (notes) => {
    if (t.base === undefined || t.root === undefined) throw new CheckFailure("no target");
    const w = await openSeed(t.base);
    try {
      expect((await w.isConnectedToDaemon()) === true, "connected through the forwarder");
      const listing = async () => JSON.stringify([(await w.getTxs()).length, (await w.getTransfers()).length, (await w.getTxs({ status: "pool" })).length]);
      const before = await listing();
      const r0 = await forwarderRoutes();
      const n1 = await w.refreshPool();
      const r1 = await forwarderRoutes();
      const n2 = await w.refreshPool();
      const r2 = await forwarderRoutes();
      const diff = (a: Record<string, number>, b: Record<string, number>) => { const out: Record<string, number> = {}; for (const k of Object.keys(b)) if (b[k] !== (a[k] ?? 0)) out[k] = b[k] - (a[k] ?? 0); return out; };
      const first = diff(r0.routes, r1.routes), second = diff(r1.routes, r2.routes);
      const allowed = (d: Record<string, number>) => Object.keys(d).every((k) => k === "/get_transaction_pool_hashes.bin -" || k === "/gettransactions -");
      expect(first["/get_transaction_pool_hashes.bin -"] === 1 && second["/get_transaction_pool_hashes.bin -"] === 1 && allowed(first) && allowed(second), "each refresh asks for the pool hashes once and otherwise only for pool transactions: " + JSON.stringify(first) + " " + JSON.stringify(second));
      expect(r2.denied === r0.denied, "no request refused by the forwarder");
      expect(n1 === 0 && n2 === 0, "the wallet without funds has no incoming pool transaction (" + n1 + ", " + n2 + ")");
      const after = await listing();
      const r3 = await forwarderRoutes();
      expect(before === after && before === "[0,0,0]", "the history stays empty (" + before + " / " + after + ")");
      expect(JSON.stringify(diff(r2.routes, r3.routes)) === "{}", "no request during the history calls after the refresh");
      report.measurements.N21 = { first, second, poolTxs: [n1, n2] };
      notes.push("refresh 1: " + JSON.stringify(first) + "; refresh 2: " + JSON.stringify(second) + "; incoming pool transactions " + n1 + ", " + n2);
    } finally {
      await w.close();
    }
  });

  // ------------------------------------------------------------------ N20: funded history (inputs from outside the public tree)
  await check("N20", "Funded history: transactions and transfers per asset and account equal the expectations; incoming sums equal the balances of wallet, accounts and subaddresses; every query filter; direct and proxied equal; confirmations grow with the daemon height", async (notes) => {
    const funded = opts.funded;
    if (funded === undefined) throw new CheckNotRun("no funded wallet supplied (FUNDED_WALLET_IN and FUNDED_EXPECT)");
    if (t.base === undefined) throw new CheckFailure("no target");
    const result = await fundedHistory(funded, notes);
    report.measurements.N20 = result;
  }, 1800000); // two syncs and up to 20 minutes of waiting for the next block

  async function fundedHistory(funded: FundedInputs, notes: string[]): Promise<Record<string, unknown>> {
    const show = (v: unknown) => JSON.stringify(v, (k, x) => (typeof x === "bigint" ? x.toString() + "n" : x instanceof Map ? Object.fromEntries(Array.from((x as Map<unknown, unknown>).entries()).map(([a, b]) => [String(a), b])) : x));
    const w = await F.openWalletData({ networkType: 0, password: funded.wallet.password, keysData: new Uint8Array(funded.wallet.keys), cacheData: new Uint8Array(funded.wallet.cache), server: t.base, proxyToWorker: false });
    try {
      expect((await w.isConnectedToDaemon()) === true, "connected through the forwarder");
      const dh0 = await w.getDaemonHeight();
      const h0 = await w.getHeight();
      expect(dh0 - h0 <= FRESH_SYNC_BLOCKS, "the copy starts within the sync window (" + (dh0 - h0) + " blocks below the daemon)");
      const r1 = await sync("N20", w, "funded copy, forwarder base path", "real", undefined, dh0 - h0);
      const h1 = await w.getHeight();
      const txs = await w.getTxs();
      const transfers = await w.getTransfers();
      // every transfer equals the expectations, by hash, and nothing else is listed
      const got = transfers.map((x) => ({ hash: x.txHash, height: x.height, direction: x.direction, asset: x.asset, amount: x.amount.toString(), accountIndex: x.accountIndex, subaddressIndex: x.subaddressIndex }));
      const key = (x: { hash: string; accountIndex: number; subaddressIndex?: number; direction: string }) => x.hash + "/" + x.direction + "/" + x.accountIndex + "/" + x.subaddressIndex;
      const want = funded.expect.transfers.slice().sort((a, b) => (key(a) < key(b) ? -1 : 1));
      const have = got.slice().sort((a, b) => (key(a) < key(b) ? -1 : 1));
      expect(show(have) === show(want), "transfers equal the expectations: " + show(have).substring(0, 600));
      expect(txs.length === new Set(want.map((x) => x.hash)).size && txs.every((tx) => tx.isConfirmed && !tx.inPool && !tx.isFailed && tx.outgoingTransfer === undefined && tx.conversion === undefined && tx.feeAsset === undefined), "transactions: confirmed, incoming only");
      expect(txs.every((tx) => tx.confirmations === h1 - (tx.height as number)), "confirmations equal the wallet height minus the transaction height");
      // incoming sums equal the balances (wallet, account, subaddress, by asset)
      const sum = (filter: (x: F.ZephyrWalletTransfer) => boolean) => { const m = new Map<string, bigint>(); for (const x of transfers) if (x.direction === "incoming" && filter(x)) m.set(x.asset as string, (m.get(x.asset as string) ?? BigInt(0)) + x.amount); return m; };
      const balance = await w.getBalance();
      const unlocked = await w.getUnlockedBalance();
      const walletSums = sum(() => true);
      for (const [asset, value] of balance) expect(value === (walletSums.get(asset) ?? BigInt(0)), "wallet balance " + asset + " equals the incoming sum");
      for (const asset of walletSums.keys()) expect(balance.has(asset), "the wallet map has " + asset);
      const accounts = await w.getAccounts({ includeSubaddresses: true });
      const shapes: Record<string, unknown> = { wallet: show(balance), walletUnlocked: show(unlocked), accounts: [] as unknown[] };
      for (const a of accounts) {
        const accSums = sum((x) => x.accountIndex === a.index);
        expect(show(new Map(Array.from(a.balance.entries()).sort())) === show(new Map(Array.from(accSums.entries()).sort())), "account " + a.index + " map equals its incoming sums");
        const byMap = await w.getBalance(a.index);
        for (const sub of a.subaddresses ?? []) {
          const subSums = sum((x) => x.accountIndex === a.index && x.subaddressIndex === sub.index);
          expect(show(new Map(Array.from(sub.balance.entries()).sort())) === show(new Map(Array.from(subSums.entries()).sort())), "subaddress " + a.index + "/" + sub.index + " map equals its incoming sums");
          for (const [asset, v] of subSums) expect((await w.getBalance(asset, a.index, sub.index)) === v, "scalar " + asset + " " + a.index + "/" + sub.index);
          const entry = byMap.get(sub.index);
          expect(subSums.size === 0 ? entry === undefined || entry.size === 0 || Array.from(entry.values()).every((v) => v === BigInt(0)) : entry !== undefined && Array.from(subSums).every(([asset, v]) => entry.get(asset) === v), "account map entry of subaddress " + sub.index);
        }
        for (const [asset, v] of accSums) expect((await w.getBalance(asset, a.index)) === v, "scalar " + asset + " of account " + a.index);
        (shapes.accounts as unknown[]).push({ index: a.index, balance: show(a.balance), unlockedBalance: show(a.unlockedBalance), accountMap: show(byMap), accountMapUnlocked: show(await w.getUnlockedBalance(a.index)),
          subaddresses: (a.subaddresses ?? []).filter((x) => x.isUsed || x.balance.size > 0).map((x) => ({ index: x.index, balance: show(x.balance), unlockedBalance: show(x.unlockedBalance), isUsed: x.isUsed, numUnspentOutputs: x.numUnspentOutputs })),
          unusedSubaddresses: (a.subaddresses ?? []).filter((x) => !x.isUsed && x.balance.size === 0).length });
      }
      // every filter on real data
      const assets = Array.from(new Set(want.map((x) => x.asset))).sort();
      const filters: Array<[string, F.ZephyrHistoryQuery, (x: FundedExpectations["transfers"][number]) => boolean]> = [];
      for (const asset of assets) filters.push(["asset " + asset, { asset }, (x) => x.asset === asset]);
      for (const a of Array.from(new Set(want.map((x) => x.accountIndex)))) { filters.push(["account " + a, { accountIndex: a }, (x) => x.accountIndex === a]); filters.push(["account " + a + " subaddress 0", { accountIndex: a, subaddressIndex: 0 }, (x) => x.accountIndex === a && x.subaddressIndex === 0]); }
      filters.push(["incoming", { direction: "incoming" }, (x) => x.direction === "incoming"], ["outgoing", { direction: "outgoing" }, (x) => x.direction === "outgoing"],
        ["confirmed", { status: "confirmed" }, () => true], ["pool", { status: "pool" }, () => false], ["failed", { status: "failed" }, () => false]);
      const heights = want.map((x) => x.height).sort((a, b) => a - b);
      const mid = heights[Math.floor(heights.length / 2)];
      filters.push(["minHeight " + mid, { minHeight: mid }, (x) => x.height >= mid], ["maxHeight " + mid, { maxHeight: mid }, (x) => x.height <= mid], ["height range " + mid, { minHeight: mid, maxHeight: mid }, (x) => x.height === mid],
        ["hashes", { hashes: [want[0].hash] }, (x) => x.hash === want[0].hash], ["asset and account", { asset: assets[0], accountIndex: 0 }, (x) => x.asset === assets[0] && x.accountIndex === 0]);
      const filterResults: Record<string, number> = {};
      for (const [label, q, pred] of filters) {
        const list = await w.getTransfers(q);
        const exp = want.filter(pred);
        expect(list.length === exp.length && list.every((x) => exp.some((e) => e.hash === x.txHash && e.accountIndex === x.accountIndex && e.subaddressIndex === x.subaddressIndex && e.asset === x.asset)), "filter " + label + ": " + list.length + " transfers, expected " + exp.length);
        const txList = await w.getTxs(q);
        expect(txList.length === new Set(exp.map((e) => e.hash)).size, "filter " + label + ": transactions");
        filterResults[label] = list.length;
      }
      for (const tx of txs) expect(show(await w.getTx(tx.hash)) === show(tx), "getTx " + tx.hash.substring(0, 8) + " equals the listing");
      // direct and proxied results equal field by field (the synced bytes, opened in a worker without a sync)
      const synced = await w.getData();
      if (funded.saveSynced !== undefined) await funded.saveSynced({ keys: synced.keys, cache: synced.cache, password: funded.wallet.password });
      const p = await F.openWalletData({ networkType: 0, password: funded.wallet.password, keysData: new Uint8Array(synced.keys), cacheData: new Uint8Array(synced.cache), proxyToWorker: true });
      try {
        expect(show(await p.getTxs()) === show(txs) && show(await p.getTransfers()) === show(transfers), "proxied listings equal the direct listings field by field");
        for (const [label, q] of filters) expect(show(await p.getTransfers(q)) === show(await w.getTransfers(q)), "proxied filter " + label);
        expect(show(await p.getAccounts({ includeSubaddresses: true })) === show(accounts) && show(await p.getBalance()) === show(balance), "proxied accounts and balances equal");
      } finally { await p.close(); }
      // confirmations grow with the daemon height: wait (bounded) for a new block, sync again
      let dh = await w.getDaemonHeight();
      const until = Date.now() + 1200000; // blocks come every two minutes on average, with long gaps now and then
      while (dh <= h1 && Date.now() < until) { await new Promise((res) => setTimeout(res, 20000)); dh = await w.getDaemonHeight(); }
      let grown: Record<string, unknown> = { waitedForBlock: dh > h1 };
      if (dh > h1) {
        await sync("N20", w, "funded copy, second sync", "real", undefined, dh - h1);
        const h2 = await w.getHeight();
        const later = await w.getTxs();
        expect(h2 > h1 && later.length === txs.length && later.every((tx, i) => tx.hash === txs[i].hash && tx.confirmations === txs[i].confirmations + (h2 - h1)), "every transaction gained exactly the new blocks as confirmations");
        grown = { waitedForBlock: true, h1, h2, confirmationsBefore: txs.map((tx) => tx.confirmations), confirmationsAfter: later.map((tx) => tx.confirmations) };
      } else {
        throw new CheckFailure("no new block within 20 minutes; confirmations not compared");
      }
      notes.push("funded copy: synced " + r1.numBlocksFetched + " blocks from " + h0 + " to " + h1 + "; " + txs.length + " transactions, " + transfers.length + " transfers; " + filters.length + " filters; direct and proxied equal");
      return { startHeight: h0, height: h1, daemonHeight: dh0, numBlocksFetched: r1.numBlocksFetched, transactions: txs.map((tx) => ({ hash: tx.hash, height: tx.height, timestamp: tx.timestamp, confirmations: tx.confirmations, isLocked: tx.isLocked, fee: tx.fee === undefined ? undefined : tx.fee.toString(), unlockTime: tx.unlockTime.toString(), incoming: tx.incomingTransfers.length })),
        transfers: got, shapes, filters: filterResults, confirmations: grown };
    } finally {
      await w.close();
    }
  }

  // ------------------------------------------------------------------ N22, N23: funded builds without relay (inputs from outside the public tree)
  /** Read-only state of a wallet for the nothing-persists comparison: balances, unlocked balances, accounts with subaddresses, history. */
  async function walletState(w: F.ZephyrWallet): Promise<string> {
    const show = (v: unknown) => JSON.stringify(v, (k, x) => (typeof x === "bigint" ? x.toString() + "n" : x instanceof Map ? Object.fromEntries(Array.from((x as Map<unknown, unknown>).entries()).map(([a, b]) => [String(a), b])) : x));
    const accounts = await w.getAccounts({ includeSubaddresses: true });
    const maps: unknown[] = [];
    for (const a of accounts) maps.push([await w.getBalance(a.index), await w.getUnlockedBalance(a.index)]);
    return show({ balance: await w.getBalance(), unlocked: await w.getUnlockedBalance(), accounts, maps, txs: await w.getTxs(), height: await w.getHeight() });
  }
  const bytesEqual = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);
  /**
   * The description without the fields that are random by nature: the hash (a new transaction key and new
   * decoys each build) and the weight with what follows from it (fee, change, total): the ring members' offsets
   * are random, so their variable-length encoding makes the weight vary by a few bytes and the per-byte fee
   * with it. What stays fixed for the same inputs is fee + change (the inputs' sum minus the amount).
   */
  const withoutRandom = (b: F.ZephyrTransferBuild) => JSON.stringify({ multipleTxs: b.multipleTxs, txs: b.txs.map((t) => ({ ...t, hash: "-", weight: "-", fee: "-", change: "-", totalDebited: "-", feePlusChange: (t.fee + t.change).toString() })) }, (k, x) => (typeof x === "bigint" ? x.toString() : x));
  /** The random fields stay within their bound: the weight within 32 bytes, the fee per weight within 1%. */
  const randomWithinBounds = (a: F.ZephyrTransferBuild, b: F.ZephyrTransferBuild) => a.txs.every((t, i) => {
    const u = b.txs[i];
    const rate = (x: F.ZephyrBuiltTx) => Number(x.fee) / x.weight;
    return Math.abs(t.weight - u.weight) <= 32 && Math.abs(rate(t) - rate(u)) <= 0.01 * rate(t);
  });
  /** Fields of two single-transaction descriptions that differ (for the notes). */
  const differing = (a: F.ZephyrTransferBuild, b: F.ZephyrTransferBuild) => Object.keys(a.txs[0]).filter((k) => JSON.stringify((a.txs[0] as unknown as Record<string, unknown>)[k], (x, v) => (typeof v === "bigint" ? v.toString() : v)) !== JSON.stringify((b.txs[0] as unknown as Record<string, unknown>)[k], (x, v) => (typeof v === "bigint" ? v.toString() : v))).map((k) => k + " " + String((a.txs[0] as unknown as Record<string, unknown>)[k]) + "/" + String((b.txs[0] as unknown as Record<string, unknown>)[k]));

  await check("N22", "Funded builds without relay on a copy, through the allowlisting forwarder: one build per V2 asset to the wallet's own account 1, one from account 1 to the primary address, two destinations, a repeated build; the description is the core's (assets, fee in the source asset, change, ring size, inputs, outputs, weight); an amount above the balance rejects without a request; balances, history and wallet bytes unchanged; direct and proxied equal except the hash; no request refused and none relayed", async (notes) => {
    const funded = opts.funded;
    if (funded === undefined) throw new CheckNotRun("no funded wallet supplied (FUNDED_WALLET_IN and FUNDED_EXPECT)");
    if (t.base === undefined) throw new CheckFailure("no target");
    const unit = BigInt("1000000000000");
    const tenth = unit / BigInt(10);
    const w = await F.openWalletData({ networkType: 0, password: funded.wallet.password, keysData: new Uint8Array(funded.wallet.keys), cacheData: new Uint8Array(funded.wallet.cache), server: t.base, proxyToWorker: false });
    const relayBefore = (HttpClient as unknown as { REFUSED_RELAY_REQUESTS: number }).REFUSED_RELAY_REQUESTS;
    try {
      expect((await w.isConnectedToDaemon()) === true, "connected through the forwarder");
      const dh0 = await w.getDaemonHeight();
      const h0 = await w.getHeight();
      expect(dh0 - h0 <= FRESH_SYNC_BLOCKS, "the copy starts within the sync window");
      await sync("N22", w, "funded copy for builds, forwarder base path", "real", undefined, dh0 - h0);
      const primary = await w.getPrimaryAddress();
      const account1 = await w.getAddress(1, 0);
      const label = (a: string) => (a === primary ? "primary" : a === account1 ? "account1" : "OTHER");
      const state0 = await walletState(w);
      const data0 = await w.getData();
      const data0b = await w.getData();
      const deterministic = bytesEqual(data0.keys, data0b.keys) && bytesEqual(data0.cache, data0b.cache);
      const plans: Array<[string, F.ZephyrTransferConfig]> = [];
      for (const asset of ["ZPH", "ZSD", "ZRS", "ZYS"]) plans.push([asset + " account 0 to account 1", { asset, destinations: [{ address: account1, amount: tenth }], accountIndex: 0 }]);
      plans.push(["ZPH account 1 to the primary address", { asset: "ZPH", destinations: [{ address: primary, amount: tenth }], accountIndex: 1 }]);
      plans.push(["ZPH two destinations", { asset: "ZPH", destinations: [{ address: account1, amount: tenth / BigInt(2) }, { address: primary, amount: tenth / BigInt(2) }], accountIndex: 0 }]);
      plans.push(["ZPH account 0 to account 1, again", plans[0][1]]);
      const results: Record<string, unknown> = {};
      const builds: F.ZephyrTransferBuild[] = [];
      for (const [name, cfg] of plans) {
        for (const d of cfg.destinations) expect(label(d.address) !== "OTHER" && d.amount <= unit, "destinations are the wallet's own addresses, amounts at most 1 unit");
        const r0 = await forwarderRoutes();
        const t0 = Date.now();
        const b = await w.buildTransfer(cfg);
        const ms = Date.now() - t0;
        const r1 = await forwarderRoutes();
        const requests: Record<string, number> = {};
        for (const k of Object.keys(r1.routes)) if (r1.routes[k] !== (r0.routes[k] ?? 0)) requests[k] = r1.routes[k] - (r0.routes[k] ?? 0);
        expect(r1.denied === r0.denied, name + ": no request refused by the forwarder");
        expect(!b.multipleTxs && b.txs.length === 1, name + ": one transaction");
        const tx = b.txs[0];
        const sum = cfg.destinations.reduce((n, d) => n + d.amount, BigInt(0));
        expect(tx.sourceAsset === cfg.asset && tx.destinationAsset === cfg.asset && tx.feeAsset === cfg.asset, name + ": assets");
        expect(tx.amount === sum && tx.totalDebited === sum + tx.fee && tx.fee > BigInt(0) && tx.fee < unit / BigInt(100), name + ": amount, fee and total");
        expect(tx.ringSize === 16 && tx.inputs >= 1 && tx.outputs === cfg.destinations.length + 1 && tx.unlockTime === BigInt(0) && tx.weight > 0, name + ": ring size 16, inputs, outputs (destinations and change), unlock time");
        expect(JSON.stringify((tx.destinations ?? []).map((d) => [label(d.address), d.amount.toString()])) === JSON.stringify(cfg.destinations.map((d) => [label(d.address), d.amount.toString()])), name + ": destinations as requested");
        builds.push(b);
        results[name] = { hash: tx.hash, asset: tx.sourceAsset, amount: tx.amount.toString(), fee: tx.fee.toString(), feeAsset: tx.feeAsset, totalDebited: tx.totalDebited.toString(), change: tx.change.toString(),
          ringSize: tx.ringSize, inputs: tx.inputs, outputs: tx.outputs, weight: tx.weight, unlockTime: tx.unlockTime.toString(), destinations: (tx.destinations ?? []).map((d) => label(d.address) + ":" + d.amount.toString()), requests, ms };
      }
      expect(builds[6].txs[0].hash !== builds[0].txs[0].hash, "a repeated identical build gives a new transaction (new hash)");
      notes.push("repeated build differs in: " + differing(builds[0], builds[6]).join("; "));
      expect(withoutRandom(builds[6]) === withoutRandom(builds[0]) && randomWithinBounds(builds[0], builds[6]), "a repeated identical build has the same description except the fields random by nature, which stay within their bounds");
      // an amount above the balance: rejected from the wallet's own balance, no request
      const r0 = await forwarderRoutes();
      await expectCode(w.buildTransfer({ asset: "ZYS", destinations: [{ address: account1, amount: BigInt(6) * unit }], accountIndex: 0 }), "TX_NOT_POSSIBLE", "an amount above the balance", notes, "NOT_ENOUGH_MONEY");
      await expectCode(w.buildTransfer({ asset: "ZSD", destinations: [{ address: primary, amount: tenth }], accountIndex: 1 }), "TX_NOT_POSSIBLE", "an asset account 1 does not hold", notes, "NOT_ENOUGH_MONEY");
      const r1 = await forwarderRoutes();
      expect(JSON.stringify(r0) === JSON.stringify(r1), "the rejected builds sent no request");
      // nothing persists
      const state1 = await walletState(w);
      const data1 = await w.getData();
      expect(state1 === state0, "balances, unlocked balances, accounts, history and height equal those before the builds");
      const keysEqual = bytesEqual(data0.keys, data1.keys), cacheEqual = bytesEqual(data0.cache, data1.cache);
      expect(!deterministic || (keysEqual && cacheEqual), "the wallet bytes equal those before the builds (getData is deterministic here)");
      // getData encrypts afresh on every call (two calls without any change differ), so the bytes are compared by
      // length and by what they open to: both reopen offline to the same state
      expect(data0.keys.length === data1.keys.length && data0.cache.length === data1.cache.length, "the wallet bytes have the same lengths before and after the builds");
      const reopened: string[] = [];
      for (const d of [data0, data1]) {
        const o = await F.openWalletData({ networkType: 0, password: funded.wallet.password, keysData: new Uint8Array(d.keys), cacheData: new Uint8Array(d.cache), proxyToWorker: false });
        try { reopened.push(await walletState(o)); } finally { await o.close(); }
      }
      expect(reopened[0] === state0 && reopened[1] === state0, "the bytes before and after the builds reopen to the same state");
      // direct and proxied: the same builds in a worker from the same synced bytes
      const p = await F.openWalletData({ networkType: 0, password: funded.wallet.password, keysData: new Uint8Array(data0.keys), cacheData: new Uint8Array(data0.cache), server: t.base, proxyToWorker: true });
      const proxied: Record<string, boolean> = {};
      try {
        for (const i of [0, 3, 4, 5]) {
          const b = await p.buildTransfer(plans[i][1]);
          proxied[plans[i][0]] = withoutRandom(b) === withoutRandom(builds[i]) && randomWithinBounds(b, builds[i]);
          notes.push("proxied " + plans[i][0] + " differs in: " + differing(builds[i], b).join("; "));
          expect(proxied[plans[i][0]], "proxied " + plans[i][0] + " equals the direct description except the fields random by nature");
        }
      } finally { await p.close(); }
      if (opts.saveBuildSynced !== undefined) await opts.saveBuildSynced({ keys: data1.keys, cache: data1.cache, password: funded.wallet.password });
      const relayAfter = (HttpClient as unknown as { REFUSED_RELAY_REQUESTS: number }).REFUSED_RELAY_REQUESTS;
      expect(relayAfter === relayBefore, "no relay request was attempted in this context");
      report.measurements.N22 = { builds: results, deterministicGetData: deterministic, keysEqual, cacheEqual, reopenedEqual: reopened[0] === state0 && reopened[1] === state0, keysBytes: data0.keys.length, cacheBytes: data0.cache.length, proxiedEqual: proxied, relayRefused: relayAfter - relayBefore };
      notes.push(plans.length + " builds; fees " + Object.entries(results).map(([k, v]) => k.split(" ")[0] + " " + (v as { fee: string }).fee).join(", ") + "; getData deterministic " + deterministic + ", keys equal " + keysEqual + ", cache equal " + cacheEqual);
    } finally {
      await w.close();
    }
  }, 1800000);

  await check("N23", "Funded builds in the test module: after a warm-up the allocator returns to the same level after every build (the built transactions and their bytes are released inside the module)", async (notes) => {
    const synced = opts.fundedSynced;
    if (synced === undefined) throw new CheckNotRun("no synced funded copy supplied (a run with the test module after N22)");
    if (t.base === undefined) throw new CheckFailure("no target");
    const module = LibraryUtils.getWasmModule() as { test_heap_in_use?: () => number } | undefined;
    if (module === undefined || typeof module.test_heap_in_use !== "function") throw new CheckFailure("not the test module");
    const w = await F.openWalletData({ networkType: 0, password: synced.password, keysData: new Uint8Array(synced.keys), cacheData: new Uint8Array(synced.cache), server: t.base, proxyToWorker: false });
    try {
      const account1 = await w.getAddress(1, 0);
      const cfg: F.ZephyrTransferConfig = { asset: "ZPH", destinations: [{ address: account1, amount: BigInt("100000000000") }], accountIndex: 0 };
      const heap = () => (module.test_heap_in_use as () => number)();
      for (let i = 0; i < 2; i++) await w.buildTransfer(cfg); // warm-up: the core's caches of daemon answers and the gamma picker
      const deltas: number[] = [];
      for (let i = 0; i < 5; i++) { const h0 = heap(); await w.buildTransfer(cfg); deltas.push(heap() - h0); }
      notes.push("allocator growth of 5 builds after a warm-up of 2: " + deltas.join(","));
      report.measurements.N23 = { deltas };
      expect(deltas.every((d) => d === deltas[0]) && deltas[0] <= 0, "every build returns the allocator to its level (growth " + deltas.join(",") + ")");
    } finally {
      await w.close();
    }
  }, 1200000);

  const entryGuard = await Internal.getNetworkGuardReport();
  report.networkGuard = combinedGuard(entryGuard, GUARD_LEDGER);
  report.workerAccounting = LibraryUtils.getWorkerAccounting();
  report.finishedUtc = new Date().toISOString();
  return report;
}
