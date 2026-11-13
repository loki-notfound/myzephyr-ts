/**
 * Test-only support for the lifecycle checks: raw worker messages, report sanitizing and the
 * instrumentation interface used against the separately built test module. None of this is
 * exported by the package entry or present in the release worker.
 */
import GenUtils from "../../main/ts/common/GenUtils";
import LibraryUtils from "../../main/ts/common/LibraryUtils";
import ZephyrWalletError, { bridgePasswordErrorOf } from "../../main/ts/common/ZephyrWalletError";
import { ZephyrWorkerChannel, ZephyrWorkerLike } from "../../main/ts/common/ZephyrWalletWorkers";
import type { ZephyrWallet, ZephyrNetworkGuardReport } from "../../main/ts/wallet/ZephyrWallet";
import * as Sdk from "../../main/ts/index";
import { ZephyrWalletWorkers } from "../../main/ts/common/ZephyrWalletWorkers";

// ------------------------------ RAW WORKER MESSAGES -------------------------

/** Outcome of posting a raw message to the worker. */
export interface RawWorkerReply {
  readonly replied: boolean;
  readonly result?: unknown;
  readonly error?: { readonly type?: unknown; readonly code?: unknown; readonly diagnostic?: unknown; readonly [k: string]: unknown };
  readonly raw?: unknown;
}

/** Worker with DOM-style message listeners (browser Worker and web-worker in Node). */
export interface ListenableWorker extends ZephyrWorkerLike {
  addEventListener(type: string, listener: (event: { data: unknown }) => void): void;
  removeEventListener(type: string, listener: (event: { data: unknown }) => void): void;
}

/** Start a worker with the configured path (no loader), optionally named; test use only. */
export function startWorkerAtPath(name?: string): ListenableWorker {
  const options = name === undefined ? undefined : { name };
  if (GenUtils.isBrowser()) return new Worker(LibraryUtils.WORKER_DIST_PATH, options) as unknown as ListenableWorker;
  const NodeWorker = require("web-worker");
  return new NodeWorker(LibraryUtils.WORKER_DIST_PATH, options) as ListenableWorker;
}

/**
 * Test-owned raw worker: started like an SDK worker but not registered with the SDK; it
 * receives raw messages only from the test and is terminated by the test.
 */
export class RawWorker {
  /** test-owned workers started in this runtime (reported, so validators can derive the expected worker count) */
  static started = 0;
  readonly worker: ListenableWorker;
  private readonly waiting = new Map<string, (resp: unknown) => void>();
  constructor(worker?: ListenableWorker) {
    this.worker = worker ?? (LibraryUtils.WORKER_LOADER ? LibraryUtils.WORKER_LOADER() as unknown as ListenableWorker : startWorkerAtPath());
    // a worker started at the path gets the runtime's compiled module first, as an SDK worker does
    if (worker === undefined && LibraryUtils.WORKER_LOADER === undefined && LibraryUtils.WASM_COMPILED_VALUE !== undefined) this.worker.postMessage([LibraryUtils.WASM_MODULE_MESSAGE, LibraryUtils.WASM_COMPILED_VALUE]);
    RawWorker.started++;
    this.worker.addEventListener("message", (e: { data: unknown }) => {
      const d = e.data;
      if (!Array.isArray(d) || d.length < 2 || typeof d[1] !== "string") return;
      const cb = this.waiting.get(d[1]);
      if (cb !== undefined) { this.waiting.delete(d[1]); cb(d[2]); }
    });
  }
  post(message: unknown, timeoutMs: number): Promise<RawWorkerReply> {
    const routable = isRoutable(message);
    return new Promise<RawWorkerReply>((resolve) => {
      let done = false;
      const timer = setTimeout(() => { if (!done) { done = true; resolve({ replied: false }); } }, timeoutMs);
      if (routable) {
        const callbackId = (message as string[])[2];
        this.waiting.set(callbackId, (resp: unknown) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          const r = resp as { result?: unknown; error?: RawWorkerReply["error"] } | undefined;
          resolve({ replied: true, result: r ? r.result : undefined, error: r ? r.error : undefined, raw: resp });
        });
      }
      this.worker.postMessage(message);
    });
  }
  terminate(): void { this.worker.terminate(); }
}

function isRoutable(message: unknown): boolean {
  return Array.isArray(message) && typeof message[0] === "string" && typeof message[2] === "string" && /^[A-Za-z0-9-]{1,64}$/.test(message[0]) && /^[A-Za-z0-9-]{1,64}$/.test(message[2]);
}

