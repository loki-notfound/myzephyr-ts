import assert from "assert";
import Path from "path";
import GenUtils from "../common/GenUtils";
import LibraryUtils from "../common/LibraryUtils";
import TaskLooper from "../common/TaskLooper";
import ZephyrAccountInherited from "./model/ZephyrAccountInherited";
import ZephyrAccountTag from "./model/ZephyrAccountTag";
import ZephyrAddressBookEntry from "./model/ZephyrAddressBookEntry";
import ZephyrBlock from "../daemon/model/ZephyrBlock";
import ZephyrCheckTx from "./model/ZephyrCheckTx";
import ZephyrCheckReserve from "./model/ZephyrCheckReserve";
import ZephyrDaemonRpc from "../daemon/ZephyrDaemonRpc";
import ZephyrError from "../common/ZephyrError";
import ZephyrIncomingTransfer from "./model/ZephyrIncomingTransfer";
import ZephyrIntegratedAddress from "./model/ZephyrIntegratedAddress";
import ZephyrKeyImage from "../daemon/model/ZephyrKeyImage";
import ZephyrKeyImageExportResult from "./model/ZephyrKeyImageExportResult";
import ZephyrKeyImageImportResult from "./model/ZephyrKeyImageImportResult";
import ZephyrMultisigInfo from "./model/ZephyrMultisigInfo";
import ZephyrMultisigInitResult from "./model/ZephyrMultisigInitResult";
import ZephyrMultisigSignResult from "./model/ZephyrMultisigSignResult";
import ZephyrNetworkType from "../daemon/model/ZephyrNetworkType";
import ZephyrOutputQuery from "./model/ZephyrOutputQuery";
import ZephyrOutputWallet from "./model/ZephyrOutputWallet";
import ZephyrRpcConnection from "../common/ZephyrRpcConnection";
import ZephyrSubaddressInherited from "./model/ZephyrSubaddressInherited";
import ZephyrSyncResult from "./model/ZephyrSyncResult";
import ZephyrTransfer from "./model/ZephyrTransfer";
import ZephyrTransferQuery from "./model/ZephyrTransferQuery";
import ZephyrTxConfig from "./model/ZephyrTxConfig";
import ZephyrTxPriority from "./model/ZephyrTxPriority";
import ZephyrTxQuery from "./model/ZephyrTxQuery";
import ZephyrTxSet from "./model/ZephyrTxSet";
import ZephyrTx from "../daemon/model/ZephyrTx";
import ZephyrTxWallet from "./model/ZephyrTxWallet";
import ZephyrWalletBase from "./ZephyrWalletBase";
import ZephyrWalletConfig from "./model/ZephyrWalletConfig";
import ZephyrWalletError, { ZephyrBridgeErrorIdentifier, ZephyrBridgePasswordState, bridgePasswordErrorOf } from "../common/ZephyrWalletError";
import { MAX_ACCOUNTS_PER_CALL, MAX_SUBADDRESSES_PER_CALL, checkLabel, checkSubaddressIndices, isAddressIndex, isRestoreHeight, parseRestoreHeightText } from "../common/ZephyrLifecycleContract";
import HttpClient from "../common/HttpClient";
import { ZephyrDaemonRoute, parseDaemonAddress } from "../common/ZephyrDaemonAddress";
import { ZephyrAccountBalances, ZephyrAssetBalances, fromAccountBalancesDto, fromAssetBalancesDto, isAssetTypeToken, parseBridgeAccountBalances, parseBridgeAssetBalances, parseSafeUintText, parseUint64Text } from "../common/ZephyrBalances";
import { MAX_DESTINATIONS, ZephyrTransferBuild, ZephyrTransferRequest, checkTransferRequest, fromBuildDto, parseBridgeBuild } from "../common/ZephyrTransfer";
import { MAX_TRANSFERS_PER_CALL, MAX_TXS_PER_CALL, ZephyrHistorySelection, ZephyrWalletTx, checkSelection, fromPoolRefreshDto, fromTxsDto, parseBridgeTxs, parsePoolRefresh } from "../common/ZephyrHistory";
import { ZephyrAccount, ZephyrAddressIndex, ZephyrSubaddress, fromAccountDto, fromAccountsDto, fromAddressIndexDto, fromSubaddressDto, fromSubaddressesDto, parseBridgeAccount, parseBridgeAccounts, parseBridgeAddressIndex, parseBridgeSubaddress, parseBridgeSubaddresses } from "../common/ZephyrAccounts";
import { configFields, toCoreConfigJson, validateCreateConfig, validateOpenConfig } from "./model/ZephyrWalletCoreConfig";
import { ZephyrWalletKeys, ZephyrWalletKeysProxy } from "./ZephyrWalletKeys";
import { ZephyrWorkerChannel } from "../common/ZephyrWalletWorkers";
import ZephyrWalletListener from "./model/ZephyrWalletListener";
import ZephyrMessageSignatureType from "./model/ZephyrMessageSignatureType";
import ZephyrMessageSignatureResult from "./model/ZephyrMessageSignatureResult";
import ZephyrVersion from "../daemon/model/ZephyrVersion";
import fs from "fs";
import ZephyrConnectionManager from "../common/ZephyrConnectionManager";

/**
 * Implements a Zephyr wallet using client-side WebAssembly bindings to the pinned Zephyr wallet core
 * (zephyr-cpp over Zephyr's wallet2, which derive from monero-cpp and monero-project's wallet2).
 * Only the surface of the package entry is supported; other inherited methods are unported.
 */
export default class ZephyrWalletFull extends ZephyrWalletKeys {

  // static variables
  protected static readonly DEFAULT_SYNC_PERIOD_IN_MS = 20000;
  protected static FS;

  // instance variables
  protected path: string;
  protected password: string;
  protected listeners: ZephyrWalletListener[];
  protected fs: any;
  protected wasmListener: WalletWasmListener;
  protected wasmListenerHandle: number;
  protected rejectUnauthorized: boolean;
  protected rejectUnauthorizedConfigId: string;
  protected syncPeriodInMs: number;
  protected syncLooper: TaskLooper;
  protected browserMainPath: string;
  protected syncCalls = new Set<Promise<any>>();
  /** Daemon route of a direct wallet, registered in this context's request allowlist */
  protected daemonRoute: ZephyrDaemonRoute | undefined = undefined;

  /**
   * Internal constructor which is given the memory address of a C++ wallet instance.
   * 
   * This constructor should be called through static wallet creation utilities in this class.
   * 
   * @param {number} cppAddress - address of the wallet instance in C++
   * @param {string} path - path of the wallet instance
   * @param {string} password - password of the wallet instance
   * @param {FileSystem} fs - node.js-compatible file system to read/write wallet files
   * @param {boolean} rejectUnauthorized - specifies if unauthorized requests (e.g. self-signed certificates) should be rejected
   * @param {string} rejectUnauthorizedFnId - unique identifier for http_client_wasm to query rejectUnauthorized
   * @param {ZephyrWalletFullProxy} walletProxy - proxy to invoke wallet operations in a web worker
   * 
   * @private
   */
  constructor(cppAddress, path, password, fs, rejectUnauthorized, rejectUnauthorizedFnId, walletProxy?: ZephyrWalletFullProxy) {
    super(cppAddress, walletProxy);
    if (walletProxy) return;
    this.path = path;
    this.password = password;
    this.listeners = [];
    this.fs = fs ? fs : (path ? ZephyrWalletFull.getFs() : undefined);
    this._isClosed = false;
    this.wasmListener = new WalletWasmListener(this); // receives notifications from wasm c++
    this.wasmListenerHandle = 0;                      // memory address of the wallet listener in c++
    this.rejectUnauthorized = rejectUnauthorized;
    this.rejectUnauthorizedConfigId = rejectUnauthorizedFnId;
    this.syncPeriodInMs = ZephyrWalletFull.DEFAULT_SYNC_PERIOD_IN_MS;
    LibraryUtils.setRejectUnauthorizedFn(rejectUnauthorizedFnId, () => this.rejectUnauthorized); // register fn informing if unauthorized reqs should be rejected
  }

  // --------------------------- STATIC UTILITIES -----------------------------
  
  /**
   * Check if a wallet exists at a given path.
   * 
   * @param {string} path - path of the wallet on the file system
   * @param {any} fs - file system compatible with Node.js `fs.promises` API (defaults to disk or in-memory FS if browser)
   * @return {boolean} true if a wallet exists at the given path, false otherwise
   */
  static async walletExists(path, fs) {
    assert(path, "Must provide a path to look for a wallet");
    if (!fs) fs = ZephyrWalletFull.getFs();
    if (!fs) throw new ZephyrError("Must provide file system to check if wallet exists");
    let exists = await LibraryUtils.exists(fs, path + ".keys");
    LibraryUtils.log(1, "Wallet exists at " + path + ": " + exists);
    return exists;
  }
  
  /**
   * Open a full wallet from keys and cache bytes. The optional caller signal applies to this
   * construction only: a proxied open runs in its own new worker, which an abort before
   * hand-off terminates (NATIVE_ERROR/CONSTRUCTION_ABORTED); in direct mode only an already aborted
   * signal is honored. After the wallet is returned the signal has no effect.
   */
  static async openWallet(config: Partial<ZephyrWalletConfig>, signal?: AbortSignal, daemon?: ZephyrDaemonRoute) {

    // validate config against the supported configuration contract before any native call
    validateOpenConfig(configFields(config));
    config = new ZephyrWalletConfig(config);
    if (config.getProxyToWorker() === undefined) config.setProxyToWorker(true);
    if (config.getSeed() !== undefined) throw new ZephyrError("Cannot specify seed when opening wallet");
    if (config.getSeedOffset() !== undefined) throw new ZephyrError("Cannot specify seed offset when opening wallet");
    if (config.getPrimaryAddress() !== undefined) throw new ZephyrError("Cannot specify primary address when opening wallet");
    if (config.getPrivateViewKey() !== undefined) throw new ZephyrError("Cannot specify private view key when opening wallet");
    if (config.getPrivateSpendKey() !== undefined) throw new ZephyrError("Cannot specify private spend key when opening wallet");
    if (config.getRestoreHeight() !== undefined) throw new ZephyrError("Cannot specify restore height when opening wallet");
    if (config.getLanguage() !== undefined) throw new ZephyrError("Cannot specify language when opening wallet");
    if (config.getSaveCurrent() === true) throw new ZephyrError("Cannot save current wallet when opening full wallet");
    if (config.getFs() === undefined) config.setFs(ZephyrWalletFull.getFs());

    // set server from connection manager if provided
    if (config.getConnectionManager()) {
      if (config.getServer()) throw new ZephyrError("Wallet can be opened with a server or connection manager but not both");
      config.setServer(config.getConnectionManager().getConnection());
    }

    // read wallet data from disk unless provided
    if (!config.getKeysData()) {
      let fs = config.getFs();
      if (!fs) throw new ZephyrError("Must provide file system to read wallet data from");
      if (!await this.walletExists(config.getPath(), fs)) throw new ZephyrError("Wallet does not exist at path: " + config.getPath());
      config.setKeysData(await fs.readFile(config.getPath() + ".keys"));
      config.setCacheData(await LibraryUtils.exists(fs, config.getPath()) ? await fs.readFile(config.getPath()) : "");
    }

    // open wallet from data
    if (signal !== undefined && signal.aborted) throw new ZephyrWalletError("NATIVE_ERROR", "CONSTRUCTION_ABORTED"); // before any worker or native call
    const wallet = await ZephyrWalletFull.openWalletData(config, signal);

    // apply explicit daemon trust
    if (config.getIsTrustedDaemon() !== undefined && config.getServer()) await wallet.setDaemonConnection(config.getServer(), config.getIsTrustedDaemon());

    // set connection manager
    await wallet.setConnectionManager(config.getConnectionManager());

    // The daemon connection is set after the wallet exists (construction itself is offline)
    if (daemon !== undefined) await ZephyrWalletFull.completeConstruction(wallet, () => wallet.setDaemonConnection(daemon.uri));
    return wallet;
  }

  /**
   * Run a step after the construction succeeded and the wallet (and, if proxied, its worker) was
   * handed over. If the step fails, the wallet is closed natively and its worker
   * retired before the step's error is rethrown, so no live worker or native wallet is left without
   * an owner. If the native close fails too, a proxied wallet's worker is terminated (its native state
   * goes with it); a direct wallet's native handle can then not be freed (direct mode isolates nothing).
   */
  protected static async completeConstruction(wallet: ZephyrWalletFull, step: () => Promise<unknown>): Promise<void> {
    try {
      await step();
    } catch (err) {
      try {
        await wallet.close(false);
      } catch (closeErr) {
        const proxy = wallet.walletProxy as ZephyrWalletFullProxy | undefined; // the field: getWalletProxy() rejects once closed
        if (proxy) proxy.getWorkerChannel().terminate();
      }
      throw err;
    }
  }
  
  /**
   * Create or restore a full wallet. The optional caller signal applies to this construction only
   *, with the same semantics as openWallet.
   */
  static async createWallet(config: ZephyrWalletConfig, signal?: AbortSignal, daemon?: ZephyrDaemonRoute): Promise<ZephyrWalletFull> {

    // validate config against the supported configuration contract and fix the core JSON before any native call
    if (config === undefined) throw new ZephyrError("Must provide config to create wallet");
    const coreConfigJson = JSON.stringify(toCoreConfigJson(validateCreateConfig(configFields(config), false), false));
    if (config.getSeed() !== undefined && (config.getPrimaryAddress() !== undefined || config.getPrivateViewKey() !== undefined || config.getPrivateSpendKey() !== undefined)) throw new ZephyrError("Wallet may be initialized with a seed or keys but not both");
    if (config.getNetworkType() === undefined) throw new ZephyrError("Must provide a networkType: 'mainnet', 'testnet' or 'stagenet'");
    ZephyrNetworkType.validate(config.getNetworkType());
    if (config.getSaveCurrent() === true) throw new ZephyrError("Cannot save current wallet when creating full WASM wallet");
    if (config.getPath() === undefined) config.setPath("");
    if (config.getPath() && await ZephyrWalletFull.walletExists(config.getPath(), config.getFs())) throw new ZephyrError("Wallet already exists: " + config.getPath());
    if (config.getPassword() === undefined) config.setPassword("");

    // set server from connection manager if provided
    if (config.getConnectionManager()) {
      if (config.getServer()) throw new ZephyrError("Wallet can be created with a server or connection manager but not both");
      config.setServer(config.getConnectionManager().getConnection());
    }

    // create proxied or local wallet
    let wallet: ZephyrWalletFull;
    if (config.getProxyToWorker() === undefined) config.setProxyToWorker(true);
    if (signal !== undefined && signal.aborted) throw new ZephyrWalletError("NATIVE_ERROR", "CONSTRUCTION_ABORTED"); // before any worker or native call
    if (config.getProxyToWorker()) {
      let walletProxy = await ZephyrWalletFullProxy.createWallet(config, signal);
      wallet = new ZephyrWalletFull(undefined, undefined, undefined, undefined, undefined, undefined, walletProxy);
    } else {
      if (config.getSeed() !== undefined) {
        if (config.getLanguage() !== undefined) throw new ZephyrError("Cannot provide language when creating wallet from seed");
        wallet = await ZephyrWalletFull.createWalletFromSeed(config, coreConfigJson);
      } else if (config.getPrivateSpendKey() !== undefined || config.getPrimaryAddress() !== undefined) {
        if (config.getSeedOffset() !== undefined) throw new ZephyrError("Cannot provide seedOffset when creating wallet from keys");
        wallet = await ZephyrWalletFull.createWalletFromKeys(config, coreConfigJson);
      } else {
        if (config.getSeedOffset() !== undefined) throw new ZephyrError("Cannot provide seedOffset when creating random wallet");
        if (config.getRestoreHeight() !== undefined) throw new ZephyrError("Cannot provide restoreHeight when creating random wallet");
        wallet = await ZephyrWalletFull.createWalletRandom(config, coreConfigJson);
      }
    }
    
    // set connection manager
    await wallet.setConnectionManager(config.getConnectionManager());

    // The daemon connection is set after the wallet exists (construction itself is offline)
    if (daemon !== undefined) await ZephyrWalletFull.completeConstruction(wallet, () => wallet.setDaemonConnection(daemon.uri));

    // a new random wallet starts at the daemon height when the connection check succeeds, as in the
    // core's own random-wallet creation; otherwise the date-based estimate stays. A daemon that stops
    // answering after the check keeps the estimate as well (an unreachable daemon never fails a
    // construction). Seed and keys restores keep their explicit restore height.
    const random = config.getSeed() === undefined && config.getPrivateSpendKey() === undefined && config.getPrivateViewKey() === undefined && config.getPrimaryAddress() === undefined;
    if (daemon !== undefined && random) await ZephyrWalletFull.completeConstruction(wallet, async () => {
      try {
        await wallet.setRestoreHeightFromDaemon();
      } catch (err) {
        if (!(err instanceof ZephyrWalletError) || err.code !== "DAEMON_ERROR") throw err;
      }
    });
    return wallet;
  }
  
