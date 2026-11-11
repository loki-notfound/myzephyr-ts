/**
 * Dedicated wallet workers of the SDK.
 *
 * Ownership model:
 * - Every proxied wallet construction (open from bytes, seed/keys restore, random creation, full
 *   or keys-only) starts a fresh worker with its own WebAssembly instance. The worker admits that
 *   one construction only (ZephyrWebWorker rejects any other construction message).
 * - On construction failure the SDK discards only that worker: its pending requests settle, its
 *   callbacks and registry entry are removed and its construction slot is released. Memory that
 *   a failed core constructor leaked inside that instance is discarded with the worker.
 * - On success the worker is handed to the returned wallet, which owns it exclusively. It is
 *   terminated immediately after a successful native close; a failed close keeps it for a retry.
 * Neither a failed construction nor a close waits for any further message to
 *   the worker, so a stalled worker cannot delay them; network guard counts are read by
 *   the test layer before closing.
 * - Utilities (address validation, log level, network guard report) use one separate utility
 *   worker that never owns a wallet.
 * - At most MAX_CONCURRENT_CONSTRUCTIONS constructions run at once per SDK runtime; further
 *   constructions wait in FIFO order. Live wallets do not hold a slot. There is no pooling, no
 *   automatic retry and no reset or reuse of a worker that holds or held a wallet.
 *
 * Cancellation: an optional caller AbortSignal applies to the construction only. A pre-aborted
 * signal rejects before a slot or worker is taken; an abort while queued leaves the queue; an
 * abort while the construction runs (including synchronous native execution inside the worker)
 * terminates only that construction worker from the caller context. Once the construction has
 * succeeded and the worker is handed to the wallet, the signal is detached and can never affect
 * the live wallet. Caller cancellation rejects with NATIVE_ERROR/CONSTRUCTION_ABORTED.
 *
 * Worker failures: a worker that cannot be started, reports an uncaught error, cannot deserialize
 * a message or exits without being terminated by the SDK is failed: every pending request settles
 * exactly once with NATIVE_ERROR/WORKER_FAILED and the worker is terminated. No error text, stack,
 * abort reason or event object is read or forwarded.
 *
 * This is worker (thread and WebAssembly instance) isolation, not process isolation: browser
 * dedicated workers and Node worker threads share their host process, and the host can still run
 * out of memory. Direct mode (no worker) shares one instance per context and isolates nothing.
 */
import GenUtils from "./GenUtils";
import ZephyrWalletError from "./ZephyrWalletError";
import { isWorkerId } from "./ZephyrLifecycleContract";

/** Concurrent proxied constructions per SDK runtime (bounds the workers that construct at once). */
export const MAX_CONCURRENT_CONSTRUCTIONS = 2;

/** Minimal worker interface used by the SDK (browser Worker, web-worker in Node, Deno Worker). */
export interface ZephyrWorkerLike {
  postMessage(message: unknown): void;
  terminate(): void;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onmessageerror?: ((event: unknown) => void) | null;
  onclose?: ((event: unknown) => void) | null;
}

export type ZephyrWorkerRole = "utility" | "construction" | "wallet";
export type ZephyrWorkerState = "open" | "terminated" | "failed";

type CallbackEntry = ((...args: unknown[]) => unknown) | [(...args: unknown[]) => unknown, unknown];

interface PendingRequest {
  readonly objectId: string;
  readonly callbackId: string;
  readonly reject: (reason: unknown) => void;
}

/** Network guard counts of one worker (getNetworkGuardReport reply, validated). */
export interface ZephyrWorkerGuardCounts {
  readonly blockedRequests: number;
  readonly blockedRequestSummary: Readonly<Record<string, number>>;
  /** Requests sent to a configured daemon route */
  readonly allowedRequests: number;
  readonly allowedRequestSummary: Readonly<Record<string, number>>;
}

/** Accounting of SDK-owned workers and admission state (counts only). */
export interface ZephyrWorkerAccounting {
  readonly utilityWorkers: number;
  readonly constructionWorkers: number;
  readonly walletWorkers: number;
  readonly activeConstructions: number;
  readonly queuedConstructions: number;
  readonly pendingRequests: number;
  readonly registeredObjects: number;
  readonly registeredCallbacks: number;
  /** workers started and registered */
  readonly workersStarted: number;
  /** started workers terminated by the SDK */
  readonly workersTerminated: number;
  /** started workers that failed (uncaught error, message error, unexpected exit) */
  readonly workersFailed: number;
  /** worker starts that failed before a worker existed (loader error, missing script) */
  readonly startFailures: number;
}

