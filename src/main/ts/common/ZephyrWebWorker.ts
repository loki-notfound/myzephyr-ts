import assert from "assert";
import GenUtils from "./GenUtils";
import HttpClient from "./HttpClient";
import LibraryUtils from "./LibraryUtils";
import ZephyrBlock from "../daemon/model/ZephyrBlock";
import ZephyrError from "./ZephyrError";
import ZephyrWalletError, { ZephyrWalletErrorDiagnostic } from "./ZephyrWalletError";
import * as WalletErrors from "./ZephyrWalletErrorMapping";
import { isWorkerId, lifecycleWorkerMethod, validateWorkerArgs } from "./ZephyrLifecycleContract";
import { validateCreateConfig, validateOpenConfig } from "../wallet/model/ZephyrWalletCoreConfig";
import ZephyrKeyImage from "../daemon/model/ZephyrKeyImage";
import ZephyrRpcConnection from "./ZephyrRpcConnection";
import ZephyrTxConfig from "../wallet/model/ZephyrTxConfig";
import ZephyrTxQuery from "../wallet/model/ZephyrTxQuery";
import ZephyrTxSet from "../wallet/model/ZephyrTxSet";
import ZephyrUtils from "./ZephyrUtils";
import ZephyrWalletConfig from "../wallet/model/ZephyrWalletConfig"
import ZephyrWalletListener from "../wallet/model/ZephyrWalletListener"
import {ZephyrWalletKeys} from "../wallet/ZephyrWalletKeys";
import { parseDaemonAddress } from "./ZephyrDaemonAddress";
import { toAccountBalancesDto, toAssetBalancesDto } from "./ZephyrBalancesInternal";
import { toAccountDto, toAddressIndexDto, toSubaddressDto } from "./ZephyrAccountsInternal";
import { checkSelection, toTxDto } from "./ZephyrHistoryInternal";
import { checkTransferRequest, toBuildDto } from "./ZephyrTransferInternal";
import { checkConversionRequest, toConversionDto } from "./ZephyrConversionInternal";
import { checkSweepRequest, toSweepDto } from "./ZephyrSweepInternal";
import { checkRelayToken, toPreparedConversionDto, toPreparedSweepDto, toPreparedTransferDto, toRelayDto } from "./ZephyrRelayInternal";
import { toReserveInfoDto, toSupplyDto } from "./ZephyrReserveInternal";
import { checkSpendProofRequest, checkTxProofRequest } from "./ZephyrProofInternal";
import { NOTIFICATION_CALLBACK_ID, ZephyrNotification, toNotificationDto } from "./ZephyrNotificationsInternal";
import ZephyrWalletFull from "../wallet/ZephyrWalletFull";

declare var self: any;

// deno configuration
declare var DedicatedWorkerGlobalScope: any;
if (GenUtils.isDeno() && typeof self === "undefined" && typeof globalThis === "object" && typeof DedicatedWorkerGlobalScope === "function" && DedicatedWorkerGlobalScope.prototype.isPrototypeOf(globalThis)) {
  self = globalThis;
  (globalThis as any).self = globalThis;
}

// an SDK worker instantiates only the compiled module its parent context posts as the first message
LibraryUtils.WASM_SHARED_REQUIRED = true;

// expose some modules to the worker
self.HttpClient = HttpClient;
self.LibraryUtils = LibraryUtils;
self.GenUtils = GenUtils;

/**
 * Worker to manage a daemon and wasm wallet off the main thread using messages.
 * 
 * Required message format: e.data[0] = object id, e.data[1] = function name, e.data[2+] = function args
 *
 * For browser applications, this file must be browserified and placed in the web app root.
 * 
 * @private
 */
/**
 * Worker dispatcher. Every message is checked against the central capability and
 * argument table (ZephyrLifecycleContract) before any normalization, wallet lookup or native
 * call: routable shape and ids, own-key method lookup, exact argument count and per-argument
 * domains, wallet existence and kind, and duplicate ids for creation. Replies carry only a
 * result or a wallet error envelope (code and approved diagnostic).
 */
self.WORKER_WALLETS = new Map(); // wallet id -> {kind: "full" | "keys", wallet}; own-key safe
self.WORKER_RESERVED_IDS = new Set(); // ids of creations in progress
/**
 * Dedicated wallet worker rule: a worker admits at most one wallet construction, and only
 * as the first routable message it receives. A worker that received any other message first (the
 * SDK's utility worker) never owns a wallet, and a wallet worker never constructs a second wallet,
 * whether its construction failed or succeeded. A later construction message rejects with
 * UNSUPPORTED_CAPABILITY/WORKER_FUNCTION after its arguments and configuration were validated.
 */
self.WORKER_ROUTABLE_MESSAGES = 0;

/** Full configuration check of a construction message before admission (the handler repeats it). */
function validateConstructionMessage(fnName: string, args: unknown[]): void {
  if (fnName === "createWalletFull") validateCreateConfig(args[0], false);
  else if (fnName === "createWalletKeys") validateCreateConfig(args[0], true);
  else if (fnName === "openWalletData") validateOpenConfig({networkType: args[2], password: args[1], keysData: args[3], cacheData: args[4]});
}

const KIND_DIAGNOSTICS: Readonly<Record<string, ZephyrWalletErrorDiagnostic>> = { getRestoreHeight: "KEYS_ONLY_RESTORE_HEIGHT", getData: "KEYS_ONLY_DATA", changePassword: "KEYS_ONLY_PASSWORD", getNetworkType: "KEYS_ONLY_NETWORK_TYPE" };

