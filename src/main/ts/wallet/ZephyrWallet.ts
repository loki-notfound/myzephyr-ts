/**
 * The wallet facade of the package and the functions that create, restore and open wallets. The
 * package entry (src/main/ts/index.ts) re-exports the names of this module; the support of the
 * contract and network tests is in wallet/ZephyrWalletTestSupport.ts, which the entry does not export.
 */
import LibraryUtils from "../common/LibraryUtils";
import ZephyrWalletError, { ZephyrWalletErrorDiagnostic, ZephyrWalletErrorCode } from "../common/ZephyrWalletError";
import * as WalletErrors from "../common/ZephyrWalletErrorMapping";
import type { ZephyrNativeErrorContext } from "../common/ZephyrWalletErrorMapping";
import { checkAddressIndices } from "../common/ZephyrLifecycleContract";
import ZephyrUtils from "../common/ZephyrUtils";
import ZephyrWalletConfig from "./model/ZephyrWalletConfig";
import ZephyrWalletFull from "./ZephyrWalletFull";
import { ZephyrWalletKeys } from "./ZephyrWalletKeys";
import { ZephyrWalletCreateIntent, validateCreateConfig, validateOpenConfig } from "./model/ZephyrWalletCoreConfig";
import { setCreateWallet } from "./ZephyrWalletTestSupport";
import { ZephyrDaemonRoute, parseDaemonAddress } from "../common/ZephyrDaemonAddress";
import { ZephyrAccountBalances, ZephyrAssetBalances } from "../common/ZephyrBalances";
import { ZephyrAccount, ZephyrAccountOptions, ZephyrAddressIndex, ZephyrSubaddress } from "../common/ZephyrAccounts";
import { accountOptions } from "../common/ZephyrAccountsInternal";
import { checkLabel, checkSubaddressIndices } from "../common/ZephyrLifecycleContract";
import { ZephyrTransferBuild, ZephyrTransferConfig } from "../common/ZephyrTransfer";
import { checkTransferConfig } from "../common/ZephyrTransferInternal";
import { ZephyrConversionBuild, ZephyrConversionConfig, checkConversionConfig } from "../common/ZephyrConversion";
import { ZephyrPreparedConversion, ZephyrPreparedTransfer, ZephyrRelayResult, checkRelayToken } from "../common/ZephyrRelay";
import { ZephyrHistoryQuery, ZephyrWalletTransfer, ZephyrWalletTx, checkHistoryQuery, checkTxHash, filterTransfers, filterTxs, selectionOf } from "../common/ZephyrHistory";


/** Network types; numeric values match the core. */
export type ZephyrNetworkTypeInput = 0 | 1 | 2 | "mainnet" | "testnet" | "stagenet";

/** Wallet bytes as returned by getData and accepted by openWalletData. */
export interface ZephyrWalletData {
  readonly keys: Uint8Array;
  readonly cache: Uint8Array;
}

/** Daemon connection as configured through the SDK (no native call). */
export interface ZephyrDaemonConnection {
  /** normalized address without credentials */
  readonly uri: string;
  /** always true: the fixed core treats every daemon as trusted */
  readonly trusted: true;
}

/** Result of one blocking sync. */
export interface ZephyrWalletSyncResult {
  readonly numBlocksFetched: number;
  readonly receivedMoney: boolean;
}

/**
 * Options of one construction. signal: an optional caller AbortSignal for this
 * construction only. Proxied: a pre-aborted signal rejects before any worker starts; an abort while
 * queued for a construction slot or while the construction runs (also during synchronous native
 * work) terminates only that construction's worker and rejects with NATIVE_ERROR/CONSTRUCTION_ABORTED.
 * Once the wallet is returned the signal is detached and can never affect it. Direct
 * (proxyToWorker: false): only an already aborted signal is honored; a running native construction
 * cannot be interrupted. The signal and its reason are never serialized or read.
 */
export interface ZephyrWalletConstructionOptions {
  readonly signal?: AbortSignal;
}

/*
 * The five construction configurations below list exactly the fields the run-time validation accepts for
 * each function, with the types it accepts; the validation stays the authority and rejects everything else
 * with the same fixed errors whatever the declared type (so a JavaScript caller gets them too). Not
 * declared, although the validation accepts them, are fields that it accepts with one value only and that
 * then have no effect: path "", isTrustedDaemon true (every daemon is trusted by the fixed core), regtest,
 * isMultisig and saveCurrent false, and in the object form of server the fields trusted true and an empty
 * username, password, proxyUri or proxy. A field whose value is undefined counts as absent at run time.
 * Value domains and rules between fields are checked at run time only (for example the seed's word count,
 * the key format, the lookahead limit, which keys a keys restore needs).
 */

/** Configuration of createRandomWallet. */
export interface ZephyrRandomWalletConfig {
  /** required */
  readonly networkType: ZephyrNetworkTypeInput;
  /** encrypts the wallet bytes; default "" */
  readonly password?: string;
  /** the seed language, for example "English" */
  readonly language?: string;
  /** a pair with subaddressLookahead: integers, each and their product at most 20,000 */
  readonly accountLookahead?: number;
  readonly subaddressLookahead?: number;
  /** default true: the wallet runs in its own worker */
  readonly proxyToWorker?: boolean;
  /** an optional daemon, set right after the construction: an address ("" means none), or an object with the address in uri */
  readonly server?: string | { readonly uri: string };
}

/** Configuration of restoreWalletFromSeed. */
export interface ZephyrSeedWalletConfig {
  /** required */
  readonly networkType: ZephyrNetworkTypeInput;
  /** encrypts the wallet bytes; default "" */
  readonly password?: string;
  /** required: 12, 13, 24 or 25 words */
  readonly seed: string;
  /** an optional passphrase that changes the derived wallet */
  readonly seedOffset?: string;
  /** the height the first sync starts from; default 0 */
  readonly restoreHeight?: number;
  /** a pair with subaddressLookahead: integers, each and their product at most 20,000 */
  readonly accountLookahead?: number;
  readonly subaddressLookahead?: number;
  /** default true: the wallet runs in its own worker */
  readonly proxyToWorker?: boolean;
  /** an optional daemon, set right after the construction: an address ("" means none), or an object with the address in uri */
  readonly server?: string | { readonly uri: string };
}