/** The worker channel owned by a proxied wallet (test-only access). */
export function channelOf(wallet: ZephyrWallet): ZephyrWorkerChannel {
  const proxy = innerOf(wallet).walletProxy;
  if (!proxy || typeof proxy.getWorkerChannel !== "function") throw new Error("not a worker wallet");
  return proxy.getWorkerChannel() as ZephyrWorkerChannel;
}

/** Target of a raw message: a test-owned raw worker, an SDK channel, a wallet's own worker, or (default) the utility worker. */
export type RawTarget = RawWorker | ZephyrWorkerChannel | ZephyrWallet | undefined;

/**
 * Post a raw message and wait for its reply (bounded by timeoutMs). Messages without routable ids
 * get no reply by design; the caller then checks liveness. Wallets own separate workers,
 * so the target names the worker.
 */
export async function postRawWorkerMessage(message: unknown, timeoutMs: number, target?: RawTarget): Promise<RawWorkerReply> {
  if (target instanceof RawWorker) return target.post(message, timeoutMs);
  if (target === undefined) await LibraryUtils.getCompiledWasmModule(); // the utility worker starts with the runtime's compiled module, as in the SDK
  const channel = target === undefined ? LibraryUtils.getUtilityChannel() : target instanceof ZephyrWorkerChannel ? target : channelOf(target);
  const routable = isRoutable(message);
  return new Promise<RawWorkerReply>((resolve) => {
    let done = false;
    const timer = setTimeout(() => { if (!done) { done = true; resolve({ replied: false }); } }, timeoutMs);
    if (routable) {
      const objectId = (message as string[])[0];
      const callbackId = (message as string[])[2];
      channel.addCallback(objectId, callbackId, (resp: unknown) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        channel.removeCallback(objectId, callbackId);
        const r = resp as { result?: unknown; error?: RawWorkerReply["error"] } | undefined;
        resolve({ replied: true, result: r ? r.result : undefined, error: r ? r.error : undefined, raw: resp });
      });
    }
    channel.worker.postMessage(message);
  });
}

// ------------------------------ GUARD LEDGER ---------------------

/**
 * The library no longer reads a worker's network guard counts before terminating
 * it. The test layer reads a proxied wallet's counts through its own worker right before the
 * wallet's first close call (bounded; an unanswered read is counted as unreported and does not
 * delay close beyond the bound) and accumulates them here. Failed constructions are discarded by
 * the library at once and are not read.
 */
export interface GuardLedger {
  reports: number;
  unreported: number;
  blockedRequests: number;
  allowedRequests: number;
  blockedSummary: Record<string, number>;
  allowedSummary: Record<string, number>;
}

export const GUARD_LEDGER: GuardLedger = { reports: 0, unreported: 0, blockedRequests: 0, allowedRequests: 0, blockedSummary: {}, allowedSummary: {} };
const GUARD_READ_TIMEOUT_MS = 10000;
const GUARD_SKIP = new WeakSet<object>();
let guardLedgerInstalled = false;

/** Read one worker's guard counts into the ledger (bounded). */
export async function readGuardInto(channel: ZephyrWorkerChannel, ledger: GuardLedger = GUARD_LEDGER): Promise<boolean> {
  let reply: unknown = undefined;
  if (channel.isOpen()) {
    const timeout = new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), GUARD_READ_TIMEOUT_MS));
    try { reply = await Promise.race([channel.invoke(undefined, "getNetworkGuardReport", []), timeout]); } catch (err) { reply = undefined; }
  }
  const counts = ZephyrWalletWorkers.guardCountsOf(reply);
  if (counts === undefined) { ledger.unreported++; return false; }
  ledger.reports++;
  ledger.blockedRequests += counts.blockedRequests;
  ledger.allowedRequests += counts.allowedRequests;
  for (const k of Object.keys(counts.blockedRequestSummary)) ledger.blockedSummary[k] = (ledger.blockedSummary[k] ?? 0) + counts.blockedRequestSummary[k];
  for (const k of Object.keys(counts.allowedRequestSummary)) ledger.allowedSummary[k] = (ledger.allowedSummary[k] ?? 0) + counts.allowedRequestSummary[k];
  return true;
}

/**
 * Install the test-layer read for every proxied wallet (idempotent). The facade's close is
 * wrapped synchronously (its promise identity and admission stop are unchanged); for a proxied
 * wallet it patches that wallet's inner worker proxy once, so the guard counts are read right
 * after the facade stopped admission and before the proxy's native close and worker retirement.
 */