  protected static async createWalletFromSeed(config: ZephyrWalletConfig, coreConfigJson: string): Promise<ZephyrWalletFull> {

    // validate and normalize params
    let daemonConnection = config.getServer();
    let rejectUnauthorized = daemonConnection ? daemonConnection.getRejectUnauthorized() : true;
    if (config.getRestoreHeight() === undefined) config.setRestoreHeight(0);
    if (config.getSeedOffset() === undefined) config.setSeedOffset("");
    
    // load full wasm module
    let module = await LibraryUtils.loadWasmModule();
    
    // create wallet in queue
    let wallet = await module.queueTask(async () => {
      return new Promise((resolve, reject) => {

        // register fn informing if unauthorized reqs should be rejected
        let rejectUnauthorizedFnId = GenUtils.getUUID();
        LibraryUtils.setRejectUnauthorizedFn(rejectUnauthorizedFnId, () => rejectUnauthorized);
        
        // create wallet in wasm which invokes callback when done
        module.create_full_wallet(coreConfigJson, rejectUnauthorizedFnId, async (cppAddress: number | string) => {
          if (typeof cppAddress === "string") reject(ZephyrWalletError.fromBridgeResult("restore", cppAddress)); // fixed bridge identifier only
          else resolve(new ZephyrWalletFull(cppAddress, config.getPath(), config.getPassword(), config.getFs(), config.getServer() ? config.getServer().getRejectUnauthorized() : undefined, rejectUnauthorizedFnId));
        });
      });
    });
    
    // save wallet
    if (config.getPath()) await wallet.save();
    return wallet;
  }
  
  protected static async createWalletFromKeys(config: ZephyrWalletConfig, coreConfigJson: string): Promise<ZephyrWalletFull> {

    // validate and normalize params
    ZephyrNetworkType.validate(config.getNetworkType());
    if (config.getPrimaryAddress() === undefined) config.setPrimaryAddress("");
    if (config.getPrivateViewKey() === undefined) config.setPrivateViewKey("");
    if (config.getPrivateSpendKey() === undefined) config.setPrivateSpendKey("");
    let daemonConnection = config.getServer();
    let rejectUnauthorized = daemonConnection ? daemonConnection.getRejectUnauthorized() : true;
    if (config.getRestoreHeight() === undefined) config.setRestoreHeight(0);
    if (config.getLanguage() === undefined) config.setLanguage("English");
    
    // load full wasm module
    let module = await LibraryUtils.loadWasmModule();
    
    // create wallet in queue
    let wallet = await module.queueTask(async () => {
      return new Promise((resolve, reject) => {
        
        // register fn informing if unauthorized reqs should be rejected
        let rejectUnauthorizedFnId = GenUtils.getUUID();
        LibraryUtils.setRejectUnauthorizedFn(rejectUnauthorizedFnId, () => rejectUnauthorized);
        
        // create wallet in wasm which invokes callback when done
        module.create_full_wallet(coreConfigJson, rejectUnauthorizedFnId, async (cppAddress: number | string) => {
          if (typeof cppAddress === "string") reject(ZephyrWalletError.fromBridgeResult("restore", cppAddress)); // fixed bridge identifier only
          else resolve(new ZephyrWalletFull(cppAddress, config.getPath(), config.getPassword(), config.getFs(), config.getServer() ? config.getServer().getRejectUnauthorized() : undefined, rejectUnauthorizedFnId));
        });
      });
    });
    
    // save wallet
    if (config.getPath()) await wallet.save();
    return wallet;
  }
  
  protected static async createWalletRandom(config: ZephyrWalletConfig, coreConfigJson: string): Promise<ZephyrWalletFull> {
    
    // validate and normalize params
    if (config.getLanguage() === undefined) config.setLanguage("English");
    let daemonConnection = config.getServer();
    let rejectUnauthorized = daemonConnection ? daemonConnection.getRejectUnauthorized() : true;
    
    // load wasm module
    let module = await LibraryUtils.loadWasmModule();
    
    // create wallet in queue
    let wallet = await module.queueTask(async () => {
      return new Promise((resolve, reject) => {
        
        // register fn informing if unauthorized reqs should be rejected
        let rejectUnauthorizedFnId = GenUtils.getUUID();
        LibraryUtils.setRejectUnauthorizedFn(rejectUnauthorizedFnId, () => rejectUnauthorized);
      
        // create wallet in wasm which invokes callback when done
        module.create_full_wallet(coreConfigJson, rejectUnauthorizedFnId, async (cppAddress: number | string) => {
          if (typeof cppAddress === "string") reject(ZephyrWalletError.fromBridgeResult("create", cppAddress)); // fixed bridge identifier only
          else resolve(new ZephyrWalletFull(cppAddress, config.getPath(), config.getPassword(), config.getFs(), config.getServer() ? config.getServer().getRejectUnauthorized() : undefined, rejectUnauthorizedFnId));
        });
      });
    });
    
    // save wallet
    if (config.getPath()) await wallet.save();
    return wallet;
  }
  
  static async getSeedLanguages() {
    let module = await LibraryUtils.loadWasmModule();
    return module.queueTask(async () => {
      return JSON.parse(ZephyrWalletError.checkBridgeResult("other", module.get_keys_wallet_seed_languages())).languages;
    });
  }

  static getFs() {
    if (!ZephyrWalletFull.FS) ZephyrWalletFull.FS = fs.promises;
    return ZephyrWalletFull.FS;
  }
  
  // ------------ WALLET METHODS SPECIFIC TO WASM IMPLEMENTATION --------------

  // TODO: move these to ZephyrWalletBase.ts, others can be unsupported
  
  /**
   * Get the maximum height of the peers the wallet's daemon is connected to.
   *
   * @return {Promise<number>} the maximum height of the peers the wallet's daemon is connected to
   */
  async getDaemonMaxPeerHeight(): Promise<number> {
    if (this.getWalletProxy()) return this.getWalletProxy().getDaemonMaxPeerHeight();
    return this.module.queueTask(async () => {
      this.assertNotClosed();
      return new Promise((resolve, reject) => {
      
        // call wasm which invokes callback when done
        this.module.get_daemon_max_peer_height(this.cppAddress, (resp) => {
          if (typeof resp === "string") reject(new ZephyrError(resp));
          else resolve(resp);
        });
      });
    });
  }
  
  /**
   * Whether the connected daemon reports itself synchronized with the network: the core's answer
   * (the daemon height is at least the highest height of its peers, and above 1). A request to the
   * daemon; failures reject with the daemon diagnostics of the other network calls.
   */
  async isDaemonSynced(): Promise<boolean> {
    if (this.getWalletProxy()) return this.getWalletProxy().isDaemonSynced();
    return this.module.queueTask(async () => {
      this.assertNotClosed();
      return new Promise<boolean>((resolve, reject) => {
        this.module.is_daemon_synced(this.cppAddress, (result: unknown) => {
          if (result === "true") resolve(true);
          else if (result === "false") resolve(false);
          else reject(ZephyrWalletError.fromBridgeResult("daemon", result));
        });
      });
    });
  }
  
  /**
   * Indicates if the wallet is synced with the daemon.
   * 
   * @return {Promise<boolean>} true if the wallet is synced with the daemon, false otherwise
   */
  async isSynced(): Promise<boolean> {
    if (this.getWalletProxy()) return this.getWalletProxy().isSynced();
    return this.module.queueTask(async () => {
      this.assertNotClosed();
      return new Promise((resolve, reject) => {
        this.module.is_synced(this.cppAddress, (resp) => {
          resolve(resp);
        });
      });
    });
  }
  
  /**
   * Get the wallet's network type (mainnet, testnet, or stagenet).
   * 
   * @return {Promise<ZephyrNetworkType>} the wallet's network type
   */
  async getNetworkType(): Promise<ZephyrNetworkType> {
    if (this.getWalletProxy()) return this.getWalletProxy().getNetworkType();
    return this.module.queueTask(async () => {
      this.assertNotClosed();
      const networkType = this.module.get_network_type(this.cppAddress); // 0, 1, 2, or -1 on a native failure
      if (networkType !== 0 && networkType !== 1 && networkType !== 2) throw new ZephyrWalletError("NATIVE_ERROR", "CORE_UNCLASSIFIED");
      return networkType;
    });
  }
  
  /**
   * Get the height of the first block that the wallet scans.
   * 
   * @return {Promise<number>} the height of the first block that the wallet scans
   */
  async getRestoreHeight(): Promise<number> {
    if (this.getWalletProxy()) return this.getWalletProxy().getRestoreHeight();
    return this.module.queueTask(async () => {
      this.assertNotClosed();
      return parseRestoreHeightText(ZephyrWalletError.checkBridgeResult("other", this.module.get_restore_height(this.cppAddress))); // exact decimal text of the core uint64_t
    });
  }
  
  /**
   * Set the height of the first block that the wallet scans.
   * 
   * @param {number} restoreHeight - height of the first block that the wallet scans
   * @return {Promise<void>}
   */
  async setRestoreHeight(restoreHeight: number): Promise<void> {
    if (this.getWalletProxy()) return this.getWalletProxy().setRestoreHeight(restoreHeight);
    return this.module.queueTask(async () => {
      this.assertNotClosed();
      this.module.set_restore_height(this.cppAddress, restoreHeight);
    });
  }
  
  /**
   * Move the wallet from its current path to the given path.
   * 
   * @param {string} path - the wallet's destination path
   * @return {Promise<void>}
   */
  async moveTo(path: string): Promise<void> {
    if (this.getWalletProxy()) return this.getWalletProxy().moveTo(path);
    return ZephyrWalletFull.moveTo(path, this);
  }
  
  // -------------------------- COMMON WALLET METHODS -------------------------
  
  async addListener(listener: ZephyrWalletListener): Promise<void> {
    if (this.getWalletProxy()) return this.getWalletProxy().addListener(listener);
    await super.addListener(listener);
    await this.refreshListening();
  }
  
  async removeListener(listener): Promise<void> {
    if (this.getWalletProxy()) return this.getWalletProxy().removeListener(listener);
    await super.removeListener(listener);
    await this.refreshListening();
  }
  
  getListeners(): ZephyrWalletListener[] {
    if (this.getWalletProxy()) return this.getWalletProxy().getListeners();
    return super.getListeners();
  }
  
  async setConnectionManager(connectionManager?: ZephyrConnectionManager): Promise<void> {
    this.assertNotClosed();
    return super.setConnectionManager(connectionManager);
  }

  /**
   * Set or clear the daemon connection. Accepts an address string, a plain { uri, trusted? }
   * object or nothing (clears the connection); see ZephyrDaemonAddress for the contract. The address
   * is validated before any native call; the route is added to this context's request allowlist before
   * the core contacts the daemon. After a failed call only the new route stays allowed (the core may
   * hold the new address). The core's connection check failing is not an error: isConnectedToDaemon
   * then reports false.
   */
  async setDaemonConnection(uriOrConnection?: Partial<ZephyrRpcConnection> | string, isTrusted?: boolean): Promise<void> {
    if (isTrusted === false) throw ZephyrWalletError.unsupported("UNTRUSTED_DAEMON");
    if (isTrusted !== undefined && isTrusted !== true) throw new ZephyrWalletError("INVALID_CONFIG", "FIELD_TYPE");
    const route = uriOrConnection === undefined || uriOrConnection === null || uriOrConnection === "" ? undefined : parseDaemonAddress(uriOrConnection);
    if (this.getWalletProxy()) return this.getWalletProxy().setDaemonRoute(route);
    return this.module.queueTask(async () => {
      this.assertNotClosed();
      const previous = this.daemonRoute;
      if (route) HttpClient.addDaemonRoute(route);
      try {
        await new Promise<void>((resolve, reject) => {
          this.module.set_daemon_connection(this.cppAddress, route ? route.origin : "", route ? route.basePath : "", (result: unknown) => {
            if (result === "") resolve();
            else reject(ZephyrWalletError.fromBridgeResult("daemon", result));
          });
        });
      } finally {
        if (previous) HttpClient.removeDaemonRoute(previous);
        this.daemonRoute = route;
      }
    });
  }

  /**
   * Indicates if the wallet's daemon is trusted.
   *
   * @return {Promise<boolean>} true if the daemon is trusted, false otherwise
   */
  async isDaemonTrusted(): Promise<boolean> {
    if (this.getWalletProxy()) return this.getWalletProxy().isDaemonTrusted();
    return this.module.queueTask(async () => {
      this.assertNotClosed();
      return this.module.is_daemon_trusted(this.cppAddress);
    });
  }

  async getDaemonConnection(): Promise<ZephyrRpcConnection> {
    if (this.getWalletProxy()) return this.getWalletProxy().getDaemonConnection();
    return this.module.queueTask(async () => {
      this.assertNotClosed();
      return new Promise((resolve, reject) => {
        let connectionContainerStr = this.module.get_daemon_connection(this.cppAddress);
        if (!connectionContainerStr) resolve(undefined);
        else {
          let jsonConnection = JSON.parse(connectionContainerStr);
          resolve(new ZephyrRpcConnection({uri: jsonConnection.uri, username: jsonConnection.username, password: jsonConnection.password, proxyUri: jsonConnection.proxyUri, rejectUnauthorized: this.rejectUnauthorized}));
        }
      });
    });
  }
  
  async isConnectedToDaemon(): Promise<boolean> {
    if (this.getWalletProxy()) return this.getWalletProxy().isConnectedToDaemon();
    return this.module.queueTask(async () => {
      this.assertNotClosed();
      return new Promise<boolean>((resolve, reject) => {
        this.module.is_connected_to_daemon(this.cppAddress, (result: unknown) => {
          if (result === "true") resolve(true);
          else if (result === "false") resolve(false);
          else reject(ZephyrWalletError.fromBridgeResult("daemon", result));
        });
      });
    });
  }
  
  /**
   * Restore height of a newly created random wallet from its daemon: if the core's connection check
   * succeeds, the restore height becomes the daemon height (true); otherwise the core's date-based
   * estimate stays (false). The rule of the core's own random-wallet creation, applied after the
   * offline construction.
   */
  async setRestoreHeightFromDaemon(): Promise<boolean> {
    if (this.getWalletProxy()) return this.getWalletProxy().setRestoreHeightFromDaemon();
    return this.module.queueTask(async () => {
      this.assertNotClosed();
      return new Promise<boolean>((resolve, reject) => {
        this.module.set_restore_height_from_daemon(this.cppAddress, (result: unknown) => {
          if (result === "true") resolve(true);
          else if (result === "false") resolve(false);
          else reject(ZephyrWalletError.fromBridgeResult("daemon", result));
        });
      });
    });
  }

  async getVersion(): Promise<ZephyrVersion> {
    if (this.getWalletProxy()) return this.getWalletProxy().getVersion();
    throw new ZephyrError("Not implemented");
  }
  
  async getPath(): Promise<string> {
    if (this.getWalletProxy()) return this.getWalletProxy().getPath();
    return this.path;
  }
  
  async getIntegratedAddress(standardAddress?: string, paymentId?: string): Promise<ZephyrIntegratedAddress> {
    if (this.getWalletProxy()) return this.getWalletProxy().getIntegratedAddress(standardAddress, paymentId);
    return this.module.queueTask(async () => {
      this.assertNotClosed();
      // fixed bridge identifier on failure; neither the native text nor the payment id is echoed
      let result = ZephyrWalletError.checkBridgeResult("address", this.module.get_integrated_address(this.cppAddress, standardAddress ? standardAddress : "", paymentId ? paymentId : ""));
      if (typeof result !== "string" || result.charAt(0) !== '{') throw new ZephyrWalletError("NATIVE_ERROR", "UNEXPECTED_RESULT");
      return new ZephyrIntegratedAddress(JSON.parse(result));
    });
  }
  
  async decodeIntegratedAddress(integratedAddress: string): Promise<ZephyrIntegratedAddress> {
    if (this.getWalletProxy()) return this.getWalletProxy().decodeIntegratedAddress(integratedAddress);
    return this.module.queueTask(async () => {
      this.assertNotClosed();
      let result = ZephyrWalletError.checkBridgeResult("address", this.module.decode_integrated_address(this.cppAddress, integratedAddress)); // fixed bridge identifier on failure
      if (typeof result !== "string" || result.charAt(0) !== '{') throw new ZephyrWalletError("NATIVE_ERROR", "UNEXPECTED_RESULT");
      return new ZephyrIntegratedAddress(JSON.parse(result));
    });
  }
  
  /** Wallet height (exact core uint64_t as a safe integer); no network access. */
  async getHeight(): Promise<number> {
    if (this.getWalletProxy()) return this.getWalletProxy().getHeight();
    return this.module.queueTask(async () => {
      this.assertNotClosed();
      return parseSafeUintText(ZephyrWalletError.checkBridgeResult("other", this.module.get_height(this.cppAddress)));
    });
  }
  
  /** Daemon height from the connected daemon (exact core uint64_t as a safe integer). */
  async getDaemonHeight(): Promise<number> {
    if (this.getWalletProxy()) return this.getWalletProxy().getDaemonHeight();
    return this.module.queueTask(async () => {
      this.assertNotClosed();
      return new Promise<number>((resolve, reject) => {
        this.module.get_daemon_height(this.cppAddress, (result: unknown) => {
          try { resolve(parseSafeUintText(ZephyrWalletError.checkBridgeResult("daemon", result))); } catch (err) { reject(err instanceof ZephyrWalletError ? err : new ZephyrWalletError("NATIVE_ERROR", "UNEXPECTED_RESULT")); }
        });
      });
    });
  }
  
