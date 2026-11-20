/**
 * Wallet notifications: the listener a full wallet calls while it syncs (ZephyrWallet.addListener, sync(listener),
 * startSyncing), with the callbacks of the Java port's ZephyrWalletListener and one more, onSyncError.
 *
 * Every callback is optional. The library calls each with plain values: heights are numbers, amounts bigint in
 * atomic units, percentDone a number from 0 to 1. A callback may be a plain function or an async function; the
 * library does not wait for a returned promise. A callback that throws, or whose promise rejects, changes nothing:
 * the sync goes on, the other listeners and the rest of that block's notifications are still delivered, the caller
 * of sync never sees the exception, and the library drops it without reading it.
 *
 * Callbacks never run inside the WebAssembly core. In a wallet that runs in its own worker (the default) the worker
 * posts each notification to the context that owns the wallet, where the callbacks run; a slow callback does not slow
 * the scan. In direct mode (proxyToWorker: false) they run in the calling context between the core's steps (at its
 * network requests and when the core call returns), so a slow callback delays the scan there.
 *
 * The output notifications repeat, as in the core: onOutputReceived comes for an output in the pool, again when its
 * block is scanned and again when it unlocks; onOutputSpent when the spending block is scanned and again when that
 * transaction unlocks, the second time as one summary (the outgoing amount plus the fee, not the real inputs). Count
 * each output once, keyed by transaction and output; do not add up the notifications. Internal parsers, worker data
 * shapes and the delivery are in common/ZephyrNotificationsInternal.ts.
 */
import ZephyrWalletError from "./ZephyrWalletError";

/**
 * The output of an onOutputReceived or onOutputSpent notification, a frozen plain object. A field the core does not
 * report for that notification is absent (never "" or 0): the asset of a pool output and of the outputs reported when
 * a transaction unlocks, the height of a pool output, the subaddress of a spent summary taken from several
 * subaddresses.
 */
export interface ZephyrWalletOutput {
  /** atomic units of the output's asset */
  readonly amount: bigint;
  readonly accountIndex?: number;
  readonly subaddressIndex?: number;
  /** 64 lowercase hexadecimal characters */
  readonly txHash: string;
  /** the height of the block that holds the transaction; absent while it is in the pool */
  readonly height?: number;
  /** one of the core's asset types, for example "ZSD"; absent where the core reports none */
  readonly assetType?: string;
}

/**
 * Receives a wallet's notifications. Implement the callbacks you need; an object literal is enough.
 */
export interface ZephyrWalletListener {
  /**
   * Once per block scanned during a sync: height is the block, startHeight the first height of the sync, endHeight
   * the daemon's height when the sync started (raised when a new block arrives during the sync), percentDone
   * (height - startHeight + 1) / (endHeight - startHeight), reaching 1 at the last block. message is always
   * "Synchronizing". A wallet that is already at the daemon's height gets no call.
   */
  onSyncProgress?(height: number, startHeight: number, endHeight: number, percentDone: number, message: string): void;
  /** Once per block scanned, with its height. */
  onNewBlock?(height: number): void;
  /** Once per asset whose balance or unlocked balance changed: the new values of the whole wallet in that asset. */
  onBalancesChanged?(balance: bigint, unlockedBalance: bigint, assetType: string): void;
  /** An output for the wallet in the pool, in a scanned block, and again when it unlocked (see the module notes). */
  onOutputReceived?(output: ZephyrWalletOutput): void;
  /** An output of the wallet spent in a scanned block, and again when that transaction unlocked (see the module notes). */
  onOutputSpent?(output: ZephyrWalletOutput): void;
  /**
   * A failure that no caller can receive: a background sync iteration that failed (startSyncing), with the fixed
   * code and diagnostic a sync would reject with; or a notification the library could not read
   * (NATIVE_ERROR/UNEXPECTED_RESULT, MALFORMED_MESSAGE/MESSAGE_SHAPE), which is then not delivered. Not in the Java port.
   */
  onSyncError?(error: ZephyrWalletError): void;
}
