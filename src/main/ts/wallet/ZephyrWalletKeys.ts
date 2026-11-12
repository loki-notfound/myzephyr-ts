import assert from "assert";
import GenUtils from "../common/GenUtils";
import LibraryUtils from "../common/LibraryUtils";
import ZephyrAccountInherited from "./model/ZephyrAccountInherited";
import ZephyrError from "../common/ZephyrError";
import ZephyrIntegratedAddress from "./model/ZephyrIntegratedAddress";
import ZephyrNetworkType from "../daemon/model/ZephyrNetworkType";
import ZephyrSubaddressInherited from "./model/ZephyrSubaddressInherited";
import ZephyrVersion from "../daemon/model/ZephyrVersion";
import ZephyrWalletBase from "./ZephyrWalletBase";
import ZephyrWalletConfig from "./model/ZephyrWalletConfig";
import ZephyrWalletError from "../common/ZephyrWalletError";
import { checkAddressIndices } from "../common/ZephyrLifecycleContract";
import { configFields, toCoreConfigJson, validateCreateConfig } from "./model/ZephyrWalletCoreConfig";
import { ZephyrWorkerChannel } from "../common/ZephyrWalletWorkers";
import ZephyrWalletListener from "./model/ZephyrWalletListener";

/**
 * Implements a ZephyrWalletBase which only manages keys using WebAssembly.
 */
export class ZephyrWalletKeys extends ZephyrWalletBase {

  // instance variables
  protected cppAddress: string;
  protected module: any;
  protected walletProxy: ZephyrWalletKeysProxy;
  protected closePromise: Promise<void>;
  protected closeCompleted = false;
  /**
   * Set when a failed native password change left the native password state unknown or
   * unverifiable. From then on every ordinary operation, including operations already
   * queued, rejects with NATIVE_ERROR/PASSWORD_STATE_UNKNOWN before any native access; close and
   * close retry remain available. It is never cleared and nothing is rolled back: the in-memory
   * wallet is not assumed to be safe, and recovery uses previously saved wallet bytes.
   */
  protected passwordStateUnknown = false;
  
  // --------------------------- STATIC UTILITIES -----------------------------
  
  /**
   * <p>Create a wallet using WebAssembly bindings to monero-project.</p>
   * 
   * <p>Example:</p>
   * 
   * <code>
   * let wallet = await ZephyrWalletKeys.createWallet({<br>
   * &nbsp;&nbsp; password: "abc123",<br>
   * &nbsp;&nbsp; networkType: ZephyrNetworkType.STAGENET,<br>
   * &nbsp;&nbsp; seed: "coexist igloo pamphlet lagoon..."<br>
   * });
   * </code>
   * 
   * @param {ZephyrWalletConfig} config - ZephyrWalletConfig or equivalent config object
   * @param {string|number} config.networkType - network type of the wallet to create (one of "mainnet", "testnet", "stagenet" or ZephyrNetworkType.MAINNET|TESTNET|STAGENET)
   * @param {string} [config.seed] - seed of the wallet to create (optional, random wallet created if neither seed nor keys given)
   * @param {string} [config.seedOffset] - the offset used to derive a new seed from the given seed to recover a secret wallet from the seed phrase
   * @param {string} [config.primaryAddress] - primary address of the wallet to create (only provide if restoring from keys)
   * @param {string} [config.privateViewKey] - private view key of the wallet to create (optional)
   * @param {string} [config.privateSpendKey] - private spend key of the wallet to create (optional)
   * @param {string} [config.language] - language of the wallet's seed (defaults to "English" or auto-detected)
   * @param {AbortSignal} [signal] - optional caller signal for this construction only: a
   *        proxied construction runs in its own new worker, which an abort before hand-off terminates
   *        (NATIVE_ERROR/CONSTRUCTION_ABORTED); in direct mode only an already aborted signal is honored
   * @return {ZephyrWalletKeys} the created wallet
   */
  static async createWallet(config: Partial<ZephyrWalletConfig>, signal?: AbortSignal) {
    
    // normalize and validate config against the supported configuration contract before any native call
    if (config === undefined) throw new ZephyrError("Must provide config to create wallet");
    const validated = validateCreateConfig(configFields(config), true);
    const coreConfigJson = JSON.stringify(toCoreConfigJson(validated, true));
    config = config instanceof ZephyrWalletConfig ? config : new ZephyrWalletConfig(config);
    if (config.getSeed() !== undefined && (config.getPrimaryAddress() !== undefined || config.getPrivateViewKey() !== undefined || config.getPrivateSpendKey() !== undefined)) {
      throw new ZephyrError("Wallet may be initialized with a seed or keys but not both");
    }
    if (config.getNetworkType() === undefined) throw new ZephyrError("Must provide a networkType: 'mainnet', 'testnet' or 'stagenet'");
    if (config.getSaveCurrent() === true) throw new ZephyrError("Cannot save current wallet when creating keys-only wallet");

    // initialize proxied wallet if configured
    if (config.getProxyToWorker() === undefined) config.setProxyToWorker(true);
    if (signal !== undefined && signal.aborted) throw new ZephyrWalletError("NATIVE_ERROR", "CONSTRUCTION_ABORTED"); // before any worker or native call
    if (config.getProxyToWorker()) {
      let walletProxy = await ZephyrWalletKeysProxy.createWallet(config, signal);
      return new ZephyrWalletKeys(undefined, walletProxy);
    }

    // disallow server connection
    if (config.getServer() !== undefined) throw new ZephyrError("Cannot initialize keys wallet with server connection");
    
    // create wallet
    if (validated.intent === "seed") return ZephyrWalletKeys.createWalletFromSeed(config, coreConfigJson);
    else if (validated.intent === "keys") return ZephyrWalletKeys.createWalletFromKeys(config, coreConfigJson);
    else return ZephyrWalletKeys.createWalletRandom(config, coreConfigJson);
  }
  