self.dispatchLifecycleMessage = async function(data: unknown) {
  // a reply is only possible with valid object and callback ids; anything else is dropped
  if (!Array.isArray(data) || data.length < 3 || !isWorkerId(data[0]) || !isWorkerId(data[2])) return;
  const objectId = data[0];
  const fnName = data[1];
  const callbackId = data[2];
  const firstMessage = self.WORKER_ROUTABLE_MESSAGES === 0;
  self.WORKER_ROUTABLE_MESSAGES++;
  const fail = (err: ZephyrWalletError) => postMessage([objectId, callbackId, {error: WalletErrors.toEnvelope(err)}]);
  if (typeof fnName !== "string" || fnName.length === 0) return fail(new ZephyrWalletError("MALFORMED_MESSAGE", "MESSAGE_SHAPE"));
  const method = lifecycleWorkerMethod(fnName);
  if (method === undefined) return fail(WalletErrors.unsupported("WORKER_FUNCTION")); // the name is not echoed
  const args = data.slice(3);
  let reserved = false;
  try {
    validateWorkerArgs(method, args);
    if (method.scope === "wallet") {
      const entry = self.WORKER_WALLETS.get(objectId);
      if (entry === undefined) {
        if (fnName === "isClosed") return postMessage([objectId, callbackId, {result: true}]);
        if (fnName === "close") return postMessage([objectId, callbackId, {result: undefined}]);
        throw WalletErrors.walletClosed();
      }
      if (method.kinds === undefined || !method.kinds.includes(entry.kind)) throw WalletErrors.unsupported(Object.prototype.hasOwnProperty.call(KIND_DIAGNOSTICS, fnName) ? KIND_DIAGNOSTICS[fnName] : "WALLET_KIND");
    } else if (method.scope === "create") {
      validateConstructionMessage(fnName, args);
      if (self.WORKER_WALLETS.has(objectId) || self.WORKER_RESERVED_IDS.has(objectId)) throw new ZephyrWalletError("MALFORMED_MESSAGE", "DUPLICATE_WALLET_ID");
      if (!firstMessage) throw WalletErrors.unsupported("WORKER_FUNCTION"); // one construction per worker, as its first message
      self.WORKER_RESERVED_IDS.add(objectId);
      reserved = true;
    }
    postMessage([objectId, callbackId, {result: await LIFECYCLE_IMPL[fnName](objectId, ...args)}]);
  } catch (err: any) {
    fail(WalletErrors.fromUnknown(method.errorContext, err)); // wallet errors pass unchanged; anything else gets a fixed code
  } finally {
    if (reserved) self.WORKER_RESERVED_IDS.delete(objectId);
  }
}

self.onmessage = async function(e) {
  if (LibraryUtils.acceptSharedWasmModule(e.data, self.WORKER_ROUTABLE_MESSAGES === 0)) return; // admitted only before any routable message; never dispatched
  await self.initOneTime();
  await self.dispatchLifecycleMessage(e.data);
}

// a message this worker could not receive: in the place of the module message it means the module was refused here
self.onmessageerror = function() {
  LibraryUtils.refuseSharedWasmModule(self.WORKER_ROUTABLE_MESSAGES === 0);
}

function walletOf(walletId: string): any {
  return self.WORKER_WALLETS.get(walletId).wallet; // existence and kind checked by the dispatcher
}

/**
 * A full wallet of this worker posts each of its notifications to the wallet's owner as one message
 * [walletId, NOTIFICATION_CALLBACK_ID, dto] (common/ZephyrNotificationsInternal.ts). The owner validates it like an error
 * envelope; the worker never waits for it, so a slow listener of the owner does not slow the scan.
 */
function forwardNotifications(walletId: string, wallet: ZephyrWalletFull): void {
  wallet.setNotificationSink((notification: ZephyrNotification, tag: string | undefined) => {
    try {
      postMessage([walletId, NOTIFICATION_CALLBACK_ID, toNotificationDto(notification, tag)]);
    } catch (ignored) {
      // a message that cannot be posted is lost; nothing unwinds into the core
    }
  });
}

/** Implementations of the table's worker methods; arguments are already validated. */
type LifecycleImpl = (objectId: string, ...args: any[]) => Promise<unknown>;