/**
 * Configuration of restoreWalletFromKeys: at least one key field. An address with a private view key and
 * no spend key restores a view-only wallet; a private spend key alone derives the rest.
 */
export interface ZephyrKeysWalletConfig {
  /** required */
  readonly networkType: ZephyrNetworkTypeInput;
  /** encrypts the wallet bytes; default "" */
  readonly password?: string;
  /** the standard address; required with privateViewKey */
  readonly primaryAddress?: string;
  /** 64 hexadecimal characters */
  readonly privateViewKey?: string;
  /** 64 hexadecimal characters */
  readonly privateSpendKey?: string;
  /** the height the first sync starts from; default 0 */
  readonly restoreHeight?: number;
  /** the seed language, for example "English" */
  readonly language?: string;
  /** a pair with subaddressLookahead: integers, each and their product at most 20,000 */
  readonly accountLookahead?: number;
  readonly subaddressLookahead?: number;
  /** default true: the wallet runs in its own worker */
  readonly proxyToWorker?: boolean;
  /** an optional daemon, set right after the construction: an address ("" means none), or an object with the address in uri */
  readonly server?: string | { readonly uri: string };
}

/**
 * Configuration of createKeysWallet, one of three forms chosen by the fields present: random (no recovery
 * field), from a seed, or from keys (at least one key field). A keys-only wallet takes no restore height,
 * lookahead or daemon; a password is accepted, but a keys-only wallet has no wallet bytes it would encrypt.
 */
export type ZephyrKeysOnlyWalletConfig =
  | {
    readonly networkType: ZephyrNetworkTypeInput;
    readonly password?: string;
    /** the seed language, for example "English" */
    readonly language?: string;
    readonly proxyToWorker?: boolean;
    readonly seed?: undefined;
    readonly seedOffset?: undefined;
    readonly primaryAddress?: undefined;
    readonly privateViewKey?: undefined;
    readonly privateSpendKey?: undefined;
  }
  | {
    readonly networkType: ZephyrNetworkTypeInput;
    readonly password?: string;
    /** 12, 13, 24 or 25 words */
    readonly seed: string;
    readonly seedOffset?: string;
    readonly proxyToWorker?: boolean;
    readonly language?: undefined;
    readonly primaryAddress?: undefined;
    readonly privateViewKey?: undefined;
    readonly privateSpendKey?: undefined;
  }
  | {
    readonly networkType: ZephyrNetworkTypeInput;
    readonly password?: string;
    readonly primaryAddress?: string;
    readonly privateViewKey?: string;
    readonly privateSpendKey?: string;
    /** the seed language, for example "English" */
    readonly language?: string;
    readonly proxyToWorker?: boolean;
    readonly seed?: undefined;
    readonly seedOffset?: undefined;
  };

/** Configuration of openWalletData: the bytes getData returned and the password they were saved with. */
export interface ZephyrOpenWalletConfig {
  /** required: the network the bytes were created for */
  readonly networkType: ZephyrNetworkTypeInput;
  /** default "" */
  readonly password?: string;
  /** required, not empty */
  readonly keysData: Uint8Array;
  readonly cacheData?: Uint8Array;
  /** default true: the wallet runs in its own worker */
  readonly proxyToWorker?: boolean;
  /** an optional daemon, set right after the construction: an address ("" means none), or an object with the address in uri */
  readonly server?: string | { readonly uri: string };
}

/** Validate construction options before any native or worker call. */
function constructionSignal(options: unknown): AbortSignal | undefined {
  if (options === undefined) return undefined;
  if (options === null || typeof options !== "object" || Array.isArray(options)) throw new ZephyrWalletError("INVALID_CONFIG", "CONFIG_TYPE");
  for (const key of Object.keys(options)) if (key !== "signal") throw new ZephyrWalletError("INVALID_CONFIG", "UNKNOWN_FIELD");
  const signal = (options as { signal?: unknown }).signal;
  if (signal === undefined) return undefined;
  if (typeof AbortSignal === "undefined" || !(signal instanceof AbortSignal)) throw new ZephyrWalletError("INVALID_CONFIG", "FIELD_TYPE");
  return signal;
}

/** Inner wallet: inherited full or keys-only wallet (direct or proxied to the worker). */
type InnerWallet = ZephyrWalletFull | ZephyrWalletKeys;

/** Wallet errors pass unchanged; any other failure gets its context's fixed code (its text is never read). */
function toWalletError(context: ZephyrNativeErrorContext, err: unknown): ZephyrWalletError {
  return WalletErrors.fromUnknown(context, err);
}

function proxyFlag(raw: unknown): boolean {
  if (raw !== null && typeof raw === "object" && "proxyToWorker" in raw) {
    const value = (raw as { proxyToWorker?: unknown }).proxyToWorker;
    if (value === undefined) return true;
    if (typeof value !== "boolean") throw new ZephyrWalletError("INVALID_CONFIG", "FIELD_TYPE");
    return value;
  }
  return true;
}

/** Wraps an inner wallet in the facade; set by the class's static block (module-internal, not a member of the class). */
let wrapWallet: (inner: InnerWallet, kind: "full" | "keys", proxied: boolean, daemon?: ZephyrDaemonRoute) => ZephyrWallet;

/**
 * Wallet facade. Supported methods delegate to the inherited wallet; representative
 * unsupported methods reject with UNSUPPORTED_CAPABILITY without reaching native code.
 */
export class ZephyrWallet {

  private readonly inner: InnerWallet;
  readonly kind: "full" | "keys";
  readonly proxied: boolean;
  private closed = false;
  private closeSettled = false;
  private terminated = false;
  private daemon: ZephyrDaemonRoute | undefined = undefined;
  private closePromise: Promise<void> | undefined = undefined;
  /** the token and hashes of the last prepare (the bridge's one slot): a relay result must name exactly these hashes */
  private prepared: { token: string; hashes: readonly string[] } | undefined = undefined;

  private constructor(inner: InnerWallet, kind: "full" | "keys", proxied: boolean) {
    this.inner = inner;
    this.kind = kind;
    this.proxied = proxied;
  }

  static {
    // the construction functions below wrap an inner wallet; the class declares no member for it
    wrapWallet = (inner, kind, proxied, daemon) => {
      const wallet = new ZephyrWallet(inner, kind, proxied);
      wallet.daemon = daemon;
      return wallet;
    };
  }