  protected static async createWalletRandom(config: Partial<ZephyrWalletConfig>, coreConfigJson: string) {

    // validate and sanitize params
    config = config.copy();
    if (config.getSeedOffset() !== undefined) throw new ZephyrError("Cannot provide seedOffset when creating random wallet");
    if (config.getRestoreHeight() !== undefined) throw new ZephyrError("Cannot provide restoreHeight when creating random wallet");
    ZephyrNetworkType.validate(config.getNetworkType());
    if (config.getLanguage() === undefined) config.setLanguage("English");
    
    // load wasm module
    let module = await LibraryUtils.loadWasmModule();
    
    // queue call to wasm module
    return module.queueTask(async () => {
      return new Promise((resolve, reject) => {
        
        // create wallet in wasm which invokes callback when done
        module.create_keys_wallet_random(coreConfigJson, (cppAddress: number | string) => {
          if (typeof cppAddress === "string") reject(ZephyrWalletError.fromBridgeResult("create", cppAddress)); // fixed bridge identifier only
          else resolve(new ZephyrWalletKeys(cppAddress));
        });
      });
    });
  }
  
  protected static async createWalletFromSeed(config: Partial<ZephyrWalletConfig>, coreConfigJson: string) {
    
    // validate and sanitize params
    ZephyrNetworkType.validate(config.getNetworkType());
    if (config.getSeed() === undefined) throw Error("Must define seed to create wallet from");
    if (config.getSeedOffset() === undefined) config.setSeedOffset("");
    if (config.getLanguage() !== undefined) throw new ZephyrError("Cannot provide language when creating wallet from seed");
    
    // load wasm module
    let module = await LibraryUtils.loadWasmModule();
    
    // queue call to wasm module
    return module.queueTask(async () => {
      return new Promise((resolve, reject) => {

        // create wallet in wasm which invokes callback when done
        module.create_keys_wallet_from_seed(coreConfigJson, (cppAddress: number | string) => {
          if (typeof cppAddress === "string") reject(ZephyrWalletError.fromBridgeResult("restore", cppAddress)); // fixed bridge identifier only
          else resolve(new ZephyrWalletKeys(cppAddress));
        });
      });
    });
  }
  
