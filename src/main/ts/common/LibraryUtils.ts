import assert from "assert";
import GenUtils from "./GenUtils";
import ZephyrError from "./ZephyrError";
import ZephyrWalletError from "./ZephyrWalletError";
import { isLogLevel, LIFECYCLE_NATIVE_EXPORTS, UNBUILT_BRIDGE_EXPORTS, UNBUILT_KEEPALIVE_EXPORTS } from "./ZephyrLifecycleContract";
import { ZephyrWalletWorkerHandle, ZephyrWalletWorkers, ZephyrWorkerAccounting, ZephyrWorkerChannel, ZephyrWorkerLike } from "./ZephyrWalletWorkers";
import ThreadPool from "./ThreadPool";
import path from "path";
import fs from "fs";

/**
 * Collection of helper utilities for the library.
 */
export default class LibraryUtils {

  // static variables
  static LOG_LEVEL = 0;
  static WASM_MODULE: any;
  /** the utility worker (never owns a wallet); undefined until a utility call needs it */
  static WORKER: any;
  /** registry of SDK-owned workers of this runtime: utility, construction and wallet workers */
  static readonly WORKERS = new ZephyrWalletWorkers();
  static UTILITY_CHANNEL: ZephyrWorkerChannel | undefined = undefined;
  static FULL_LOADED: any;
  static REJECT_UNAUTHORIZED_FNS: any;
  static readonly MUTEX = new ThreadPool(1);
  static WORKER_DIST_PATH_DEFAULT = GenUtils.isBrowser() ? "/zephyr.worker.js" : function() {

    // use worker file beside this module when running from dist, else map src to dist
    let curPath = path.normalize(__dirname);
    if (!fs.existsSync(path.join(curPath, "ZephyrWebWorker.js"))) curPath = path.join(curPath, "../../../../dist/src/main/ts/common");
    curPath = LibraryUtils.prefixWindowsPath(path.join(curPath, "./ZephyrWebWorker.js"));
    if (GenUtils.isDeno()) curPath = path.join("file://", curPath);
    return curPath;
  }();
  static WORKER_DIST_PATH = LibraryUtils.WORKER_DIST_PATH_DEFAULT;

  static WORKER_LOADER?: () => Worker = undefined;

  /**
   * Location of the separately shipped WebAssembly module (zephyr.wasm). Browser: a URL, by default
   * "/zephyr.wasm" on the page's origin. Node: the file beside the package's glue (dist/zephyr.wasm).
   */
  static WASM_LOCATION_DEFAULT: string = GenUtils.isBrowser() || !LibraryUtils.isNodeRuntime() ? "/zephyr.wasm" : function() {
    let file = path.join(path.normalize(__dirname), "../../../../zephyr.wasm"); // dist/src/main/ts/common -> dist
    if (!fs.existsSync(file)) file = path.join(path.normalize(__dirname), "../../../../dist/zephyr.wasm"); // running from src
    return file;
  }();
  static WASM_LOCATION: string = LibraryUtils.WASM_LOCATION_DEFAULT;
  /** The compiled module of this runtime (compiled once, then shared with every SDK worker). */
  static WASM_COMPILED: Promise<WebAssembly.Module> | undefined = undefined;
  static WASM_COMPILED_VALUE: WebAssembly.Module | undefined = undefined;
  /** Number of compilations in this context (a context that received a shared module compiles none). */
  static WASM_COMPILATIONS = 0;
  /** Set in an SDK worker: the module must come from the parent context, never from a compilation here. */
  static WASM_SHARED_REQUIRED = false;
  /** Loads the Emscripten glue (factory) that instantiates the module. */
  static WASM_GLUE_LOADER: () => any = () => require("#zephyr-sdk/zephyr.js");
  /**
   * Loads the SHA-256 of zephyr.wasm (lowercase hex) that the build embedded beside the glue
   * (dist/zephyr.digest.js, written by bin/build_ts.sh from the built module).
   */
  static WASM_DIGEST_LOADER: () => unknown = () => require("#zephyr-sdk/zephyr.digest.js");
  static WASM_LOADING: Promise<any> | undefined = undefined;
  /** First message the SDK posts to each of its workers: [WASM_MODULE_MESSAGE, WebAssembly.Module]. */
  static readonly WASM_MODULE_MESSAGE = "zephyr-wasm-module";