  async getHeightByDate(year: number, month: number, day: number): Promise<number> {
    if (this.getWalletProxy()) return this.getWalletProxy().getHeightByDate(year, month, day);
    return this.module.queueTask(async () => {
      this.assertNotClosed();
      return new Promise((resolve, reject) => {
        this.module.get_height_by_date(this.cppAddress, year, month, day, (resp) => {
          if (typeof resp === "string") reject(new ZephyrError(resp));
          else resolve(resp);
        });
      });
    });
  }
  
  /**
   * Synchronize the wallet with the daemon as a one-time synchronous process.
   * 
   * @param {ZephyrWalletListener|number} [listenerOrStartHeight] - listener xor start height (defaults to no sync listener, the last synced block)
   * @param {number} [startHeight] - startHeight if not given in first arg (defaults to last synced block)
   * @param {boolean} [allowConcurrentCalls] - allow other wallet methods to be processed simultaneously during sync (default false)<br><br><b>WARNING</b>: enabling this option will crash wallet execution if another call makes a simultaneous network request. TODO: possible to sync wasm network requests in http_client_wasm.cpp? 
   */
  /**
   * One blocking sync: from startHeight, or from the core's default start (the larger of the
   * wallet height and the restore height) when it is omitted. Listeners and concurrent calls are not
   * supported. The core lowers the restore height to startHeight if startHeight is below it.
   * Close issued during the sync waits for it; there is no native cancellation.
   */
  async sync(listenerOrStartHeight?: ZephyrWalletListener | number, startHeight?: number, allowConcurrentCalls = false): Promise<ZephyrSyncResult> {
    if (listenerOrStartHeight instanceof ZephyrWalletListener) throw ZephyrWalletError.unsupported("LISTENERS");
    if (startHeight !== undefined || allowConcurrentCalls !== false) throw ZephyrWalletError.unsupported("SYNC");
    const start = listenerOrStartHeight;
    if (start !== undefined && !isRestoreHeight(start)) throw new ZephyrWalletError("INVALID_CONFIG", "SYNC_START_HEIGHT");
    if (this.getWalletProxy()) return this.getWalletProxy().syncFrom(start);
    return this.module.queueTask(async () => {
      this.assertNotClosed();
      return new Promise<ZephyrSyncResult>((resolve, reject) => {
        this.module.sync(this.cppAddress, start === undefined ? "" : String(start), (result: unknown) => {
          try { resolve(ZephyrWalletFull.parseSyncResult(ZephyrWalletError.checkBridgeResult("sync", result))); } catch (err) { reject(err instanceof ZephyrWalletError ? err : new ZephyrWalletError("NATIVE_ERROR", "UNEXPECTED_RESULT")); }
        });
      });
    });
  }

  /** Strict parse of the bridge's sync result {"numBlocksFetched":"<decimal>","receivedMoney":<boolean>}. */
  static parseSyncResult(text: unknown): ZephyrSyncResult {
    if (typeof text !== "string" || text.charAt(0) !== "{") throw new ZephyrWalletError("NATIVE_ERROR", "UNEXPECTED_RESULT");
    let parsed: any;
    try { parsed = JSON.parse(text); } catch (err) { throw new ZephyrWalletError("NATIVE_ERROR", "UNEXPECTED_RESULT"); }
    return ZephyrWalletFull.syncResultOf(parsed, "NATIVE_ERROR");
  }

  /** Strict sync result DTO {numBlocksFetched: "<decimal>", receivedMoney: boolean} (bridge JSON and worker reply). */
  static syncResultOf(value: any, code: "NATIVE_ERROR" | "MALFORMED_MESSAGE"): ZephyrSyncResult {
    const bad = () => code === "NATIVE_ERROR" ? new ZephyrWalletError("NATIVE_ERROR", "UNEXPECTED_RESULT") : new ZephyrWalletError("MALFORMED_MESSAGE", "MESSAGE_SHAPE");
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw bad();
    const keys = Object.keys(value).sort();
    if (keys.length !== 2 || keys[0] !== "numBlocksFetched" || keys[1] !== "receivedMoney" || typeof value.receivedMoney !== "boolean") throw bad();
    let blocks: number;
    try { blocks = parseSafeUintText(value.numBlocksFetched); } catch (err) { throw bad(); }
    return new ZephyrSyncResult(blocks, value.receivedMoney);
  }

  /** Worker DTO of a sync result. */
  static syncResultDto(result: ZephyrSyncResult): { numBlocksFetched: string; receivedMoney: boolean } {
    return { numBlocksFetched: String(result.getNumBlocksFetched()), receivedMoney: result.getReceivedMoney() };
  }

  /** Wallet balance map: the core's keys including its zero entries; unlocked selects the unlocked balances. */
  async getBalanceMap(unlocked: boolean): Promise<ZephyrAssetBalances> {
    if (typeof unlocked !== "boolean") throw new ZephyrWalletError("INVALID_CONFIG", "FIELD_TYPE");
    if (this.getWalletProxy()) return this.getWalletProxy().getBalanceMap(unlocked);
    return this.module.queueTask(async () => {
      this.assertNotClosed();
      return parseBridgeAssetBalances(ZephyrWalletError.checkBridgeResult("other", unlocked ? this.module.get_unlocked_balance_wallet(this.cppAddress) : this.module.get_balance_wallet(this.cppAddress)));
    });
  }

  /** Account balance map keyed by subaddress index; subaddresses absent from the core's map stay absent. */
  async getAccountBalanceMap(unlocked: boolean, accountIdx: number): Promise<ZephyrAccountBalances> {
    if (typeof unlocked !== "boolean") throw new ZephyrWalletError("INVALID_CONFIG", "FIELD_TYPE");
    if (!isAddressIndex(accountIdx)) throw new ZephyrWalletError("INVALID_CONFIG", "ADDRESS_INDEX_RANGE");
    if (this.getWalletProxy()) return this.getWalletProxy().getAccountBalanceMap(unlocked, accountIdx);
    return this.module.queueTask(async () => {
      this.assertNotClosed();
      return parseBridgeAccountBalances(ZephyrWalletError.checkBridgeResult("other", unlocked ? this.module.get_unlocked_balance_account(this.cppAddress, accountIdx) : this.module.get_balance_account(this.cppAddress, accountIdx)));
    });
  }

  /** Asset-first scalar balance for one of the core's asset types. */
  async getAssetBalance(unlocked: boolean, assetType: string, accountIdx: number, subaddressIdx?: number): Promise<bigint> {
    if (typeof unlocked !== "boolean") throw new ZephyrWalletError("INVALID_CONFIG", "FIELD_TYPE");
    if (!isAssetTypeToken(assetType)) throw new ZephyrWalletError("INVALID_CONFIG", "ASSET_TYPE");
    if (!isAddressIndex(accountIdx) || (subaddressIdx !== undefined && !isAddressIndex(subaddressIdx))) throw new ZephyrWalletError("INVALID_CONFIG", "ADDRESS_INDEX_RANGE");
    if (this.getWalletProxy()) return this.getWalletProxy().getAssetBalance(unlocked, assetType, accountIdx, subaddressIdx);
    return this.module.queueTask(async () => {
      this.assertNotClosed();
      const has = subaddressIdx !== undefined;
      const sub = has ? subaddressIdx as number : 0;
      return parseUint64Text(ZephyrWalletError.checkBridgeResult("other", unlocked ? this.module.get_unlocked_balance_asset(this.cppAddress, assetType, accountIdx, has, sub) : this.module.get_balance_asset(this.cppAddress, assetType, accountIdx, has, sub)));
    });
  }
  
  async startSyncing(syncPeriodInMs?: number): Promise<void> {
    if (this.getWalletProxy()) return this.getWalletProxy().startSyncing(syncPeriodInMs);
    this.syncPeriodInMs = syncPeriodInMs === undefined ? ZephyrWalletFull.DEFAULT_SYNC_PERIOD_IN_MS : syncPeriodInMs;
    if (!this.syncLooper) this.syncLooper = new TaskLooper(async () => await this.backgroundSync())
    this.syncLooper.start(this.syncPeriodInMs);
  }
    
  async stopSyncing(): Promise<void> {
    if (this.getWalletProxy()) return this.getWalletProxy().stopSyncing();
    this.assertNotClosed();
    if (this.syncLooper) this.syncLooper.stop();
    this.module.stop_syncing(this.cppAddress); // task is not queued so wallet stops immediately
  }
  
  async scanTxs(txHashes: string[]): Promise<void> {
    if (this.getWalletProxy()) return this.getWalletProxy().scanTxs(txHashes);
    return this.module.queueTask(async () => {
      this.assertNotClosed();
      return new Promise<void>((resolve, reject) => {
        this.module.scan_txs(this.cppAddress, JSON.stringify({txHashes: txHashes}), (err) => {
          if (err) reject(new ZephyrError(err));
          else resolve();
        });
      });
    });
  }
  
  async rescanSpent(): Promise<void> {
    if (this.getWalletProxy()) return this.getWalletProxy().rescanSpent();
    return this.module.queueTask(async () => {
      this.assertNotClosed();
      return new Promise<void>((resolve, reject) => {
        this.module.rescan_spent(this.cppAddress, (err) => {
          if (err) reject(new ZephyrError(err));
          else resolve();
        });
      });
    });
  }
  
  async rescanBlockchain(): Promise<void> {
    if (this.getWalletProxy()) return this.getWalletProxy().rescanBlockchain();
    return this.module.queueTask(async () => {
      this.assertNotClosed();
      return new Promise<void>((resolve, reject) => {
        this.module.rescan_blockchain(this.cppAddress, (err) => {
          if (err) reject(new ZephyrError(err));
          else resolve();
        });
      });
    });
  }
  
  async getBalance(accountIdx?: number, subaddressIdx?: number): Promise<bigint> {
    if (this.getWalletProxy()) return this.getWalletProxy().getBalance(accountIdx, subaddressIdx);
    return this.module.queueTask(async () => {
      this.assertNotClosed();
      
      // get balance encoded in json string
      let balanceStr;
      if (accountIdx === undefined) {
        assert(subaddressIdx === undefined, "Subaddress index must be undefined if account index is undefined");
        balanceStr = this.module.get_balance_wallet(this.cppAddress);
      } else if (subaddressIdx === undefined) {
        balanceStr = this.module.get_balance_account(this.cppAddress, accountIdx);
      } else {
        balanceStr = this.module.get_balance_subaddress(this.cppAddress, accountIdx, subaddressIdx);
      }
      
      // parse json string to bigint
      return BigInt(JSON.parse(GenUtils.stringifyBigInts(balanceStr)).balance);
    });
  }
  
  async getUnlockedBalance(accountIdx?: number, subaddressIdx?: number): Promise<bigint> {
    if (this.getWalletProxy()) return this.getWalletProxy().getUnlockedBalance(accountIdx, subaddressIdx);
    return this.module.queueTask(async () => {
      this.assertNotClosed();
      
      // get balance encoded in json string
      let unlockedBalanceStr;
      if (accountIdx === undefined) {
        assert(subaddressIdx === undefined, "Subaddress index must be undefined if account index is undefined");
        unlockedBalanceStr = this.module.get_unlocked_balance_wallet(this.cppAddress);
      } else if (subaddressIdx === undefined) {
        unlockedBalanceStr = this.module.get_unlocked_balance_account(this.cppAddress, accountIdx);
      } else {
        unlockedBalanceStr = this.module.get_unlocked_balance_subaddress(this.cppAddress, accountIdx, subaddressIdx);
      }
      
      // parse json string to bigint
      return BigInt(JSON.parse(GenUtils.stringifyBigInts(unlockedBalanceStr)).unlockedBalance);
    });
  }
  
  // The inherited model methods of accounts and subaddresses are not ported (their bindings now have the
  // checked signatures below); they reject with a typed error instead of a binding failure.
  async getAccounts(includeSubaddresses?: boolean, tag?: string): Promise<ZephyrAccountInherited[]> { throw ZephyrWalletError.unsupported("NATIVE_EXPORT"); }
  async getAccount(accountIdx: number, includeSubaddresses?: boolean): Promise<ZephyrAccountInherited> { throw ZephyrWalletError.unsupported("NATIVE_EXPORT"); }
  async createAccount(label?: string): Promise<ZephyrAccountInherited> { throw ZephyrWalletError.unsupported("NATIVE_EXPORT"); }
  async getSubaddresses(accountIdx: number, subaddressIndices?: number[]): Promise<ZephyrSubaddressInherited[]> { throw ZephyrWalletError.unsupported("NATIVE_EXPORT"); }
  async createSubaddress(accountIdx: number, label?: string): Promise<ZephyrSubaddressInherited> { throw ZephyrWalletError.unsupported("NATIVE_EXPORT"); }
  async setSubaddressLabel(accountIdx: number, subaddressIdx: number, label: string): Promise<void> { throw ZephyrWalletError.unsupported("NATIVE_EXPORT"); }

  /**
   * Accounts and subaddresses (checked): arguments are validated again here (the facade validated them
   * first), every index is checked against the wallet in the bridge, and results are parsed strictly
   * from the bridge's fixed-format JSON (common/ZephyrAccounts.ts). Listings are bounded by
   * MAX_ACCOUNTS_PER_CALL and MAX_SUBADDRESSES_PER_CALL.
   */
  async getAccountsChecked(includeSubaddresses: boolean): Promise<ReadonlyArray<ZephyrAccount>> {
    if (typeof includeSubaddresses !== "boolean") throw new ZephyrWalletError("INVALID_CONFIG", "FIELD_TYPE");
    if (this.getWalletProxy()) return this.getWalletProxy().getAccountsChecked(includeSubaddresses);
    return this.module.queueTask(async () => {
      this.assertNotClosed();
      return parseBridgeAccounts(ZephyrWalletError.checkBridgeResult("other", this.module.get_accounts(this.cppAddress, includeSubaddresses, MAX_ACCOUNTS_PER_CALL, MAX_SUBADDRESSES_PER_CALL)), includeSubaddresses);
    });
  }

  async getAccountChecked(accountIdx: number, includeSubaddresses: boolean): Promise<ZephyrAccount> {
    if (!isAddressIndex(accountIdx)) throw new ZephyrWalletError("INVALID_CONFIG", "ADDRESS_INDEX_RANGE");
    if (typeof includeSubaddresses !== "boolean") throw new ZephyrWalletError("INVALID_CONFIG", "FIELD_TYPE");
    if (this.getWalletProxy()) return this.getWalletProxy().getAccountChecked(accountIdx, includeSubaddresses);
    return this.module.queueTask(async () => {
      this.assertNotClosed();
      return parseBridgeAccount(ZephyrWalletError.checkBridgeResult("other", this.module.get_account(this.cppAddress, accountIdx, includeSubaddresses, MAX_SUBADDRESSES_PER_CALL)), accountIdx, includeSubaddresses);
    });
  }

  async createAccountChecked(label: string): Promise<ZephyrAccount> {
    checkLabel(label);
    if (this.getWalletProxy()) return this.getWalletProxy().createAccountChecked(label);
    return this.module.queueTask(async () => {
      this.assertNotClosed();
      return parseBridgeAccount(ZephyrWalletError.checkBridgeResult("other", this.module.create_account(this.cppAddress, label)), undefined, false);
    });
  }

  async getSubaddressesChecked(accountIdx: number, subaddressIndices: readonly number[] | undefined): Promise<ReadonlyArray<ZephyrSubaddress>> {
    if (!isAddressIndex(accountIdx)) throw new ZephyrWalletError("INVALID_CONFIG", "ADDRESS_INDEX_RANGE");
    const indices = subaddressIndices === undefined ? undefined : checkSubaddressIndices(subaddressIndices);
    if (this.getWalletProxy()) return this.getWalletProxy().getSubaddressesChecked(accountIdx, indices);
    return this.module.queueTask(async () => {
      this.assertNotClosed();
      return parseBridgeSubaddresses(ZephyrWalletError.checkBridgeResult("other", this.module.get_subaddresses(this.cppAddress, accountIdx, indices === undefined ? "" : indices.join(","), MAX_SUBADDRESSES_PER_CALL)), accountIdx, indices);
    });
  }

  async createSubaddressChecked(accountIdx: number, label: string): Promise<ZephyrSubaddress> {
    if (!isAddressIndex(accountIdx)) throw new ZephyrWalletError("INVALID_CONFIG", "ADDRESS_INDEX_RANGE");
    checkLabel(label);
    if (this.getWalletProxy()) return this.getWalletProxy().createSubaddressChecked(accountIdx, label);
    return this.module.queueTask(async () => {
      this.assertNotClosed();
      return parseBridgeSubaddress(ZephyrWalletError.checkBridgeResult("other", this.module.create_subaddress(this.cppAddress, accountIdx, label)), accountIdx);
    });
  }