  /** WALLET_CLOSED, with the diagnostic WALLET_TERMINATED after a forced stop. */
  private closedError(): ZephyrWalletError {
    return this.terminated ? new ZephyrWalletError("WALLET_CLOSED", "WALLET_TERMINATED") : WalletErrors.walletClosed();
  }

  private async call<T>(context: ZephyrNativeErrorContext, fn: () => Promise<T>): Promise<T> {
    if (this.closed) throw this.closedError();
    try {
      return await fn();
    } catch (err) {
      const error = toWalletError(context, err);
      throw this.terminated && error.code === "WALLET_CLOSED" ? this.closedError() : error;
    }
  }

  private full(keysOnlyDiagnostic: ZephyrWalletErrorDiagnostic): ZephyrWalletFull {
    if (this.kind !== "full") throw WalletErrors.unsupported(keysOnlyDiagnostic);
    return this.inner as ZephyrWalletFull;
  }

  isClosed(): boolean { return this.closed; }
  async getPrimaryAddress(): Promise<string> { return this.call("other", () => this.inner.getPrimaryAddress()); }
  /** Account and subaddress indices are integers 0..2^32-1 (bridge uint32_t); others reject before dispatch. */
  async getAddress(accountIdx: number, subaddressIdx: number): Promise<string> {
    checkAddressIndices(accountIdx, subaddressIdx);
    return this.call("other", () => this.inner.getAddress(accountIdx, subaddressIdx));
  }
  async getNetworkType(): Promise<number> {
    const wallet = this.full("KEYS_ONLY_NETWORK_TYPE"); // the inherited keys-only wallet has no network type getter
    return this.call("other", async () => Number(await wallet.getNetworkType()));
  }
  /** The 25-word seed; undefined for a view-only wallet (full or keys-only). */
  async getSeed(): Promise<string | undefined> { return this.call("other", () => this.inner.getSeed()); }
  /** The seed language, for example "English"; undefined for a view-only wallet (full or keys-only). */
  async getSeedLanguage(): Promise<string | undefined> { return this.call("other", () => this.inner.getSeedLanguage()); }
  async getPrivateViewKey(): Promise<string> { return this.call("other", () => this.inner.getPrivateViewKey()); }
  /** The private spend key; undefined for a view-only wallet (full or keys-only). */
  async getPrivateSpendKey(): Promise<string | undefined> { return this.call("other", () => this.inner.getPrivateSpendKey()); }
  async getPublicViewKey(): Promise<string> { return this.call("other", () => this.inner.getPublicViewKey()); }
  async getPublicSpendKey(): Promise<string> { return this.call("other", () => this.inner.getPublicSpendKey()); }
  async isViewOnly(): Promise<boolean> { return this.call("other", () => this.inner.isViewOnly()); }

  /** Exact restore height (core uint64_t) as a safe integer; an unrepresentable height rejects. */
  async getRestoreHeight(): Promise<number> {
    const wallet = this.full("KEYS_ONLY_RESTORE_HEIGHT");
    return this.call("other", () => wallet.getRestoreHeight());
  }