const LIFECYCLE_IMPL: Readonly<Record<string, LifecycleImpl>> = Object.freeze(Object.assign(Object.create(null), {
  setLogLevel: async (objectId: string, level: number) => LibraryUtils.setLogLevel(level),
  getNetworkGuardReport: async (objectId: string) => self.getNetworkGuardReport(objectId),
  zephyrUtilsValidateAddress: async (objectId: string, address: string, networkType: number) => ZephyrUtils.validateAddress(address, networkType),
  zephyrUtilsGetIntegratedAddress: async (objectId: string, networkType: number, standardAddress: string, paymentId: string | undefined) => (await ZephyrUtils.getIntegratedAddress(networkType, standardAddress, paymentId)).toJson(),
  openWalletData: async (walletId: string, path: unknown, password: string, networkType: number, keysData: Uint8Array, cacheData: Uint8Array | undefined) => {
    const validated = validateOpenConfig({networkType, password, keysData, cacheData}); // path, daemon and regtest checked by the table
    const wallet = await ZephyrWalletFull.openWallet({networkType: validated.networkType, password: validated.password, keysData: validated.keysData, cacheData: validated.cacheData, proxyToWorker: false});
    forwardNotifications(walletId, wallet);
    self.WORKER_WALLETS.set(walletId, {kind: "full", wallet});
  },
  createWalletFull: async (walletId: string, configJson: Record<string, unknown>) => {
    validateCreateConfig(configJson, false); // before normalization: a non-empty path is rejected, never cleared
    const config = new ZephyrWalletConfig(configJson);
    config.setProxyToWorker(false);
    const wallet = await ZephyrWalletFull.createWallet(config);
    forwardNotifications(walletId, wallet);
    self.WORKER_WALLETS.set(walletId, {kind: "full", wallet});
  },
  createWalletKeys: async (walletId: string, configJson: Record<string, unknown>) => {
    validateCreateConfig(configJson, true);
    const config = new ZephyrWalletConfig(configJson);
    config.setProxyToWorker(false);
    const wallet = await ZephyrWalletKeys.createWallet(config);
    self.WORKER_WALLETS.set(walletId, {kind: "keys", wallet});
  },
  isViewOnly: async (walletId: string) => walletOf(walletId).isViewOnly(),
  getNetworkType: async (walletId: string) => walletOf(walletId).getNetworkType(),
  getSeed: async (walletId: string) => walletOf(walletId).getSeed(),
  getSeedLanguage: async (walletId: string) => walletOf(walletId).getSeedLanguage(),
  getSeedLanguages: async (walletId: string) => walletOf(walletId).getSeedLanguages(),
  getPrivateSpendKey: async (walletId: string) => walletOf(walletId).getPrivateSpendKey(),
  getPrivateViewKey: async (walletId: string) => walletOf(walletId).getPrivateViewKey(),
  getPublicViewKey: async (walletId: string) => walletOf(walletId).getPublicViewKey(),
  getPublicSpendKey: async (walletId: string) => walletOf(walletId).getPublicSpendKey(),
  getAddress: async (walletId: string, accountIdx: number, subaddressIdx: number) => walletOf(walletId).getAddress(accountIdx, subaddressIdx),
  getAddressIndex: async (walletId: string, address: string) => toAddressIndexDto(await walletOf(walletId).getAddressIndexChecked(address)),
  getIntegratedAddress: async (walletId: string, standardAddress: string | undefined, paymentId: string | undefined) => (await walletOf(walletId).getIntegratedAddress(standardAddress, paymentId)).toJson(),
  decodeIntegratedAddress: async (walletId: string, integratedAddress: string) => (await walletOf(walletId).decodeIntegratedAddress(integratedAddress)).toJson(),
  getRestoreHeight: async (walletId: string) => walletOf(walletId).getRestoreHeight(),
  getData: async (walletId: string) => walletOf(walletId).getData(),
  changePassword: async (walletId: string, oldPassword: string, newPassword: string) => walletOf(walletId).changePassword(oldPassword, newPassword),
  // read-only daemon access: the address is parsed again from its text; replies are strict DTOs
  setDaemonConnection: async (walletId: string, uri: string | undefined) => walletOf(walletId).setDaemonConnection(uri === undefined ? undefined : parseDaemonAddress(uri).uri),
  isConnectedToDaemon: async (walletId: string) => walletOf(walletId).isConnectedToDaemon(),
  getDaemonHeight: async (walletId: string) => walletOf(walletId).getDaemonHeight(),
  setRestoreHeightFromDaemon: async (walletId: string) => walletOf(walletId).setRestoreHeightFromDaemon(),
  isDaemonSynced: async (walletId: string) => walletOf(walletId).isDaemonSynced(),
  // the reserve and the circulating supply: daemon requests; the replies are strict DTOs (common/ZephyrReserve.ts)
  getReserveInfo: async (walletId: string) => toReserveInfoDto(await walletOf(walletId).getReserveInfoChecked()),
  getCirculatingSupply: async (walletId: string) => toSupplyDto(await walletOf(walletId).getCirculatingSupplyChecked()),
  getHeight: async (walletId: string) => walletOf(walletId).getHeight(),
  sync: async (walletId: string, startHeight: number | undefined, tag: string | undefined) => ZephyrWalletFull.syncResultDto(await walletOf(walletId).syncChecked(startHeight, tag)),
  // notifications and background synchronization: the arguments were validated by the table
  setNotifications: async (walletId: string, enabled: boolean) => { await walletOf(walletId).setNotifying(enabled); },
  startSyncing: async (walletId: string, periodMs: number) => { await walletOf(walletId).startSyncingChecked(periodMs); },
  stopSyncing: async (walletId: string) => { await walletOf(walletId).stopSyncingChecked(); },
  getBalances: async (walletId: string, unlocked: boolean) => toAssetBalancesDto(await walletOf(walletId).getBalanceMap(unlocked)),
  getAccountBalances: async (walletId: string, unlocked: boolean, accountIdx: number) => toAccountBalancesDto(await walletOf(walletId).getAccountBalanceMap(unlocked, accountIdx)),
  getAssetBalance: async (walletId: string, unlocked: boolean, assetType: string, accountIdx: number, subaddressIdx: number | undefined) => (await walletOf(walletId).getAssetBalance(unlocked, assetType, accountIdx, subaddressIdx)).toString(),
  // accounts and subaddresses: strict DTOs (common/ZephyrAccounts.ts)
  getAccounts: async (walletId: string, includeSubaddresses: boolean) => (await walletOf(walletId).getAccountsChecked(includeSubaddresses)).map(toAccountDto),
  getAccount: async (walletId: string, accountIdx: number, includeSubaddresses: boolean) => toAccountDto(await walletOf(walletId).getAccountChecked(accountIdx, includeSubaddresses)),
  createAccount: async (walletId: string, label: string) => toAccountDto(await walletOf(walletId).createAccountChecked(label)),
  getSubaddresses: async (walletId: string, accountIdx: number, indices: number[] | undefined) => (await walletOf(walletId).getSubaddressesChecked(accountIdx, indices)).map(toSubaddressDto),
  createSubaddress: async (walletId: string, accountIdx: number, label: string) => toSubaddressDto(await walletOf(walletId).createSubaddressChecked(accountIdx, label)),
  setSubaddressLabel: async (walletId: string, accountIdx: number, subaddressIdx: number, label: string) => { await walletOf(walletId).setSubaddressLabelChecked(accountIdx, subaddressIdx, label); },
  // read-only history: the selection was validated by the table; the reply is a strict DTO (common/ZephyrHistory.ts)
  getHistory: async (walletId: string, status: string, minHeight: number | undefined, maxHeight: number | undefined, hashes: string[] | undefined) =>
    (await walletOf(walletId).getHistoryChecked(checkSelection(status, minHeight, maxHeight, hashes))).map(toTxDto),
  // explicit pool refresh: a daemon request; the reply is the count of incoming pool transactions
  refreshPool: async (walletId: string) => await walletOf(walletId).refreshPoolChecked(),
  // build, describe and discard same-asset transactions: the request was validated by the table and is checked again
  buildTransfer: async (walletId: string, asset: string, addresses: string[], amounts: string[], accountIdx: number, indices: number[], priority: number) =>
    toBuildDto(await walletOf(walletId).buildTransferChecked(checkTransferRequest(asset, addresses, amounts, accountIdx, indices, priority))),
  // build, describe and discard the one transaction of a conversion: the request was validated by the table and is checked again
  buildConversion: async (walletId: string, sourceAsset: string, destinationAsset: string, address: string, amount: string, accountIdx: number, indices: number[], priority: number) =>
    toConversionDto(await walletOf(walletId).buildConversionChecked(checkConversionRequest(sourceAsset, destinationAsset, address, amount, accountIdx, indices, priority))),
  // prepare (build and keep in the wallet's one slot), relay exactly what was prepared, discard it: requests validated by
  // the table and checked again; the replies are strict DTOs without any byte of a kept transaction
  prepareTransfer: async (walletId: string, asset: string, addresses: string[], amounts: string[], accountIdx: number, indices: number[], priority: number) =>
    toPreparedTransferDto(await walletOf(walletId).prepareTransferChecked(checkTransferRequest(asset, addresses, amounts, accountIdx, indices, priority))),
  prepareConversion: async (walletId: string, sourceAsset: string, destinationAsset: string, address: string, amount: string, accountIdx: number, indices: number[], priority: number) =>
    toPreparedConversionDto(await walletOf(walletId).prepareConversionChecked(checkConversionRequest(sourceAsset, destinationAsset, address, amount, accountIdx, indices, priority))),
  // build and discard, or prepare and keep, a sweep: the request was validated by the table and is checked again
  buildSweepUnlocked: async (walletId: string, asset: string, address: string, accountIdx: number, indices: number[], priority: number) =>
    toSweepDto(await walletOf(walletId).buildSweepChecked(checkSweepRequest(asset, address, accountIdx, indices, priority))),
  prepareSweepUnlocked: async (walletId: string, asset: string, address: string, accountIdx: number, indices: number[], priority: number) =>
    toPreparedSweepDto(await walletOf(walletId).prepareSweepChecked(checkSweepRequest(asset, address, accountIdx, indices, priority))),
  relayPrepared: async (walletId: string, token: string) => toRelayDto(await walletOf(walletId).relayPreparedChecked(checkRelayToken(token))),
  discardPrepared: async (walletId: string, token: string) => await walletOf(walletId).discardPreparedChecked(checkRelayToken(token)),
  // payment proofs and transaction keys: the arguments were validated by the table and are checked again; the replies are
  // the strings the wallet checked for the core's form
  getTxKey: async (walletId: string, txHash: string) => await walletOf(walletId).getTxKeyChecked(checkSpendProofRequest(txHash, undefined).txHash),
  getTxProof: async (walletId: string, txHash: string, address: string, message: string) => await walletOf(walletId).getTxProofChecked(checkTxProofRequest(txHash, address, message)),
  getSpendProof: async (walletId: string, txHash: string, message: string) => {
    const r = checkSpendProofRequest(txHash, message);
    return await walletOf(walletId).getSpendProofChecked(r.txHash, r.message);
  },
  isClosed: async (walletId: string) => walletOf(walletId).isClosed(),
  prepareClose: async (walletId: string) => walletOf(walletId).prepareClose(),
  close: async (walletId: string) => {
    await walletOf(walletId).close(false); // on failure the entry stays for a retry; the handle is not freed
    self.WORKER_WALLETS.delete(walletId);
  }
}));