  async setSubaddressLabelChecked(accountIdx: number, subaddressIdx: number, label: string): Promise<void> {
    if (!isAddressIndex(accountIdx) || !isAddressIndex(subaddressIdx)) throw new ZephyrWalletError("INVALID_CONFIG", "ADDRESS_INDEX_RANGE");
    checkLabel(label);
    if (this.getWalletProxy()) return this.getWalletProxy().setSubaddressLabelChecked(accountIdx, subaddressIdx, label);
    return this.module.queueTask(async () => {
      this.assertNotClosed();
      if (ZephyrWalletError.checkBridgeResult("other", this.module.set_subaddress_label(this.cppAddress, accountIdx, subaddressIdx, label)) !== "") throw new ZephyrWalletError("NATIVE_ERROR", "UNEXPECTED_RESULT");
    });
  }

  async getAddressIndexChecked(address: string): Promise<ZephyrAddressIndex> {
    if (typeof address !== "string" || address.length === 0 || address.length > 256) throw new ZephyrWalletError("INVALID_ADDRESS", "ADDRESS_TYPE");
    if (this.getWalletProxy()) return this.getWalletProxy().getAddressIndexChecked(address);
    return this.module.queueTask(async () => {
      this.assertNotClosed();
      return parseBridgeAddressIndex(ZephyrWalletError.checkBridgeResult("address", this.module.get_address_index(this.cppAddress, address)));
    });
  }
  
  /**
   * Read-only history: the wallet's transactions in a selection (status, height range, hashes), each
   * with all of its transfers, from what the last sync stored; no daemon request (common/ZephyrHistory.ts).
   */
  async getHistoryChecked(selection: ZephyrHistorySelection): Promise<ReadonlyArray<ZephyrWalletTx>> {
    const s = checkSelection(selection?.status, selection?.minHeight, selection?.maxHeight, selection?.hashes);
    if (this.getWalletProxy()) return this.getWalletProxy().getHistoryChecked(s);
    return this.module.queueTask(async () => {
      this.assertNotClosed();
      return parseBridgeTxs(ZephyrWalletError.checkBridgeResult("other", this.module.get_txs(this.cppAddress, s.status, s.minHeight === undefined ? "" : String(s.minHeight),
        s.maxHeight === undefined ? "" : String(s.maxHeight), s.hashes === undefined ? "" : s.hashes.join(","), MAX_TXS_PER_CALL, MAX_TRANSFERS_PER_CALL)), s);
    });
  }

  /**
   * Explicit pool refresh: asks the daemon for its pool and keeps the wallet's incoming pool transfers for
   * the history (a daemon request; bridge refresh_pool). Resolves with the number of incoming pool
   * transactions the wallet holds now.
   */
  async refreshPoolChecked(): Promise<number> {
    if (this.getWalletProxy()) return this.getWalletProxy().refreshPoolChecked();
    return this.module.queueTask(async () => {
      this.assertNotClosed();
      return new Promise<number>((resolve, reject) => {
        this.module.refresh_pool(this.cppAddress, MAX_TXS_PER_CALL, (result: unknown) => {
          try { resolve(parsePoolRefresh(ZephyrWalletError.checkBridgeResult("daemon", result))); } catch (err) { reject(err); }
        });
      });
    });
  }

  /**
   * Build, describe and discard the transactions of a same-asset transfer (bridge build_txs; never relays,
   * returns no byte of a built transaction). The request is checked again before the native call.
   */
  async buildTransferChecked(request: ZephyrTransferRequest): Promise<ZephyrTransferBuild> {
    const r = checkTransferRequest(request?.asset, request?.addresses, request?.amounts, request?.accountIndex, request?.subaddressIndices, request?.priority);
    if (this.getWalletProxy()) return this.getWalletProxy().buildTransferChecked(r);
    return this.module.queueTask(async () => {
      this.assertNotClosed();
      return new Promise<ZephyrTransferBuild>((resolve, reject) => {
        this.module.build_txs(this.cppAddress, r.asset, r.addresses.join(","), r.amounts.join(","), r.accountIndex, r.subaddressIndices.join(","), r.priority, MAX_DESTINATIONS, (result: unknown) => {
          try { resolve(parseBridgeBuild(ZephyrWalletError.checkBridgeResult("build", result), r)); } catch (err) { reject(err); }
        });
      });
    });
  }

  // the inherited query-based listing reached a binding whose signature changed (get_txs); see getHistoryChecked
  async getTxs(query?: string[] | Partial<ZephyrTxQuery>): Promise<ZephyrTxWallet[]> { throw ZephyrWalletError.unsupported("NATIVE_EXPORT"); }

  async getTransfers(query?: Partial<ZephyrTransferQuery>): Promise<ZephyrTransfer[]> {
    if (this.getWalletProxy()) return this.getWalletProxy().getTransfers(query);
    
    // copy and normalize query up to block
    const queryNormalized = ZephyrWalletBase.normalizeTransferQuery(query);
    
    // return promise which resolves on callback
    return this.module.queueTask(async () => {
      this.assertNotClosed();
      return new Promise((resolve, reject) => {
        
        // call wasm which invokes callback
        this.module.get_transfers(this.cppAddress, JSON.stringify(queryNormalized.getTxQuery().getBlock().toJson()), (blocksJsonStr) => {
            
          // check for error
          if (blocksJsonStr.charAt(0) !== '{') {
            reject(new ZephyrError(blocksJsonStr));
            return;
          }
           
          // resolve with deserialized transfers 
          try {
            resolve(ZephyrWalletFull.deserializeTransfers(queryNormalized, blocksJsonStr));
          } catch (err) {
            reject(err);
          }
        });
      });
    });
  }
  
  async getOutputs(query?: Partial<ZephyrOutputQuery>): Promise<ZephyrOutputWallet[]> {
    if (this.getWalletProxy()) return this.getWalletProxy().getOutputs(query);
    
    // copy and normalize query up to block
    const queryNormalized = ZephyrWalletBase.normalizeOutputQuery(query);
    
    // return promise which resolves on callback
    return this.module.queueTask(async () => {
      this.assertNotClosed();
      return new Promise((resolve, reject) =>{
        
        // call wasm which invokes callback
        this.module.get_outputs(this.cppAddress, JSON.stringify(queryNormalized.getTxQuery().getBlock().toJson()), (blocksJsonStr) => {
          
          // check for error
          if (blocksJsonStr.charAt(0) !== '{') {
            reject(new ZephyrError(blocksJsonStr));
            return;
          }
          
          // resolve with deserialized outputs
          try {
            resolve(ZephyrWalletFull.deserializeOutputs(queryNormalized, blocksJsonStr));
          } catch (err) {
            reject(err);
          }
        });
      });
    });
  }
  
  async exportOutputs(all = false): Promise<string> {
    if (this.getWalletProxy()) return this.getWalletProxy().exportOutputs(all);
    return this.module.queueTask(async () => {
      this.assertNotClosed();
      return new Promise((resolve, reject) => {
        this.module.export_outputs(this.cppAddress, all, (outputsHex) => resolve(outputsHex));
      });
    });
  }
  
  async importOutputs(outputsHex: string): Promise<number> {
    if (this.getWalletProxy()) return this.getWalletProxy().importOutputs(outputsHex);
    return this.module.queueTask(async () => {
      this.assertNotClosed();
      return new Promise((resolve, reject) => {
        this.module.import_outputs(this.cppAddress, outputsHex, (numImported) => resolve(numImported));
      });
    });
  }
  
  async exportKeyImages(all = false): Promise<ZephyrKeyImageExportResult> {
    if (this.getWalletProxy()) return this.getWalletProxy().exportKeyImages(all);
    return this.module.queueTask(async () => {
      this.assertNotClosed();
      return new Promise((resolve, reject) => {
        this.module.export_key_images(this.cppAddress, all, (resultStr) => {
          if (resultStr.charAt(0) !== '{') reject(new ZephyrError(resultStr)); // json expected, else error
          else {
            let resultJson = JSON.parse(GenUtils.stringifyBigInts(resultStr));
            if (!resultJson.keyImages) resultJson.keyImages = [];
            resolve(new ZephyrKeyImageExportResult(resultJson));
          }
        });
      });
    });
  }
  
  async importKeyImages(keyImages: ZephyrKeyImage[], offset = 0): Promise<ZephyrKeyImageImportResult> {
    if (this.getWalletProxy()) return this.getWalletProxy().importKeyImages(keyImages, offset);
    return this.module.queueTask(async () => {
      this.assertNotClosed();
      return new Promise((resolve, reject) => {
        this.module.import_key_images(this.cppAddress, JSON.stringify({offset: offset, keyImages: keyImages.map(keyImage => keyImage.toJson())}), (keyImageImportResultStr) => {
          if (keyImageImportResultStr.charAt(0) !== '{') reject(new ZephyrError(keyImageImportResultStr)); // json expected, else error
          else resolve(new ZephyrKeyImageImportResult(JSON.parse(GenUtils.stringifyBigInts(keyImageImportResultStr))));
        });
      });
    });
  }
  
  async getNewKeyImagesFromLastImport(): Promise<ZephyrKeyImage[]> {
    if (this.getWalletProxy()) return this.getWalletProxy().getNewKeyImagesFromLastImport();
    throw new ZephyrError("Not implemented");
  }
  
  async freezeOutput(keyImage: string): Promise<void> {
    if (this.getWalletProxy()) return this.getWalletProxy().freezeOutput(keyImage);
    if (!keyImage) throw new ZephyrError("Must specify key image to freeze");
    return this.module.queueTask(async () => {
      this.assertNotClosed();
      return new Promise<void>((resolve, reject) => {
        this.module.freeze_output(this.cppAddress, keyImage, () => resolve());
      });
    });
  }
  
  async thawOutput(keyImage: string): Promise<void> {
    if (this.getWalletProxy()) return this.getWalletProxy().thawOutput(keyImage);
    if (!keyImage) throw new ZephyrError("Must specify key image to thaw");
    return this.module.queueTask(async () => {
      this.assertNotClosed();
      return new Promise<void>((resolve, reject) => {
        this.module.thaw_output(this.cppAddress, keyImage, () => resolve());
      });
    });
  }
  
  async isOutputFrozen(keyImage: string): Promise<boolean> {
    if (this.getWalletProxy()) return this.getWalletProxy().isOutputFrozen(keyImage);
    if (!keyImage) throw new ZephyrError("Must specify key image to check if frozen");
    return this.module.queueTask(async () => {
      this.assertNotClosed();
      return new Promise((resolve, reject) => {
        this.module.is_output_frozen(this.cppAddress, keyImage, (result) => resolve(result));
      });
    });
  }

  async getDefaultFeePriority(): Promise<ZephyrTxPriority> {
    if (this.getWalletProxy()) return this.getWalletProxy().getDefaultFeePriority();
    return this.module.queueTask(async () => {
      this.assertNotClosed();
      return new Promise((resolve, reject) => {
        this.module.get_default_fee_priority(this.cppAddress, (result) => resolve(result));
      });
    });
  }
  
  async createTxs(config: Partial<ZephyrTxConfig>): Promise<ZephyrTxWallet[]> {
    if (this.getWalletProxy()) return this.getWalletProxy().createTxs(config);
    
    // validate, copy, and normalize config
    const configNormalized = ZephyrWalletBase.normalizeCreateTxsConfig(config);
    if (configNormalized.getCanSplit() === undefined) configNormalized.setCanSplit(true);
    
    // create txs in queue
    return this.module.queueTask(async () => {
      this.assertNotClosed();
      return new Promise((resolve, reject) => {
        
        // create txs in wasm which invokes callback when done
        this.module.create_txs(this.cppAddress, JSON.stringify(configNormalized.toJson()), (txSetJsonStr) => {
          if (txSetJsonStr.charAt(0) !== '{') reject(new ZephyrError(txSetJsonStr)); // json expected, else error
          else resolve(new ZephyrTxSet(JSON.parse(GenUtils.stringifyBigInts(txSetJsonStr))).getTxs());
        });
      });
    });
  }
  
  async sweepOutput(config: Partial<ZephyrTxConfig>): Promise<ZephyrTxWallet> {
    if (this.getWalletProxy()) return this.getWalletProxy().sweepOutput(config);
    
    // normalize and validate config
    const configNormalized = ZephyrWalletBase.normalizeSweepOutputConfig(config);
    
    // sweep output in queue
    return this.module.queueTask(async () => {
      this.assertNotClosed();
      return new Promise((resolve, reject) => {
        
        // sweep output in wasm which invokes callback when done
        this.module.sweep_output(this.cppAddress, JSON.stringify(configNormalized.toJson()), (txSetJsonStr) => {
          if (txSetJsonStr.charAt(0) !== '{') reject(new ZephyrError(txSetJsonStr)); // json expected, else error
          else resolve(new ZephyrTxSet(JSON.parse(GenUtils.stringifyBigInts(txSetJsonStr))).getTxs()[0]);
        });
      });
    });
  }

  async sweepUnlocked(config: Partial<ZephyrTxConfig>): Promise<ZephyrTxWallet[]> {
    if (this.getWalletProxy()) return this.getWalletProxy().sweepUnlocked(config);
    
    // validate and normalize config
    const configNormalized = ZephyrWalletBase.normalizeSweepUnlockedConfig(config);
    
    // sweep unlocked in queue
    return this.module.queueTask(async () => {
      this.assertNotClosed();
      return new Promise((resolve, reject) => {
        
        // sweep unlocked in wasm which invokes callback when done
        this.module.sweep_unlocked(this.cppAddress, JSON.stringify(configNormalized.toJson()), (txSetsJson) => {
          if (txSetsJson.charAt(0) !== '{') reject(new ZephyrError(txSetsJson)); // json expected, else error
          else {
            let txSets = [];
            for (let txSetJson of JSON.parse(GenUtils.stringifyBigInts(txSetsJson)).txSets) txSets.push(new ZephyrTxSet(txSetJson));
            let txs = [];
            for (let txSet of txSets) for (let tx of txSet.getTxs()) txs.push(tx);
            resolve(txs);
          }
        });
      });
    });
  }
  
  async sweepDust(relay?: boolean): Promise<ZephyrTxWallet[]> {
    if (this.getWalletProxy()) return this.getWalletProxy().sweepDust(relay);
    return this.module.queueTask(async () => {
      this.assertNotClosed();
      return new Promise((resolve, reject) => {
        
        // call wasm which invokes callback when done
        this.module.sweep_dust(this.cppAddress, relay, (txSetJsonStr) => {
          if (txSetJsonStr.charAt(0) !== '{') reject(new ZephyrError(txSetJsonStr)); // json expected, else error
          else {
            let txSet = new ZephyrTxSet(JSON.parse(GenUtils.stringifyBigInts(txSetJsonStr)));
            if (txSet.getTxs() === undefined) txSet.setTxs([]);
            resolve(txSet.getTxs());
          }
        });
      });
    });
  }
  
  async relayTxs(txsOrMetadatas: (ZephyrTxWallet | string)[]): Promise<string[]> {
    if (this.getWalletProxy()) return this.getWalletProxy().relayTxs(txsOrMetadatas);
    assert(Array.isArray(txsOrMetadatas), "Must provide an array of txs or their metadata to relay");
    let txMetadatas = [];
    for (let txOrMetadata of txsOrMetadatas) txMetadatas.push(txOrMetadata instanceof ZephyrTxWallet ? txOrMetadata.getMetadata() : txOrMetadata);
    return this.module.queueTask(async () => {
      this.assertNotClosed();
      return new Promise((resolve, reject) => {
        this.module.relay_txs(this.cppAddress, JSON.stringify({txMetadatas: txMetadatas}), (txHashesJson) => {
          if (txHashesJson.charAt(0) !== '{') reject(new ZephyrError(txHashesJson));
          else resolve(JSON.parse(txHashesJson).txHashes);
        });
      });
    });
  }
  
  async describeTxSet(txSet: ZephyrTxSet): Promise<ZephyrTxSet> {
    if (this.getWalletProxy()) return this.getWalletProxy().describeTxSet(txSet);
    return this.module.queueTask(async () => {
      this.assertNotClosed();
      txSet = new ZephyrTxSet({unsignedTxHex: txSet.getUnsignedTxHex(), signedTxHex: txSet.getSignedTxHex(), multisigTxHex: txSet.getMultisigTxHex()});
      try { return new ZephyrTxSet(JSON.parse(GenUtils.stringifyBigInts(this.module.describe_tx_set(this.cppAddress, JSON.stringify(txSet.toJson()))))); }
      catch (err) { throw new ZephyrError(this.module.get_exception_message(err)); }
    });
  }
  
  async signTxs(unsignedTxHex: string): Promise<ZephyrTxSet> {
    if (this.getWalletProxy()) return this.getWalletProxy().signTxs(unsignedTxHex);
    return this.module.queueTask(async () => {
      this.assertNotClosed();
      try { return new ZephyrTxSet(JSON.parse(GenUtils.stringifyBigInts(this.module.sign_txs(this.cppAddress, unsignedTxHex)))); }
      catch (err) { throw new ZephyrError(this.module.get_exception_message(err)); }
    });
  }
  
  async submitTxs(signedTxHex: string): Promise<string[]> {
    if (this.getWalletProxy()) return this.getWalletProxy().submitTxs(signedTxHex);
    return this.module.queueTask(async () => {
      this.assertNotClosed();
      return new Promise((resolve, reject) => {
        this.module.submit_txs(this.cppAddress, signedTxHex, (resp) => {
          if (resp.charAt(0) !== '{') reject(new ZephyrError(resp));
          else resolve(JSON.parse(resp).txHashes);
        });
      });
    });
  }
  