  /** Keys and cache bytes of a full wallet (no file is written). */
  async getData(): Promise<ZephyrWalletData> {
    const wallet = this.full("KEYS_ONLY_DATA");
    return this.call("other", async () => {
      const views = await wallet.getData();
      if (!Array.isArray(views) || views.length !== 2) throw new ZephyrWalletError("NATIVE_ERROR", "UNEXPECTED_RESULT");
      const toBytes = (v: unknown): Uint8Array => {
        if (v instanceof Uint8Array) return new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength));
        if (v instanceof DataView) return new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength));
        throw new ZephyrWalletError("NATIVE_ERROR", "UNEXPECTED_RESULT");
      };
      return { keys: toBytes(views[0]), cache: toBytes(views[1]) };
    });
  }

  /**
   * Pathless password change: re-encrypts in memory; the next getData carries the new password.
   * Types are checked at admission; the old-password check, the native change and the password
   * update run as one queued operation, so changes issued without awaiting chain in order.
   *
   * Failure contract: a verified unchanged native state rejects with the bridge's code and keeps
   * the old password; a verified changed state adopts the new password and rejects with
   * NATIVE_ERROR/PASSWORD_CHANGED_WITH_ERROR. An unknown or malformed native state rejects with
   * NATIVE_ERROR/PASSWORD_STATE_UNKNOWN and stops the wallet's ordinary admission: every later and
   * already queued call except close rejects with that diagnostic before native access. The
   * in-memory wallet is then not considered safe; close it (close retry stays available) and open
   * bytes saved earlier with the password that was valid for them. Nothing is rolled back.
   */
  async changePassword(oldPassword: string, newPassword: string): Promise<void> {
    const wallet = this.full("KEYS_ONLY_PASSWORD");
    if (typeof oldPassword !== "string" || typeof newPassword !== "string") throw new ZephyrWalletError("INVALID_CONFIG", "PASSWORD_TYPE");
    return this.call("changePassword", () => wallet.changePassword(oldPassword, newPassword));
  }

  /**
   * Idempotent close.
   *
   * - Admission stops immediately: every later call rejects with WALLET_CLOSED.
   * - Work queued before close that has not started rejects with WALLET_CLOSED when dequeued.
   * - An operation already running (including one suspended inside native code) settles first,
   *   with its own success or failure; the native wallet is only freed afterwards.
   * - Concurrent close calls share one attempt. After success, close resolves immediately and
   *   the native wallet has been freed exactly once.
   * - If the native close fails, close rejects (NATIVE_ERROR, CORE_CLOSE_FAILED), the wallet stays
   *   closed to new work, the native handle is retained, and a later close call retries.
   * There is no native cancellation and no timeout-based free.
   */
  close(): Promise<void> {
    if (this.closeSettled) return Promise.resolve();
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    const attempt = (async () => {
      try {
        await this.inner.close(false);
        this.closeSettled = true;
      } catch (err) {
        if (this.terminated) return; // a forced stop ended the close: no native handle remains
        throw toWalletError("close", err);
      } finally {
        this.closePromise = undefined;
      }
    })();
    this.closePromise = attempt;
    return attempt;
  }

  /**
   * Forced stop of this wallet, proxied wallets (full or keys-only) only. Its own worker is terminated
   * at once: no native close, no waiting for a running or queued call (a sync stalled on a slow
   * daemon included). Unsaved state is lost; persist getData() first if you need it. Every pending
   * call of this wallet and every later call rejects with WALLET_CLOSED and the diagnostic
   * WALLET_TERMINATED, exactly once each; isClosed() is then true, and close() (also one already
   * in progress) resolves. No other wallet, worker or construction is affected, and no worker,
   * callback, daemon route or construction slot of this wallet remains. Idempotent; after a
   * completed close it does nothing.
   *
   * Direct mode (proxyToWorker: false) rejects with UNSUPPORTED_CAPABILITY/TERMINATE: a call that
   * runs in the caller's own context cannot be interrupted.
   */
  async terminate(): Promise<void> {
    if (!this.proxied) throw WalletErrors.unsupported("TERMINATE");
    if (this.terminated || this.closeSettled) return;
    this.terminated = true;
    this.closed = true;
    try {
      this.inner.terminateProxiedWorker();
    } finally {
      this.closeSettled = true;
    }
  }

  // ------------------------- read-only network access -------------------------

  /**
   * Set (or, with undefined, clear) the daemon connection of a full wallet. The address is validated
   * before any native call (see the module documentation). Resolves when the core holds the address;
   * an unreachable daemon is not an error here (isConnectedToDaemon reports false).
   */
  async setDaemonConnection(address?: string | { uri: string; trusted?: boolean }): Promise<void> {
    const wallet = this.full("KEYS_ONLY_DAEMON");
    if (this.closed) throw this.closedError();
    const route = address === undefined ? undefined : parseDaemonAddress(address);
    await this.call("daemon", () => wallet.setDaemonConnection(route === undefined ? undefined : route.uri));
    this.daemon = route;
  }

  /** The daemon connection configured through the SDK, or undefined (no native call). */
  getDaemonConnection(): ZephyrDaemonConnection | undefined {
    return this.daemon === undefined ? undefined : { uri: this.daemon.uri, trusted: true };
  }

  /** Whether the core reaches the configured daemon now (a request to the daemon). */
  async isConnectedToDaemon(): Promise<boolean> {
    const wallet = this.full("KEYS_ONLY_DAEMON");
    return this.call("daemon", () => wallet.isConnectedToDaemon());
  }

  /** Height of the connected daemon. */
  async getDaemonHeight(): Promise<number> {
    const wallet = this.full("KEYS_ONLY_DAEMON");
    return this.call("daemon", () => wallet.getDaemonHeight());
  }

  /**
   * Whether the connected daemon reports itself synchronized with the network: the core's answer
   * (its height is at least the highest height of its peers, and above 1). A request to the daemon;
   * failures reject with DAEMON_ERROR and the same diagnostics as getDaemonHeight
   * (DAEMON_NOT_CONNECTED without a connected daemon). A daemon that is not synchronized makes a
   * sync fetch nothing.
   */
  async isDaemonSynced(): Promise<boolean> {
    const wallet = this.full("KEYS_ONLY_DAEMON");
    return this.call("daemon", () => wallet.isDaemonSynced());
  }

  /** Height of the wallet (no network access). */
  async getHeight(): Promise<number> {
    const wallet = this.full("KEYS_ONLY_DAEMON");
    return this.call("other", () => wallet.getHeight());
  }

  /**
   * One blocking sync from startHeight (a safe integer), or from the core's default start when it is
   * omitted. Other calls of this wallet wait for it, close included.
   */
  async sync(startHeight?: number): Promise<ZephyrWalletSyncResult> {
    const wallet = this.full("KEYS_ONLY_DAEMON");
    if (startHeight !== undefined && (typeof startHeight !== "number" || !Number.isSafeInteger(startHeight) || startHeight < 0)) throw new ZephyrWalletError("INVALID_CONFIG", "SYNC_START_HEIGHT");
    if (arguments.length > 1) throw WalletErrors.unsupported("SYNC");
    const result = await this.call("sync", () => wallet.sync(startHeight));
    return { numBlocksFetched: result.getNumBlocksFetched(), receivedMoney: result.getReceivedMoney() };
  }

  /**
   * Balances: getBalance() returns the wallet map (the core's asset keys, zero entries
   * included); getBalance(accountIdx) the account map keyed by subaddress index (only subaddresses the
   * core reports); getBalance(assetType, accountIdx[, subaddressIdx]) the asset-first scalar for one of
   * the core's asset types. The inherited asset-less (account, subaddress) call is not offered. An
   * account or subaddress index the wallet does not have rejects with INVALID_CONFIG and
   * ACCOUNT_NOT_FOUND or SUBADDRESS_NOT_FOUND instead of the core's empty answer.
   */
  getBalance(): Promise<ZephyrAssetBalances>;
  getBalance(accountIdx: number): Promise<ZephyrAccountBalances>;
  getBalance(assetType: string, accountIdx: number, subaddressIdx?: number): Promise<bigint>;
  async getBalance(...args: unknown[]): Promise<ZephyrAssetBalances | ZephyrAccountBalances | bigint> {
    return this.balance(false, args);
  }

  /** Unlocked balances in the same three shapes as getBalance. */
  getUnlockedBalance(): Promise<ZephyrAssetBalances>;
  getUnlockedBalance(accountIdx: number): Promise<ZephyrAccountBalances>;
  getUnlockedBalance(assetType: string, accountIdx: number, subaddressIdx?: number): Promise<bigint>;
  async getUnlockedBalance(...args: unknown[]): Promise<ZephyrAssetBalances | ZephyrAccountBalances | bigint> {
    return this.balance(true, args);
  }

  private async balance(unlocked: boolean, args: unknown[]): Promise<ZephyrAssetBalances | ZephyrAccountBalances | bigint> {
    const wallet = this.full("KEYS_ONLY_DAEMON");
    if (args.length === 0) return this.call("other", () => wallet.getBalanceMap(unlocked));
    if (args.length === 1 && typeof args[0] === "number") {
      checkAddressIndices(args[0], 0);
      return this.call("other", () => wallet.getAccountBalanceMap(unlocked, args[0] as number));
    }
    if (typeof args[0] === "string" && (args.length === 2 || args.length === 3)) {
      if (!/^[A-Z0-9]{1,16}$/.test(args[0])) throw new ZephyrWalletError("INVALID_CONFIG", "ASSET_TYPE");
      checkAddressIndices(args[1], args.length === 3 ? args[2] : 0);
      return this.call("other", () => wallet.getAssetBalance(unlocked, args[0] as string, args[1] as number, args.length === 3 ? args[2] as number : undefined));
    }
    if (typeof args[0] === "number") throw WalletErrors.unsupported("BALANCE"); // the inherited asset-less (account, subaddress) scalar
    throw new ZephyrWalletError("INVALID_CONFIG", "FIELD_TYPE");
  }

  // ------------------------- accounts and subaddresses -------------------------
  //
  // Full wallets, direct and proxied; keys-only wallets reject with UNSUPPORTED_CAPABILITY/KEYS_ONLY_ACCOUNTS.
  // Results are read-only plain data (common/ZephyrAccounts.ts). Every index is an integer 0..2^32-1,
  // checked before any native or worker call (INVALID_CONFIG/ADDRESS_INDEX_RANGE); an account or
  // subaddress the wallet does not have rejects with INVALID_CONFIG and ACCOUNT_NOT_FOUND or
  // SUBADDRESS_NOT_FOUND. A label is a string of at most 255 bytes in UTF-8 without control characters
  // or unpaired surrogates (INVALID_CONFIG: LABEL_TYPE, LABEL_LENGTH, LABEL_CHARACTERS); "" clears it.
  // The SDK never copies a label into an error or a log line.

  /**
   * Every account in index order. With includeSubaddresses, every subaddress of each account as well.
   * Bounded per call: at most 1,000 accounts and, with subaddresses, at most 1,000 subaddresses in
   * total; a larger listing rejects with INVALID_CONFIG/LISTING_LIMIT (page an account's
   * subaddresses with getSubaddresses and explicit indices, using its subaddressCount).
   */
  async getAccounts(options?: ZephyrAccountOptions): Promise<ReadonlyArray<ZephyrAccount>> {
    const wallet = this.full("KEYS_ONLY_ACCOUNTS");
    const include = accountOptions(options);
    return this.call("other", () => wallet.getAccountsChecked(include));
  }

  /** One account; with includeSubaddresses every subaddress of it (at most 1,000, else LISTING_LIMIT). */
  async getAccount(accountIdx: number, options?: ZephyrAccountOptions): Promise<ZephyrAccount> {
    const wallet = this.full("KEYS_ONLY_ACCOUNTS");
    checkAddressIndices(accountIdx, 0);
    const include = accountOptions(options);
    return this.call("other", () => wallet.getAccountChecked(accountIdx, include));
  }

  /** Create one account with an optional label (default ""); returns it. */
  async createAccount(label?: string): Promise<ZephyrAccount> {
    const wallet = this.full("KEYS_ONLY_ACCOUNTS");
    const text = label === undefined ? "" : checkLabel(label);
    return this.call("other", () => wallet.createAccountChecked(text));
  }

  /**
   * Subaddresses of one account: every subaddress in index order (at most 1,000, else
   * LISTING_LIMIT), or the given indices in the given order: a non-empty array of at most 1,000
   * distinct indices (INVALID_CONFIG/SUBADDRESS_INDICES or LISTING_LIMIT otherwise).
   */
  async getSubaddresses(accountIdx: number, subaddressIndices?: readonly number[]): Promise<ReadonlyArray<ZephyrSubaddress>> {
    const wallet = this.full("KEYS_ONLY_ACCOUNTS");
    checkAddressIndices(accountIdx, 0);
    const indices = subaddressIndices === undefined ? undefined : checkSubaddressIndices(subaddressIndices);
    return this.call("other", () => wallet.getSubaddressesChecked(accountIdx, indices));
  }

  /** One subaddress. */
  async getSubaddress(accountIdx: number, subaddressIdx: number): Promise<ZephyrSubaddress> {
    const wallet = this.full("KEYS_ONLY_ACCOUNTS");
    checkAddressIndices(accountIdx, subaddressIdx);
    const list = await this.call("other", () => wallet.getSubaddressesChecked(accountIdx, [subaddressIdx]));
    return list[0];
  }

  /** Create one subaddress of an account with an optional label (default ""); returns it. */
  async createSubaddress(accountIdx: number, label?: string): Promise<ZephyrSubaddress> {
    const wallet = this.full("KEYS_ONLY_ACCOUNTS");
    checkAddressIndices(accountIdx, 0);
    const text = label === undefined ? "" : checkLabel(label);
    return this.call("other", () => wallet.createSubaddressChecked(accountIdx, text));
  }

  /** Set (or with "" clear) the label of a subaddress; subaddress 0 carries the account's label. */
  async setSubaddressLabel(accountIdx: number, subaddressIdx: number, label: string): Promise<void> {
    const wallet = this.full("KEYS_ONLY_ACCOUNTS");
    checkAddressIndices(accountIdx, subaddressIdx);
    const text = checkLabel(label);
    return this.call("other", () => wallet.setSubaddressLabelChecked(accountIdx, subaddressIdx, text));
  }

  /**
   * The account and subaddress an address of this wallet belongs to (standard addresses and
   * subaddresses of the wallet's network). A malformed address or one of another network rejects with
   * INVALID_ADDRESS/CORE_INVALID_ADDRESS, an address of another wallet with
   * INVALID_ADDRESS/ADDRESS_NOT_IN_WALLET. The core also resolves the addresses of subaddresses within
   * the wallet's lookahead that were not created yet (it watches them for incoming outputs).
   */
  async getAddressIndex(address: string): Promise<ZephyrAddressIndex> {
    const wallet = this.full("KEYS_ONLY_ACCOUNTS");
    if (typeof address !== "string" || address.length === 0 || address.length > 256) throw new ZephyrWalletError("INVALID_ADDRESS", "ADDRESS_TYPE");
    return this.call("address", () => wallet.getAddressIndexChecked(address));
  }

  // --------------------------------- read-only history ---------------------------------
  //
  // Full wallets, direct and proxied; keys-only wallets reject with UNSUPPORTED_CAPABILITY/KEYS_ONLY_HISTORY.
  // The wallet's transactions and transfers per asset as the last sync and the last refreshPool stored
  // them: none of these calls sends a request to the daemon. Results are read-only plain data with bigint
  // amounts (common/ZephyrHistory.ts). The query is validated before any native or worker call. A
  // selection holds at most 1,000 transactions with at most 2,000 transfers (else
  // INVALID_CONFIG/LISTING_LIMIT); page by height range. Incoming transfers still in the pool are listed
  // only after refreshPool (status "pool", direction incoming).

  /**
   * Explicit pool refresh: asks the daemon for its transaction pool and updates the wallet's view of its
   * incoming unconfirmed transfers; afterwards getTxs, getTransfers and getTx list them (status "pool",
   * direction incoming) without a request, until the next refreshPool or until the wallet holds the
   * transaction as confirmed. A daemon request the caller chooses: the core asks for the hashes in the
   * pool (/get_transaction_pool_hashes.bin) and then for the pool transactions the wallet has not scanned
   * before (/gettransactions, pruned); it sends no key image and no address, but leaves out the
   * transactions this wallet sent itself or already recorded as received. Resolves with the number of
   * incoming pool transactions the wallet holds now (at most 1,000, else INVALID_CONFIG/LISTING_LIMIT).
   * Failures reject like the other daemon calls (DAEMON_ERROR); a failed refresh leaves no pool entries
   * in the listing. Keys-only wallets reject with UNSUPPORTED_CAPABILITY/KEYS_ONLY_DAEMON.
   */
  async refreshPool(): Promise<number> {
    const wallet = this.full("KEYS_ONLY_DAEMON");
    if (arguments.length > 0) throw new ZephyrWalletError("INVALID_CONFIG", "FIELD_TYPE");
    return this.call("daemon", () => wallet.refreshPoolChecked());
  }

  /**
   * The wallet's transactions, confirmed by height then hash, unconfirmed (own pending and failed) after
   * them. With transfer filters (asset, accountIndex, subaddressIndex, direction) only the transactions
   * with at least one matching transfer, each with all of its transfers.
   */
  async getTxs(query?: ZephyrHistoryQuery): Promise<ReadonlyArray<ZephyrWalletTx>> {
    const wallet = this.full("KEYS_ONLY_HISTORY");
    const q = checkHistoryQuery(query);
    if (arguments.length > 1) throw new ZephyrWalletError("INVALID_CONFIG", "FIELD_TYPE");
    const txs = await this.call("other", () => wallet.getHistoryChecked(selectionOf(q)));
    return filterTxs(txs, q);
  }

  /** The transfers that match the query, per transaction the outgoing transfer first, then the incoming ones. */
  async getTransfers(query?: ZephyrHistoryQuery): Promise<ReadonlyArray<ZephyrWalletTransfer>> {
    const wallet = this.full("KEYS_ONLY_HISTORY");
    const q = checkHistoryQuery(query);
    if (arguments.length > 1) throw new ZephyrWalletError("INVALID_CONFIG", "FIELD_TYPE");
    const txs = await this.call("other", () => wallet.getHistoryChecked(selectionOf(q)));
    return filterTransfers(txs, q);
  }

  /**
   * One transaction of the wallet by its hash (64 lowercase hexadecimal characters, else
   * INVALID_CONFIG/TX_HASH before any native call). A hash the wallet has no transaction for rejects
   * with INVALID_CONFIG/TX_NOT_FOUND (also an incoming transaction that is still in the pool, unless the
   * last refreshPool saw it).
   */
  async getTx(hash: string): Promise<ZephyrWalletTx> {
    const wallet = this.full("KEYS_ONLY_HISTORY");
    const h = checkTxHash(hash);
    const txs = await this.call("other", () => wallet.getHistoryChecked({ status: "all", hashes: [h] }));
    if (txs.length !== 1 || txs[0].hash !== h) throw new ZephyrWalletError("NATIVE_ERROR", "UNEXPECTED_RESULT");
    return txs[0];
  }

  // ------------------------- building transactions without relay -------------------------

  /**
   * Build the transactions of a same-asset transfer, describe them and discard them (common/ZephyrTransfer.ts).
   * Nothing is relayed and nothing is stored: the bridge passes relay false, and no byte of a built
   * transaction (hex, signed set, key images, transaction key) leaves the module. To relay, prepare the same
   * configuration with prepareTransfer and relay the result's token with relayPrepared. The configuration is validated before the build is dispatched; the addresses are then
   * checked with the core's own parser for the wallet's network, and the wallet's unlocked balance of the
   * asset in the selected account or subaddresses must cover the amounts (TX_NOT_POSSIBLE otherwise, before
   * any request). The core then asks the daemon for heights and fork rules, the fee estimate and the
   * outputs it needs for the rings (no key image is sent). Full wallets with spend keys only: keys-only
   * wallets reject with UNSUPPORTED_CAPABILITY/KEYS_ONLY_TX, view-only ones with VIEW_ONLY_TX. A conversion
   * rejects with UNSUPPORTED_CAPABILITY/CONVERSION before dispatch (see buildConversion).
   */
  async buildTransfer(config: ZephyrTransferConfig): Promise<ZephyrTransferBuild> {
    const wallet = this.full("KEYS_ONLY_TX");
    const request = checkTransferConfig(config);
    if (arguments.length > 1) throw new ZephyrWalletError("INVALID_CONFIG", "FIELD_TYPE");
    return this.call("build", () => wallet.buildTransferChecked(request));
  }

  /**
   * Build the one transaction of a conversion between two V2 assets, describe it and discard it
   * (common/ZephyrConversion.ts). The pair is one of ZPH to ZSD, ZSD to ZPH, ZPH to ZRS, ZRS to ZPH, ZSD to
   * ZYS and ZYS to ZSD; there is exactly one destination and its amount, in the source asset, has at most
   * four decimals. Nothing is relayed and nothing is stored, as for buildTransfer. The core reads the pricing
   * record of the wallet's top block, the circulating supply and the pricing record history from the daemon
   * and refuses a pair the reserve ratio does not allow (TX_NOT_POSSIBLE/RESERVE_RATIO). The description
   * carries the amount burnt and the amount minted as the built transaction states them, the fee (in the
   * source asset) and the height of the pricing record the transaction refers to; no rate computed by the SDK.
   */
  async buildConversion(config: ZephyrConversionConfig): Promise<ZephyrConversionBuild> {
    const wallet = this.full("KEYS_ONLY_TX");
    const request = checkConversionConfig(config);
    if (arguments.length > 1) throw new ZephyrWalletError("INVALID_CONFIG", "FIELD_TYPE");
    return this.call("build", () => wallet.buildConversionChecked(request));
  }

  // ------------------------- relaying a prepared build -------------------------

  /**
   * As buildTransfer (the same configuration, checks, requests and description), but the built transactions are
   * kept inside the module in the wallet's one slot instead of being discarded, under a new token
   * (common/ZephyrRelay.ts); the previous kept build of this wallet is voided. Nothing is relayed here.
   */
  async prepareTransfer(config: ZephyrTransferConfig): Promise<ZephyrPreparedTransfer> {
    const wallet = this.full("KEYS_ONLY_TX");
    const request = checkTransferConfig(config);
    if (arguments.length > 1) throw new ZephyrWalletError("INVALID_CONFIG", "FIELD_TYPE");
    this.prepared = undefined;
    const prepared = await this.call("build", () => wallet.prepareTransferChecked(request));
    this.prepared = { token: prepared.token, hashes: Object.freeze(prepared.build.txs.map((t) => t.hash)) };
    return prepared;
  }

  /** As buildConversion, but the built transaction is kept in the wallet's one slot under a new token (see prepareTransfer). */
  async prepareConversion(config: ZephyrConversionConfig): Promise<ZephyrPreparedConversion> {
    const wallet = this.full("KEYS_ONLY_TX");
    const request = checkConversionConfig(config);
    if (arguments.length > 1) throw new ZephyrWalletError("INVALID_CONFIG", "FIELD_TYPE");
    this.prepared = undefined;
    const prepared = await this.call("build", () => wallet.prepareConversionChecked(request));
    this.prepared = { token: prepared.token, hashes: Object.freeze([prepared.build.hash]) };
    return prepared;
  }

  /**
   * Relay exactly the kept build that token names, as it was described (common/ZephyrRelay.ts). The daemon is given
   * each kept transaction in one submit request (POST /sendrawtransaction to the wallet's configured daemon); the
   * bridge checks before the request that the transaction hashes to the described hash and fails closed otherwise.
   * Resolves when at least one transaction was accepted in this call (for one transaction: it was accepted); rejects
   * with the failure's pair otherwise: TX_REJECTED (the daemon refused it), RELAY_UNKNOWN (sent, no usable answer: the
   * transaction may have reached the network), DAEMON_ERROR/DAEMON_BUSY or DAEMON_UNREACHABLE (not processed, not
   * sent), INVALID_CONFIG/RELAY_TOKEN_VOID, TX_NOT_POSSIBLE/PRICING_RECORD_AGE. After acceptance the wallet records the
   * outgoing transaction as unconfirmed and its spent outputs: save the wallet bytes then.
   */
  async relayPrepared(token: string): Promise<ZephyrRelayResult> {
    const wallet = this.full("KEYS_ONLY_TX");
    const t = checkRelayToken(token);
    if (arguments.length > 1) throw new ZephyrWalletError("INVALID_CONFIG", "FIELD_TYPE");
    const hashes = this.prepared !== undefined && this.prepared.token === t ? this.prepared.hashes : undefined;
    return this.call("relay", () => wallet.relayPreparedChecked(t, hashes));
  }

  /** Void the kept build that token names (wiped and released inside the module); false when it named none. */
  async discardPrepared(token: string): Promise<boolean> {
    const wallet = this.full("KEYS_ONLY_TX");
    const t = checkRelayToken(token);
    if (arguments.length > 1) throw new ZephyrWalletError("INVALID_CONFIG", "FIELD_TYPE");
    if (this.prepared !== undefined && this.prepared.token === t) this.prepared = undefined;
    return this.call("relay", () => wallet.discardPreparedChecked(t));
  }

  // ----------------------- representative unsupported calls -----------------------

  async startSyncing(): Promise<never> { throw WalletErrors.unsupported("SYNC"); }
  async createTxs(): Promise<never> { throw WalletErrors.unsupported("TRANSACTIONS"); }
  async addListener(): Promise<never> { throw WalletErrors.unsupported("LISTENERS"); }
  async getReserveProofWallet(): Promise<never> { throw WalletErrors.unsupported("RESERVE_PROOF"); }
  async rescanSpent(): Promise<never> { throw WalletErrors.unsupported("DAEMON_SETTINGS"); }
  async importKeyImages(): Promise<never> { throw WalletErrors.unsupported("DAEMON_SETTINGS"); }
}