self.initOneTime = async function() {
  if (!self.isInitialized) {
    self.WORKER_OBJECTS = Object.create(null); // inherited functions outside the supported surface are unreachable
    self.isInitialized = true;
    ZephyrUtils.PROXY_TO_WORKER = false;
  }
}

// --------------------------- STATIC UTILITIES -------------------------------

self.httpRequest = async function(objectId, opts) {
  try {
    return await HttpClient.request(Object.assign(opts, {proxyToWorker: false}));  
  } catch (err: any) {
    throw err.statusCode ? new Error(JSON.stringify({statusCode: err.statusCode, statusMessage: err.message})) : err;
  }
}

self.getNetworkGuardReport = async function(objectId: string) {
  let threadId: number | undefined = undefined;
  if (!GenUtils.isBrowser()) {
    try { threadId = require("worker_threads").threadId; } catch (err) { threadId = undefined; }
  }
  return {networkEnabled: HttpClient.NETWORK_ENABLED, blockedRequests: HttpClient.BLOCKED_REQUESTS, blockedRequestSummary: Object.assign({}, HttpClient.BLOCKED_REQUEST_SUMMARY),
    allowedRequests: HttpClient.ALLOWED_REQUESTS, allowedRequestSummary: Object.assign({}, HttpClient.ALLOWED_REQUEST_SUMMARY), daemonRoutes: HttpClient.daemonRouteCount(),
    globalScope: Object.prototype.toString.call(self), hasImportScripts: typeof (self as any).importScripts === "function", threadId: threadId, wasmLoaded: LibraryUtils.getWasmModule() !== undefined};
}


