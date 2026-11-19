/**
 * Read-only history of full wallets: the wallet's transactions and transfers per asset, as the wallet
 * stored them at its last sync and its last pool refresh. Nothing here talks to the daemon: a listing
 * reads the wallet's own records (getTxs, getTransfers and getTx send no request). Incoming transfers
 * that are still in the pool appear only after an explicit refreshPool, which is a daemon request the
 * caller chooses; the listing then holds what that refresh saw until the next refresh or until the
 * wallet holds the transaction as confirmed.
 *
 * Results are read-only plain data: frozen objects and arrays with numbers, strings, booleans and
 * bigint amounts in atomic units. No inherited model class appears in a result. A value the core
 * does not report stays absent; nothing absent becomes zero or an asset name. The asset is the core's
 * string (historical names such as ZEPH pass through unchanged).
 *
 * Known gaps of the fixed core, documented in LIMITATIONS.md:
 * - incoming transfers that are still in the pool are listed only from the last refreshPool: the core
 *   fetches the pool from the daemon to find them; an incoming pool transfer carries the asset the core
 *   recorded for it, and no asset when the core recorded none (absent stays absent);
 * - the core reports no fee asset; feeAsset is the asset of the outgoing transfer (fees are paid in
 *   the source asset) and absent for a transaction without an outgoing transfer;
 * - outgoing amounts, fees and conversion amounts are the core's own computation. On real data (the
 *   mainnet test of 2026-11-15 with a funded test wallet) outgoing transfers with their destinations, the
 *   fees paid and conversions with their burnt and minted amounts were read as the transactions stated
 *   them; own transactions in the pool and failed ones are tested with constructed records only.
 *
 * Text stored in the wallet or derived from the chain (destination addresses as the sender's wallet
 * stored them) is untrusted: the bridge writes an address only if it has the form of an address, and
 * the SDK never copies such text into an error or a log line. Notes and payment identifiers are not
 * returned.
 */

/** Direction of a transfer. */
export type ZephyrTransferDirection = "incoming" | "outgoing";

/** State of a transaction: confirmed, in the pool (own outgoing, or incoming as of the last refreshPool), or failed. */
export type ZephyrHistoryStatus = "confirmed" | "pool" | "failed";

/** One destination of an outgoing transfer as the wallet stored it when it sent the transaction. */
export interface ZephyrTransferDestination {
  /** absent when the stored text does not have the form of an address */
  readonly address?: string;
  /** amount in the destination asset (atomic units) */
  readonly amount: bigint;
  /** absent when the core reports none */
  readonly asset?: string;
}

/** One transfer of the wallet: an incoming transfer to one subaddress, or the outgoing transfer of a transaction. */
export interface ZephyrWalletTransfer {
  readonly direction: ZephyrTransferDirection;
  /** the core's asset of the transfer; absent when the core reports none */
  readonly asset?: string;
  /** atomic units */
  readonly amount: bigint;
  readonly accountIndex: number;
  /** incoming: the subaddress that received it */
  readonly subaddressIndex?: number;
  /** outgoing: the subaddresses whose outputs were spent */
  readonly subaddressIndices?: ReadonlyArray<number>;
  /** outgoing: the destinations the wallet stored (empty when it stored none) */
  readonly destinations?: ReadonlyArray<ZephyrTransferDestination>;
  /** the transaction of this transfer */
  readonly txHash: string;
  /** block height of the transaction; absent while unconfirmed */
  readonly height?: number;
  /** confirmations of the transaction at the wallet's height (0 while unconfirmed) */
  readonly confirmations: number;
}

/**
 * Source and destination of a conversion, as far as the core reports them (on real data: the four
 * conversions relayed on mainnet on 2026-11-15).
 */
export interface ZephyrTxConversion {
  readonly sourceAsset: string;
  readonly destinationAsset: string;
  /** the outgoing transfer's amount as the core computes it */
  readonly sourceAmount: bigint;
  /** the sum of the destinations' amounts in the destination asset */
  readonly destinationAmount: bigint;
}

/** One transaction of the wallet with all of its transfers. */
export interface ZephyrWalletTx {
  /** 64 lowercase hexadecimal characters */
  readonly hash: string;
  /** block height; absent while unconfirmed */
  readonly height?: number;
  /** block timestamp in seconds; absent while unconfirmed */
  readonly timestamp?: number;
  /** confirmations at the wallet's height (0 while unconfirmed) */
  readonly confirmations: number;
  readonly isConfirmed: boolean;
  /** in the pool: an own outgoing transaction, or an incoming one as of the last refreshPool */
  readonly inPool: boolean;
  readonly isFailed: boolean;
  /** whether the core considers the transaction locked at the wallet's height */
  readonly isLocked: boolean;
  readonly isMinerTx: boolean;
  /** the core's fee of the transaction (atomic units); absent when the core reports none */
  readonly fee?: bigint;
  /** asset of the fee: the outgoing transfer's asset; absent without an outgoing transfer */
  readonly feeAsset?: string;
  /** the transaction's unlock time as stored (a height, or a timestamp at or above 500,000,000) */
  readonly unlockTime: bigint;
  /** incoming transfers in account, then subaddress order */
  readonly incomingTransfers: ReadonlyArray<ZephyrWalletTransfer>;
  readonly outgoingTransfer?: ZephyrWalletTransfer;
  /** present when the outgoing transfer's asset differs from the one asset of its destinations */
  readonly conversion?: ZephyrTxConversion;
}

/**
 * Query of getTxs and getTransfers; every field is optional, unknown fields reject.
 * - asset, accountIndex, subaddressIndex (only with accountIndex), direction: transfer filters. getTxs
 *   returns the transactions with at least one matching transfer, each with all of its transfers;
 *   getTransfers returns the matching transfers. An outgoing transfer matches a subaddress index when
 *   it spent from that subaddress.
 * - status, minHeight, maxHeight (inclusive; confirmed transactions only), hashes: the selection of
 *   transactions. A hash the selection does not contain rejects with INVALID_CONFIG/TX_NOT_FOUND.
 * A transfer filter on an account or subaddress the wallet does not have matches nothing and gives an
 * empty listing (a filter, not a lookup; the balance calls reject such an index with ACCOUNT_NOT_FOUND).
 * The query must be a plain object (or one without prototype) of own data properties: a property with a
 * getter or setter, or a symbol key, rejects with INVALID_CONFIG/CONFIG_TYPE before any property is read.
 */
export interface ZephyrHistoryQuery {
  readonly asset?: string;
  readonly accountIndex?: number;
  readonly subaddressIndex?: number;
  readonly direction?: ZephyrTransferDirection;
  readonly status?: ZephyrHistoryStatus;
  readonly minHeight?: number;
  readonly maxHeight?: number;
  readonly hashes?: ReadonlyArray<string>;
}