function workerFailed(): ZephyrWalletError { return new ZephyrWalletError("NATIVE_ERROR", "WORKER_FAILED"); }
function constructionAborted(): ZephyrWalletError { return new ZephyrWalletError("NATIVE_ERROR", "CONSTRUCTION_ABORTED"); }

/**
 * One SDK-owned worker: request/reply routing, callbacks, failure detection and termination.
 * Every request settles exactly once: by its reply, or by termination or failure of the worker.
 */
export class ZephyrWorkerChannel {

  readonly worker: ZephyrWorkerLike;
  private roleValue: ZephyrWorkerRole;
  private stateValue: ZephyrWorkerState = "open";
  private readonly objects: Record<string, { callbacks: Record<string, CallbackEntry> }> = Object.create(null);
  private readonly pending = new Map<string, PendingRequest>();
  private readonly endedListeners: Array<() => void> = [];
  private readonly idleListeners: Array<() => void> = [];

  constructor(worker: ZephyrWorkerLike, role: ZephyrWorkerRole) {
    this.worker = worker;
    this.roleValue = role;
    worker.onmessage = (event: { data: unknown }) => this.receive(event);
    worker.onerror = () => this.fail();          // event content (text, file, stack) is never read
    worker.onmessageerror = () => this.fail();   // a reply that cannot be deserialized is lost: fail the worker
    worker.onclose = () => this.fail();          // web-worker (Node) exit without SDK termination
  }

  get role(): ZephyrWorkerRole { return this.roleValue; }
  get state(): ZephyrWorkerState { return this.stateValue; }
  isOpen(): boolean { return this.stateValue === "open"; }

  /** @internal ownership transfer from construction to the returned wallet */
  handOff(): void { if (this.roleValue === "construction") this.roleValue = "wallet"; }

  /** Number of requests awaiting a reply. */
  pendingCount(): number { return this.pending.size; }

  /** Number of registered objects and callbacks (including request callbacks). */
  registrationCounts(): { objects: number; callbacks: number } {
    let callbacks = 0;
    const keys = Object.keys(this.objects);
    for (const k of keys) callbacks += Object.keys(this.objects[k].callbacks).length;
    return { objects: keys.length, callbacks };
  }

  /** Register a callback the worker may invoke (listeners); removed when the worker ends. */
  addCallback(objectId: string, callbackId: string, callback: CallbackEntry): void {
    if (!this.isOpen()) return;
    this.objectOf(objectId).callbacks[callbackId] = callback;
  }

  removeCallback(objectId: string, callbackId: string): void {
    if (!Object.prototype.hasOwnProperty.call(this.objects, objectId)) return;
    const callbacks = this.objects[objectId].callbacks;
    delete callbacks[callbackId];
    if (Object.keys(callbacks).length === 0) delete this.objects[objectId]; // an object is only a container of callbacks
  }

  removeObject(objectId: string): void {
    delete this.objects[objectId];
  }

  /** Call a function once no request is pending (at once if none is); also called if the worker ends. */
  onIdle(listener: () => void): void {
    if (this.stateValue !== "open" || this.pending.size === 0) { listener(); return; }
    this.idleListeners.push(listener);
  }

  private notifyIdle(): void {
    if (this.pending.size !== 0 || this.idleListeners.length === 0) return;
    const listeners = this.idleListeners.splice(0, this.idleListeners.length);
    for (const l of listeners) l();
  }

  /** Register a function called once when the worker ends (termination or failure). */
  onEnded(listener: () => void): void {
    if (this.stateValue !== "open") { listener(); return; }
    this.endedListeners.push(listener);
  }

  /**
   * Invoke a worker function. Resolves or rejects exactly once: with the strictly validated reply,
   * or with the termination reason / WORKER_FAILED if the worker ends first. A closed channel
   * rejects immediately with the reason of its end.
   */
  invoke(objectId: string | undefined, fnName: string, args: readonly unknown[]): Promise<unknown> {
    if (this.stateValue === "failed") return Promise.reject(workerFailed());
    if (this.stateValue === "terminated") return Promise.reject(ZephyrWalletError.walletClosed());
    const randomObject = objectId === undefined;
    const target = randomObject ? GenUtils.getUUID() : objectId as string;
    const callbackId = GenUtils.getUUID();
    return new Promise<unknown>((resolve, reject) => {
      const key = target + "\u0000" + callbackId;
      this.pending.set(key, { objectId: target, callbackId, reject });
      this.objectOf(target).callbacks[callbackId] = (resp: unknown) => {
        if (!this.pending.delete(key)) return; // already settled by termination or failure
        this.removeCallback(target, callbackId);
        ZephyrWorkerChannel.settleReply(resp, resolve, reject);
        this.notifyIdle();
      };
      try {
        this.worker.postMessage(([target, fnName, callbackId] as unknown[]).concat(args as unknown[]));
      } catch (err) {
        // a value that cannot be cloned: reject this request only, without reading the error
        if (this.pending.delete(key)) {
          this.removeCallback(target, callbackId);
          reject(new ZephyrWalletError("MALFORMED_MESSAGE", "MESSAGE_SHAPE"));
          this.notifyIdle();
        }
      }
    });
  }