export function installGuardLedger(): void {
  if (guardLedgerInstalled) return;
  guardLedgerInstalled = true;
  const proto = Sdk.ZephyrWallet.prototype as unknown as { close: (this: ZephyrWallet) => Promise<void> };
  const original = proto.close;
  proto.close = function(this: ZephyrWallet): Promise<void> {
    if (this.proxied && !GUARD_SKIP.has(this)) {
      GUARD_SKIP.add(this); // read once, before the first close reaches the worker
      const proxy = innerOf(this).walletProxy as { close: (save?: boolean) => Promise<void>; getWorkerChannel: () => ZephyrWorkerChannel } | undefined;
      if (proxy !== undefined && typeof proxy.close === "function") {
        const proxyClose = proxy.close;
        proxy.close = async function(this: unknown, save?: boolean): Promise<void> {
          proxy.close = proxyClose; // once
          let channel: ZephyrWorkerChannel | undefined = undefined;
          try { channel = proxy.getWorkerChannel(); } catch (err) { channel = undefined; }
          if (channel !== undefined) await readGuardInto(channel);
          else GUARD_LEDGER.unreported++;
          return proxyClose.call(this, save);
        };
      } else GUARD_LEDGER.unreported++;
    }
    return original.call(this);
  };
}

/** Close without the ledger read (a wallet whose worker deliberately does not answer utility messages). */
export function skipGuardRead(wallet: ZephyrWallet): void {
  GUARD_SKIP.add(wallet);
}

/** The SDK's report over open workers combined with the ledger of closed proxied wallets. */
export function combinedGuard(report: ZephyrNetworkGuardReport, ledger: GuardLedger = GUARD_LEDGER): ZephyrNetworkGuardReport & { ledgerReports: number; ledgerUnreported: number } {
  const merge = (a: Readonly<Record<string, number>> | undefined, b: Record<string, number>): Record<string, number> => {
    const out: Record<string, number> = Object.assign({}, a ?? {});
    for (const k of Object.keys(b)) out[k] = (out[k] ?? 0) + b[k];
    return out;
  };
  const reports = report.workerReports + ledger.reports;
  return Object.assign({}, report, {
    workerBlockedRequests: reports > 0 ? (report.workerBlockedRequests ?? 0) + ledger.blockedRequests : undefined,
    workerBlockedSummary: reports > 0 ? merge(report.workerBlockedSummary, ledger.blockedSummary) : undefined,
    workerAllowedRequests: reports > 0 ? (report.workerAllowedRequests ?? 0) + ledger.allowedRequests : undefined,
    workerAllowedSummary: reports > 0 ? merge(report.workerAllowedSummary, ledger.allowedSummary) : undefined,
    workerReports: reports,
    workersUnreported: report.workersUnreported + ledger.unreported,
    ledgerReports: ledger.reports,
    ledgerUnreported: ledger.unreported
  });
}

export function newMessageId(): string {
  return GenUtils.getUUID();
}

/** Remove long hex runs and mnemonic-like word runs from a text for test reports. */
export function sanitize(text: string): string {
  let out = text.replace(/[0-9a-fA-F]{16,}/g, "<hex>");
  out = out.replace(/(?:\b[\p{Ll}]{2,}\b[\s,]+){5,}\b[\p{Ll}]{2,}\b/gu, "<words>");
  out = out.replace(/[\r\n\t]+/g, " ");
  return out.length > 160 ? out.substring(0, 160) + "..." : out;
}

// ------------------------------ INSTRUMENTATION -----------------------------

/** State recorded by the test module's hooks and the test-side spies. */
export interface InstrumentationState {
  readonly events: string[];
  readonly allocated: number;
  readonly freed: number;
  readonly live: number;
  readonly doubleFrees: number;
  readonly injected: number;
  /** allocator bytes in use; -1 when not sampled (no export is called while a native call is suspended) */
  readonly heapInUse: number;
  readonly nativeCalls: Record<string, number>;
  readonly wallets: number | undefined;
}

/** One worker started through the test loader (worker mode). */
export interface TrackedWorkerInfo {
  readonly index: number;
  readonly name: string | undefined;
  /** the SDK called terminate() on it */
  readonly terminated: boolean;
  /** native construction exports entered and left (posted by the test worker) */
  readonly nativeEntered: readonly string[];
  readonly nativeLeft: readonly string[];
  readonly telemetry: InstrumentationState | undefined;
}