  protected static async createWalletFromKeys(config: Partial<ZephyrWalletConfig>, coreConfigJson: string) {
    
    // validate and sanitize params
    if (config.getSeedOffset() !== undefined) throw new ZephyrError("Cannot provide seedOffset when creating wallet from keys");
    ZephyrNetworkType.validate(config.getNetworkType());
    if (config.getPrimaryAddress() === undefined) config.setPrimaryAddress("");
    if (config.getPrivateViewKey() === undefined) config.setPrivateViewKey("");
    if (config.getPrivateSpendKey() === undefined) config.setPrivateSpendKey("");
    if (config.getLanguage() === undefined) config.setLanguage("English");
    
    // load wasm module
    let module = await LibraryUtils.loadWasmModule();
    
    // queue call to wasm module
    return module.queueTask(async () => {
      return new Promise((resolve, reject) => {
        
        // create wallet in wasm which invokes callback when done
        module.create_keys_wallet_from_keys(coreConfigJson, (cppAddress: number | string) => {
          if (typeof cppAddress === "string") reject(ZephyrWalletError.fromBridgeResult("restore", cppAddress)); // fixed bridge identifier only
          else resolve(new ZephyrWalletKeys(cppAddress));
        });
      });
    });
  }
  
  static async getSeedLanguages(): Promise<string[]> {
    let module = await LibraryUtils.loadWasmModule();
    return module.queueTask(async () => {
      return JSON.parse(ZephyrWalletError.checkBridgeResult("other", module.get_keys_wallet_seed_languages())).languages;
    });
  }
  
  // --------------------------- INSTANCE METHODS -----------------------------
  
  /**
   * Internal constructor which is given the memory address of a C++ wallet
   * instance.
   * 
   * This method should not be called externally but should be called through
   * static wallet creation utilities in this class.
   * 
   * @param {number} cppAddress - address of the wallet instance in C++
   * @param {ZephyrWalletKeysProxy} walletProxy - proxy
   * 
   * @private
   */
  constructor(cppAddress, walletProxy?: ZephyrWalletKeysProxy) {
    super();
    if (!cppAddress && !walletProxy) throw new ZephyrError("Must provide cppAddress or walletProxy");
    if (walletProxy) this.walletProxy = walletProxy;
    else {
      this.cppAddress = cppAddress;
      this.module = LibraryUtils.getWasmModule();
      if (!this.module.create_full_wallet) throw new ZephyrError("WASM module not loaded - create wallet instance using static utilities");  // static utilites pre-load wasm module
    }
  }
  
  async isViewOnly(): Promise<boolean> {
    if (this.getWalletProxy()) return this.getWalletProxy().isViewOnly();
    return this.module.queueTask(async () => {
      this.assertNotClosed();
      const viewOnly = this.module.is_view_only(this.cppAddress); // 1, 0, or -1 on a native failure
      if (viewOnly !== 0 && viewOnly !== 1) throw new ZephyrWalletError("NATIVE_ERROR", "CORE_UNCLASSIFIED");
      return viewOnly === 1;
    });
  }
  
  async isConnectedToDaemon(): Promise<boolean> {
    if (this.getWalletProxy()) return this.getWalletProxy().isConnectedToDaemon();
    return false;
  }

  async getVersion(): Promise<ZephyrVersion> {
    if (this.getWalletProxy()) return this.getWalletProxy().getVersion();
    return this.module.queueTask(async () => {
      this.assertNotClosed();
      let versionStr = ZephyrWalletError.checkBridgeResult("other", this.module.get_version(this.cppAddress));
      let versionJson = JSON.parse(versionStr);
      return new ZephyrVersion(versionJson.number, versionJson.isRelease);
    });
  }
  
  /**
   * @ignore
   */
  getPath(): Promise<string> {
    throw new ZephyrError("ZephyrWalletKeys does not support a persisted path");
  }
  