/**
 * The daemon address (config field server) is validated and split off before the offline
 * configuration is validated; an empty server means none. Keys-only wallets take no daemon.
 */
function splitServer(raw: unknown, keysOnly: boolean): { rest: unknown; daemon: ZephyrDaemonRoute | undefined } {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw) || !Object.prototype.hasOwnProperty.call(raw, "server")) return { rest: raw, daemon: undefined };
  const fields = Object.assign({}, raw as Record<string, unknown>);
  const server = fields.server;
  delete fields.server;
  if (server === undefined || server === "") return { rest: fields, daemon: undefined };
  if (keysOnly) throw WalletErrors.unsupported("KEYS_ONLY_DAEMON");
  if (fields.isTrustedDaemon === false) throw WalletErrors.unsupported("UNTRUSTED_DAEMON");
  return { rest: fields, daemon: parseDaemonAddress(server) };
}

async function createFull(raw: unknown, expectedIntent: ZephyrWalletCreateIntent | undefined, options: unknown): Promise<ZephyrWallet> {
  const { rest, daemon } = splitServer(raw, false);
  const validated = validateCreateConfig(rest, false, expectedIntent); // throws before any native or worker call
  const signal = constructionSignal(options);
  const proxied = proxyFlag(rest);
  const config = new ZephyrWalletConfig(Object.assign({}, rest as object, { proxyToWorker: proxied }) as Partial<ZephyrWalletConfig>);
  try {
    const wallet = await ZephyrWalletFull.createWallet(config, signal, daemon);
    return wrapWallet(wallet, "full", proxied, daemon);
  } catch (err) {
    throw toWalletError(validated.intent === "random" ? "create" : "restore", err);
  }
}