export interface InstrumentationArm {
  readonly barrier?: string;
  /** native hook points to fail (count), after skipping the given number of passes */
  readonly fail?: Record<string, number>;
  readonly skip?: Record<string, number>;
  /** failure kind per hook point: 1 runtime_error carrying the call inputs, 2 non-standard, 3 bad_alloc, 4 invalid_password */
  readonly kind?: Record<string, number>;
  /** make the JS copy of the first or second wallet buffer of the next getData fail */
  readonly copyFailure?: "first" | "second";
  /**
   * The next change_wallet_password runs natively, then its callback receives this value
   * instead of the bridge's result (malformed-result injection beneath the TypeScript layer)
   */
  readonly passwordResult?: { readonly value: unknown };
  /** The next change_wallet_password throws synchronously instead of reporting a result */
  readonly passwordThrow?: boolean;
  /** synthetic incoming pool records for refresh_pool of the test module (with fail["pool.core"] the core's selection is skipped) */
  readonly poolRecords?: ReadonlyArray<TestPoolRecord>;
}

/** Instrumentation driver; direct (same context) or worker (test worker messages). */
export interface Instrumentation {
  readonly mode: "direct" | "worker";
  /**
   * Every proxied wallet owns its worker. Observe this wallet's worker (worker mode; the
   * one shared module in direct mode). Later state/arm/release/reset calls apply to it.
   */
  target(wallet: ZephyrWallet): Promise<void>;
  /** observe the utility worker (worker mode; no-op in direct mode) */
  targetUtility(): Promise<void>;
  /** arm the next started worker before its construction message (worker mode; arm() in direct mode) */
  armNext(arm: InstrumentationArm, name?: string): Promise<void>;
  /** state of the most recently started worker (final telemetry once it ended); state() in direct mode */
  lastStartedState(): Promise<InstrumentationState>;
  /** workers started by the SDK through the test loader so far (worker mode), with their end state */
  started(): readonly TrackedWorkerInfo[];
  install(): Promise<void>;
  arm(arm: InstrumentationArm): Promise<void>;
  release(): Promise<void>;
  waitBarrierEntered(timeoutMs: number): Promise<boolean>;
  state(sampleHeap?: boolean): Promise<InstrumentationState>;
  resetCounters(): Promise<void>;
  /** call the native change_wallet_password through the wallet's queue, beneath the TS pre-check */
  nativeChangePassword(wallet: ZephyrWallet, oldPassword: string, newPassword: string): Promise<void>;
  /** whether the native handle of a wallet is still allocated (not freed) */
  handlePresent(wallet: ZephyrWallet): Promise<boolean>;
}

interface Hooks {
  events: string[];
  fail: Record<string, number>;
  skip: Record<string, number>;
  kind: Record<string, number>;
  barrier?: { point: string; entered?: boolean; released?: boolean };
  buffers?: { allocated: number; bytes: number; live: Record<string, number> };
  poolRecords?: ReadonlyArray<TestPoolRecord>;
}

/** A synthetic incoming pool record that refresh_pool of the test module adds to the core's selection. */
export interface TestPoolRecord {
  readonly hash: string;
  readonly amount: string;
  readonly asset?: string;
  readonly accountIndex: number;
  readonly subaddressIndex: number;
}

/** Shared implementation over a loaded test module (used in the page, Node and test workers). */
export class ModuleInstrumentation {

  private readonly module: any;
  private freed = 0;
  private doubleFrees = 0;
  private calls: Record<string, number> = {};
  private copyFailureSkip = -1; // HEAPU8 reads to let pass before the injected copy failure; -1 = off
  private releasedPointers = new Set<string>(); // bridge buffers released since the last allocation at that address
  private installed = false;
  private passwordResult: { readonly value: unknown } | undefined = undefined; // password-check injection, one use
  private passwordThrow = false; // password-check injection, one use
  /** Called before and after a native construction export (worker telemetry) */
  onNative: ((phase: "enter" | "leave", name: string) => void) | undefined = undefined;

  constructor(module: any) {
    this.module = module;
  }