  /**
   * Terminate the worker deliberately. Pending requests settle with reasonFactory(); callbacks and
   * objects are removed. Idempotent; a failed worker stays failed.
   */
  terminate(reasonFactory: () => ZephyrWalletError = () => ZephyrWalletError.walletClosed()): void {
    if (this.stateValue !== "open") return;
    this.stateValue = "terminated";
    this.end(reasonFactory);
  }

  /** Mark the worker failed: pending requests settle with WORKER_FAILED and it is terminated. */
  fail(): void {
    if (this.stateValue !== "open") return;
    this.stateValue = "failed";
    this.end(workerFailed);
  }

  private end(reasonFactory: () => ZephyrWalletError): void {
    try { this.worker.terminate(); } catch (err) { /* already gone; nothing is read from the error */ }
    this.worker.onmessage = null;
    const pending = Array.from(this.pending.values());
    this.pending.clear();
    for (const k of Object.keys(this.objects)) delete this.objects[k];
    for (const p of pending) p.reject(reasonFactory());
    const listeners = this.endedListeners.splice(0, this.endedListeners.length);
    for (const l of listeners) l();
    this.idleListeners.length = 0; // an ended worker needs no idle notification
  }

  private objectOf(objectId: string): { callbacks: Record<string, CallbackEntry> } {
    if (!Object.prototype.hasOwnProperty.call(this.objects, objectId)) this.objects[objectId] = { callbacks: Object.create(null) };
    return this.objects[objectId];
  }

  private receive(event: { data: unknown }): void {
    if (this.stateValue !== "open") return;
    const data = event.data;
    // replies that cannot be routed are ignored, so a stray message cannot settle another request; own keys only
    if (!Array.isArray(data) || data.length < 2 || !isWorkerId(data[0]) || !isWorkerId(data[1])) return;
    const own = Object.prototype.hasOwnProperty;
    const object = own.call(this.objects, data[0]) ? this.objects[data[0]] : undefined;
    const entry = object !== undefined && own.call(object.callbacks, data[1]) ? object.callbacks[data[1]] : undefined;
    if (entry === undefined) return;
    if (Array.isArray(entry)) entry[0].apply(entry[1], data.slice(2));
    else entry.apply(undefined, data.slice(2));
  }

  /**
   * Settle one worker reply strictly: undefined, a plain object with exactly the field
   * result, or a plain object with exactly the field error holding a valid envelope. Any other
   * shape, extra field or invalid envelope rejects with MALFORMED_MESSAGE.
   */
  static settleReply(resp: unknown, resolve: (value: unknown) => void, reject: (reason: unknown) => void): void {
    if (resp === undefined) return resolve(undefined);
    const malformed = () => reject(new ZephyrWalletError("MALFORMED_MESSAGE", "MESSAGE_SHAPE"));
    if (resp === null || typeof resp !== "object" || Array.isArray(resp)) return malformed();
    const proto = Object.getPrototypeOf(resp);
    if (proto !== Object.prototype && proto !== null) return malformed();
    const names = Object.getOwnPropertyNames(resp);
    if (names.length !== 1 || Object.getOwnPropertySymbols(resp).length !== 0 || Object.keys(resp).length !== 1) return malformed();
    if (names[0] === "result") return resolve((resp as { result: unknown }).result);
    if (names[0] === "error") return reject(ZephyrWalletError.fromEnvelope((resp as { error: unknown }).error));
    return malformed();
  }
}

interface Waiter {
  readonly grant: () => void;
  readonly reject: (reason: unknown) => void;
}

/** FIFO admission with a fixed number of construction slots. */
export class ZephyrConstructionGate {

  readonly limit: number;
  private active = 0;
  private readonly queue: Waiter[] = [];

  constructor(limit: number) {
    this.limit = limit;
  }