  async signMessage(message: string, signatureType = ZephyrMessageSignatureType.SIGN_WITH_SPEND_KEY, accountIdx = 0, subaddressIdx = 0): Promise<string> {
    if (this.getWalletProxy()) return this.getWalletProxy().signMessage(message, signatureType, accountIdx, subaddressIdx);
    
    // assign defaults
    signatureType = signatureType || ZephyrMessageSignatureType.SIGN_WITH_SPEND_KEY;
    accountIdx = accountIdx || 0;
    subaddressIdx = subaddressIdx || 0;
    
    // queue task to sign message
    return this.module.queueTask(async () => {
      this.assertNotClosed();
      try { return this.module.sign_message(this.cppAddress, message, signatureType === ZephyrMessageSignatureType.SIGN_WITH_SPEND_KEY ? 0 : 1, accountIdx, subaddressIdx); }
      catch (err) { throw new ZephyrError(this.module.get_exception_message(err)); }
    });
  }
  
  async verifyMessage(message: string, address: string, signature: string): Promise<ZephyrMessageSignatureResult> {
    if (this.getWalletProxy()) return this.getWalletProxy().verifyMessage(message, address, signature);
    return this.module.queueTask(async () => {
      this.assertNotClosed();
      let result;
      try {
        result = JSON.parse(this.module.verify_message(this.cppAddress, message, address, signature));
      } catch (err) {
        result = {isGood: false};
      }
      return new ZephyrMessageSignatureResult(result.isGood ?
        {isGood: result.isGood, isOld: result.isOld, signatureType: result.signatureType === "spend" ? ZephyrMessageSignatureType.SIGN_WITH_SPEND_KEY : ZephyrMessageSignatureType.SIGN_WITH_VIEW_KEY, version: result.version} :
        {isGood: false}
      );
    });
  }
  
  async getTxKey(txHash: string): Promise<string> {
    if (this.getWalletProxy()) return this.getWalletProxy().getTxKey(txHash);
    return this.module.queueTask(async () => {
      this.assertNotClosed();
      try { return this.module.get_tx_key(this.cppAddress, txHash); }
      catch (err) { throw new ZephyrError(this.module.get_exception_message(err)); }
    });
  }
  
  async checkTxKey(txHash: string, txKey: string, address: string): Promise<ZephyrCheckTx> {
    if (this.getWalletProxy()) return this.getWalletProxy().checkTxKey(txHash, txKey, address);
    return this.module.queueTask(async () => {
      this.assertNotClosed(); 
      return new Promise((resolve, reject) => {
        this.module.check_tx_key(this.cppAddress, txHash, txKey, address, (respJsonStr) => {
          if (respJsonStr.charAt(0) !== '{') reject(new ZephyrError(respJsonStr));
          else resolve(new ZephyrCheckTx(JSON.parse(GenUtils.stringifyBigInts(respJsonStr))));
        });
      });
    });
  }
  
  async getTxProof(txHash: string, address: string, message?: string): Promise<string> {
    if (this.getWalletProxy()) return this.getWalletProxy().getTxProof(txHash, address, message);
    return this.module.queueTask(async () => {
      this.assertNotClosed();
      return new Promise((resolve, reject) => {
        this.module.get_tx_proof(this.cppAddress, txHash || "", address || "", message || "", (signature) => {
          let errorKey = "error: ";
          if (signature.indexOf(errorKey) === 0) reject(new ZephyrError(signature.substring(errorKey.length)));
          else resolve(signature);
        });
      });
    });
  }
  
  async checkTxProof(txHash: string, address: string, message: string | undefined, signature: string): Promise<ZephyrCheckTx> {
    if (this.getWalletProxy()) return this.getWalletProxy().checkTxProof(txHash, address, message, signature);
    return this.module.queueTask(async () => {
      this.assertNotClosed(); 
      return new Promise((resolve, reject) => {
        this.module.check_tx_proof(this.cppAddress, txHash || "", address || "", message || "", signature || "", (respJsonStr) => {
          if (respJsonStr.charAt(0) !== '{') reject(new ZephyrError(respJsonStr));
          else resolve(new ZephyrCheckTx(JSON.parse(GenUtils.stringifyBigInts(respJsonStr))));
        });
      });
    });
  }
  
  async getSpendProof(txHash: string, message?: string): Promise<string> {
    if (this.getWalletProxy()) return this.getWalletProxy().getSpendProof(txHash, message);
    return this.module.queueTask(async () => {
      this.assertNotClosed();
      return new Promise((resolve, reject) => {
        this.module.get_spend_proof(this.cppAddress, txHash || "", message || "", (signature) => {
          let errorKey = "error: ";
          if (signature.indexOf(errorKey) === 0) reject(new ZephyrError(signature.substring(errorKey.length)));
          else resolve(signature);
        });
      });
    });
  }
  
  async checkSpendProof(txHash: string, message: string | undefined, signature: string): Promise<boolean> {
    if (this.getWalletProxy()) return this.getWalletProxy().checkSpendProof(txHash, message, signature);
    return this.module.queueTask(async () => {
      this.assertNotClosed(); 
      return new Promise((resolve, reject) => {
        this.module.check_spend_proof(this.cppAddress, txHash || "", message || "", signature || "", (resp) => {
          typeof resp === "string" ? reject(new ZephyrError(resp)) : resolve(resp);
        });
      });
    });
  }
  
  async getReserveProofWallet(message?: string): Promise<string> {
    if (this.getWalletProxy()) return this.getWalletProxy().getReserveProofWallet(message);
    return this.module.queueTask(async () => {
      this.assertNotClosed();
      return new Promise((resolve, reject) => {
        this.module.get_reserve_proof_wallet(this.cppAddress, message, (signature) => {
          let errorKey = "error: ";
          if (signature.indexOf(errorKey) === 0) reject(new ZephyrError(signature.substring(errorKey.length), -1));
          else resolve(signature);
        });
      });
    });
  }
  
  async getReserveProofAccount(accountIdx: number, amount: bigint, message?: string): Promise<string> {
    if (this.getWalletProxy()) return this.getWalletProxy().getReserveProofAccount(accountIdx, amount, message);
    return this.module.queueTask(async () => {
      this.assertNotClosed();
      return new Promise((resolve, reject) => {
        this.module.get_reserve_proof_account(this.cppAddress, accountIdx, amount.toString(), message, (signature) => {
          let errorKey = "error: ";
          if (signature.indexOf(errorKey) === 0) reject(new ZephyrError(signature.substring(errorKey.length), -1));
          else resolve(signature);
        });
      });
    });
  }

  async checkReserveProof(address: string, message: string | undefined, signature: string): Promise<ZephyrCheckReserve> {
    if (this.getWalletProxy()) return this.getWalletProxy().checkReserveProof(address, message, signature);
    return this.module.queueTask(async () => {
      this.assertNotClosed(); 
      return new Promise((resolve, reject) => {
        this.module.check_reserve_proof(this.cppAddress, address, message, signature, (respJsonStr) => {
          if (respJsonStr.charAt(0) !== '{') reject(new ZephyrError(respJsonStr, -1));
          else resolve(new ZephyrCheckReserve(JSON.parse(GenUtils.stringifyBigInts(respJsonStr))));
        });
      });
    });
  }
  
  async getTxNotes(txHashes: string[]): Promise<string[]> {
    if (this.getWalletProxy()) return this.getWalletProxy().getTxNotes(txHashes);
    return this.module.queueTask(async () => {
      this.assertNotClosed();
      try { return JSON.parse(this.module.get_tx_notes(this.cppAddress, JSON.stringify({txHashes: txHashes}))).txNotes; }
      catch (err) { throw new ZephyrError(this.module.get_exception_message(err)); }
    });
  }
  
  async setTxNotes(txHashes: string[], notes: string[]): Promise<void> {
    if (this.getWalletProxy()) return this.getWalletProxy().setTxNotes(txHashes, notes);
    notes = notes.map(note => GenUtils.isInitialized(note) ? note : ""); // the bridge would store json null as text
    return this.module.queueTask(async () => {
      this.assertNotClosed();
      try { this.module.set_tx_notes(this.cppAddress, JSON.stringify({txHashes: txHashes, txNotes: notes})); }
      catch (err) { throw new ZephyrError(this.module.get_exception_message(err)); }
    });
  }
  
  async getAddressBookEntries(entryIndices?: number[]): Promise<ZephyrAddressBookEntry[]> {
    if (this.getWalletProxy()) return this.getWalletProxy().getAddressBookEntries(entryIndices);
    if (!entryIndices) entryIndices = [];
    return this.module.queueTask(async () => {
      this.assertNotClosed();
      let entries = [];
      for (let entryJson of JSON.parse(this.module.get_address_book_entries(this.cppAddress, JSON.stringify({entryIndices: entryIndices}))).entries) {
        entries.push(new ZephyrAddressBookEntry(entryJson));
      }
      return entries;
    });
  }
  
  async addAddressBookEntry(address: string, description?: string): Promise<number> {
    if (this.getWalletProxy()) return this.getWalletProxy().addAddressBookEntry(address, description);
    if (!address) address = "";
    if (!description) description = "";
    return this.module.queueTask(async () => {
      this.assertNotClosed();
      return this.module.add_address_book_entry(this.cppAddress, address, description);
    });
  }
  
  async editAddressBookEntry(index: number, setAddress: boolean, address: string | undefined, setDescription: boolean, description: string | undefined): Promise<void> {
    if (this.getWalletProxy()) return this.getWalletProxy().editAddressBookEntry(index, setAddress, address, setDescription, description);
    if (!setAddress) setAddress = false;
    if (!address) address = "";
    if (!setDescription) setDescription = false;
    if (!description) description = "";
    return this.module.queueTask(async () => {
      this.assertNotClosed();
      this.module.edit_address_book_entry(this.cppAddress, index, setAddress, address, setDescription, description);
    });
  }
  
  async deleteAddressBookEntry(entryIdx: number): Promise<void> {
    if (this.getWalletProxy()) return this.getWalletProxy().deleteAddressBookEntry(entryIdx);
    return this.module.queueTask(async () => {
      this.assertNotClosed();
      this.module.delete_address_book_entry(this.cppAddress, entryIdx);
    });
  }
  
  async tagAccounts(tag: string, accountIndices: number[]): Promise<void> {
    if (this.getWalletProxy()) return this.getWalletProxy().tagAccounts(tag, accountIndices);
    if (!tag) tag = "";
    if (!accountIndices) accountIndices = [];
    return this.module.queueTask(async () => {
      this.assertNotClosed();
      this.module.tag_accounts(this.cppAddress, JSON.stringify({tag: tag, accountIndices: accountIndices}));
    });
  }

  async untagAccounts(accountIndices: number[]): Promise<void> {
    if (this.getWalletProxy()) return this.getWalletProxy().untagAccounts(accountIndices);
    if (!accountIndices) accountIndices = [];
    return this.module.queueTask(async () => {
      this.assertNotClosed();
      this.module.tag_accounts(this.cppAddress, JSON.stringify({accountIndices: accountIndices}));
    });
  }
  
  async getAccountTags(): Promise<ZephyrAccountTag[]> {
    if (this.getWalletProxy()) return this.getWalletProxy().getAccountTags();
    return this.module.queueTask(async () => {
      this.assertNotClosed();
      let accountTags = [];
      for (let accountTagJson of JSON.parse(this.module.get_account_tags(this.cppAddress)).accountTags) accountTags.push(new ZephyrAccountTag(accountTagJson));
      return accountTags;
    });
  }

  async setAccountTagLabel(tag: string, label: string): Promise<void> {
    if (this.getWalletProxy()) return this.getWalletProxy().setAccountTagLabel(tag, label);
    if (!tag) tag = "";
    if (!label) label = "";
    return this.module.queueTask(async () => {
      this.assertNotClosed();
      this.module.set_account_tag_label(this.cppAddress, tag, label);
    });
  }
  
  async getPaymentUri(config: ZephyrTxConfig): Promise<string> {
    if (this.getWalletProxy()) return this.getWalletProxy().getPaymentUri(config);
    config = ZephyrWalletBase.normalizeCreateTxsConfig(config);
    return this.module.queueTask(async () => {
      this.assertNotClosed();
      try {
        return this.module.get_payment_uri(this.cppAddress, JSON.stringify(config.toJson()));
      } catch (err) {
        throw new ZephyrError("Cannot make URI from supplied parameters");
      }
    });
  }
  
  async parsePaymentUri(uri: string): Promise<ZephyrTxConfig> {
    if (this.getWalletProxy()) return this.getWalletProxy().parsePaymentUri(uri);
    return this.module.queueTask(async () => {
      this.assertNotClosed();
      try {
        return new ZephyrTxConfig(JSON.parse(GenUtils.stringifyBigInts(this.module.parse_payment_uri(this.cppAddress, uri))));
      } catch (err: any) {
        throw new ZephyrError(err.message);
      }
    });
  }
  
  async getAttribute(key: string): Promise<string> {
    if (this.getWalletProxy()) return this.getWalletProxy().getAttribute(key);
    this.assertNotClosed();
    assert(typeof key === "string", "Attribute key must be a string");
    return this.module.queueTask(async () => {
      this.assertNotClosed();
      let value = this.module.get_attribute(this.cppAddress, key);
      return value === "" ? null : value;
    });
  }
  
  async setAttribute(key: string, val: string): Promise<void> {
    if (this.getWalletProxy()) return this.getWalletProxy().setAttribute(key, val);
    this.assertNotClosed();
    assert(typeof key === "string", "Attribute key must be a string");
    assert(typeof val === "string", "Attribute value must be a string");
    return this.module.queueTask(async () => {
      this.assertNotClosed();
      this.module.set_attribute(this.cppAddress, key, val);
    });
  }
  
  async startMining(numThreads: number, backgroundMining?: boolean, ignoreBattery?: boolean): Promise<void> {
    if (this.getWalletProxy()) return this.getWalletProxy().startMining(numThreads, backgroundMining, ignoreBattery);
    this.assertNotClosed();
    let daemon = await ZephyrDaemonRpc.connectToDaemonRpc(await this.getDaemonConnection());
    await daemon.startMining(await this.getPrimaryAddress(), numThreads, backgroundMining, ignoreBattery);
  }
  
  async stopMining(): Promise<void> {
    if (this.getWalletProxy()) return this.getWalletProxy().stopMining();
    this.assertNotClosed();
    let daemon = await ZephyrDaemonRpc.connectToDaemonRpc(await this.getDaemonConnection());
    await daemon.stopMining();
  }
  
  async isMultisigImportNeeded(): Promise<boolean> {
    if (this.getWalletProxy()) return this.getWalletProxy().isMultisigImportNeeded();
    return this.module.queueTask(async () => {
      this.assertNotClosed();
      return this.module.is_multisig_import_needed(this.cppAddress);
    });
  }
  
  async isMultisig(): Promise<boolean> {
    if (this.getWalletProxy()) return this.getWalletProxy().isMultisig();
    return this.module.queueTask(async () => {
      this.assertNotClosed();
      return this.module.is_multisig(this.cppAddress);
    });
  }
  
  async getMultisigInfo(): Promise<ZephyrMultisigInfo> {
    if (this.getWalletProxy()) return this.getWalletProxy().getMultisigInfo();
    return this.module.queueTask(async () => {
      this.assertNotClosed();
      return new ZephyrMultisigInfo(JSON.parse(this.module.get_multisig_info(this.cppAddress)));
    });
  }
  
  async prepareMultisig(): Promise<string> {
    if (this.getWalletProxy()) return this.getWalletProxy().prepareMultisig();
    return this.module.queueTask(async () => {
      this.assertNotClosed();
      return this.module.prepare_multisig(this.cppAddress);
    });
  }
  
  async makeMultisig(multisigHexes: string[], threshold: number, password: string): Promise<string> {
    if (this.getWalletProxy()) return this.getWalletProxy().makeMultisig(multisigHexes, threshold, password);
    return this.module.queueTask(async () => {
      this.assertNotClosed();
      return new Promise((resolve, reject) => {
        this.module.make_multisig(this.cppAddress, JSON.stringify({multisigHexes: multisigHexes, threshold: threshold, password: password}), (resp) => {
          let errorKey = "error: ";
          if (resp.indexOf(errorKey) === 0) reject(new ZephyrError(resp.substring(errorKey.length)));
          else resolve(resp);
        });
      });
    });
  }
  
  async exchangeMultisigKeys(multisigHexes: string[], password: string): Promise<ZephyrMultisigInitResult> {
    if (this.getWalletProxy()) return this.getWalletProxy().exchangeMultisigKeys(multisigHexes, password);
    return this.module.queueTask(async () => {
      this.assertNotClosed();
      return new Promise((resolve, reject) => {
        this.module.exchange_multisig_keys(this.cppAddress, JSON.stringify({multisigHexes: multisigHexes, password: password}), (resp) => {
          let errorKey = "error: ";
          if (resp.indexOf(errorKey) === 0) reject(new ZephyrError(resp.substring(errorKey.length)));
          else resolve(new ZephyrMultisigInitResult(JSON.parse(resp)));
        });
      });
    });
  }
  
  async exportMultisigHex(): Promise<string> {
    if (this.getWalletProxy()) return this.getWalletProxy().exportMultisigHex();
    return this.module.queueTask(async () => {
      this.assertNotClosed();
      return this.module.export_multisig_hex(this.cppAddress);
    });
  }
  