  install(): void {
    const module = this.module;
    if (typeof module.test_heap_in_use !== "function") throw new Error("not the instrumented test module");
    module.__zephyrTsTestHooks = { events: [], fail: {}, skip: {}, kind: {}, buffers: { allocated: 0, bytes: 0, live: {} } } as Hooks;
    if (this.installed) return;
    this.installed = true;
    const self = this;
    // The glue's lazy _free stub reassigns Module._free on first use; keep the spy in place with an
    // accessor that forwards reassignment to the underlying function instead of replacing the spy.
    let freeTarget = module._free;
    const freeSpy = function(pointer: number) {
      const hooks = module.__zephyrTsTestHooks as Hooks;
      const key = String(pointer);
      if (hooks.buffers && Object.prototype.hasOwnProperty.call(hooks.buffers.live, key)) { delete hooks.buffers.live[key]; self.freed++; }
      else if (hooks.buffers && pointer !== 0 && self.releasedPointers.has(key)) self.doubleFrees++;
      if (pointer !== 0) self.releasedPointers.add(key);
      return freeTarget.call(module, pointer);
    };
    Object.defineProperty(module, "_free", { configurable: true, get() { return freeSpy; }, set(v) { freeTarget = v; } });
    for (const name of Object.keys(module)) {
      if (!/^[a-z][a-z_]+$/.test(name) || typeof module[name] !== "function" || name === "test_heap_in_use") continue;
      const original = module[name];
      module[name] = function(...args: unknown[]) {
        self.calls[name] = (self.calls[name] ?? 0) + 1;
        if (name === "change_wallet_password" && self.passwordThrow) {
          self.passwordThrow = false;
          (module.__zephyrTsTestHooks as Hooks).events.push("injected:password-throw");
          throw new Error("injected synchronous change_wallet_password failure");
        }
        if (name === "change_wallet_password" && self.passwordResult !== undefined && typeof args[3] === "function") {
          const replacement = self.passwordResult;
          self.passwordResult = undefined;
          (module.__zephyrTsTestHooks as Hooks).events.push("injected:password-result");
          const callback = args[3] as (result?: unknown) => void;
          args[3] = () => callback(replacement.value); // the native change itself runs; its real result is discarded
        }
        const construction = /^(create_full_wallet|open_wallet_full|create_keys_wallet_random|create_keys_wallet_from_seed|create_keys_wallet_from_keys)$/.test(name);
        if (construction && self.onNative) self.onNative("enter", name);
        try {
          return original.apply(module, args);
        } finally {
          if (construction && self.onNative) self.onNative("leave", name);
        }
      };
    }
    // copy-failure injection: the next read of HEAPU8 by the buffer copy throws once
    const descriptor = Object.getOwnPropertyDescriptor(module, "HEAPU8");
    let heap = module.HEAPU8;
    Object.defineProperty(module, "HEAPU8", {
      configurable: true,
      get() {
        if (self.copyFailureSkip > 0) self.copyFailureSkip--;
        else if (self.copyFailureSkip === 0) { self.copyFailureSkip = -1; (module.__zephyrTsTestHooks as Hooks).events.push("injected:copy"); throw new Error("injected copy failure"); }
        return heap;
      },
      set(v) { heap = v; }
    });
    void descriptor;
  }

  arm(arm: InstrumentationArm): void {
    const hooks = this.module.__zephyrTsTestHooks as Hooks;
    if (arm.barrier !== undefined) hooks.barrier = { point: arm.barrier };
    if (arm.fail) for (const [k, v] of Object.entries(arm.fail)) hooks.fail[k] = v;
    if (arm.skip) for (const [k, v] of Object.entries(arm.skip)) hooks.skip[k] = v;
    if (arm.kind) for (const [k, v] of Object.entries(arm.kind)) hooks.kind[k] = v;
    if (arm.copyFailure) this.copyFailureSkip = arm.copyFailure === "first" ? 0 : 2; // each buffer reads HEAPU8 for the copy and the clearing
    if (arm.passwordResult !== undefined) this.passwordResult = { value: arm.passwordResult.value };
    if (arm.passwordThrow === true) this.passwordThrow = true;
    if (arm.poolRecords !== undefined) hooks.poolRecords = arm.poolRecords.map((r) => Object.assign({}, r));
  }

  release(): void {
    const hooks = this.module.__zephyrTsTestHooks as Hooks;
    if (hooks.barrier) hooks.barrier.released = true;
  }

  barrierEntered(): boolean {
    const hooks = this.module.__zephyrTsTestHooks as Hooks;
    return hooks.events.some((e) => e.startsWith("barrier-entered:"));
  }