  activeCount(): number { return this.active; }
  queuedCount(): number { return this.queue.length; }

  /**
   * Wait for a slot in FIFO order. Resolves with an idempotent release function. An abort while
   * waiting removes the waiter and rejects with CONSTRUCTION_ABORTED; a pre-aborted signal rejects
   * before waiting.
   */
  acquire(signal: AbortSignal | undefined): Promise<() => void> {
    if (signal !== undefined && signal.aborted) return Promise.reject(constructionAborted());
    return new Promise<() => void>((resolve, reject) => {
      let onAbort: (() => void) | undefined = undefined;
      const waiter: Waiter = {
        grant: () => {
          if (onAbort !== undefined && signal !== undefined) signal.removeEventListener("abort", onAbort);
          this.active++;
          let released = false;
          resolve(() => {
            if (released) return;
            released = true;
            this.active--;
            this.next();
          });
        },
        reject: (reason: unknown) => {
          if (onAbort !== undefined && signal !== undefined) signal.removeEventListener("abort", onAbort);
          reject(reason);
        }
      };
      if (signal !== undefined) {
        onAbort = () => {
          const i = this.queue.indexOf(waiter);
          if (i >= 0) { this.queue.splice(i, 1); waiter.reject(constructionAborted()); }
        };
        signal.addEventListener("abort", onAbort);
      }
      this.queue.push(waiter);
      this.next();
    });
  }

  /** Reject every waiting construction (context shutdown). Active constructions are not counted here. */
  rejectAll(reasonFactory: () => ZephyrWalletError): void {
    const waiters = this.queue.splice(0, this.queue.length);
    for (const w of waiters) w.reject(reasonFactory());
  }

  private next(): void {
    while (this.active < this.limit && this.queue.length > 0) {
      const w = this.queue.shift() as Waiter;
      w.grant();
    }
  }
}

/** Factory that starts one worker instance; throws if the worker cannot be started. */
export type ZephyrWorkerFactory = () => ZephyrWorkerLike;

/** Result of a successful construction: the worker channel now owned by the wallet and its id. */
export interface ZephyrWalletWorkerHandle {
  readonly channel: ZephyrWorkerChannel;
  readonly walletId: string;
}

/**
 * Registry of SDK-owned workers of one runtime (the main context or a page) and the construction
 * gate.
 */
export class ZephyrWalletWorkers {

  private readonly channels = new Set<ZephyrWorkerChannel>();
  private readonly gate = new ZephyrConstructionGate(MAX_CONCURRENT_CONSTRUCTIONS);
  private started = 0;
  private terminated = 0;
  private failed = 0;
  private startFailures = 0;

  /** Start and register one worker; a start failure throws NATIVE_ERROR/WORKER_FAILED. */
  spawn(factory: ZephyrWorkerFactory, role: ZephyrWorkerRole): ZephyrWorkerChannel {
    let worker: ZephyrWorkerLike;
    try {
      worker = factory();
    } catch (err) {
      this.startFailures++;
      throw workerFailed(); // the start error is not read
    }
    if (worker === null || typeof worker !== "object" || typeof worker.postMessage !== "function" || typeof worker.terminate !== "function") {
      this.startFailures++;
      throw workerFailed();
    }
    const channel = new ZephyrWorkerChannel(worker, role);
    this.started++;
    this.channels.add(channel);
    channel.onEnded(() => {
      this.channels.delete(channel);
      if (channel.state === "failed") this.failed++;
      else this.terminated++;
    });
    return channel;
  }

  /** All open SDK-owned channels (utility, construction and wallet workers). */
  openChannels(): ZephyrWorkerChannel[] {
    return Array.from(this.channels).filter((c) => c.isOpen());
  }