  /**
   * Log a message.
   *
   * @param {number} level - log level of the message
   * @param {string} msg - message to log
   */
  static log(level, msg) {
    assert(level === parseInt(level, 10) && level >= 0, "Log level must be an integer >= 0");
    if (LibraryUtils.LOG_LEVEL >= level) console.log(msg);
  }
  
  /**
   * Set the library's log level with 0 being least verbose.
   *
   * @param {number} level - the library's log level
   */
  static async setLogLevel(level) {
    if (!isLogLevel(level)) throw new ZephyrWalletError("INVALID_CONFIG", "LOG_LEVEL_RANGE"); // bridge int parameter
    LibraryUtils.LOG_LEVEL = level;
    if (LibraryUtils.WASM_MODULE) ZephyrWalletError.checkBridgeResult("other", LibraryUtils.WASM_MODULE.set_log_level(level)); // "" or a fixed bridge identifier
    // forward to every open SDK-owned worker (utility, construction and wallet workers); the first failure is reported
    const results = await Promise.allSettled(LibraryUtils.WORKERS.openChannels().map((c) => c.invoke(undefined, "setLogLevel", [level])));
    for (const r of results) if (r.status === "rejected") throw r.reason instanceof ZephyrWalletError ? r.reason : ZephyrWalletError.fromUnknown("other", r.reason);
  }
  
  /**
   * Get the library's log level.
   *
   * @return {number} the library's log level
   */
  static getLogLevel(): number {
    return LibraryUtils.LOG_LEVEL;
  }
  
  /**
   * Get the total memory used by WebAssembly.
   * 
   * @return {Promise<number>} the total memory used by WebAssembly
   */
  static async getWasmMemoryUsed(): Promise<number> {
    let total = 0;
    if (LibraryUtils.WORKER) total += await LibraryUtils.invokeWorker(undefined, "getWasmMemoryUsed", []) as number;
    if (LibraryUtils.getWasmModule() && LibraryUtils.getWasmModule().HEAP8) total += LibraryUtils.getWasmModule().HEAP8.length;
    return total;
  }
  
  /**
   * Get the WebAssembly module in the current context (nodejs, browser main thread or worker).
   */
  static getWasmModule() {
    return LibraryUtils.WASM_MODULE;
  }
  
  /** Whether this context is Node (main thread or worker thread), not a browser bundle. */
  static isNodeRuntime(): boolean {
    return typeof process !== "undefined" && process !== null && typeof process.versions === "object" && process.versions !== null && typeof process.versions.node === "string";
  }

  /**
   * Set where the WebAssembly module is loaded from: a URL in the browser (default "/zephyr.wasm"),
   * a file path in Node (default: the file shipped in the package). A compiled module of the old
   * location is dropped; wallets that already exist keep the instance they have.
   */
  static setWasmModuleLocation(location?: string): void {
    if (location !== undefined && (typeof location !== "string" || location.length === 0)) throw new ZephyrWalletError("INVALID_CONFIG", "FIELD_TYPE");
    const next = location === undefined ? LibraryUtils.WASM_LOCATION_DEFAULT : LibraryUtils.prefixWindowsPath(location);
    if (next === LibraryUtils.WASM_LOCATION) return;
    LibraryUtils.WASM_LOCATION = next;
    LibraryUtils.WASM_COMPILED = undefined;
    LibraryUtils.WASM_COMPILED_VALUE = undefined;
    LibraryUtils.retireUtilityWorker(); // the utility worker holds the module of the old location
  }