  resetCounters(): void {
    const hooks = this.module.__zephyrTsTestHooks as Hooks;
    hooks.events.length = 0;
    hooks.fail = {};
    hooks.skip = {};
    hooks.kind = {};
    this.copyFailureSkip = -1;
    this.passwordResult = undefined;
    this.passwordThrow = false;
    hooks.poolRecords = undefined;
    this.calls = {};
    this.freed = 0;
    this.doubleFrees = 0;
    if (hooks.buffers) { hooks.buffers.allocated = 0; hooks.buffers.bytes = 0; }
  }

  state(wallets: number | undefined, sampleHeap = true): InstrumentationState {
    const hooks = this.module.__zephyrTsTestHooks as Hooks;
    const buffers = hooks.buffers ?? { allocated: 0, bytes: 0, live: {} };
    return {
      events: hooks.events.filter((e) => !e.startsWith("hook:")).slice(-200),
      allocated: buffers.allocated, freed: this.freed, live: Object.keys(buffers.live).length, doubleFrees: this.doubleFrees,
      injected: hooks.events.filter((e) => e.startsWith("injected:")).length,
      heapInUse: sampleHeap ? this.module.test_heap_in_use() : -1, nativeCalls: Object.assign({}, this.calls), wallets
    };
  }

  /**
   * Queue a native change_wallet_password on the wallet's module queue (as the wallet itself does),
   * beneath the TypeScript check; a native failure rejects with the fixed bridge identifier.
   */
  nativeChangePassword(inner: any, oldPassword: string, newPassword: string): Promise<void> {
    const module = this.module;
    return module.queueTask(async () => {
      if (inner._isClosed) throw ZephyrWalletError.walletClosed();
      const result = await new Promise<unknown>((resolve) => module.change_wallet_password(inner.cppAddress, oldPassword, newPassword, (r: unknown) => resolve(r)));
      if (result === undefined) return;
      const parsed = bridgePasswordErrorOf(result);
      if (parsed.state !== "unchanged") throw new ZephyrWalletError("NATIVE_ERROR", parsed.state === "changed" ? "PASSWORD_CHANGED_WITH_ERROR" : "PASSWORD_STATE_UNKNOWN");
      throw ZephyrWalletError.fromBridge("changePassword", parsed.identifier);
    });
  }
}

/** Inner inherited wallet of a facade wallet (test-only access to a private field). */
export function innerOf(wallet: ZephyrWallet): any {
  return (wallet as unknown as { inner: unknown }).inner;
}

/** Direct-mode instrumentation over the module loaded in this context. */
export class DirectInstrumentation implements Instrumentation {
  readonly mode = "direct" as const;
  async target(wallet: ZephyrWallet): Promise<void> { void wallet; } // one shared module: nothing to select
  async targetUtility(): Promise<void> { /* one shared module */ }
  async armNext(arm: InstrumentationArm): Promise<void> { this.i.arm(arm); }
  async lastStartedState(): Promise<InstrumentationState> { return this.i.state(undefined, true); }
  started(): readonly TrackedWorkerInfo[] { return []; }
  private impl: ModuleInstrumentation | undefined;
  private get i(): ModuleInstrumentation {
    if (!this.impl) this.impl = new ModuleInstrumentation(LibraryUtils.getWasmModule());
    return this.impl;
  }
  async install(): Promise<void> { await LibraryUtils.loadWasmModule(); this.i.install(); }
  async arm(arm: InstrumentationArm): Promise<void> { this.i.arm(arm); }
  async release(): Promise<void> { this.i.release(); }
  async waitBarrierEntered(timeoutMs: number): Promise<boolean> { return waitFor(() => this.i.barrierEntered(), timeoutMs); }
  async state(sampleHeap = true): Promise<InstrumentationState> { return this.i.state(undefined, sampleHeap); }
  async resetCounters(): Promise<void> { this.i.resetCounters(); }
  async nativeChangePassword(wallet: ZephyrWallet, oldPassword: string, newPassword: string): Promise<void> {
    try {
      await this.i.nativeChangePassword(innerOf(wallet), oldPassword, newPassword);
    } catch (err) {
      throw ZephyrWalletError.fromUnknown("changePassword", err); // wallet errors unchanged; no text is read
    }
  }
  async handlePresent(wallet: ZephyrWallet): Promise<boolean> { return innerOf(wallet).cppAddress !== undefined; }
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await predicate()) return true;
    await new Promise((r) => setTimeout(r, 5));
  }
  return predicate();
}

/** Telemetry the test worker posts before each production reply. */
interface Telemetry {
  readonly state: InstrumentationState;
  readonly handles: Record<string, boolean>;
}