  async getSeed(): Promise<string> {
    if (this.getWalletProxy()) return this.getWalletProxy().getSeed();
    return this.module.queueTask(async () => {
      this.assertNotClosed();
      let resp = ZephyrWalletError.checkBridgeResult("other", this.module.get_seed(this.cppAddress)); // fixed bridge identifier on failure
      return resp ? resp : undefined;
    });
  }
  
  async getSeedLanguage(): Promise<string> {
    if (this.getWalletProxy()) return this.getWalletProxy().getSeedLanguage();
    return this.module.queueTask(async () => {
      this.assertNotClosed();
      let resp = ZephyrWalletError.checkBridgeResult("other", this.module.get_seed_language(this.cppAddress)); // fixed bridge identifier on failure
      return resp ? resp : undefined;
    });
  }

  async getPrivateSpendKey(): Promise<string> {
    if (this.getWalletProxy()) return this.getWalletProxy().getPrivateSpendKey();
    return this.module.queueTask(async () => {
      this.assertNotClosed();
      let resp = ZephyrWalletError.checkBridgeResult("other", this.module.get_private_spend_key(this.cppAddress)); // fixed bridge identifier on failure
      return resp ? resp : undefined;
    });
  }
  
  async getPrivateViewKey(): Promise<string> {
    if (this.getWalletProxy()) return this.getWalletProxy().getPrivateViewKey();
    return this.module.queueTask(async () => {
      this.assertNotClosed();
      let resp = ZephyrWalletError.checkBridgeResult("other", this.module.get_private_view_key(this.cppAddress)); // fixed bridge identifier on failure
      return resp ? resp : undefined;
    });
  }
  
  async getPublicViewKey(): Promise<string> {
    if (this.getWalletProxy()) return this.getWalletProxy().getPublicViewKey();
    return this.module.queueTask(async () => {
      this.assertNotClosed();
      let resp = ZephyrWalletError.checkBridgeResult("other", this.module.get_public_view_key(this.cppAddress)); // fixed bridge identifier on failure
      return resp ? resp : undefined;
    });
  }
  
  async getPublicSpendKey(): Promise<string> {
    if (this.getWalletProxy()) return this.getWalletProxy().getPublicSpendKey();
    return this.module.queueTask(async () => {
      this.assertNotClosed();
      let resp = ZephyrWalletError.checkBridgeResult("other", this.module.get_public_spend_key(this.cppAddress)); // fixed bridge identifier on failure
      return resp ? resp : undefined;
    });
  }
  
  async getAddress(accountIdx: number, subaddressIdx: number): Promise<string> {
    checkAddressIndices(accountIdx, subaddressIdx); // bridge uint32_t: reject instead of wrapping, before dispatch
    if (this.getWalletProxy()) return this.getWalletProxy().getAddress(accountIdx, subaddressIdx);
    return this.module.queueTask(async () => {
      this.assertNotClosed();
      return ZephyrWalletError.checkBridgeResult("other", this.module.get_address(this.cppAddress, accountIdx, subaddressIdx));
    });
  }
  
  async getAddressIndex(address: string): Promise<ZephyrSubaddressInherited> {
    if (this.getWalletProxy()) return this.getWalletProxy().getAddressIndex(address);
    return this.module.queueTask(async () => {
      this.assertNotClosed();
      let resp = ZephyrWalletError.checkBridgeResult("address", this.module.get_address_index(this.cppAddress, address));
      if (typeof resp !== "string" || resp.charAt(0) !== '{') throw new ZephyrWalletError("NATIVE_ERROR", "UNEXPECTED_RESULT");
      return new ZephyrSubaddressInherited(JSON.parse(resp));
    });
  }
  
  async getAccounts(includeSubaddresses?: boolean, tag?: string): Promise<ZephyrAccountInherited[]> {
    if (this.getWalletProxy()) return this.getWalletProxy().getAccounts();
    throw new ZephyrError("ZephyrWalletKeys does not support getting an enumerable set of accounts; query specific accounts");
  }
  
  // getIntegratedAddress(paymentId)  // TODO
  // decodeIntegratedAddress
  