  async importMultisigHex(multisigHexes: string[], refreshAfterImport?: boolean): Promise<number> {
    if (refreshAfterImport === undefined) refreshAfterImport = true;
    if (this.getWalletProxy()) return this.getWalletProxy().importMultisigHex(multisigHexes, refreshAfterImport);
    if (!GenUtils.isArray(multisigHexes)) throw new ZephyrError("Must provide string[] to importMultisigHex()")
    return this.module.queueTask(async () => {
      this.assertNotClosed();
      return new Promise((resolve, reject) => {
        this.module.import_multisig_hex(this.cppAddress, JSON.stringify({multisigHexes: multisigHexes, refreshAfterImport: refreshAfterImport}), (resp) => {
          if (typeof resp === "string") reject(new ZephyrError(resp));
          else resolve(resp);
        });
      });
    });
  }
  
  async signMultisigTxHex(multisigTxHex: string): Promise<ZephyrMultisigSignResult> {
    if (this.getWalletProxy()) return this.getWalletProxy().signMultisigTxHex(multisigTxHex);
    return this.module.queueTask(async () => {
      this.assertNotClosed();
      return new Promise((resolve, reject) => {
        this.module.sign_multisig_tx_hex(this.cppAddress, multisigTxHex, (resp) => {
          if (resp.charAt(0) !== '{') reject(new ZephyrError(resp));
          else resolve(new ZephyrMultisigSignResult(JSON.parse(resp)));
        });
      });
    });
  }
  
  async submitMultisigTxHex(signedMultisigTxHex: string): Promise<string[]> {
    if (this.getWalletProxy()) return this.getWalletProxy().submitMultisigTxHex(signedMultisigTxHex);
    return this.module.queueTask(async () => {
      this.assertNotClosed();
      return new Promise((resolve, reject) => {
        this.module.submit_multisig_tx_hex(this.cppAddress, signedMultisigTxHex, (resp) => {
          if (resp.charAt(0) !== '{') reject(new ZephyrError(resp));
          else resolve(JSON.parse(resp).txHashes);
        });
      });
    });
  }
  
  /**
   * Get the wallet's keys and cache data.
   * 
   * @return {Promise<DataView[]>} is the keys and cache data, respectively
   */
  async getData(): Promise<DataView[]> {
    if (this.getWalletProxy()) return this.getWalletProxy().getData();
    
    return this.module.queueTask(async () => {
      this.assertNotClosed();
      return this.getDataWasm();
    });
  }

  /**
   * Copy one bridge-owned buffer out of the WASM heap and release it.
   *
   * Contract (zephyr_wasm_bridge get_keys_file_buffer/get_cache_file_buffer): the result is
   * {"pointer","length"} of one malloc() block, or {"error":"<identifier>"} with nothing owned.
   * The block is released exactly once with the module's _free(), also if parsing or copying
   * fails; its bytes are cleared first. An empty buffer (pointer 0, length 0) owns nothing.
   */
  protected takeNativeBuffer(resultJson: string): Uint8Array {
    let loc: any;
    try {
      loc = JSON.parse(resultJson);
    } catch (err) {
      throw new ZephyrWalletError("NATIVE_ERROR", "BUFFER_RESULT");
    }
    if (loc === null || typeof loc !== "object") throw new ZephyrWalletError("NATIVE_ERROR", "BUFFER_RESULT");
    if (loc.error !== undefined) throw new ZephyrWalletError("NATIVE_ERROR", ZephyrWalletError.isDiagnostic(loc.error) ? loc.error : "BUFFER_RESULT");
    const pointer = loc.pointer;
    const length = loc.length;
    if (!Number.isSafeInteger(pointer) || !Number.isSafeInteger(length) || pointer < 0 || length < 0) throw new ZephyrWalletError("NATIVE_ERROR", "BUFFER_RESULT"); // nothing known to release
    if (length === 0) {
      if (pointer !== 0) this.module._free(pointer);
      throw new ZephyrWalletError("NATIVE_ERROR", "BUFFER_EMPTY"); // wallet keys and cache are never empty
    }
    if (pointer === 0) throw new ZephyrWalletError("NATIVE_ERROR", "BUFFER_RESULT"); // a non-empty result without a block owns nothing
    try {
      const heap: Uint8Array = this.module.HEAPU8;
      if (pointer + length > heap.length) throw new ZephyrWalletError("NATIVE_ERROR", "BUFFER_RESULT");
      const copy = heap.slice(pointer, pointer + length);
      if (copy.length !== length) throw new ZephyrWalletError("NATIVE_ERROR", "BUFFER_COPY_FAILED");
      return copy;
    } catch (err) {
      throw err instanceof ZephyrWalletError ? err : new ZephyrWalletError("NATIVE_ERROR", "BUFFER_COPY_FAILED");
    } finally {
      try {
        const heap: Uint8Array = this.module.HEAPU8;
        if (pointer + length <= heap.length) heap.fill(0, pointer, pointer + length); // clear the copy source
      } catch (err) { /* release regardless */ }
      this.module._free(pointer); // the bridge's malloc() block, released exactly once
    }
  }

  protected getDataWasm(): DataView[] {
    const viewOnlyResult = this.module.is_view_only(this.cppAddress); // 1, 0, or -1 on a native failure
    if (viewOnlyResult !== 0 && viewOnlyResult !== 1) throw new ZephyrWalletError("NATIVE_ERROR", "CORE_UNCLASSIFIED");
    const viewOnly = viewOnlyResult === 1;
    const cache = this.takeNativeBuffer(this.module.get_cache_file_buffer(this.cppAddress)); // released before the second buffer is requested
    const keys = this.takeNativeBuffer(this.module.get_keys_file_buffer(this.cppAddress, this.password, viewOnly));
    return [Buffer.from(keys.buffer, keys.byteOffset, keys.byteLength) as unknown as DataView, Buffer.from(cache.buffer, cache.byteOffset, cache.byteLength) as unknown as DataView];
  }

  /**
   * Pathless password change as one queued operation.
   *
   * Argument types are checked at admission. Inside the wallet's queue task, in this order: the
   * closed check, the TypeScript check of oldPassword against the password left by every earlier
   * queued task, the native change (the bridge verifies the old password again with the core's
   * cache-key test) and, on success, the TypeScript password update. A change queued behind
   * another therefore sees the completed earlier change, and work queued behind it (getData)
   * sees matching native and TypeScript state. On a native failure the bridge reports the
   * resulting native password state; the TypeScript password follows it ("changed" adopts the new
   * password and rejects with PASSWORD_CHANGED_WITH_ERROR; "unchanged" keeps the old one and rejects
   * with the bridge identifier). No cancellation, no timeout.
   *
   * Unknown state: if the bridge reports "unknown", reports a malformed result, or the
   * native call throws instead of reporting a result, neither password can be assumed to be the
   * native one. The call rejects with NATIVE_ERROR/PASSWORD_STATE_UNKNOWN and the wallet stops
   * ordinary admission: every later or already queued operation (getData, changePassword, getters)
   * rejects with the same diagnostic before native access. Only close (and its retry after a
   * failure) remains; there is no implicit rollback and no worker reset. Recover by closing the
   * wallet and opening wallet bytes saved before the change with the password valid for them.
   */
  async changePassword(oldPassword: string, newPassword: string): Promise<void> {
    if (this.getWalletProxy()) return this.getWalletProxy().changePassword(oldPassword, newPassword);
    if (typeof oldPassword !== "string" || typeof newPassword !== "string") throw new ZephyrWalletError("INVALID_CONFIG", "PASSWORD_TYPE");
    await this.module.queueTask(async () => {
      this.assertNotClosed(); // also rejects after an earlier unknown password state
      if (oldPassword !== this.password) throw new ZephyrWalletError("WRONG_PASSWORD"); // TypeScript check against the state of the previous queued task
      let result: unknown;
      try {
        result = await new Promise<unknown>((resolve) => {
          this.module.change_wallet_password(this.cppAddress, oldPassword, newPassword, (errResult: unknown) => resolve(errResult));
        });
      } catch (err) {
        throw this.stopAdmissionForUnknownPasswordState(); // no result was reported: the native password state is unknown
      }
      if (result === undefined) {
        this.password = newPassword; // committed in the same queue task as the successful native change
        return;
      }
      let parsed: { identifier: ZephyrBridgeErrorIdentifier; state: ZephyrBridgePasswordState };
      try {
        parsed = bridgePasswordErrorOf(result);
      } catch (err) {
        throw this.stopAdmissionForUnknownPasswordState(); // malformed result: the native password state is unverifiable
      }
      if (parsed.state === "changed") {
        this.password = newPassword; // the native wallet now holds the new password although the call failed
        throw new ZephyrWalletError("NATIVE_ERROR", "PASSWORD_CHANGED_WITH_ERROR");
      }
      if (parsed.state === "unknown") throw this.stopAdmissionForUnknownPasswordState();
      throw ZephyrWalletError.fromBridge("changePassword", parsed.identifier);
    });
    if (this.path) await this.save(); // auto save
  }
  
  async save(): Promise<void> {
    if (this.getWalletProxy()) return this.getWalletProxy().save();
    return ZephyrWalletFull.save(this);
  }
  
  protected async closeInternal(save: boolean): Promise<void> {
    if (this.walletProxy) {
      await super.closeInternal(save);
      return;
    }
    await this.prepareClose();
    if (save) {
      await LibraryUtils.queueTask(async () => {
        const snapshot = await this.getCloseData();
        await ZephyrWalletFull.writeWalletData(this, snapshot.data, snapshot.primaryAddress);
      });
    }
    await super.closeInternal(false, this.wasmListenerHandle);
    if (this.daemonRoute) { HttpClient.removeDaemonRoute(this.daemonRoute); this.daemonRoute = undefined; }
    this.wasmListenerHandle = 0;
    delete this.path;
    delete this.password;
    delete this.wasmListener;
    LibraryUtils.setRejectUnauthorizedFn(this.rejectUnauthorizedConfigId, undefined); // unregister fn informing if unauthorized reqs should be rejected
  }

  // cancel outside the module queue so a blocked request can release it
  protected async prepareClose(): Promise<void> {
    this._isClosed = true;
    if (this.syncLooper) this.syncLooper.stop();
    // the fixed core has no request_shutdown(): no native cancellation; wait for active work below
    if (this.connectionManager && this.connectionManager.getListeners().includes(this.connectionManagerListener)) this.connectionManager.removeListener(this.connectionManagerListener);
    this.connectionManager = undefined;
    this.connectionManagerListener = undefined;
    await Promise.all(Array.from(this.syncCalls, call => call.catch(() => {})));
    await this.module.queueTask(async () => {});
  }

  // serialize a stopped wallet for saving on this thread or the worker's caller
  protected async getCloseData() {
    return this.module.queueTask(async () => ({
      data: this.getDataWasm(),
      primaryAddress: ZephyrWalletError.checkBridgeResult("other", this.module.get_address(this.cppAddress, 0, 0))
    }));
  }

  // ----------- ADD JSDOC FOR SUPPORTED DEFAULT IMPLEMENTATIONS --------------
  
  async getNumBlocksToUnlock(): Promise<number[]|undefined> { return super.getNumBlocksToUnlock(); }
  async getTx(txHash: string): Promise<ZephyrTxWallet|undefined> { return super.getTx(txHash); }
  async getIncomingTransfers(query: Partial<ZephyrTransferQuery>): Promise<ZephyrIncomingTransfer[]> { return super.getIncomingTransfers(query); }
  async getOutgoingTransfers(query: Partial<ZephyrTransferQuery>) { return super.getOutgoingTransfers(query); }
  async createTx(config: Partial<ZephyrTxConfig>): Promise<ZephyrTxWallet> { return super.createTx(config); }
  async relayTx(txOrMetadata: ZephyrTxWallet | string): Promise<string> { return super.relayTx(txOrMetadata); }
  async getTxNote(txHash: string): Promise<string> { return super.getTxNote(txHash); }
  async setTxNote(txHash: string, note: string): Promise<void> { return super.setTxNote(txHash, note); }
  
  // ---------------------------- PRIVATE HELPERS ----------------------------

  protected static async openWalletData(config: Partial<ZephyrWalletConfig>, signal?: AbortSignal) {
    if (config.proxyToWorker) {
      let walletProxy = await ZephyrWalletFullProxy.openWalletData(config, signal);
      return new ZephyrWalletFull(undefined, undefined, undefined, undefined, undefined, undefined, walletProxy);
    }
    
    // validate and normalize parameters
    if (config.networkType === undefined) throw new ZephyrError("Must provide the wallet's network type");
    config.networkType = ZephyrNetworkType.from(config.networkType);
    let daemonConnection = config.getServer();
    let daemonUri = daemonConnection && daemonConnection.getUri() ? daemonConnection.getUri() : "";
    let daemonUsername = daemonConnection && daemonConnection.getUsername() ? daemonConnection.getUsername() : "";
    let daemonPassword = daemonConnection && daemonConnection.getPassword() ? daemonConnection.getPassword() : "";
    let rejectUnauthorized = daemonConnection ? daemonConnection.getRejectUnauthorized() : true;
    
    // load wasm module
    let module = await LibraryUtils.loadWasmModule();
    
    // open wallet in queue
    return module.queueTask(async () => {
      return new Promise((resolve, reject) => {
        
        // register fn informing if unauthorized reqs should be rejected
        let rejectUnauthorizedFnId = GenUtils.getUUID();
        LibraryUtils.setRejectUnauthorizedFn(rejectUnauthorizedFnId, () => rejectUnauthorized);
      
        // create wallet in wasm which invokes callback when done
        module.open_wallet_full(config.password, config.networkType, config.keysData ?? "", config.cacheData ?? "", daemonUri, daemonUsername, daemonPassword, rejectUnauthorizedFnId, config.getRegtest() === undefined ? false : config.getRegtest(), (cppAddress) => {
          if (typeof cppAddress === "string") reject(ZephyrWalletError.fromBridgeResult("open", cppAddress)); // fixed bridge identifier only
          else resolve(new ZephyrWalletFull(cppAddress, config.path, config.password, config.fs, rejectUnauthorized, rejectUnauthorizedFnId));
        });
      });
    });
  }

  protected getWalletProxy(): ZephyrWalletFullProxy {
    return super.getWalletProxy() as ZephyrWalletFullProxy;
  }
  
  protected async backgroundSync() {
    let label = this.path ? this.path : (this.browserMainPath ? this.browserMainPath : "in-memory wallet"); // label for log
    LibraryUtils.log(1, "Background synchronizing " + label);
    try { await this.sync(); }
    catch (err: any) { if (!this._isClosed) console.error("Failed to background synchronize " + label + ": " + err.message); }
  }
  
  protected async refreshListening() {
    if (this._isClosed) return;
    let isEnabled = this.listeners.length > 0;
    if (this.wasmListenerHandle === 0 && !isEnabled || this.wasmListenerHandle > 0 && isEnabled) return; // no difference
    return this.module.queueTask(async () => {
      if (this._isClosed) return;
      return new Promise<void>((resolve, reject) => {
        this.module.set_listener(
          this.cppAddress,
          this.wasmListenerHandle,
            newListenerHandle => {
              if (typeof newListenerHandle === "string") reject(new ZephyrError(newListenerHandle));
              else {
                this.wasmListenerHandle = newListenerHandle;
                resolve();
              }
            },
            isEnabled ? async (height, startHeight, endHeight, percentDone, message) => await this.wasmListener.onSyncProgress(height, startHeight, endHeight, percentDone, message) : undefined,
            isEnabled ? async (height) => await this.wasmListener.onNewBlock(height) : undefined,
            isEnabled ? async (newBalanceStr, newUnlockedBalanceStr) => await this.wasmListener.onBalancesChanged(newBalanceStr, newUnlockedBalanceStr) : undefined,
            isEnabled ? async (height, txHash, amountStr, accountIdx, subaddressIdx, version, unlockTime, isLocked) => await this.wasmListener.onOutputReceived(height, txHash, amountStr, accountIdx, subaddressIdx, version, unlockTime, isLocked) : undefined,
            isEnabled ? async (height, txHash, amountStr, accountIdxStr, subaddressIdxStr, version, unlockTime, isLocked) => await this.wasmListener.onOutputSpent(height, txHash, amountStr, accountIdxStr, subaddressIdxStr, version, unlockTime, isLocked) : undefined,
        );
      });
    });
  }
  
  static sanitizeBlock(block) {
    for (let tx of block.getTxs()) ZephyrWalletFull.sanitizeTxWallet(tx);
    return block;
  }
  
  static sanitizeTxWallet(tx) {
    assert(tx instanceof ZephyrTxWallet);
    return tx;
  }
  
  static sanitizeAccount(account) {
    if (account.getSubaddresses()) {
      for (let subaddress of account.getSubaddresses()) ZephyrWalletKeys.sanitizeSubaddress(subaddress);
    }
    return account;
  }
  
  static deserializeBlocks(blocksJsonStr) {
    let blocksJson = JSON.parse(GenUtils.stringifyBigInts(blocksJsonStr));
    let deserializedBlocks: any = {};
    deserializedBlocks.blocks = [];
    if (blocksJson.blocks) for (let blockJson of blocksJson.blocks) deserializedBlocks.blocks.push(ZephyrWalletFull.sanitizeBlock(new ZephyrBlock(blockJson, ZephyrBlock.DeserializationType.TX_WALLET)));
    return deserializedBlocks;
  }
  