interface TrackedWorker {
  readonly index: number;
  readonly name: string | undefined;
  readonly worker: ListenableWorker;
  terminated: boolean;
  readonly nativeEntered: string[];
  readonly nativeLeft: string[];
  telemetry: Telemetry | undefined;
  readonly waiting: Map<string, (resp: unknown) => void>;
}

/**
 * Worker-mode instrumentation. install() sets an SDK worker loader that starts the test
 * worker, tracks it, and posts __testInstall (and an armNext arm) before the SDK's first message,
 * so construction workers are instrumented from their start. Calls go to the targeted worker
 * through test messages; a worker that ended answers from its last telemetry (heap not sampled).
 */
export class WorkerInstrumentation implements Instrumentation {
  readonly mode = "worker" as const;
  private readonly tracked: TrackedWorker[] = [];
  private current: TrackedWorker | undefined = undefined;
  private nextArm: { arm: InstrumentationArm; name?: string } | undefined = undefined;
  /** called synchronously with each started worker's index (tests use it for ordering) */
  onStart: ((index: number) => void) | undefined = undefined;
  /** called synchronously when a started worker reports entering a native construction export */
  onNativeEnter: ((index: number, name: string) => void) | undefined = undefined;
  /** called synchronously on each telemetry message (before the reply it precedes is delivered) */
  onTelemetry: ((index: number) => void) | undefined = undefined;

  async install(): Promise<void> {
    LibraryUtils.setWorkerLoader(() => this.startTracked() as unknown as Worker);
  }

  private startTracked(): ListenableWorker {
    const pre = this.nextArm;
    this.nextArm = undefined;
    const worker = startWorkerAtPath(pre?.name);
    const t: TrackedWorker = { index: this.tracked.length, name: pre?.name, worker, terminated: false, nativeEntered: [], nativeLeft: [], telemetry: undefined, waiting: new Map() };
    this.tracked.push(t);
    const terminate = worker.terminate.bind(worker);
    worker.terminate = () => { t.terminated = true; terminate(); };
    worker.addEventListener("message", (e: { data: unknown }) => {
      const d = e.data;
      if (!Array.isArray(d) || d.length < 2) return;
      if (d[0] === "__telemetry") { t.telemetry = d[1] as Telemetry; if (this.onTelemetry) this.onTelemetry(t.index); return; }
      if (d[0] === "__native" && typeof d[2] === "string") {
        if (d[1] === "enter") { t.nativeEntered.push(d[2]); if (this.onNativeEnter) this.onNativeEnter(t.index, d[2]); }
        else t.nativeLeft.push(d[2]);
        return;
      }
      if (typeof d[1] === "string") { const cb = t.waiting.get(d[1]); if (cb !== undefined) { t.waiting.delete(d[1]); cb(d[2]); } }
    });
    // first the runtime's compiled module, as the SDK posts it (the SDK's own copy that follows is ignored), then the
    // instrumentation, both before the SDK's construction message
    if (LibraryUtils.WASM_COMPILED_VALUE !== undefined) worker.postMessage([LibraryUtils.WASM_MODULE_MESSAGE, LibraryUtils.WASM_COMPILED_VALUE]);
    worker.postMessage([newMessageId(), "__testInstall", newMessageId()]);
    if (pre !== undefined) worker.postMessage([newMessageId(), "__testArm", newMessageId(), pre.arm]);
    if (this.onStart) this.onStart(t.index);
    return worker;
  }

  private trackedOf(worker: unknown): TrackedWorker {
    const t = this.tracked.find((x) => x.worker === worker);
    if (t === undefined) throw new Error("worker not started through the test loader");
    return t;
  }

  private ended(t: TrackedWorker): boolean { return t.terminated; }