  async close(save = false): Promise<void> {
    if (this.closePromise) return this.closePromise;
    if (this.closeCompleted) return;
    this.closePromise = this.closeInternal(save);
    try {
      await this.closePromise;
      this.closeCompleted = true;
    } finally {
      this.closePromise = undefined; // keep native resources available for retry after failure
    }
  }

  protected async closeInternal(save: boolean, listenerHandle = 0): Promise<void> {
    if (this.connectionManager && this.connectionManager.getListeners().includes(this.connectionManagerListener)) this.connectionManager.removeListener(this.connectionManagerListener);
    this.connectionManager = undefined;
    this.connectionManagerListener = undefined;
    if (this.walletProxy) {
      this._isClosed = true;
      await this.walletProxy.close(save);
    } else {
      if (save) await this.save();
      this._isClosed = true;
      await this.module.queueTask(async () => {
        return new Promise<void>((resolve, reject) => {
          this.module.close(this.cppAddress, false, listenerHandle, (errMsg) => { // saving handled external to webassembly
            if (errMsg) reject(ZephyrWalletError.fromBridgeResult("close", errMsg)); // handle kept; close may be retried
            else {
              delete this.cppAddress;
              resolve();
            }
          });
        });
      });
    }
    await super.close();
  }

  async isClosed(): Promise<boolean> {
    return this._isClosed;
  }
  
  // ----------- ADD JSDOC FOR SUPPORTED DEFAULT IMPLEMENTATIONS --------------
  
  async getPrimaryAddress(): Promise<string> { return super.getPrimaryAddress(); }
  async getSubaddress(accountIdx: number, subaddressIdx: number): Promise<ZephyrSubaddressInherited> { return super.getSubaddress(accountIdx, subaddressIdx); }
  
  // ----------------------------- PRIVATE HELPERS ----------------------------

  static sanitizeSubaddress(subaddress) {
    if (subaddress.getLabel() === "") subaddress.setLabel(undefined);
    return subaddress
  }
  
  /**
   * Admission check at the start of every ordinary operation and of its queued task: a closed
   * wallet rejects with WALLET_CLOSED; a wallet whose native password state became unknown rejects
   * with NATIVE_ERROR/PASSWORD_STATE_UNKNOWN. Close does not use this check.
   */
  protected assertNotClosed() {
    if (this._isClosed) throw ZephyrWalletError.walletClosed();
    if (this.passwordStateUnknown) throw new ZephyrWalletError("NATIVE_ERROR", "PASSWORD_STATE_UNKNOWN");
  }

  /**
   * @internal Forced stop of a proxied wallet (ZephyrWallet.terminate): its own worker is terminated
   * at once, without a native close and without waiting for a running or queued request; every
   * pending request of the wallet rejects with WALLET_CLOSED/WALLET_TERMINATED. A direct wallet
   * cannot be stopped this way (UNSUPPORTED_CAPABILITY/TERMINATE).
   */
  terminateProxiedWorker(): void {
    if (!this.walletProxy) throw ZephyrWalletError.unsupported("TERMINATE");
    this._isClosed = true;
    this.walletProxy.terminateWorker();
  }

  /** Stop ordinary admission after an unknown or unverifiable native password state. */
  protected stopAdmissionForUnknownPasswordState(): ZephyrWalletError {
    this.passwordStateUnknown = true;
    return new ZephyrWalletError("NATIVE_ERROR", "PASSWORD_STATE_UNKNOWN");
  }

  protected getWalletProxy(): ZephyrWalletKeysProxy {
    this.assertNotClosed();
    return this.walletProxy;
  }
}

/**
 * Implements a ZephyrWalletBase by proxying requests to a worker which runs a keys-only wallet.
 * 
 * TODO: sort these methods according to master sort in ZephyrWalletBase.ts
 * TODO: probably only allow one listener to worker then propogate to registered listeners for performance
 * 
 * @private
 */
export class ZephyrWalletKeysProxy extends ZephyrWalletBase {

  // state variables
  protected walletId: string;
  protected worker: Worker;
  /** the wallet's own dedicated worker; terminated after a successful native close */
  protected channel: ZephyrWorkerChannel;
  