  static deserializeTxs(query, blocksJsonStr) {
    
    // deserialize blocks
    let deserializedBlocks = ZephyrWalletFull.deserializeBlocks(blocksJsonStr);
    let blocks = deserializedBlocks.blocks;
    
    // collect txs
    let txs = [];
    for (let block of blocks) {
      ZephyrWalletFull.sanitizeBlock(block);
      for (let tx of block.getTxs()) {
        if (block.getHeight() === undefined) tx.setBlock(undefined); // dereference placeholder block for unconfirmed txs
        txs.push(tx);
      }
    }
    
    // re-sort txs which is lost over wasm serialization  // TODO: confirm that order is lost
    if (query.getHashes() !== undefined) {
      let txMap = new Map();
      for (let tx of txs) txMap[tx.getHash()] = tx;
      let txsSorted = [];
      for (let txHash of query.getHashes()) if (txMap[txHash] !== undefined) txsSorted.push(txMap[txHash]);
      txs = txsSorted;
    }
    
    return txs;
  }
  
  static deserializeTransfers(query, blocksJsonStr) {
    
    // deserialize blocks
    let deserializedBlocks = ZephyrWalletFull.deserializeBlocks(blocksJsonStr);
    let blocks = deserializedBlocks.blocks;
    
    // collect transfers
    let transfers = [];
    for (let block of blocks) {
      for (let tx of block.getTxs()) {
        if (block.getHeight() === undefined) tx.setBlock(undefined); // dereference placeholder block for unconfirmed txs
        if (tx.getOutgoingTransfer() !== undefined) transfers.push(tx.getOutgoingTransfer());
        if (tx.getIncomingTransfers() !== undefined) {
          for (let transfer of tx.getIncomingTransfers()) transfers.push(transfer);
        }
      }
    }
    
    return transfers;
  }
  
  static deserializeOutputs(query, blocksJsonStr) {
    
    // deserialize blocks
    let deserializedBlocks = ZephyrWalletFull.deserializeBlocks(blocksJsonStr);
    let blocks = deserializedBlocks.blocks;
    
    // collect outputs
    let outputs = [];
    for (let block of blocks) {
      for (let tx of block.getTxs()) {
        for (let output of tx.getOutputs()) outputs.push(output);
      }
    }
    
    return outputs;
  }
  
  /**
   * Set the path of the wallet on the browser main thread if run as a worker.
   * 
   * @param {string} browserMainPath - path of the wallet on the browser main thread
   */
  protected setBrowserMainPath(browserMainPath) {
    this.browserMainPath = browserMainPath;
  }
  
  static async moveTo(path, wallet) {

    // save and return if same path
    if (Path.normalize(wallet.path) === Path.normalize(path)) {
      return wallet.save();
    }

    return LibraryUtils.queueTask(async () => {
      if (await wallet.isClosed()) throw new ZephyrError("Wallet is closed");
      if (!path) throw new ZephyrError("Must provide path of destination wallet");

      // create destination directory if it doesn't exist
      let walletDir = Path.dirname(path);
      if (!await LibraryUtils.exists(wallet.fs, walletDir)) {
        try { await wallet.fs.mkdir(walletDir); }
        catch (err: any) { throw new ZephyrError("Destination path " + path + " does not exist and cannot be created: " + err.message); }
      }

      // get wallet data
      const data = await wallet.getData();

      // write wallet files
      await wallet.fs.writeFile(path + ".keys", data[0], "binary");
      await wallet.fs.writeFile(path, data[1], "binary");
      await wallet.fs.writeFile(path + ".address.txt", await wallet.getPrimaryAddress());
      let oldPath = wallet.path;
      wallet.path = path;

      // delete old wallet files
      if (oldPath) {
        await wallet.fs.unlink(oldPath + ".address.txt");
        await wallet.fs.unlink(oldPath + ".keys");
        await wallet.fs.unlink(oldPath);
      }
    });
  }
  
  static async save(wallet: any) {
    return LibraryUtils.queueTask(async () => {
      if (await wallet.isClosed()) throw new ZephyrError("Wallet is closed");

      if (!await wallet.getPath()) throw new ZephyrError("Cannot save wallet because path is not set");
      await ZephyrWalletFull.writeWalletData(wallet, await wallet.getData(), await wallet.getPrimaryAddress());
    });
  }

  static async writeWalletData(wallet: any, data: DataView[], primaryAddress: string) {
    let path = wallet.path;
    if (!path) throw new ZephyrError("Cannot save wallet because path is not set");

    // write wallet files to *.new
    let pathNew = path + ".new";
    await wallet.fs.writeFile(pathNew + ".keys", data[0], "binary");
    await wallet.fs.writeFile(pathNew, data[1], "binary");
    await wallet.fs.writeFile(pathNew + ".address.txt", primaryAddress);

    // replace old wallet files with new
    await wallet.fs.rename(pathNew + ".keys", path + ".keys");
    await wallet.fs.rename(pathNew, path);
    await wallet.fs.rename(pathNew + ".address.txt", path + ".address.txt");
  }
}

/**
 * Implements a ZephyrWalletBase by proxying requests to a worker which runs a full wallet.
 * 
 * @private
 */
class ZephyrWalletFullProxy extends ZephyrWalletKeysProxy {

  // instance variables
  protected path: any;
  protected fs: any;
  protected wrappedListeners: any;
  
  // -------------------------- WALLET STATIC UTILS ---------------------------
  
  // each construction runs in its own new worker, which the returned proxy owns
  static async openWalletData(config: Partial<ZephyrWalletConfig>, signal?: AbortSignal) {
    if (config.password === undefined) config.password = "";
    let daemonConnection = config.getServer();
    const full = config as ZephyrWalletConfig; // normalized by openWallet
    const handle = await LibraryUtils.constructWalletInWorker("openWalletData", [full.path, full.password, full.networkType, full.keysData, full.cacheData, daemonConnection ? daemonConnection.toJson() : undefined, full.getRegtest()], signal);
    let wallet = new ZephyrWalletFullProxy(handle.walletId, handle.channel, full.path, full.getFs());
    if (config.path) await wallet.save();
    return wallet;
  }
  
  static async createWallet(config: ZephyrWalletConfig, signal?: AbortSignal) {
    if (config.getPath() && await ZephyrWalletFull.walletExists(config.getPath(), config.getFs())) throw new ZephyrError("Wallet already exists: " + config.getPath());
    const handle = await LibraryUtils.constructWalletInWorker("createWalletFull", [config.toJson()], signal);
    let wallet = new ZephyrWalletFullProxy(handle.walletId, handle.channel, config.getPath(), config.getFs());
    if (config.getPath()) await wallet.save();
    return wallet;
  }
  
  // --------------------------- INSTANCE METHODS ----------------------------
  
  /**
   * Internal constructor which is given a worker to communicate with via messages.
   * 
   * This method should not be called externally but should be called through
   * static wallet creation utilities in this class.
   * 
   * @param {string} walletId - identifies the wallet with the worker
   * @param {ZephyrWorkerChannel} channel - the wallet's own worker, owned exclusively by this proxy
   */
  constructor(walletId: string, channel: ZephyrWorkerChannel, path: string | undefined, fs: any) {
    super(walletId, channel);
    this.path = path;
    this.fs = fs ? fs : (path ? ZephyrWalletFull.getFs() : undefined);
    this.wrappedListeners = [];
  }

  getPath() {
    return this.path;
  }

  async getNetworkType() {
    return this.invokeWorker("getNetworkType");
  }
  
  async setSubaddressLabel(accountIdx: number, subaddressIdx: number, label: string): Promise<void> {
    throw ZephyrWalletError.unsupported("NATIVE_EXPORT");
  }
  
  /** The worker re-validates the address from its normalized text */
  async setDaemonRoute(route: ZephyrDaemonRoute | undefined): Promise<void> {
    await this.invokeWorker("setDaemonConnection", [route ? route.uri : undefined]);
  }

  async setDaemonConnection(uriOrRpcConnection, isTrusted?) {
    if (isTrusted === false) throw ZephyrWalletError.unsupported("UNTRUSTED_DAEMON");
    return this.setDaemonRoute(uriOrRpcConnection === undefined || uriOrRpcConnection === null || uriOrRpcConnection === "" ? undefined : parseDaemonAddress(uriOrRpcConnection));
  }

  async isDaemonTrusted() {
    return this.invokeWorker("isDaemonTrusted") as Promise<boolean>;
  }

  async getDaemonConnection() {
    let rpcConfig = await this.invokeWorker("getDaemonConnection");
    return rpcConfig ? new ZephyrRpcConnection(rpcConfig) : undefined;
  }
  
  async isConnectedToDaemon(): Promise<boolean> {
    const connected = await this.invokeWorker("isConnectedToDaemon");
    if (typeof connected !== "boolean") throw new ZephyrWalletError("MALFORMED_MESSAGE", "MESSAGE_SHAPE");
    return connected;
  }
  
  async getRestoreHeight() {
    return this.invokeWorker("getRestoreHeight");
  }

  async setRestoreHeightFromDaemon(): Promise<boolean> {
    const set = await this.invokeWorker("setRestoreHeightFromDaemon");
    if (typeof set !== "boolean") throw new ZephyrWalletError("MALFORMED_MESSAGE", "MESSAGE_SHAPE");
    return set;
  }
  
  async setRestoreHeight(restoreHeight) {
    return this.invokeWorker("setRestoreHeight", [restoreHeight]);
  }
  
  async getDaemonHeight(): Promise<number> {
    return ZephyrWalletFullProxy.heightOf(await this.invokeWorker("getDaemonHeight"));
  }

  protected static heightOf(value: unknown): number {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new ZephyrWalletError("MALFORMED_MESSAGE", "MESSAGE_SHAPE");
    return value;
  }
  
  async getDaemonMaxPeerHeight() {
    return this.invokeWorker("getDaemonMaxPeerHeight");
  }
  
  async getHeightByDate(year, month, day) {
    return this.invokeWorker("getHeightByDate", [year, month, day]);
  }
  
  async isDaemonSynced(): Promise<boolean> {
    const synced = await this.invokeWorker("isDaemonSynced");
    if (typeof synced !== "boolean") throw new ZephyrWalletError("MALFORMED_MESSAGE", "MESSAGE_SHAPE");
    return synced;
  }
  
  async getHeight(): Promise<number> {
    return ZephyrWalletFullProxy.heightOf(await this.invokeWorker("getHeight"));
  }
  
  async addListener(listener) {
    let wrappedListener = new WalletWorkerListener(listener, () => this._isClosed);
    let listenerId = wrappedListener.getId();
    this.channel.addCallback(this.walletId, "onSyncProgress_" + listenerId, [wrappedListener.onSyncProgress, wrappedListener]);
    this.channel.addCallback(this.walletId, "onNewBlock_" + listenerId, [wrappedListener.onNewBlock, wrappedListener]);
    this.channel.addCallback(this.walletId, "onBalancesChanged_" + listenerId, [wrappedListener.onBalancesChanged, wrappedListener]);
    this.channel.addCallback(this.walletId, "onOutputReceived_" + listenerId, [wrappedListener.onOutputReceived, wrappedListener]);
    this.channel.addCallback(this.walletId, "onOutputSpent_" + listenerId, [wrappedListener.onOutputSpent, wrappedListener]);
    this.wrappedListeners.push(wrappedListener);
    return this.invokeWorker("addListener", [listenerId]);
  }
  
  async removeListener(listener) {
    for (let i = 0; i < this.wrappedListeners.length; i++) {
      if (this.wrappedListeners[i].getListener() === listener) {
        let listenerId = this.wrappedListeners[i].getId();
        await this.invokeWorker("removeListener", [listenerId]);
        this.channel.removeCallback(this.walletId, "onSyncProgress_" + listenerId);
        this.channel.removeCallback(this.walletId, "onNewBlock_" + listenerId);
        this.channel.removeCallback(this.walletId, "onBalancesChanged_" + listenerId);
        this.channel.removeCallback(this.walletId, "onOutputReceived_" + listenerId);
        this.channel.removeCallback(this.walletId, "onOutputSpent_" + listenerId);
        this.wrappedListeners.splice(i, 1);
        return;
      }
    }
    throw new ZephyrError("Listener is not registered with wallet");
  }
  
  getListeners() {
    let listeners = [];
    for (let wrappedListener of this.wrappedListeners) listeners.push(wrappedListener.getListener());
    return listeners;
  }
  
  async isSynced() {
    return this.invokeWorker("isSynced");
  }
  
  async sync(listenerOrStartHeight?: ZephyrWalletListener | number, startHeight?: number, allowConcurrentCalls = false): Promise<ZephyrSyncResult> {
    if (listenerOrStartHeight instanceof ZephyrWalletListener) throw ZephyrWalletError.unsupported("LISTENERS");
    if (startHeight !== undefined || allowConcurrentCalls !== false) throw ZephyrWalletError.unsupported("SYNC");
    if (listenerOrStartHeight !== undefined && !isRestoreHeight(listenerOrStartHeight)) throw new ZephyrWalletError("INVALID_CONFIG", "SYNC_START_HEIGHT");
    return this.syncFrom(listenerOrStartHeight);
  }

  /** One blocking sync in the wallet's worker; the reply is a strict DTO */
  async syncFrom(start: number | undefined): Promise<ZephyrSyncResult> {
    return ZephyrWalletFull.syncResultOf(await this.invokeWorker("sync", start === undefined ? [] : [start]), "MALFORMED_MESSAGE");
  }

  async getBalanceMap(unlocked: boolean): Promise<ZephyrAssetBalances> {
    return fromAssetBalancesDto(await this.invokeWorker("getBalances", [unlocked]));
  }

  async getAccountBalanceMap(unlocked: boolean, accountIdx: number): Promise<ZephyrAccountBalances> {
    return fromAccountBalancesDto(await this.invokeWorker("getAccountBalances", [unlocked, accountIdx]));
  }

  async getAssetBalance(unlocked: boolean, assetType: string, accountIdx: number, subaddressIdx?: number): Promise<bigint> {
    const value = await this.invokeWorker("getAssetBalance", subaddressIdx === undefined ? [unlocked, assetType, accountIdx] : [unlocked, assetType, accountIdx, subaddressIdx]);
    try { return parseUint64Text(value); } catch (err) { throw new ZephyrWalletError("MALFORMED_MESSAGE", "MESSAGE_SHAPE"); }
  }
  
  async startSyncing(syncPeriodInMs) {
    return this.invokeWorker("startSyncing", Array.from(arguments));
  }
    
  async stopSyncing() {
    return this.invokeWorker("stopSyncing");
  }
  
  async scanTxs(txHashes) {
    assert(Array.isArray(txHashes), "Must provide an array of txs hashes to scan");
    return this.invokeWorker("scanTxs", [txHashes]);
  }
  
  async rescanSpent() {
    return this.invokeWorker("rescanSpent");
  }
    
  async rescanBlockchain() {
    return this.invokeWorker("rescanBlockchain");
  }
  
  async getBalance(accountIdx, subaddressIdx) {
    return BigInt(await this.invokeWorker("getBalance", Array.from(arguments)));
  }
  
  async getUnlockedBalance(accountIdx, subaddressIdx) {
    let unlockedBalanceStr = await this.invokeWorker("getUnlockedBalance", Array.from(arguments));
    return BigInt(unlockedBalanceStr);
  }
  
  async getAccounts(includeSubaddresses?: boolean, tag?: string): Promise<ZephyrAccountInherited[]> { throw ZephyrWalletError.unsupported("NATIVE_EXPORT"); }
  async getAccount(accountIdx: number, includeSubaddresses?: boolean): Promise<ZephyrAccountInherited> { throw ZephyrWalletError.unsupported("NATIVE_EXPORT"); }
  async createAccount(label?: string): Promise<ZephyrAccountInherited> { throw ZephyrWalletError.unsupported("NATIVE_EXPORT"); }
  async getSubaddresses(accountIdx: number, subaddressIndices?: number[]): Promise<ZephyrSubaddressInherited[]> { throw ZephyrWalletError.unsupported("NATIVE_EXPORT"); }
  async createSubaddress(accountIdx: number, label?: string): Promise<ZephyrSubaddressInherited> { throw ZephyrWalletError.unsupported("NATIVE_EXPORT"); }

  async getAccountsChecked(includeSubaddresses: boolean): Promise<ReadonlyArray<ZephyrAccount>> {
    return fromAccountsDto(await this.invokeWorker("getAccounts", [includeSubaddresses]), includeSubaddresses, MAX_ACCOUNTS_PER_CALL);
  }

  async getAccountChecked(accountIdx: number, includeSubaddresses: boolean): Promise<ZephyrAccount> {
    return fromAccountDto(await this.invokeWorker("getAccount", [accountIdx, includeSubaddresses]), accountIdx, includeSubaddresses);
  }

  async createAccountChecked(label: string): Promise<ZephyrAccount> {
    return fromAccountDto(await this.invokeWorker("createAccount", [label]), undefined, false);
  }