  /**
   * Accept the module the parent context posts as an SDK worker's first message. Returns true if the
   * message has the module message's shape; it is then consumed. The module is adopted only if admit
   * is true (no other message came first) and no module was adopted before.
   */
  static acceptSharedWasmModule(data: unknown, admit: boolean): boolean {
    if (!Array.isArray(data) || data.length !== 2 || data[0] !== LibraryUtils.WASM_MODULE_MESSAGE) return false;
    if (admit && LibraryUtils.WASM_COMPILED_VALUE === undefined && typeof WebAssembly === "object" && data[1] instanceof WebAssembly.Module) {
      LibraryUtils.WASM_COMPILED_VALUE = data[1];
      LibraryUtils.WASM_COMPILED = Promise.resolve(data[1]);
    }
    return true; // a repeated or malformed module message is consumed and never dispatched
  }

  /**
   * The compiled module of this runtime: compiled once from WASM_LOCATION and shared with every
   * SDK worker. A failed load is not cached, so a later call tries again. The bytes are checked
   * against the SHA-256 the build embedded before they are compiled. Fixed diagnostics:
   * NATIVE_ERROR/WASM_MODULE_UNAVAILABLE (the file could not be read or fetched),
   * NATIVE_ERROR/WASM_MODULE_UNVERIFIED (this runtime offers no Web Crypto digest, so the bytes
   * cannot be checked), NATIVE_ERROR/WASM_MODULE_MISMATCH (the bytes are not the zephyr.wasm of
   * this build) and NATIVE_ERROR/WASM_MODULE_REJECTED (the right bytes do not compile in this
   * runtime, e.g. compilation refused by a Content-Security-Policy without 'wasm-unsafe-eval').
   */
  static getCompiledWasmModule(): Promise<WebAssembly.Module> {
    if (LibraryUtils.WASM_COMPILED !== undefined) return LibraryUtils.WASM_COMPILED;
    if (LibraryUtils.WASM_SHARED_REQUIRED) return Promise.reject(new ZephyrWalletError("NATIVE_ERROR", "WASM_MODULE_UNAVAILABLE"));
    const attempt = LibraryUtils.compileWasmModule(LibraryUtils.WASM_LOCATION);
    LibraryUtils.WASM_COMPILED = attempt;
    attempt.then((compiled) => {
      if (LibraryUtils.WASM_COMPILED === attempt) LibraryUtils.WASM_COMPILED_VALUE = compiled;
    }, () => {
      if (LibraryUtils.WASM_COMPILED === attempt) LibraryUtils.WASM_COMPILED = undefined;
    });
    return attempt;
  }