self.getWasmMemoryUsed = async function(objectId) {
  return LibraryUtils.getWasmModule() && LibraryUtils.getWasmModule().HEAP8 ? LibraryUtils.getWasmModule().HEAP8.length : undefined;
}

// ----------------------------- ZEPHYR UTILS ---------------------------------

self.zephyrUtilsJsonToBinary = async function(objectId, json) {
  return ZephyrUtils.jsonToBinary(json);
}

self.zephyrUtilsBinaryToJson = async function(objectId, uint8arr) {
  return ZephyrUtils.binaryToJson(uint8arr);
}

self.zephyrUtilsBinaryBlocksToJson = async function(objectId, uint8arr) {
  return ZephyrUtils.binaryBlocksToJson(uint8arr);
}

//------------------------------ WALLET METHODS -------------------------------




//
//async getVersion() {
//  throw new Error("Not implemented");
//}






self.setSubaddressLabel = async function(walletId, accountIdx, subaddressIdx, label) {
  await self.WORKER_OBJECTS[walletId].setSubaddressLabel(accountIdx, subaddressIdx, label);
}

self.setDaemonConnection = async function(walletId, config, isTrusted) {
  return self.WORKER_OBJECTS[walletId].setDaemonConnection(config ? new ZephyrRpcConnection(Object.assign(config, {proxyToWorker: false})) : undefined, isTrusted);
}

self.getDaemonConnection = async function(walletId) {
  let connection = await self.WORKER_OBJECTS[walletId].getDaemonConnection();
  return connection ? connection.getConfig() : undefined;
}

self.isDaemonTrusted = async function(walletId) {
  return self.WORKER_OBJECTS[walletId].isDaemonTrusted();
}

self.isConnectedToDaemon = async function(walletId) {
  return self.WORKER_OBJECTS[walletId].isConnectedToDaemon();
}


self.setRestoreHeight = async function(walletId, restoreHeight) {
  return self.WORKER_OBJECTS[walletId].setRestoreHeight(restoreHeight);
}

self.getDaemonHeight = async function(walletId) {
  return self.WORKER_OBJECTS[walletId].getDaemonHeight();
}

self.getDaemonMaxPeerHeight = async function(walletId) {
  return self.WORKER_OBJECTS[walletId].getDaemonMaxPeerHeight()
}

self.getHeightByDate = async function(walletId, year, month, day) {
  return self.WORKER_OBJECTS[walletId].getHeightByDate(year, month, day);
}

self.isDaemonSynced = async function(walletId) {
  return self.WORKER_OBJECTS[walletId].isDaemonSynced();
}

self.getHeight = async function(walletId) {
  return self.WORKER_OBJECTS[walletId].getHeight();
}

self.addListener = async function(walletId, listenerId) {
  
  /**
   * Internal listener to bridge notifications to external listeners.
   * 
   * TODO: ZephyrWalletListener is not defined until scripts imported
   * 
   * @private
   */
  class WalletWorkerHelperListener extends ZephyrWalletListener {

    protected walletId: string;
    protected id: string;
    protected worker: Worker;
    
    constructor(walletId, id, worker) {
      super();
      this.walletId = walletId;
      this.id = id;
      this.worker = worker;
    }
    
    getId() {
      return this.id;
    }
    
    async onSyncProgress(height, startHeight, endHeight, percentDone, message) {
      this.worker.postMessage([this.walletId, "onSyncProgress_" + this.getId(), height, startHeight, endHeight, percentDone, message]);
    }

    async onNewBlock(height) { 
      this.worker.postMessage([this.walletId, "onNewBlock_" + this.getId(), height]);
    }
    
    async onBalancesChanged(newBalance, newUnlockedBalance) {
      this.worker.postMessage([this.walletId, "onBalancesChanged_" + this.getId(), newBalance.toString(), newUnlockedBalance.toString()]);
    }

   async onOutputReceived(output) {
      let block = output.getTx().getBlock();
      if (block === undefined) block = new ZephyrBlock().setTxs([output.getTx()]);
      this.worker.postMessage([this.walletId, "onOutputReceived_" + this.getId(), block.toJson()]);  // serialize from root block
    }
    
    async onOutputSpent(output) {
      let block = output.getTx().getBlock();
      if (block === undefined) block = new ZephyrBlock().setTxs([output.getTx()]);
      this.worker.postMessage([this.walletId, "onOutputSpent_" + this.getId(), block.toJson()]);     // serialize from root block
    }
  }
  
  let listener = new WalletWorkerHelperListener(walletId, listenerId, self);
  if (!self.listeners) self.listeners = [];
  self.listeners.push(listener);
  await self.WORKER_OBJECTS[walletId].addListener(listener);
}