/*
 * Creation and restore accept accountLookahead and subaddressLookahead only as a pair of integers
 * with each value and their product at most 20,000 (provisional resource policy); larger
 * values reject with INVALID_CONFIG/LOOKAHEAD_LIMIT before any native or worker call. openWalletData
 * takes no lookahead: bytes carry their own stored pair, which this limit does not bound.
 */

/**
 * Create a random full wallet; any recovery field is rejected. Its restore height is the daemon
 * height when a daemon is given (server) and answers the connection check, as in the core's own
 * random-wallet creation; otherwise it is the core's date-based estimate, which lies about a month
 * of blocks below the chain tip, so a first sync also scans those older blocks.
 */
export async function createRandomWallet(config: ZephyrRandomWalletConfig, options?: ZephyrWalletConstructionOptions): Promise<ZephyrWallet> { return createFull(config, "random", options); }

/** Restore a full wallet from a seed; never falls back to a random wallet. */
export async function restoreWalletFromSeed(config: ZephyrSeedWalletConfig, options?: ZephyrWalletConstructionOptions): Promise<ZephyrWallet> { return createFull(config, "seed", options); }

/** Restore a full wallet from keys; never falls back to a random wallet. */
export async function restoreWalletFromKeys(config: ZephyrKeysWalletConfig, options?: ZephyrWalletConstructionOptions): Promise<ZephyrWallet> { return createFull(config, "keys", options); }