  private async callOn(t: TrackedWorker, fn: string, ...args: unknown[]): Promise<any> {
    const callbackId = newMessageId();
    const reply = await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => { t.waiting.delete(callbackId); reject(new Error("test worker did not reply")); }, 60000);
      t.waiting.set(callbackId, (resp) => { clearTimeout(timer); resolve(resp); });
      t.worker.postMessage([newMessageId(), fn, callbackId, ...args]);
    });
    const r = reply as { result?: unknown; error?: { code?: unknown } } | undefined;
    if (r && r.error) throw new Error("test worker error " + String(r.error.code));
    return r ? r.result : undefined;
  }

  private get t(): TrackedWorker {
    if (this.current === undefined) throw new Error("no targeted worker");
    return this.current;
  }

  async target(wallet: ZephyrWallet): Promise<void> { this.current = this.trackedOf(channelOf(wallet).worker); }
  async targetUtility(): Promise<void> { this.current = this.trackedOf(LibraryUtils.getUtilityChannel().worker); }
  async armNext(arm: InstrumentationArm, name?: string): Promise<void> { this.nextArm = { arm, name }; }
  /** start the next worker with this name (startup-failure tests), without an arm */
  nameNext(name: string): void { this.nextArm = { arm: {}, name }; }
  async lastStartedState(): Promise<InstrumentationState> {
    const t = this.tracked[this.tracked.length - 1];
    if (t === undefined) throw new Error("no worker started");
    return this.stateOf(t, true);
  }
  started(): readonly TrackedWorkerInfo[] {
    return this.tracked.map((t) => ({ index: t.index, name: t.name, terminated: t.terminated, nativeEntered: t.nativeEntered.slice(), nativeLeft: t.nativeLeft.slice(), telemetry: t.telemetry ? t.telemetry.state : undefined }));
  }
  /** the tracked worker of a wallet (test access) */
  workerIndexOf(wallet: ZephyrWallet): number { return this.trackedOf(channelOf(wallet).worker).index; }
  /** post a raw test message to a started worker without waiting (crash injection) */
  postTo(index: number, message: unknown): void { this.tracked[index].worker.postMessage(message); }

  private async stateOf(t: TrackedWorker, sampleHeap: boolean): Promise<InstrumentationState> {
    if (this.ended(t)) {
      if (t.telemetry === undefined) throw new Error("ended worker without telemetry");
      return t.telemetry.state;
    }
    return this.callOn(t, "__testState", sampleHeap);
  }

  async arm(arm: InstrumentationArm): Promise<void> { await this.callOn(this.t, "__testArm", arm); }
  async release(): Promise<void> { await this.callOn(this.t, "__testRelease"); }
  async waitBarrierEntered(timeoutMs: number): Promise<boolean> { return waitFor(async () => (await this.callOn(this.t, "__testBarrierEntered")) === true, timeoutMs); }
  async state(sampleHeap = true): Promise<InstrumentationState> { return this.stateOf(this.t, sampleHeap); }
  async resetCounters(): Promise<void> { await this.callOn(this.t, "__testReset"); }
  async nativeChangePassword(wallet: ZephyrWallet, oldPassword: string, newPassword: string): Promise<void> {
    const r = await postRawWorkerMessage([newMessageId(), "__testNativeChangePassword", newMessageId(), walletIdOf(wallet), oldPassword, newPassword], 120000, wallet);
    if (!r.replied) throw new Error("test worker did not reply");
    if (r.error) throw ZephyrWalletError.fromEnvelope(r.error);
  }
  async handlePresent(wallet: ZephyrWallet): Promise<boolean> {
    const t = this.trackedOf(channelOf(wallet).worker);
    const id = walletIdOf(wallet);
    if (this.ended(t)) return t.telemetry !== undefined && t.telemetry.handles[id] === true;
    return (await this.callOn(t, "__testHandlePresent", id)) === true;
  }
}

/** Worker wallet id of a proxied wallet (test-only access). */
export function walletIdOf(wallet: ZephyrWallet): string {
  const proxy = innerOf(wallet).walletProxy;
  if (!proxy || typeof proxy.walletId !== "string") throw new Error("not a worker wallet");
  return proxy.walletId;
}

/**
 * Load the test module from a file in Node: its location and the digest the build wrote beside it
 * (dist/zephyr.test.wasm and dist/zephyr.test.digest.js), so that the production integrity check
 * compares the test module with its own build digest.
 */
export function useTestModuleFile(wasmFile: string): void {
  const digestFile = wasmFile.replace(/\.wasm$/, ".digest.js");
  LibraryUtils.WASM_DIGEST_LOADER = () => require(digestFile);
  LibraryUtils.setWasmModuleLocation(wasmFile);
}

/** Make a loaded test module the context's wasm module before anything loads the release one. */
export async function useTestModule(glue?: () => unknown, wasmLocation?: string): Promise<void> {
  // the instrumented module goes through the production loading path: its glue instantiates the
  // runtime's compiled test module (compiled here, or posted to this worker by its parent context)
  if (glue !== undefined) LibraryUtils.WASM_GLUE_LOADER = glue;
  if (wasmLocation !== undefined) useTestModuleFile(wasmLocation);
  const module = await LibraryUtils.loadWasmModule();
  if (typeof module.test_heap_in_use !== "function") throw new Error("not the instrumented test module");
}