self.removeListener = async function(walletId, listenerId) {
  for (let i = 0; i < self.listeners.length; i++) {
    if (self.listeners[i].getId() !== listenerId) continue;
    await self.WORKER_OBJECTS[walletId].removeListener(self.listeners[i]);
    self.listeners.splice(i, 1);
    return;
  }
  throw new ZephyrError("Listener is not registered with wallet");
}

self.isSynced = async function(walletId) {
  return self.WORKER_OBJECTS[walletId].isSynced();
}

self.sync = async function(walletId, startHeight, allowConcurrentCalls) {
  return (await self.WORKER_OBJECTS[walletId].sync(undefined, startHeight, allowConcurrentCalls));
}

self.startSyncing = async function(walletId, syncPeriodInMs) {
  return self.WORKER_OBJECTS[walletId].startSyncing(syncPeriodInMs);
}

self.stopSyncing = async function(walletId) {
  return self.WORKER_OBJECTS[walletId].stopSyncing();
}

self.scanTxs = async function(walletId, txHashes) {
  return self.WORKER_OBJECTS[walletId].scanTxs(txHashes);
}

self.rescanSpent = async function(walletId) {
  return self.WORKER_OBJECTS[walletId].rescanSpent();
}

self.rescanBlockchain = async function(walletId) {
  return self.WORKER_OBJECTS[walletId].rescanBlockchain();
}

self.getBalance = async function(walletId, accountIdx, subaddressIdx) {
  return (await self.WORKER_OBJECTS[walletId].getBalance(accountIdx, subaddressIdx)).toString();
}

self.getUnlockedBalance = async function(walletId, accountIdx, subaddressIdx) {
  return (await self.WORKER_OBJECTS[walletId].getUnlockedBalance(accountIdx, subaddressIdx)).toString();
}

self.getAccounts = async function(walletId, includeSubaddresses, tag) {
  let accountJsons = [];
  for (let account of await self.WORKER_OBJECTS[walletId].getAccounts(includeSubaddresses, tag)) accountJsons.push(account.toJson());
  return accountJsons;
}

self.getAccount = async function(walletId, accountIdx, includeSubaddresses) {
  return (await self.WORKER_OBJECTS[walletId].getAccount(accountIdx, includeSubaddresses)).toJson();
}

self.createAccount = async function(walletId, label) {
  return (await self.WORKER_OBJECTS[walletId].createAccount(label)).toJson();
}

self.getSubaddresses = async function(walletId, accountIdx, subaddressIndices) {
  let subaddressJsons = [];
  for (let subaddress of await self.WORKER_OBJECTS[walletId].getSubaddresses(accountIdx, subaddressIndices)) subaddressJsons.push(subaddress.toJson());
  return subaddressJsons;
}

self.createSubaddress = async function(walletId, accountIdx, label) {
  return (await self.WORKER_OBJECTS[walletId].createSubaddress(accountIdx, label)).toJson();
}

// TODO: easier or more efficient way than serializing from root blocks?
self.getTxs = async function(walletId, blockJsonQuery) {
  
  // deserialize query which is json string rooted at block
  let query = new ZephyrBlock(blockJsonQuery, ZephyrBlock.DeserializationType.TX_QUERY).getTxs()[0];
  
  // get txs
  let txs = await self.WORKER_OBJECTS[walletId].getTxs(query);
  
  // collect unique blocks to preserve model relationships as trees (based on zephyr_wasm_bridge.cpp::get_txs)
  let seenBlocks = new Set();
  let unconfirmedBlock = undefined;
  let blocks = [];
  for (let tx of txs) {
    if (!tx.getBlock()) {
      if (!unconfirmedBlock) unconfirmedBlock = new ZephyrBlock().setTxs([]);
      tx.setBlock(unconfirmedBlock);
      unconfirmedBlock.getTxs().push(tx);
    }
    if (!seenBlocks.has(tx.getBlock())) {
      seenBlocks.add(tx.getBlock());
      blocks.push(tx.getBlock());
    }
  }
  
  // serialize blocks to json
  for (let i = 0; i < blocks.length; i++) blocks[i] = blocks[i].toJson();
  return {blocks: blocks};
}

self.getTransfers = async function(walletId, blockJsonQuery) {
  
  // deserialize query which is json string rooted at block
  let query = (new ZephyrBlock(blockJsonQuery, ZephyrBlock.DeserializationType.TX_QUERY).getTxs()[0] as ZephyrTxQuery).getTransferQuery();
  
  // get transfers
  let transfers = await self.WORKER_OBJECTS[walletId].getTransfers(query);
  
  // collect unique blocks to preserve model relationships as tree
  let unconfirmedBlock = undefined;
  let blocks = [];
  let seenBlocks = new Set();
  for (let transfer of transfers) {
    let tx = transfer.getTx();
    if (!tx.getBlock()) {
      if (!unconfirmedBlock) unconfirmedBlock = new ZephyrBlock().setTxs([]);
      tx.setBlock(unconfirmedBlock);
      unconfirmedBlock.getTxs().push(tx);
    }
    if (!seenBlocks.has(tx.getBlock())) {
      seenBlocks.add(tx.getBlock());
      blocks.push(tx.getBlock());
    }
  }
  
  // serialize blocks to json
  for (let i = 0; i < blocks.length; i++) blocks[i] = blocks[i].toJson();
  return blocks;
}