// the construction with the intent derived from the fields present serves the contract tests (wallet/ZephyrWalletTestSupport.ts)
setCreateWallet((raw, options) => createFull(raw, undefined, options));

/** Create a keys-only wallet (random, seed or keys by the fields present). */
export async function createKeysWallet(config: ZephyrKeysOnlyWalletConfig, options?: ZephyrWalletConstructionOptions): Promise<ZephyrWallet> {
  const raw: unknown = config;
  splitServer(raw, true); // a non-empty server rejects with KEYS_ONLY_DAEMON
  const validated = validateCreateConfig(raw, true);
  const signal = constructionSignal(options);
  const proxied = proxyFlag(raw);
  const walletConfig = new ZephyrWalletConfig(Object.assign({}, raw as object, { proxyToWorker: proxied }) as Partial<ZephyrWalletConfig>);
  try {
    const wallet = await ZephyrWalletKeys.createWallet(walletConfig, signal);
    return wrapWallet(wallet, "keys", proxied);
  } catch (err) {
    throw toWalletError(validated.intent === "random" ? "create" : "restore", err);
  }
}

/** Open a full wallet from keys and cache bytes (no path; an optional daemon address in server). */
export async function openWalletData(config: ZephyrOpenWalletConfig, options?: ZephyrWalletConstructionOptions): Promise<ZephyrWallet> {
  const { rest, daemon } = splitServer(config, false);
  const validated = validateOpenConfig(rest);
  const signal = constructionSignal(options);
  const proxied = proxyFlag(rest);
  try {
    const wallet = await ZephyrWalletFull.openWallet({ networkType: validated.networkType, password: validated.password, keysData: validated.keysData, cacheData: validated.cacheData, proxyToWorker: proxied }, signal, daemon);
    return wrapWallet(wallet, "full", proxied, daemon);
  } catch (err) {
    throw toWalletError("open", err);
  }
}