  async getSubaddressesChecked(accountIdx: number, indices: readonly number[] | undefined): Promise<ReadonlyArray<ZephyrSubaddress>> {
    return fromSubaddressesDto(await this.invokeWorker("getSubaddresses", indices === undefined ? [accountIdx] : [accountIdx, indices.slice()]), accountIdx, indices);
  }

  async createSubaddressChecked(accountIdx: number, label: string): Promise<ZephyrSubaddress> {
    return fromSubaddressDto(await this.invokeWorker("createSubaddress", [accountIdx, label]), accountIdx);
  }

  async setSubaddressLabelChecked(accountIdx: number, subaddressIdx: number, label: string): Promise<void> {
    if (await this.invokeWorker("setSubaddressLabel", [accountIdx, subaddressIdx, label]) !== undefined) throw new ZephyrWalletError("MALFORMED_MESSAGE", "MESSAGE_SHAPE");
  }

  async getAddressIndexChecked(address: string): Promise<ZephyrAddressIndex> {
    return fromAddressIndexDto(await this.invokeWorker("getAddressIndex", [address]));
  }
  
  async getHistoryChecked(selection: ZephyrHistorySelection): Promise<ReadonlyArray<ZephyrWalletTx>> {
    const args: unknown[] = [selection.status, selection.minHeight, selection.maxHeight];
    if (selection.hashes !== undefined) args.push(selection.hashes.slice());
    return fromTxsDto(await this.invokeWorker("getHistory", args), selection);
  }

  async refreshPoolChecked(): Promise<number> {
    return fromPoolRefreshDto(await this.invokeWorker("refreshPool"));
  }

  async buildTransferChecked(request: ZephyrTransferRequest): Promise<ZephyrTransferBuild> {
    return fromBuildDto(await this.invokeWorker("buildTransfer", [request.asset, request.addresses.slice(), request.amounts.slice(), request.accountIndex, request.subaddressIndices.slice(), request.priority]), request);
  }

  async getTxs(query?: string[] | Partial<ZephyrTxQuery>): Promise<ZephyrTxWallet[]> { throw ZephyrWalletError.unsupported("NATIVE_EXPORT"); }
  
  async getTransfers(query) {
    query = ZephyrWalletBase.normalizeTransferQuery(query);
    let blockJsons = await this.invokeWorker("getTransfers", [query.getTxQuery().getBlock().toJson()]);
    return ZephyrWalletFull.deserializeTransfers(query, JSON.stringify({blocks: blockJsons})); // initialize transfers from blocks json string TODO: this stringifies then utility parses, avoid
  }
  
  async getOutputs(query) {
    query = ZephyrWalletBase.normalizeOutputQuery(query);
    let blockJsons = await this.invokeWorker("getOutputs", [query.getTxQuery().getBlock().toJson()]);
    return ZephyrWalletFull.deserializeOutputs(query, JSON.stringify({blocks: blockJsons})); // initialize transfers from blocks json string TODO: this stringifies then utility parses, avoid
  }
  
  async exportOutputs(all) {
    return this.invokeWorker("exportOutputs", [all]);
  }
  
  async importOutputs(outputsHex) {
    return this.invokeWorker("importOutputs", [outputsHex]);
  }
  
  async exportKeyImages(all) {
    return new ZephyrKeyImageExportResult(await this.invokeWorker("getKeyImages", [all]));
  }
  
  async importKeyImages(keyImages, offset = 0) {
    let keyImagesJson = [];
    for (let keyImage of keyImages) keyImagesJson.push(keyImage.toJson());
    return new ZephyrKeyImageImportResult(await this.invokeWorker("importKeyImages", [keyImagesJson, offset]));
  }
  
  async getNewKeyImagesFromLastImport(): Promise<ZephyrKeyImage[]> {
    throw new ZephyrError("ZephyrWalletFull.getNewKeyImagesFromLastImport() not implemented");
  }
  
  async freezeOutput(keyImage) {
    return this.invokeWorker("freezeOutput", [keyImage]);
  }
  
  async thawOutput(keyImage) {
    return this.invokeWorker("thawOutput", [keyImage]);
  }
  
  async isOutputFrozen(keyImage) {
    return this.invokeWorker("isOutputFrozen", [keyImage]);
  }

  async getDefaultFeePriority() {
    return this.invokeWorker("getDefaultFeePriority");
  }
  
  async createTxs(config) {
    config = ZephyrWalletBase.normalizeCreateTxsConfig(config);
    let txSetJson = await this.invokeWorker("createTxs", [config.toJson()]);
    return new ZephyrTxSet(txSetJson).getTxs();
  }
  
  async sweepOutput(config) {
    config = ZephyrWalletBase.normalizeSweepOutputConfig(config);
    let txSetJson = await this.invokeWorker("sweepOutput", [config.toJson()]);
    return new ZephyrTxSet(txSetJson).getTxs()[0];
  }

  async sweepUnlocked(config) {
    config = ZephyrWalletBase.normalizeSweepUnlockedConfig(config);
    let txSetsJson = await this.invokeWorker("sweepUnlocked", [config.toJson()]);
    let txs = [];
    for (let txSetJson of txSetsJson) for (let tx of new ZephyrTxSet(txSetJson).getTxs()) txs.push(tx);
    return txs;
  }
  
  async sweepDust(relay) {
    return new ZephyrTxSet(await this.invokeWorker("sweepDust", [relay])).getTxs() || [];
  }
  
  async relayTxs(txsOrMetadatas) {
    assert(Array.isArray(txsOrMetadatas), "Must provide an array of txs or their metadata to relay");
    let txMetadatas = [];
    for (let txOrMetadata of txsOrMetadatas) txMetadatas.push(txOrMetadata instanceof ZephyrTxWallet ? txOrMetadata.getMetadata() : txOrMetadata);
    return this.invokeWorker("relayTxs", [txMetadatas]);
  }
  
  async describeTxSet(txSet) {
    return new ZephyrTxSet(await this.invokeWorker("describeTxSet", [txSet.toJson()]));
  }
  
  async signTxs(unsignedTxHex) {
    return new ZephyrTxSet(await this.invokeWorker("signTxs", Array.from(arguments)));
  }
  
  async submitTxs(signedTxHex) {
    return this.invokeWorker("submitTxs", Array.from(arguments));
  }
  
  async signMessage(message, signatureType, accountIdx, subaddressIdx) {
    return this.invokeWorker("signMessage", Array.from(arguments));
  }
  
  async verifyMessage(message, address, signature) {
    return new ZephyrMessageSignatureResult(await this.invokeWorker("verifyMessage", Array.from(arguments)));
  }
  
  async getTxKey(txHash) {
    return this.invokeWorker("getTxKey", Array.from(arguments));
  }
  
  async checkTxKey(txHash, txKey, address) {
    return new ZephyrCheckTx(await this.invokeWorker("checkTxKey", Array.from(arguments)));
  }
  
  async getTxProof(txHash, address, message) {
    return this.invokeWorker("getTxProof", Array.from(arguments));
  }
  
  async checkTxProof(txHash, address, message, signature) {
    return new ZephyrCheckTx(await this.invokeWorker("checkTxProof", Array.from(arguments)));
  }
  
  async getSpendProof(txHash, message) {
    return this.invokeWorker("getSpendProof", Array.from(arguments));
  }
  
  async checkSpendProof(txHash, message, signature) {
    return this.invokeWorker("checkSpendProof", Array.from(arguments));
  }
  
  async getReserveProofWallet(message) {
    return this.invokeWorker("getReserveProofWallet", Array.from(arguments));
  }
  
  async getReserveProofAccount(accountIdx, amount, message) {
    try { return await this.invokeWorker("getReserveProofAccount", [accountIdx, amount.toString(), message]); }
    catch (e: any) { throw new ZephyrError(e.message, -1); }
  }

  async checkReserveProof(address, message, signature) {
    try { return new ZephyrCheckReserve(await this.invokeWorker("checkReserveProof", Array.from(arguments))); }
    catch (e: any) { throw new ZephyrError(e.message, -1); }
  }
  
  async getTxNotes(txHashes) {
    return this.invokeWorker("getTxNotes", Array.from(arguments));
  }
  
  async setTxNotes(txHashes, notes) {
    return this.invokeWorker("setTxNotes", Array.from(arguments));
  }
  
  async getAddressBookEntries(entryIndices) {
    if (!entryIndices) entryIndices = [];
    let entries = [];
    for (let entryJson of await this.invokeWorker("getAddressBookEntries", Array.from(arguments))) {
      entries.push(new ZephyrAddressBookEntry(entryJson));
    }
    return entries;
  }
  
  async addAddressBookEntry(address, description) {
    return this.invokeWorker("addAddressBookEntry", Array.from(arguments));
  }
  
  async editAddressBookEntry(index, setAddress, address, setDescription, description) {
    return this.invokeWorker("editAddressBookEntry", Array.from(arguments));
  }
  
  async deleteAddressBookEntry(entryIdx) {
    return this.invokeWorker("deleteAddressBookEntry", Array.from(arguments));
  }
  
  async tagAccounts(tag, accountIndices) {
    return this.invokeWorker("tagAccounts", Array.from(arguments));
  }

  async untagAccounts(accountIndices) {
    return this.invokeWorker("untagAccounts", Array.from(arguments));
  }
  
  async getAccountTags() {
    return this.invokeWorker("getAccountTags", Array.from(arguments));
  }

  async setAccountTagLabel(tag, label) {
    return this.invokeWorker("setAccountTagLabel", Array.from(arguments));
  }
  
  async getPaymentUri(config) {
    config = ZephyrWalletBase.normalizeCreateTxsConfig(config);
    return this.invokeWorker("getPaymentUri", [config.toJson()]);
  }
  
  async parsePaymentUri(uri) {
    return new ZephyrTxConfig(await this.invokeWorker("parsePaymentUri", Array.from(arguments)));
  }
  
  async getAttribute(key) {
    return this.invokeWorker("getAttribute", Array.from(arguments));
  }
  
  async setAttribute(key, val) {
    return this.invokeWorker("setAttribute", Array.from(arguments));
  }
  
  async startMining(numThreads, backgroundMining, ignoreBattery) {
    return this.invokeWorker("startMining", Array.from(arguments));
  }
  
  async stopMining() {
    return this.invokeWorker("stopMining", Array.from(arguments));
  }
  
  async isMultisigImportNeeded() {
    return this.invokeWorker("isMultisigImportNeeded");
  }
  
  async isMultisig() {
    return this.invokeWorker("isMultisig");
  }
  
  async getMultisigInfo() {
    return new ZephyrMultisigInfo(await this.invokeWorker("getMultisigInfo"));
  }
  
  async prepareMultisig() {
    return this.invokeWorker("prepareMultisig");
  }
  
  async makeMultisig(multisigHexes, threshold, password) {
    return await this.invokeWorker("makeMultisig", Array.from(arguments));
  }
  
  async exchangeMultisigKeys(multisigHexes, password) {
    return new ZephyrMultisigInitResult(await this.invokeWorker("exchangeMultisigKeys", Array.from(arguments)));
  }
  
  async exportMultisigHex() {
    return this.invokeWorker("exportMultisigHex");
  }
  
  async importMultisigHex(multisigHexes, refreshAfterImport) {
    return this.invokeWorker("importMultisigHex", Array.from(arguments));
  }
  
  async signMultisigTxHex(multisigTxHex) {
    return new ZephyrMultisigSignResult(await this.invokeWorker("signMultisigTxHex", Array.from(arguments)));
  }
  
  async submitMultisigTxHex(signedMultisigTxHex) {
    return this.invokeWorker("submitMultisigTxHex", Array.from(arguments));
  }
  
  async getData() {
    return this.invokeWorker("getData");
  }
  
  async moveTo(path) {
    return ZephyrWalletFull.moveTo(path, this);
  }
  
  async changePassword(oldPassword, newPassword) {
    await this.invokeWorker("changePassword", Array.from(arguments));
    if (this.path) await this.save(); // auto save
  }
  
  async save() {
    return ZephyrWalletFull.save(this);
  }

  async isClosed() {
    return this._isClosed || super.isClosed();
  }

  /** @internal forced stop (see ZephyrWalletKeysProxy.terminateWorker); listener wrappers are dropped */
  terminateWorker(): void {
    this._isClosed = true;
    this.wrappedListeners.length = 0;
    super.terminateWorker();
  }

  async close(save) {
    this._isClosed = true;
    if (!this.channel.isOpen()) return; // the worker already ended: no reachable native handle (see ZephyrWalletKeysProxy.close)
    await this.invokeWorker("prepareClose");
    if (save) {
      await LibraryUtils.queueTask(async () => {
        const snapshot = await this.invokeWorker("getCloseData");
        await ZephyrWalletFull.writeWalletData(this, snapshot.data, snapshot.primaryAddress);
      });
    }
    await super.close(false);
    this.wrappedListeners.length = 0;
  }
}

// -------------------------------- LISTENING ---------------------------------

/**
 * Receives notifications directly from wasm c++.
 * 
 * @private
 */
class WalletWasmListener {

  protected wallet: ZephyrWalletBase;
  
  constructor(wallet) {
    this.wallet = wallet;
  }
  
  async onSyncProgress(height, startHeight, endHeight, percentDone, message) {
    await this.wallet.announceSyncProgress(height, startHeight, endHeight, percentDone, message);
  }
  
  async onNewBlock(height) {
    await this.wallet.announceNewBlock(height);
  }
  
  async onBalancesChanged(newBalanceStr, newUnlockedBalanceStr) {
    await this.wallet.announceBalancesChanged(newBalanceStr, newUnlockedBalanceStr);
  }
  
  async onOutputReceived(height, txHash, amountStr, accountIdx, subaddressIdx, version, unlockTime, isLocked) {
    
    // build received output
    let output = new ZephyrOutputWallet();
    output.setAmount(BigInt(amountStr));
    output.setAccountIndex(accountIdx);
    output.setSubaddressIndex(subaddressIdx);
    let tx = new ZephyrTxWallet();
    tx.setHash(txHash);
    tx.setVersion(version);
    tx.setUnlockTime(unlockTime);
    output.setTx(tx);
    tx.setOutputs([output]);
    tx.setIsIncoming(true);
    tx.setIsLocked(isLocked);
    if (height > 0) {
      let block = new ZephyrBlock().setHeight(height);
      block.setTxs([tx as ZephyrTx]);
      tx.setBlock(block);
      tx.setIsConfirmed(true);
      tx.setInTxPool(false);
      tx.setIsFailed(false);
    } else {
      tx.setIsConfirmed(false);
      tx.setInTxPool(true);
    }
    
    // announce output
    await this.wallet.announceOutputReceived(output);
  }
  
  async onOutputSpent(height, txHash, amountStr, accountIdxStr, subaddressIdxStr, version, unlockTime, isLocked) {
    
    // build spent output
    let output = new ZephyrOutputWallet();
    output.setAmount(BigInt(amountStr));
    if (accountIdxStr) output.setAccountIndex(parseInt(accountIdxStr));
    if (subaddressIdxStr) output.setSubaddressIndex(parseInt(subaddressIdxStr));
    let tx = new ZephyrTxWallet();
    tx.setHash(txHash);
    tx.setVersion(version);
    tx.setUnlockTime(unlockTime);
    tx.setIsLocked(isLocked);
    output.setTx(tx);
    tx.setInputs([output]);
    if (height > 0) {
      let block = new ZephyrBlock().setHeight(height);
      block.setTxs([tx]);
      tx.setBlock(block);
      tx.setIsConfirmed(true);
      tx.setInTxPool(false);
      tx.setIsFailed(false);
    } else {
      tx.setIsConfirmed(false);
      tx.setInTxPool(true);
    }
    
    // announce output
    await this.wallet.announceOutputSpent(output);
  }
}

/**
 * Internal listener to bridge notifications to external listeners.
 * 
 * @private
 */
class WalletWorkerListener {

  protected id: any;
  protected listener: any;
  protected isClosed: () => boolean;
  
  constructor(listener, isClosed) {
    this.id = GenUtils.getUUID();
    this.listener = listener;
    this.isClosed = isClosed;
  }
  
  getId() {
    return this.id;
  }
  
  getListener() {
    return this.listener;
  }
  
  onSyncProgress(height, startHeight, endHeight, percentDone, message) {
    if (this.isClosed()) return;
    this.listener.onSyncProgress(height, startHeight, endHeight, percentDone, message);
  }

  async onNewBlock(height) {
    if (this.isClosed()) return;
    await this.listener.onNewBlock(height);
  }
  
  async onBalancesChanged(newBalanceStr, newUnlockedBalanceStr) {
    if (this.isClosed()) return;
    await this.listener.onBalancesChanged(BigInt(newBalanceStr), BigInt(newUnlockedBalanceStr));
  }

  async onOutputReceived(blockJson) {
    if (this.isClosed()) return;
    let block = new ZephyrBlock(blockJson, ZephyrBlock.DeserializationType.TX_WALLET);
    await this.listener.onOutputReceived(block.getTxs()[0].getOutputs()[0]);
  }
  
  async onOutputSpent(blockJson) {
    if (this.isClosed()) return;
    let block = new ZephyrBlock(blockJson, ZephyrBlock.DeserializationType.TX_WALLET);
    await this.listener.onOutputSpent(block.getTxs()[0].getInputs()[0]);
  }
}