  protected static async compileWasmModule(location: string): Promise<WebAssembly.Module> {
    let bytes: ArrayBuffer;
    try {
      if (LibraryUtils.isNodeRuntime() && !/^https?:/i.test(location)) {
        const file: Uint8Array = await fs.promises.readFile(location.indexOf("file://") === 0 ? new URL(location) : location);
        bytes = file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength) as ArrayBuffer;
      } else {
        const response = await fetch(location, { credentials: "same-origin" });
        if (!response.ok) throw new Error("status");
        bytes = await response.arrayBuffer();
      }
    } catch (err) {
      throw new ZephyrWalletError("NATIVE_ERROR", "WASM_MODULE_UNAVAILABLE"); // the read or fetch error is not read
    }
    await LibraryUtils.verifyWasmModule(bytes); // before compiling, once per runtime (compilation happens once)
    LibraryUtils.WASM_COMPILATIONS++;
    try {
      return await WebAssembly.compile(bytes);
    } catch (err) {
      throw new ZephyrWalletError("NATIVE_ERROR", "WASM_MODULE_REJECTED");
    }
  }

  /**
   * Integrity pin: the bytes must have the SHA-256 that the build embedded in the JavaScript. This
   * detects a stale, mismatched or damaged zephyr.wasm beside this release's JavaScript (for
   * example an old file left in a cache); it is not a signature and does not authenticate the
   * release. The digest is computed with the Web Crypto API (Node.js 22, and browsers in a secure
   * context: https or localhost). Without it (a page on a plain http origin other than localhost)
   * the module is rejected with WASM_MODULE_UNVERIFIED; a missing or malformed embedded digest and
   * a different digest reject with WASM_MODULE_MISMATCH. Nothing is compiled in either case.
   */
  protected static async verifyWasmModule(bytes: ArrayBuffer): Promise<void> {
    let expected: unknown = undefined;
    try { expected = LibraryUtils.WASM_DIGEST_LOADER(); } catch (err) { expected = undefined; }
    if (typeof expected !== "string" || !/^[0-9a-f]{64}$/.test(expected)) throw new ZephyrWalletError("NATIVE_ERROR", "WASM_MODULE_MISMATCH");
    let subtle: SubtleCrypto | undefined = undefined;
    try {
      const webCrypto = typeof globalThis === "object" && globalThis !== null ? (globalThis as { crypto?: Crypto }).crypto : undefined;
      if (webCrypto !== undefined && webCrypto !== null && typeof webCrypto.subtle === "object" && webCrypto.subtle !== null && typeof webCrypto.subtle.digest === "function") subtle = webCrypto.subtle;
    } catch (err) {
      subtle = undefined;
    }
    if (subtle === undefined) throw new ZephyrWalletError("NATIVE_ERROR", "WASM_MODULE_UNVERIFIED");
    let actual: string | undefined = undefined;
    try {
      const digest = new Uint8Array(await subtle.digest("SHA-256", bytes));
      actual = Array.from(digest, (b) => (b < 16 ? "0" : "") + b.toString(16)).join("");
    } catch (err) {
      throw new ZephyrWalletError("NATIVE_ERROR", "WASM_MODULE_UNVERIFIED"); // the digest could not be computed in this runtime
    }
    if (actual !== expected) throw new ZephyrWalletError("NATIVE_ERROR", "WASM_MODULE_MISMATCH");
  }

  /**
   * Instantiate the glue with a compiled module (the glue neither fetches nor compiles). An
   * instantiation failure (a module that does not belong to this glue) and a module without the
   * lifecycle exports reject with NATIVE_ERROR/WASM_MODULE_REJECTED.
   */
  protected static instantiateWasmModule(factory: any, compiled: WebAssembly.Module): Promise<any> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const rejected = () => { if (!settled) { settled = true; reject(new ZephyrWalletError("NATIVE_ERROR", "WASM_MODULE_REJECTED")); } };
      let ready: Promise<any>;
      try {
        if (typeof factory !== "function") throw new Error("glue");
        ready = factory({
          instantiateWasm: (imports: WebAssembly.Imports, receive: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void) => {
            WebAssembly.instantiate(compiled, imports).then((instance) => receive(instance, compiled)).catch(rejected); // also a glue failure on a foreign instance
            return {}; // asynchronous instantiation
          }
        });
      } catch (err) {
        rejected();
        return;
      }
      Promise.resolve(ready).then((module) => {
        if (settled) return;
        if (module === null || typeof module !== "object" || LIFECYCLE_NATIVE_EXPORTS.some((name) => typeof module[name] !== "function")) return rejected();
        settled = true;
        resolve(module);
      }, rejected);
    });
  }

  /**
   * Load the WebAssembly module of this context once: the runtime's compiled module (or the one
   * the parent context posted to this SDK worker), instantiated by the glue.
   */
  static async loadWasmModule() {
    if (LibraryUtils.WASM_MODULE && LibraryUtils.FULL_LOADED) return LibraryUtils.WASM_MODULE;
    if (LibraryUtils.WASM_LOADING === undefined) {
      const loading = (async () => {
        const compiled = await LibraryUtils.getCompiledWasmModule();
        let factory: any;
        try { factory = LibraryUtils.WASM_GLUE_LOADER(); } catch (err) { throw new ZephyrWalletError("NATIVE_ERROR", "WASM_MODULE_UNAVAILABLE"); }
        const module = await LibraryUtils.instantiateWasmModule(factory, compiled);
        delete module.then;
        LibraryUtils.WASM_MODULE = module;
        LibraryUtils.FULL_LOADED = true;
        LibraryUtils.initWasmModule(module);
        return module;
      })();
      LibraryUtils.WASM_LOADING = loading;
      loading.catch(() => { if (LibraryUtils.WASM_LOADING === loading) LibraryUtils.WASM_LOADING = undefined; });
    }
    return LibraryUtils.WASM_LOADING;
  }
  
  /**
   * Register a function by id which informs if unauthorized requests (e.g.
   * self-signed certificates) should be rejected.
   * 
   * @param {string} fnId - unique identifier for the function
   * @param {function} fn - function to inform if unauthorized requests should be rejected
   */
  static setRejectUnauthorizedFn(fnId, fn) {
    if (!LibraryUtils.REJECT_UNAUTHORIZED_FNS) LibraryUtils.REJECT_UNAUTHORIZED_FNS = [];
    if (fn === undefined) delete LibraryUtils.REJECT_UNAUTHORIZED_FNS[fnId];
    else LibraryUtils.REJECT_UNAUTHORIZED_FNS[fnId] = fn;
  }
  
  /**
   * Indicate if unauthorized requests should be rejected.
   * 
   * @param {string} fnId - uniquely identifies the function
   */
  static isRejectUnauthorized(fnId) {
    if (!LibraryUtils.REJECT_UNAUTHORIZED_FNS[fnId]) throw new Error("No function registered with id " + fnId + " to inform if unauthorized reqs should be rejected");
    return LibraryUtils.REJECT_UNAUTHORIZED_FNS[fnId]();
  }
  
  /**
   * Set the path to load the worker. Defaults to "/zephyr.worker.js" in the browser
   * and "./ZephyrWebWorker.js" in node.
   * 
   * @param {string} workerDistPath - path to load the worker
   */
  static setWorkerDistPath(workerDistPath) {
    let path = LibraryUtils.prefixWindowsPath(workerDistPath ? workerDistPath : LibraryUtils.WORKER_DIST_PATH_DEFAULT);
    if (path !== LibraryUtils.WORKER_DIST_PATH) LibraryUtils.retireUtilityWorker(); // new workers use the new path; wallet workers keep theirs
    LibraryUtils.WORKER_DIST_PATH = path;
  }

  /**
   * Set the worker loader closure to customize worker loading.
   * Takes precedence over default loading mechanisms.
   *
   * Could be as simple as `() => new Worker(new URL("monero-ts/dist/zephyr.worker.js", import.meta.url));` for browsers.
   *
   * @param {function} loader - loader function which instantiates a worker
   */
  static setWorkerLoader(loader?: () => Worker): void {
    LibraryUtils.WORKER_LOADER = loader;
  }

  /**
   * Start one new worker instance with the configured loader or path; throws if it cannot be
   * started (the caller maps this to NATIVE_ERROR/WORKER_FAILED without reading the error).
   */
  static newWorkerInstance(): ZephyrWorkerLike {
    const worker = LibraryUtils.startWorker();
    // the runtime's compiled module is the worker's first message; the worker never compiles it again
    if (LibraryUtils.WASM_COMPILED_VALUE !== undefined && worker !== null && typeof worker === "object" && typeof worker.postMessage === "function") {
      worker.postMessage([LibraryUtils.WASM_MODULE_MESSAGE, LibraryUtils.WASM_COMPILED_VALUE]);
    }
    return worker;
  }

  protected static startWorker(): ZephyrWorkerLike {
    if (LibraryUtils.WORKER_LOADER) return LibraryUtils.WORKER_LOADER() as unknown as ZephyrWorkerLike;
    if (GenUtils.isBrowser()) return new Worker(LibraryUtils.WORKER_DIST_PATH) as unknown as ZephyrWorkerLike;
    if (GenUtils.isDeno()) return new Worker(LibraryUtils.WORKER_DIST_PATH, { type: "module" }) as unknown as ZephyrWorkerLike;
    const workerPath: string = LibraryUtils.WORKER_DIST_PATH;
    // web-worker only logs a missing script inside the thread; detect it before starting
    if (!/^[A-Za-z][A-Za-z0-9+.-]*:/.test(workerPath) && !fs.existsSync(workerPath)) throw new ZephyrWalletError("NATIVE_ERROR", "WORKER_FAILED");
    const NodeWorker = require("web-worker"); // import web worker if nodejs
    return new NodeWorker(workerPath) as ZephyrWorkerLike;
  }

  /** The utility worker's channel; started on first use. It never owns a wallet. */
  static getUtilityChannel(): ZephyrWorkerChannel {
    if (LibraryUtils.UTILITY_CHANNEL === undefined || !LibraryUtils.UTILITY_CHANNEL.isOpen()) {
      const channel = LibraryUtils.WORKERS.spawn(() => LibraryUtils.newWorkerInstance(), "utility");
      LibraryUtils.UTILITY_CHANNEL = channel;
      LibraryUtils.WORKER = channel.worker;
      channel.onEnded(() => {
        if (LibraryUtils.UTILITY_CHANNEL === channel) { LibraryUtils.UTILITY_CHANNEL = undefined; LibraryUtils.WORKER = undefined; }
      });
      // apply a log level set before the worker was started, ahead of other calls, without awaiting a reply
      if (LibraryUtils.LOG_LEVEL > 0) channel.invoke(undefined, "setLogLevel", [LibraryUtils.LOG_LEVEL]).catch(() => undefined);
    }
    return LibraryUtils.UTILITY_CHANNEL;
  }

  /**
   * Get the utility worker (wallets no longer share it; each proxied wallet owns its worker).
   *
   * @return {Worker} the utility worker
   */
  static async getWorker() {
    await LibraryUtils.getCompiledWasmModule();
    return LibraryUtils.getUtilityChannel().worker;
  }

  static addWorkerCallback(objectId, callbackId, callbackArgs) {
    LibraryUtils.getUtilityChannel().addCallback(objectId, callbackId, callbackArgs);
  }

  static removeWorkerCallback(objectId, callbackId) {
    if (LibraryUtils.UTILITY_CHANNEL) LibraryUtils.UTILITY_CHANNEL.removeCallback(objectId, callbackId);
  }

  static removeWorkerObject(objectId) {
    if (LibraryUtils.UTILITY_CHANNEL) LibraryUtils.UTILITY_CHANNEL.removeObject(objectId);
  }

  /**
   * Construct a wallet in a fresh dedicated worker: FIFO admission with two construction
   * slots, optional caller AbortSignal for the construction only, failure cleanup of that worker,
   * and hand-off of the worker to the wallet on success. See ZephyrWalletWorkers.
   */
  static async constructWalletInWorker(fnName: string, args: readonly unknown[], signal: AbortSignal | undefined): Promise<ZephyrWalletWorkerHandle> {
    await LibraryUtils.getCompiledWasmModule(); // compiled once per runtime before the first worker starts
    if (signal !== undefined && signal.aborted) throw new ZephyrWalletError("NATIVE_ERROR", "CONSTRUCTION_ABORTED");
    return LibraryUtils.WORKERS.construct(() => LibraryUtils.newWorkerInstance(), fnName, args, signal, LibraryUtils.LOG_LEVEL);
  }

  /** Terminate a wallet's worker at once after its successful native close (never after a failed close). */
  static async retireWalletWorker(channel: ZephyrWorkerChannel): Promise<void> {
    LibraryUtils.WORKERS.retire(channel);
  }

  /** Counts of SDK-owned workers, construction slots and registrations of this runtime. */
  static getWorkerAccounting(): ZephyrWorkerAccounting {
    return LibraryUtils.WORKERS.accounting();
  }

  /**
   * Stop using the current utility worker: later utility calls start a new one. The old worker
   * answers the requests already posted to it and is then terminated, without being sent anything
   * further (the inherited code dropped the reference without terminating the worker).
   */
  static retireUtilityWorker(): void {
    const channel = LibraryUtils.UTILITY_CHANNEL;
    LibraryUtils.UTILITY_CHANNEL = undefined;
    LibraryUtils.WORKER = undefined;
    if (channel) LibraryUtils.WORKERS.retireWhenIdle(channel);
  }

  /**
   * Context shutdown: terminate every SDK-owned worker of this runtime (utility, construction and
   * wallet workers) and reject queued constructions. This is an explicit all-wallet action, as the
   * inherited shared-worker termination was: every live proxied wallet of this runtime loses its
   * native state without a native close (later calls reject with WALLET_CLOSED; close resolves).
   * Pending constructions reject with NATIVE_ERROR/CONSTRUCTION_ABORTED, other pending requests
   * with WALLET_CLOSED. Workers not started by the SDK are not touched.
   */
  static async terminateWorker() {
    LibraryUtils.WORKERS.shutdown();
    LibraryUtils.UTILITY_CHANNEL = undefined;
    LibraryUtils.WORKER = undefined;
  }

  /**
   * Invoke a utility worker function and get the result with error handling.
   * 
   * @param {string} objectId identifies the worker object to invoke (default random id)
   * @param {string} fnName is the name of the function to invoke
   * @param {any[]} [args] are function arguments to invoke with
   * @return {any} resolves with response payload from the worker or an error
   */
  static async invokeWorker(objectId, fnName, args) {
    assert(fnName.length >= 2);
    await LibraryUtils.getCompiledWasmModule(); // the utility worker receives the runtime's compiled module
    try {
      return await LibraryUtils.getUtilityChannel().invoke(objectId, fnName, args === undefined ? [] : GenUtils.listify(args));
    } catch (e: any) {
      throw e instanceof ZephyrWalletError ? e : ZephyrWalletError.fromEnvelope(undefined);
    }
  }

  /**
   * Serialize an error for the worker boundary: only a wallet error envelope (type, code, approved
   * diagnostic). Any other error gets its context's fixed code; no message, stack or cause is posted.
   */
  static serializeError(err) {
    return ZephyrWalletError.fromUnknown("other", err).toEnvelope();
  }

  /** Rebuild a received worker error; anything but an exactly valid envelope is MALFORMED_MESSAGE. */
  protected static deserializeError(serializedErr) {
    return ZephyrWalletError.fromEnvelope(serializedErr);
  }

  /**
   * Settle one worker reply strictly: undefined, a plain object with exactly the field
   * result, or a plain object with exactly the field error holding a valid envelope. Any other
   * shape, extra field or invalid envelope rejects with MALFORMED_MESSAGE.
   */
  static settleWorkerReply(resp: unknown, resolve: (value: unknown) => void, reject: (reason: unknown) => void): void {
    ZephyrWorkerChannel.settleReply(resp, resolve, reject); // the same strict rule for the utility and wallet workers
  }

  static async queueTask<T>(asyncFn: () => Promise<T>): Promise<T> {
    return LibraryUtils.MUTEX.submit(asyncFn);
  }

  static async exists(fs: any, path: string): Promise<boolean> {
    try {
      await fs.access(path);
      return true;
    } catch (err) {
      return false;
    }
  }
  
  // ------------------------------ PRIVATE HELPERS ---------------------------
  
  protected static initWasmModule(wasmModule) {
    for (const name of UNBUILT_BRIDGE_EXPORTS.concat(UNBUILT_KEEPALIVE_EXPORTS)) {
      if (wasmModule[name] === undefined) wasmModule[name] = function() { throw ZephyrWalletError.unsupported("NATIVE_EXPORT"); };
    }
    wasmModule.taskQueue = new ThreadPool(1);
    wasmModule.queueTask = async function(asyncFn) { return wasmModule.taskQueue.submit(asyncFn); }
    if (LibraryUtils.LOG_LEVEL > 0) ZephyrWalletError.checkBridgeResult("other", wasmModule.set_log_level(LibraryUtils.LOG_LEVEL)); // apply log level set before load

    // assign utilities to globalThis
    const HttpClient = typeof require !== 'undefined' ? require("./HttpClient").default : (globalThis as any).HttpClient;
    if (HttpClient) (globalThis as any).HttpClient = HttpClient;
    (globalThis as any).LibraryUtils = LibraryUtils;
    (globalThis as any).GenUtils = GenUtils;

    // fix for next.js: bind the request utility directly to globalThis for emscripten asyncify
    if (!(globalThis as any).request && HttpClient) {
      (globalThis as any).request = async function(options: any) { return HttpClient.request(options); };
    }
  }
  
  protected static prefixWindowsPath(path) {
    if (/^[A-Z]:/.test(path) && path.indexOf("file://") == -1) path = "file://" + path; // prepend e.g. C: paths with file://
    return path;
  }
}
