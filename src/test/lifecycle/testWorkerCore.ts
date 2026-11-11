/**
 * Test-only worker wrapper around the production lifecycle worker: it loads the separately
 * built test module, then answers "__test" messages (instrumentation, barrier release, a native
 * call beneath the TypeScript password pre-check) and passes every other message unchanged to
 * the production dispatcher. Never part of the release worker bundle.
 */
import "../../main/ts/common/ZephyrWebWorker";
import LibraryUtils from "../../main/ts/common/LibraryUtils";
import ZephyrWalletError from "../../main/ts/common/ZephyrWalletError";
import { ModuleInstrumentation, useTestModule } from "./testSupport";

declare const self: any;

export function installTestWorker(testGlue: () => unknown): void {
  // startup-failure injection, selected by the worker name the test loader passes
  if (self.name === "zephyr-ts-startup-exit") {
    if (typeof process !== "undefined" && typeof process.exit === "function") process.exit(3); // Node: the thread exits during start
    self.close(); // browser fallback: stop without a reply
    return;
  }
  if (self.name === "zephyr-ts-startup-throw") throw new Error("injected startup failure"); // uncaught error during script evaluation
  const production = self.onmessage;
  let loading: Promise<void> | undefined;
  let instrumentation: ModuleInstrumentation | undefined;
  const ensureModule = (): Promise<void> => {
    if (!loading) loading = useTestModule(testGlue);
    return loading;
  };
  const tests: Record<string, (...args: any[]) => Promise<unknown>> = {
    __testInstall: async () => {
      instrumentation = new ModuleInstrumentation(LibraryUtils.getWasmModule());
      instrumentation.install();
      instrumentation.onNative = (phase, name) => { productionPost(["__native", phase, name]); }; // posted before a synchronous native construction runs
    },
    __testArm: async (arm) => { instrumentation!.arm(arm); },
    __testRelease: async () => { instrumentation!.release(); },
    __testBarrierEntered: async () => instrumentation!.barrierEntered(),
    __testReset: async () => { instrumentation!.resetCounters(); },
    __testState: async (sampleHeap) => instrumentation!.state(self.WORKER_WALLETS.size, sampleHeap !== false),
    __testHandlePresent: async (walletId) => { const e = self.WORKER_WALLETS.get(walletId); return e !== undefined && e.wallet.cppAddress !== undefined; },
    __testNativeChangePassword: async (walletId, oldPassword, newPassword) => {
      const e = self.WORKER_WALLETS.get(walletId);
      if (e === undefined) throw ZephyrWalletError.walletClosed();
      try {
        await instrumentation!.nativeChangePassword(e.wallet, oldPassword, newPassword);
      } catch (err) {
        throw ZephyrWalletError.fromUnknown("changePassword", err);
      }
    }
  };
  // crafted replies for the strict reply/envelope checks (T08); the marker must never be accepted
  const crafted = (variant: unknown, marker: unknown): unknown => {
    const m = typeof marker === "string" ? marker : "marker";
    switch (variant) {
      case "envelope-message": return { error: { type: "ZephyrWalletError", code: "WRONG_PASSWORD", message: m } };
      case "envelope-stack": return { error: { type: "ZephyrWalletError", code: "NATIVE_ERROR", stack: m } };
      case "envelope-invalid-diagnostic": return { error: { type: "ZephyrWalletError", code: "NATIVE_ERROR", diagnostic: m } };
      case "envelope-undefined-diagnostic": return { error: { type: "ZephyrWalletError", code: "NATIVE_ERROR", diagnostic: undefined } };
      case "reply-extra-field": return { result: 1, note: m };
      case "reply-result-and-error": return { result: 1, error: { type: "ZephyrWalletError", code: "NATIVE_ERROR" } };
      case "reply-not-object": return m;
      case "valid-error": return { error: { type: "ZephyrWalletError", code: "WRONG_PASSWORD" } };
      default: return { result: true };
    }
  };
  // telemetry: before each production reply, post the counters and wallet handles of this
  // worker, so a test can read the final state of a worker the SDK terminates after the reply
  const productionPost = self.postMessage.bind(self);
  self.postMessage = (message: unknown, transfer?: unknown) => {
    if (instrumentation !== undefined && Array.isArray(message) && message.length === 3 && typeof message[0] === "string" && !message[0].startsWith("__")) {
      const handles: Record<string, boolean> = {};
      for (const [id, entry] of self.WORKER_WALLETS) handles[id] = entry.wallet.cppAddress !== undefined;
      // the allocator is sampled only while no native call can be suspended at the test barrier
      const hooks = LibraryUtils.getWasmModule().__zephyrTsTestHooks;
      const suspended = hooks !== undefined && hooks.barrier !== undefined;
      productionPost(["__telemetry", { state: instrumentation.state(self.WORKER_WALLETS.size, !suspended), handles }]);
    }
    return transfer === undefined ? productionPost(message) : productionPost(message, transfer);
  };
  const handle = async (e: MessageEvent) => {
    const data = e.data;
    // the runtime's compiled module arrives first; the production handler adopts it before any load
    if (Array.isArray(data) && data[0] === LibraryUtils.WASM_MODULE_MESSAGE) return production(e);
    await ensureModule();
    if (Array.isArray(data) && data[1] === "__testReply") {
      productionPost([data[0], data[2], crafted(data[3], data[4])]);
      return;
    }
    if (Array.isArray(data) && typeof data[1] === "string" && data[1].startsWith("__test") && Object.prototype.hasOwnProperty.call(tests, data[1])) {
      const [objectId, fnName, callbackId, ...args] = data;
      try {
        productionPost([objectId, callbackId, { result: await tests[fnName](...args) }]);
      } catch (err) {
        productionPost([objectId, callbackId, { error: ZephyrWalletError.fromUnknown("other", err).toEnvelope() }]);
      }
      return;
    }
    return production(e);
  };
  // crash injection (no reply), handled synchronously before any later message: the thread
  // exits (Node), or an uncaught error is thrown from the message handler (browser error event)
  self.onmessage = (e: MessageEvent) => {
    const data = e.data;
    if (Array.isArray(data) && data[1] === "__testCrash") {
      if (data[3] === "exit" && typeof process !== "undefined" && typeof process.exit === "function") process.exit(9);
      throw new Error("injected worker crash");
    }
    return handle(e);
  };
}