/**
 * Validate an address for a network type with the core's parser: an address it does not accept for that
 * network (or an empty one) rejects with INVALID_ADDRESS; a network type outside the three with
 * INVALID_CONFIG/NETWORK_TYPE.
 */
export async function validateAddress(address: string, networkType: ZephyrNetworkTypeInput, proxyToWorker = true): Promise<void> {
  if (typeof address !== "string" || address.length === 0) throw new ZephyrWalletError("INVALID_ADDRESS", "ADDRESS_TYPE");
  const net = networkType === "mainnet" ? 0 : networkType === "testnet" ? 1 : networkType === "stagenet" ? 2 : networkType;
  if (net !== 0 && net !== 1 && net !== 2) throw new ZephyrWalletError("INVALID_CONFIG", "NETWORK_TYPE");
  if (typeof proxyToWorker !== "boolean") throw new ZephyrWalletError("INVALID_CONFIG", "FIELD_TYPE");
  ZephyrUtils.setProxyToWorker(proxyToWorker);
  try {
    await ZephyrUtils.validateAddress(address, net);
  } catch (err) {
    throw toWalletError("address", err);
  }
}

/**
 * Configure where the wallet worker script is loaded from: a URL in the browser (default: the
 * zephyr.worker.js beside the browser entry, which a bundler emits and rewrites), a file path in
 * Node (default: the file in the package). Without an argument the default is restored.
 */
export function setWorkerDistPath(path?: string): void {
  LibraryUtils.setWorkerDistPath(path);
}

/**
 * Configure where the WebAssembly module (zephyr.wasm) is loaded from: a URL in the browser (default:
 * the zephyr.wasm beside the browser entry, which a bundler emits and rewrites), a file path in Node
 * (default: the file in the package). The module is compiled once per runtime and shared with
 * every wallet worker; a missing or unusable file rejects the first construction with NATIVE_ERROR
 * and WASM_MODULE_UNAVAILABLE (not readable), WASM_MODULE_UNVERIFIED (no Web Crypto digest in this
 * runtime), WASM_MODULE_MISMATCH (not the zephyr.wasm whose SHA-256 the build embedded) or
 * WASM_MODULE_REJECTED (does not compile or instantiate in this runtime, or a wallet worker could not
 * receive the compiled module). Without an argument the default is restored.
 */
export function setWasmModuleUrl(location?: string): void {
  LibraryUtils.setWasmModuleLocation(location);
}

/**
 * Context shutdown: terminate every SDK-owned worker of this runtime, i.e. the utility
 * worker, running constructions and the worker of every live proxied wallet, and reject queued
 * constructions. This is an explicit all-wallet action, as termination of the former shared worker
 * was: live proxied wallets lose their native state without a native close (later calls reject
 * with WALLET_CLOSED, close resolves); pending constructions reject with
 * NATIVE_ERROR/CONSTRUCTION_ABORTED and other pending calls with WALLET_CLOSED. Direct-mode wallets
 * and workers not started by the SDK are unaffected.
 */
export async function terminateWorker(): Promise<void> {
  await LibraryUtils.terminateWorker();
}