self.getOutputs = async function(walletId, blockJsonQuery) {

  // deserialize query which is json string rooted at block
  let query = (new ZephyrBlock(blockJsonQuery, ZephyrBlock.DeserializationType.TX_QUERY).getTxs()[0] as ZephyrTxQuery).getOutputQuery();
  
  // get outputs
  let outputs = await self.WORKER_OBJECTS[walletId].getOutputs(query);
  
  // collect unique blocks to preserve model relationships as tree
  let unconfirmedBlock = undefined;
  let blocks = [];
  let seenBlocks = new Set();
  for (let output of outputs) {
    let tx = output.getTx();
    if (!tx.getBlock()) {
      if (!unconfirmedBlock) unconfirmedBlock = new ZephyrBlock().setTxs([]);
      tx.setBlock(unconfirmedBlock);
      unconfirmedBlock.getTxs().push(tx);
    }
    if (!seenBlocks.has(tx.getBlock())) {
      seenBlocks.add(tx.getBlock());
      blocks.push(tx.getBlock());
    }
  }
  
  // serialize blocks to json
  for (let i = 0; i < blocks.length; i++) blocks[i] = blocks[i].toJson();
  return blocks;
}

self.exportOutputs = async function(walletId, all) {
  return self.WORKER_OBJECTS[walletId].exportOutputs(all);
}

self.importOutputs = async function(walletId, outputsHex) {
  return self.WORKER_OBJECTS[walletId].importOutputs(outputsHex);
}

self.getKeyImages = async function(walletId, all) {
  return (await self.WORKER_OBJECTS[walletId].exportKeyImages(all)).toJson();
}

self.importKeyImages = async function(walletId, keyImagesJson, offset) {
  let keyImages = [];
  for (let keyImageJson of keyImagesJson) keyImages.push(new ZephyrKeyImage(keyImageJson));
  return (await self.WORKER_OBJECTS[walletId].importKeyImages(keyImages, offset)).toJson();
}

//async getNewKeyImagesFromLastImport() {
//  throw new ZephyrError("Not implemented");
//}

self.freezeOutput = async function(walletId, keyImage) {
  return self.WORKER_OBJECTS[walletId].freezeOutput(keyImage);
}

self.thawOutput = async function(walletId, keyImage) {
  return self.WORKER_OBJECTS[walletId].thawOutput(keyImage);
}

self.isOutputFrozen = async function(walletId, keyImage) {
  return self.WORKER_OBJECTS[walletId].isOutputFrozen(keyImage);
}

self.getDefaultFeePriority = async function(walletId) {
  return self.WORKER_OBJECTS[walletId].getDefaultFeePriority();
}

self.createTxs = async function(walletId, config) {
  if (typeof config === "object") config = new ZephyrTxConfig(config);
  let txs = await self.WORKER_OBJECTS[walletId].createTxs(config);
  return txs[0].getTxSet().toJson();
}

self.sweepOutput = async function(walletId, config) {
  if (typeof config === "object") config = new ZephyrTxConfig(config);
  let tx = await self.WORKER_OBJECTS[walletId].sweepOutput(config);
  return tx.getTxSet().toJson();
}

self.sweepUnlocked = async function(walletId, config) {
  if (typeof config === "object") config = new ZephyrTxConfig(config);
  let txs = await self.WORKER_OBJECTS[walletId].sweepUnlocked(config);
  let txSets = [];
  for (let tx of txs) if (!GenUtils.arrayContains(txSets, tx.getTxSet())) txSets.push(tx.getTxSet());
  let txSetsJson = [];
  for (let txSet of txSets) txSetsJson.push(txSet.toJson());
  return txSetsJson;
}

self.sweepDust = async function(walletId, relay) {
  let txs = await self.WORKER_OBJECTS[walletId].sweepDust(relay);
  return txs.length === 0 ? {} : txs[0].getTxSet().toJson();
}

self.relayTxs = async function(walletId, txMetadatas) {
  return self.WORKER_OBJECTS[walletId].relayTxs(txMetadatas);
}

self.describeTxSet = async function(walletId, txSetJson) {
  return (await self.WORKER_OBJECTS[walletId].describeTxSet(new ZephyrTxSet(txSetJson))).toJson();
}

self.signTxs = async function(walletId, unsignedTxHex) {
  return self.WORKER_OBJECTS[walletId].signTxs(unsignedTxHex);
}

self.submitTxs = async function(walletId, signedTxHex) {
  return self.WORKER_OBJECTS[walletId].submitTxs(signedTxHex);
}

self.signMessage = async function(walletId, message, signatureType, accountIdx, subaddressIdx) {
  return self.WORKER_OBJECTS[walletId].signMessage(message, signatureType, accountIdx, subaddressIdx);
}

self.verifyMessage = async function(walletId, message, address, signature) {
  return (await self.WORKER_OBJECTS[walletId].verifyMessage(message, address, signature)).toJson();
}

self.getTxKey = async function(walletId, txHash) {
  return self.WORKER_OBJECTS[walletId].getTxKey(txHash);
}