  /**
   * Construct a wallet in a fresh worker: wait for a slot (FIFO), start the worker, post the
   * construction as its first message and hand the worker to the caller on success. See the
   * module documentation for failure, abort and race semantics.
   */
  async construct(factory: ZephyrWorkerFactory, fnName: string, args: readonly unknown[], signal: AbortSignal | undefined, logLevel: number): Promise<ZephyrWalletWorkerHandle> {
    if (signal !== undefined && signal.aborted) throw constructionAborted();
    const release = await this.gate.acquire(signal);
    if (signal !== undefined && signal.aborted) { release(); throw constructionAborted(); } // granted and aborted in the same turn
    let channel: ZephyrWorkerChannel;
    try {
      channel = this.spawn(factory, "construction");
    } catch (err) {
      release();
      throw err;
    }
    channel.onEnded(release); // a construction worker that ends releases its slot
    let handedOff = false;
    let aborted = false;
    const onAbort = () => {
      if (handedOff) return;
      aborted = true;
      channel.terminate(constructionAborted); // also stops synchronous native execution in that worker
    };
    if (signal !== undefined) signal.addEventListener("abort", onAbort);
    const walletId = GenUtils.getUUID();
    try {
      const constructed = channel.invoke(walletId, fnName, args); // the construction is the worker's first message
      if (logLevel > 0) channel.invoke(undefined, "setLogLevel", [logLevel]).catch(() => undefined);
      await constructed;
      if (aborted || !channel.isOpen()) throw constructionAborted(); // abort or end after the success reply, before hand-off
      handedOff = true;
      if (signal !== undefined) signal.removeEventListener("abort", onAbort);
      channel.handOff();
      release(); // the live wallet does not hold a construction slot
      return { channel, walletId };
    } catch (err) {
      if (signal !== undefined) signal.removeEventListener("abort", onAbort);
      channel.terminate(); // discard the construction worker at once (no further message); idempotent if it already ended
      release();
      if (aborted) throw constructionAborted();
      throw err instanceof ZephyrWalletError ? err : ZephyrWalletError.fromUnknown("other", err);
    }
  }

  /**
   * Terminate a wallet worker after its successful native close, at once (no further message is
   * sent first). A failed close never calls this.
   */
  retire(channel: ZephyrWorkerChannel): void {
    channel.terminate();
  }

  /**
   * Retire a worker that may still have requests in flight (the utility worker after a path
   * change): it is terminated once its pending requests have settled, without sending it anything.
   */
  retireWhenIdle(channel: ZephyrWorkerChannel): void {
    channel.onIdle(() => channel.terminate());
  }

  /** Validate a getNetworkGuardReport reply; undefined if it is not a well-formed report. */
  static guardCountsOf(report: unknown): ZephyrWorkerGuardCounts | undefined {
    if (report === null || typeof report !== "object") return undefined;
    const r = report as { blockedRequests?: unknown; blockedRequestSummary?: unknown; allowedRequests?: unknown; allowedRequestSummary?: unknown };
    const count = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
    const summaryOf = (v: unknown): Record<string, number> | undefined => {
      if (v === null || typeof v !== "object") return undefined;
      const out: Record<string, number> = {};
      for (const [k, n] of Object.entries(v as Record<string, unknown>)) { if (!count(n)) return undefined; out[k] = n; }
      return out;
    };
    if (!count(r.blockedRequests) || !count(r.allowedRequests)) return undefined;
    const blockedSummary = summaryOf(r.blockedRequestSummary);
    const allowedSummary = summaryOf(r.allowedRequestSummary);
    if (blockedSummary === undefined || allowedSummary === undefined) return undefined;
    return { blockedRequests: r.blockedRequests, blockedRequestSummary: blockedSummary, allowedRequests: r.allowedRequests, allowedRequestSummary: allowedSummary };
  }

  /**
   * Context shutdown (explicit caller action): reject every queued construction and terminate every
   * SDK-owned worker. Pending construction requests reject with CONSTRUCTION_ABORTED, every other
   * pending request with WALLET_CLOSED. Every live wallet of this runtime loses its worker and
   * native state without a native close; later calls reject with WALLET_CLOSED and close resolves.
   */
  shutdown(): void {
    this.gate.rejectAll(constructionAborted);
    for (const channel of Array.from(this.channels)) {
      if (!channel.isOpen()) continue;
      channel.terminate(channel.role === "construction" ? constructionAborted : () => ZephyrWalletError.walletClosed());
    }
  }

  accounting(): ZephyrWorkerAccounting {
    let utility = 0, construction = 0, wallet = 0, pending = 0, objects = 0, callbacks = 0;
    for (const c of this.channels) {
      if (!c.isOpen()) continue;
      if (c.role === "utility") utility++;
      else if (c.role === "construction") construction++;
      else wallet++;
      pending += c.pendingCount();
      const r = c.registrationCounts();
      objects += r.objects;
      callbacks += r.callbacks;
    }
    return { utilityWorkers: utility, constructionWorkers: construction, walletWorkers: wallet, activeConstructions: this.gate.activeCount(), queuedConstructions: this.gate.queuedCount(),
      pendingRequests: pending, registeredObjects: objects, registeredCallbacks: callbacks, workersStarted: this.started, workersTerminated: this.terminated, workersFailed: this.failed, startFailures: this.startFailures };
  }
}
