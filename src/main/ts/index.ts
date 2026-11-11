/**
 * Entry module of the package @loki-notfound/zephyr-ts: the supported wallet surface. Node.js loads
 * its CommonJS build; browser bundlers load index.browser.ts, which exports the same names.
 *
 * Wallet lifecycle: random, seed and keys creation, open from keys and cache bytes, address and key
 * getters, byte serialization, pathless password change and close. Every other capability is
 * rejected with UNSUPPORTED_CAPABILITY before any native symbol or worker function is used.
 * SDK-owned identifiers carry Zephyr names; core, wire-format and upstream provenance names are
 * unchanged. Test-only hooks and raw worker messaging are not part of this entry.
 *
 * WebAssembly module: zephyr.wasm ships as a separate file. Each runtime (a Node main thread, a
 * browser page) compiles it once, at the first construction, and posts the compiled module to every
 * wallet worker it starts; direct mode instantiates the same compiled module. Before compiling, the
 * bytes are checked against the SHA-256 of zephyr.wasm that the build embedded in the JavaScript;
 * a different file rejects with NATIVE_ERROR/WASM_MODULE_MISMATCH (this detects a stale or
 * mismatched file; it is not a signature), and a runtime without the Web Crypto digest (a page
 * outside a secure context) with NATIVE_ERROR/WASM_MODULE_UNVERIFIED. See setWasmModuleUrl.
 *
 * Worker isolation: with proxyToWorker (the default) every construction runs in its own new worker
 * and WebAssembly instance, which the returned wallet owns exclusively and which is terminated
 * after a successful close. A failed construction discards only its worker, including memory a
 * failed core constructor leaked there. At most two constructions run at once; further
 * constructions wait in FIFO order (live wallets do not count). Each live proxied wallet keeps its
 * own instance, so memory grows with the number of open wallets, and workers share their host
 * process: this is not a process or hard memory bound. With proxyToWorker: false all wallets share
 * one instance in the calling context and nothing is isolated: a failed construction there leaks
 * into that context.
 *
 * Read-only network access, full wallets only: a daemon address at construction (config field
 * server) or through setDaemonConnection; isConnectedToDaemon, getDaemonHeight, getHeight, one
 * blocking sync and the asset balance maps. Construction itself is offline; the daemon is set right
 * after it, and if that step fails the wallet is closed and its worker retired before the
 * construction rejects. A new random wallet whose daemon answers the connection check starts at the
 * daemon height; without a daemon it keeps the core's date-based estimate. The address contract is
 * in common/ZephyrDaemonAddress.ts: http or https, host, optional port, optional base path;
 * credentials, proxies, certificate settings and an untrusted flag are rejected; every daemon is
 * treated as trusted by the fixed core. Only requests to a configured daemon route are sent (request
 * allowlist in HttpClient, per context and worker). Daemon failures reject with DAEMON_ERROR and a
 * fixed diagnostic; text supplied by a node never reaches an error. Each request is bounded (JSON
 * at most 30 s, binary at most 120 s, the core's shorter bound where it has one); there is no
 * native cancellation, and a wallet's other calls, close included, wait for a running request.
 * Not supported: listeners, background sync, history, outputs, transactions, key images, rescans
 * and any relay.
 */
export {
  ZephyrWallet,
  createRandomWallet,
  restoreWalletFromSeed,
  restoreWalletFromKeys,
  createKeysWallet,
  openWalletData,
  validateAddress,
  setWorkerDistPath,
  setWasmModuleUrl,
  terminateWorker
} from "./wallet/ZephyrWallet";
export type {
  ZephyrWalletData,
  ZephyrDaemonConnection,
  ZephyrWalletSyncResult,
  ZephyrWalletConstructionOptions,
  ZephyrNetworkTypeInput
} from "./wallet/ZephyrWallet";
export type { ZephyrAssetBalances, ZephyrAccountBalances } from "./common/ZephyrBalances";
export { default as ZephyrWalletError } from "./common/ZephyrWalletError";
export type { ZephyrWalletErrorCode, ZephyrWalletErrorDiagnostic } from "./common/ZephyrWalletError";