self.checkTxKey = async function(walletId, txHash, txKey, address) {
  return (await self.WORKER_OBJECTS[walletId].checkTxKey(txHash, txKey, address)).toJson();
}

self.getTxProof = async function(walletId, txHash, address, message) {
  return self.WORKER_OBJECTS[walletId].getTxProof(txHash, address, message);
}

self.checkTxProof = async function(walletId, txHash, address, message, signature) {
  return (await self.WORKER_OBJECTS[walletId].checkTxProof(txHash, address, message, signature)).toJson();
}

self.getSpendProof = async function(walletId, txHash, message) {
  return self.WORKER_OBJECTS[walletId].getSpendProof(txHash, message);
}

self.checkSpendProof = async function(walletId, txHash, message, signature) {
  return self.WORKER_OBJECTS[walletId].checkSpendProof(txHash, message, signature);
}

self.getReserveProofWallet = async function(walletId, message) {
  return self.WORKER_OBJECTS[walletId].getReserveProofWallet(message);
}

self.getReserveProofAccount = async function(walletId, accountIdx, amountStr, message) {
  return self.WORKER_OBJECTS[walletId].getReserveProofAccount(accountIdx, amountStr, message);
}

self.checkReserveProof = async function(walletId, address, message, signature) {
  return (await self.WORKER_OBJECTS[walletId].checkReserveProof(address, message, signature)).toJson();
}

self.getTxNotes = async function(walletId, txHashes) {
  return self.WORKER_OBJECTS[walletId].getTxNotes(txHashes);
}

self.setTxNotes = async function(walletId, txHashes, txNotes) {
  return self.WORKER_OBJECTS[walletId].setTxNotes(txHashes, txNotes);
}

self.getAddressBookEntries = async function(walletId, entryIndices) {
  let entriesJson = [];
  for (let entry of await self.WORKER_OBJECTS[walletId].getAddressBookEntries(entryIndices)) entriesJson.push(entry.toJson());
  return entriesJson;
}

self.addAddressBookEntry = async function(walletId, address, description) {
  return self.WORKER_OBJECTS[walletId].addAddressBookEntry(address, description);
}

self.editAddressBookEntry = async function(walletId, index, setAddress, address, setDescription, description) {
  return self.WORKER_OBJECTS[walletId].editAddressBookEntry(index, setAddress, address, setDescription, description);
}

self.deleteAddressBookEntry = async function(walletId, index) {
  return self.WORKER_OBJECTS[walletId].deleteAddressBookEntry(index);
}

self.tagAccounts = async function(walletId, tag, accountIndices) {
  throw new Error("Not implemented");
}

self.untagAccounts = async function(walletId, accountIndices) {
  throw new Error("Not implemented");
}

self.getAccountTags = async function(walletId) {
  throw new Error("Not implemented");
}

self.setAccountTagLabel = async function(walletId, tag, label) {
  throw new Error("Not implemented");
}

self.getPaymentUri = async function(walletId, configJson) {
  return self.WORKER_OBJECTS[walletId].getPaymentUri(new ZephyrTxConfig(configJson));
}

self.parsePaymentUri = async function(walletId, uri) {
  return (await self.WORKER_OBJECTS[walletId].parsePaymentUri(uri)).toJson();
}

self.getAttribute = async function(walletId, key) {
  return self.WORKER_OBJECTS[walletId].getAttribute(key);
}

self.setAttribute = async function(walletId, key, value) {
  return self.WORKER_OBJECTS[walletId].setAttribute(key, value);
}

self.startMining = async function(walletId, numThreads, backgroundMining, ignoreBattery) {
  return self.WORKER_OBJECTS[walletId].startMining(numThreads, backgroundMining, ignoreBattery);
}

self.stopMining = async function(walletId) {
  return self.WORKER_OBJECTS[walletId].stopMining();
}

self.isMultisigImportNeeded = async function(walletId) {
  return self.WORKER_OBJECTS[walletId].isMultisigImportNeeded();
}

self.isMultisig = async function(walletId) {
  return self.WORKER_OBJECTS[walletId].isMultisig();
}

self.getMultisigInfo = async function(walletId) {
  return (await self.WORKER_OBJECTS[walletId].getMultisigInfo()).toJson();
}

self.prepareMultisig = async function(walletId) {
  return self.WORKER_OBJECTS[walletId].prepareMultisig();
}

self.makeMultisig = async function(walletId, multisigHexes, threshold, password) {
  return await self.WORKER_OBJECTS[walletId].makeMultisig(multisigHexes, threshold, password);
}

self.exchangeMultisigKeys = async function(walletId, multisigHexes, password) {
  return (await self.WORKER_OBJECTS[walletId].exchangeMultisigKeys(multisigHexes, password)).toJson();
}

self.exportMultisigHex = async function(walletId) {
  return self.WORKER_OBJECTS[walletId].exportMultisigHex();
}

self.importMultisigHex = async function(walletId, multisigHexes, refreshAfterImport) {
  return self.WORKER_OBJECTS[walletId].importMultisigHex(multisigHexes, refreshAfterImport);
}

self.signMultisigTxHex = async function(walletId, multisigTxHex) {
  return (await self.WORKER_OBJECTS[walletId].signMultisigTxHex(multisigTxHex)).toJson();
}

self.submitMultisigTxHex = async function(walletId, signedMultisigTxHex) {
  return self.WORKER_OBJECTS[walletId].submitMultisigTxHex(signedMultisigTxHex);
}