  // -------------------------- WALLET STATIC UTILS ---------------------------
  
  static async createWallet(config: Partial<ZephyrWalletConfig>, signal?: AbortSignal) {
    const handle = await LibraryUtils.constructWalletInWorker("createWalletKeys", [(config as ZephyrWalletConfig).toJson()], signal); // a ZephyrWalletConfig (createWallet normalizes it)
    return new ZephyrWalletKeysProxy(handle.walletId, handle.channel);
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
   * 
   * @protected
   */
  constructor(walletId: string, channel: ZephyrWorkerChannel) {
    super();
    this.walletId = walletId;
    this.channel = channel;
    this.worker = channel.worker as unknown as Worker;
  }
  
  async isViewOnly(): Promise<boolean> {
    return this.invokeWorker("isViewOnly");
  }

  async getVersion(): Promise<ZephyrVersion> {
    throw new ZephyrError("Not implemented");
  }

  async getSeed() {
    return this.invokeWorker("getSeed") as Promise<string>;
  }
  
  async getSeedLanguage() {
    return this.invokeWorker("getSeedLanguage") as Promise<string>;
  }
  
  async getSeedLanguages() {
    return this.invokeWorker("getSeedLanguages");
  }
  
  async getPrivateSpendKey() {
    return this.invokeWorker("getPrivateSpendKey") as Promise<string>;
  }
  
  async getPrivateViewKey() {
    return this.invokeWorker("getPrivateViewKey") as Promise<string>;
  }
  
  async getPublicViewKey() {
    return this.invokeWorker("getPublicViewKey") as Promise<string>;
  }
  
  async getPublicSpendKey() {
    return this.invokeWorker("getPublicSpendKey") as Promise<string>;
  }
  
  async getAddress(accountIdx, subaddressIdx) {
    return this.invokeWorker("getAddress", Array.from(arguments)) as Promise<string>;
  }

  async getAddressIndex(address) {
    let subaddressJson = await this.invokeWorker("getAddressIndex", Array.from(arguments));
    return ZephyrWalletKeys.sanitizeSubaddress(new ZephyrSubaddressInherited(subaddressJson));
  }

  async getIntegratedAddress(standardAddress, paymentId) {
    return new ZephyrIntegratedAddress(await this.invokeWorker("getIntegratedAddress", Array.from(arguments)));
  }
  
  async decodeIntegratedAddress(integratedAddress) {
    return new ZephyrIntegratedAddress(await this.invokeWorker("decodeIntegratedAddress", Array.from(arguments)));
  }

  /**
   * Native close in the wallet's worker; after it succeeded the worker is terminated. A failed close
   * keeps the worker and the native handle for a retry. A worker that already ended (context
   * shutdown or WORKER_FAILED) holds no reachable native handle: close then resolves.
   */
  async close(save) {
    if (!this.channel.isOpen()) return;
    await this.invokeWorker("close", Array.from(arguments));
    this.channel.removeObject(this.walletId);
    await LibraryUtils.retireWalletWorker(this.channel);
  }
  
  async isClosed() {
    if (!this.channel.isOpen()) return true;
    return this.invokeWorker("isClosed");
  }

  /** @internal the wallet's own worker channel */
  getWorkerChannel(): ZephyrWorkerChannel {
    return this.channel;
  }

  /**
   * @internal Terminate the wallet's own worker at once (forced stop): no native close, no further
   * message. Pending requests reject with WALLET_CLOSED/WALLET_TERMINATED; callbacks and the
   * registry entry go with the worker. Idempotent.
   */
  terminateWorker(): void {
    this.channel.terminate(() => new ZephyrWalletError("WALLET_CLOSED", "WALLET_TERMINATED"));
  }

  protected async invokeWorker(fnName: string, args?: any): Promise<any> {
    try {
      return await this.channel.invoke(this.walletId, fnName, args === undefined ? [] : GenUtils.listify(args));
    } catch (e: any) {
      throw e instanceof ZephyrWalletError ? e : ZephyrWalletError.fromEnvelope(undefined);
    }
  }
}
