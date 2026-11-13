import ZephyrWalletError from "./ZephyrWalletError";
import { isAddressIndex } from "./ZephyrLifecycleContract";
import { isAssetTypeToken, parseUint64Text } from "./ZephyrBalances";

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
 * - outgoing amounts, fees and conversion amounts are the core's own computation and are not proven
 *   on real data (no transaction has been sent from a test wallet).
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

/** Source and destination of a conversion, as far as the core reports them (unproven on real data). */
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

/**
 * Listing bounds (resource policy, provisional): the selection of one call holds at most
 * MAX_TXS_PER_CALL transactions with at most MAX_TRANSFERS_PER_CALL transfers in total, else
 * INVALID_CONFIG/LISTING_LIMIT, checked before anything crosses the bridge. The core has no cursor;
 * a caller pages by height range (minHeight, maxHeight). A query names at most MAX_TXS_PER_CALL hashes.
 */
export const MAX_TXS_PER_CALL = 1000;
export const MAX_TRANSFERS_PER_CALL = 2000;

/** The selection the bridge makes; transfer filters are applied afterwards to the complete transactions. */
export interface ZephyrHistorySelection {
  readonly status: "all" | ZephyrHistoryStatus;
  readonly minHeight?: number;
  readonly maxHeight?: number;
  readonly hashes?: readonly string[];
}

const QUERY_KEYS = ["asset", "accountIndex", "subaddressIndex", "direction", "status", "minHeight", "maxHeight", "hashes"];
const TX_HASH = /^[0-9a-f]{64}$/;

function invalid(diagnostic: "CONFIG_TYPE" | "UNKNOWN_FIELD" | "FIELD_TYPE" | "ASSET_TYPE" | "ADDRESS_INDEX_RANGE" | "HEIGHT_RANGE" | "TX_HASH" | "TX_HASHES" | "LISTING_LIMIT" | "QUERY_ACCOUNT_REQUIRED"): never {
  throw new ZephyrWalletError("INVALID_CONFIG", diagnostic);
}

/** A transaction hash argument: 64 lowercase hexadecimal characters (INVALID_CONFIG/TX_HASH otherwise). */
export function checkTxHash(hash: unknown): string {
  if (typeof hash !== "string" || !TX_HASH.test(hash)) invalid("TX_HASH");
  return hash as string;
}

/** Explicit transaction hashes: a non-empty array of distinct hashes, at most MAX_TXS_PER_CALL. */
export function checkTxHashes(hashes: unknown): readonly string[] {
  if (!Array.isArray(hashes) || hashes.length === 0) invalid("TX_HASHES");
  if ((hashes as unknown[]).length > MAX_TXS_PER_CALL) invalid("LISTING_LIMIT");
  const seen = new Set<string>();
  for (const h of hashes as unknown[]) {
    checkTxHash(h);
    if (seen.has(h as string)) invalid("TX_HASHES");
    seen.add(h as string);
  }
  return (hashes as string[]).slice();
}

function isHeight(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Validate a history query before any native or worker call; returns a normalized copy. */
export function checkHistoryQuery(query: unknown): ZephyrHistoryQuery {
  if (query === undefined) return Object.freeze({});
  if (query === null || typeof query !== "object" || Array.isArray(query)) invalid("CONFIG_TYPE");
  const proto = Object.getPrototypeOf(query);
  if (proto !== Object.prototype && proto !== null) invalid("CONFIG_TYPE");
  // own data properties only: no getter or setter is ever invoked, no symbol key is accepted
  if (Object.getOwnPropertySymbols(query as object).length > 0) invalid("CONFIG_TYPE");
  const descriptors = Object.getOwnPropertyDescriptors(query as object);
  for (const key of Object.keys(descriptors)) if (!("value" in descriptors[key])) invalid("CONFIG_TYPE");
  const q = query as Record<string, unknown>;
  for (const key of Object.keys(q)) if (!QUERY_KEYS.includes(key)) invalid("UNKNOWN_FIELD");
  const out: { -readonly [K in keyof ZephyrHistoryQuery]: ZephyrHistoryQuery[K] } = {};
  if (q.asset !== undefined) { if (!isAssetTypeToken(q.asset)) invalid("ASSET_TYPE"); out.asset = q.asset as string; }
  if (q.accountIndex !== undefined) { if (!isAddressIndex(q.accountIndex)) invalid("ADDRESS_INDEX_RANGE"); out.accountIndex = q.accountIndex as number; }
  if (q.subaddressIndex !== undefined) {
    if (!isAddressIndex(q.subaddressIndex)) invalid("ADDRESS_INDEX_RANGE");
    if (q.accountIndex === undefined) invalid("QUERY_ACCOUNT_REQUIRED");
    out.subaddressIndex = q.subaddressIndex as number;
  }
  if (q.direction !== undefined) { if (q.direction !== "incoming" && q.direction !== "outgoing") invalid("FIELD_TYPE"); out.direction = q.direction; }
  if (q.status !== undefined) { if (q.status !== "confirmed" && q.status !== "pool" && q.status !== "failed") invalid("FIELD_TYPE"); out.status = q.status; }
  if (q.minHeight !== undefined) { if (!isHeight(q.minHeight)) invalid("HEIGHT_RANGE"); out.minHeight = q.minHeight; }
  if (q.maxHeight !== undefined) { if (!isHeight(q.maxHeight)) invalid("HEIGHT_RANGE"); out.maxHeight = q.maxHeight; }
  if (out.minHeight !== undefined && out.maxHeight !== undefined && out.minHeight > out.maxHeight) invalid("HEIGHT_RANGE");
  if (q.hashes !== undefined) out.hashes = Object.freeze(checkTxHashes(q.hashes));
  return Object.freeze(out);
}

/** The bridge selection of a validated query. */
export function selectionOf(query: ZephyrHistoryQuery): ZephyrHistorySelection {
  const s: { -readonly [K in keyof ZephyrHistorySelection]: ZephyrHistorySelection[K] } = { status: query.status ?? "all" };
  if (query.minHeight !== undefined) s.minHeight = query.minHeight;
  if (query.maxHeight !== undefined) s.maxHeight = query.maxHeight;
  if (query.hashes !== undefined) s.hashes = query.hashes.slice();
  return s;
}

/** Validate a selection (worker side, and before a direct native call). */
export function checkSelection(status: unknown, minHeight: unknown, maxHeight: unknown, hashes: unknown): ZephyrHistorySelection {
  if (status !== "all" && status !== "confirmed" && status !== "pool" && status !== "failed") invalid("FIELD_TYPE");
  if (minHeight !== undefined && !isHeight(minHeight)) invalid("HEIGHT_RANGE");
  if (maxHeight !== undefined && !isHeight(maxHeight)) invalid("HEIGHT_RANGE");
  if (minHeight !== undefined && maxHeight !== undefined && (minHeight as number) > (maxHeight as number)) invalid("HEIGHT_RANGE");
  const s: { -readonly [K in keyof ZephyrHistorySelection]: ZephyrHistorySelection[K] } = { status: status as ZephyrHistorySelection["status"] };
  if (minHeight !== undefined) s.minHeight = minHeight as number;
  if (maxHeight !== undefined) s.maxHeight = maxHeight as number;
  if (hashes !== undefined) s.hashes = checkTxHashes(hashes);
  return s;
}

/** Whether a transfer matches the transfer filters of a query. */
function transferMatches(t: ZephyrWalletTransfer, q: ZephyrHistoryQuery): boolean {
  if (q.direction !== undefined && t.direction !== q.direction) return false;
  if (q.asset !== undefined && t.asset !== q.asset) return false;
  if (q.accountIndex !== undefined && t.accountIndex !== q.accountIndex) return false;
  if (q.subaddressIndex !== undefined) {
    if (t.direction === "incoming" ? t.subaddressIndex !== q.subaddressIndex : !(t.subaddressIndices ?? []).includes(q.subaddressIndex)) return false;
  }
  return true;
}

function transfersOf(tx: ZephyrWalletTx): ZephyrWalletTransfer[] {
  return tx.outgoingTransfer === undefined ? tx.incomingTransfers.slice() : [tx.outgoingTransfer, ...tx.incomingTransfers];
}

/** getTxs: the selected transactions that have at least one transfer matching the query's transfer filters. */
export function filterTxs(txs: ReadonlyArray<ZephyrWalletTx>, q: ZephyrHistoryQuery): ReadonlyArray<ZephyrWalletTx> {
  return Object.freeze(txs.filter((tx) => transfersOf(tx).some((t) => transferMatches(t, q))));
}

/** getTransfers: the matching transfers of the selected transactions (per transaction: outgoing first, then incoming). */
export function filterTransfers(txs: ReadonlyArray<ZephyrWalletTx>, q: ZephyrHistoryQuery): ReadonlyArray<ZephyrWalletTransfer> {
  const out: ZephyrWalletTransfer[] = [];
  for (const tx of txs) for (const t of transfersOf(tx)) if (transferMatches(t, q)) out.push(t);
  return Object.freeze(out);
}

// ------------------------------------------------------------------ strict shapes

type Bad = () => never;

function plainObject(value: unknown, bad: Bad): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) bad();
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) bad();
  return value as Record<string, unknown>;
}

function exactKeys(fields: Record<string, unknown>, required: readonly string[], optional: readonly string[], bad: Bad): void {
  for (const k of required) if (!Object.prototype.hasOwnProperty.call(fields, k)) bad();
  for (const k of Object.keys(fields)) if (!required.includes(k) && !optional.includes(k)) bad();
}

function index(value: unknown, bad: Bad): number {
  if (!isAddressIndex(value)) bad();
  return value as number;
}

function bool(value: unknown, bad: Bad): boolean {
  if (typeof value !== "boolean") bad();
  return value as boolean;
}

function amount(value: unknown, bad: Bad): bigint {
  try { return parseUint64Text(value); } catch (err) { return bad(); }
}

function safeNumber(value: unknown, bad: Bad): number {
  const v = amount(value, bad);
  if (v > BigInt(Number.MAX_SAFE_INTEGER)) bad();
  return Number(v);
}

function asset(value: unknown, bad: Bad): string {
  if (!isAssetTypeToken(value)) bad();
  return value as string;
}

function addressText(value: unknown, bad: Bad): string {
  if (typeof value !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{90,140}$/.test(value)) bad();
  return value as string;
}

const TX_KEYS = ["hash", "confirmations", "isConfirmed", "inPool", "isFailed", "isLocked", "isMinerTx", "unlockTime", "incoming"];
const TX_OPTIONAL = ["height", "timestamp", "fee", "outgoing"];
const IN_KEYS = ["amount", "accountIndex", "subaddressIndex"];
const OUT_KEYS = ["amount", "accountIndex", "subaddressIndices", "destinations"];
const DEST_KEYS = ["amount"];

/**
 * One transaction from its wire fields (the bridge's JSON and the worker DTO have the same shape:
 * decimal strings for uint64 values). Every field is checked; bad() rejects with the boundary's code.
 */
function txFromFields(value: unknown, bad: Bad): ZephyrWalletTx {
  const f = plainObject(value, bad);
  exactKeys(f, TX_KEYS, TX_OPTIONAL, bad);
  if (typeof f.hash !== "string" || !TX_HASH.test(f.hash)) bad();
  const hash = f.hash as string;
  const isConfirmed = bool(f.isConfirmed, bad), inPool = bool(f.inPool, bad), isFailed = bool(f.isFailed, bad);
  if ((isConfirmed ? 1 : 0) + (inPool ? 1 : 0) + (isFailed ? 1 : 0) !== 1) bad();
  if (isConfirmed !== (f.height !== undefined) || isConfirmed !== (f.timestamp !== undefined)) bad();
  const height = f.height === undefined ? undefined : safeNumber(f.height, bad);
  const timestamp = f.timestamp === undefined ? undefined : safeNumber(f.timestamp, bad);
  const confirmations = safeNumber(f.confirmations, bad);
  if (!isConfirmed && confirmations !== 0) bad();
  const ref = (): { txHash: string; height?: number; confirmations: number } => height === undefined ? { txHash: hash, confirmations } : { txHash: hash, height, confirmations };
  if (!Array.isArray(f.incoming) || f.incoming.length > MAX_TRANSFERS_PER_CALL) bad();
  const incoming = (f.incoming as unknown[]).map((v) => {
    const t = plainObject(v, bad);
    exactKeys(t, IN_KEYS, ["asset"], bad);
    const transfer: { -readonly [K in keyof ZephyrWalletTransfer]: ZephyrWalletTransfer[K] } = { direction: "incoming", amount: amount(t.amount, bad), accountIndex: index(t.accountIndex, bad),
      subaddressIndex: index(t.subaddressIndex, bad), ...ref() };
    if (t.asset !== undefined) transfer.asset = asset(t.asset, bad);
    return Object.freeze(reorderTransfer(transfer));
  });
  for (let i = 1; i < incoming.length; i++) {
    const a = incoming[i - 1], b = incoming[i];
    if (a.accountIndex > b.accountIndex || (a.accountIndex === b.accountIndex && (a.subaddressIndex as number) > (b.subaddressIndex as number))) bad();
  }
  let outgoing: ZephyrWalletTransfer | undefined = undefined;
  if (f.outgoing !== undefined) {
    const t = plainObject(f.outgoing, bad);
    exactKeys(t, OUT_KEYS, ["asset"], bad);
    if (!Array.isArray(t.subaddressIndices) || t.subaddressIndices.length > 65536) bad();
    const indices = (t.subaddressIndices as unknown[]).map((i) => index(i, bad));
    if (!Array.isArray(t.destinations) || t.destinations.length > 65536) bad();
    const destinations = (t.destinations as unknown[]).map((v) => {
      const d = plainObject(v, bad);
      exactKeys(d, DEST_KEYS, ["address", "asset"], bad);
      const dest: { -readonly [K in keyof ZephyrTransferDestination]: ZephyrTransferDestination[K] } = { amount: amount(d.amount, bad) };
      if (d.address !== undefined) dest.address = addressText(d.address, bad);
      if (d.asset !== undefined) dest.asset = asset(d.asset, bad);
      return Object.freeze({ ...(dest.address !== undefined ? { address: dest.address } : {}), amount: dest.amount, ...(dest.asset !== undefined ? { asset: dest.asset } : {}) });
    });
    const transfer: { -readonly [K in keyof ZephyrWalletTransfer]: ZephyrWalletTransfer[K] } = { direction: "outgoing", amount: amount(t.amount, bad), accountIndex: index(t.accountIndex, bad),
      subaddressIndices: Object.freeze(indices), destinations: Object.freeze(destinations), ...ref() };
    if (t.asset !== undefined) transfer.asset = asset(t.asset, bad);
    outgoing = Object.freeze(reorderTransfer(transfer));
  }
  const tx = { hash } as { -readonly [K in keyof ZephyrWalletTx]: ZephyrWalletTx[K] };
  if (height !== undefined) tx.height = height;
  if (timestamp !== undefined) tx.timestamp = timestamp;
  tx.confirmations = confirmations;
  tx.isConfirmed = isConfirmed; tx.inPool = inPool; tx.isFailed = isFailed;
  tx.isLocked = bool(f.isLocked, bad); tx.isMinerTx = bool(f.isMinerTx, bad);
  if (f.fee !== undefined) tx.fee = amount(f.fee, bad);
  if (outgoing !== undefined && outgoing.asset !== undefined) tx.feeAsset = outgoing.asset;
  tx.unlockTime = amount(f.unlockTime, bad);
  tx.incomingTransfers = Object.freeze(incoming);
  if (outgoing !== undefined) {
    tx.outgoingTransfer = outgoing;
    const conversion = conversionOf(outgoing);
    if (conversion !== undefined) tx.conversion = conversion;
  }
  if (incoming.length === 0 && outgoing === undefined) bad();
  return Object.freeze(tx as ZephyrWalletTx);
}

/** Fields in a fixed order, so that equal transfers serialize equally in every mode. */
function reorderTransfer(t: ZephyrWalletTransfer): ZephyrWalletTransfer {
  const o: { -readonly [K in keyof ZephyrWalletTransfer]: ZephyrWalletTransfer[K] } = { direction: t.direction } as ZephyrWalletTransfer;
  if (t.asset !== undefined) o.asset = t.asset;
  o.amount = t.amount;
  o.accountIndex = t.accountIndex;
  if (t.subaddressIndex !== undefined) o.subaddressIndex = t.subaddressIndex;
  if (t.subaddressIndices !== undefined) o.subaddressIndices = t.subaddressIndices;
  if (t.destinations !== undefined) o.destinations = t.destinations;
  o.txHash = t.txHash;
  if (t.height !== undefined) o.height = t.height;
  o.confirmations = t.confirmations;
  return o;
}

/** A conversion: the outgoing asset differs from the single asset of all destinations. */
function conversionOf(t: ZephyrWalletTransfer): ZephyrTxConversion | undefined {
  const dests = t.destinations ?? [];
  if (t.asset === undefined || dests.length === 0) return undefined;
  const target = dests[0].asset;
  if (target === undefined || target === t.asset || dests.some((d) => d.asset !== target)) return undefined;
  return Object.freeze({ sourceAsset: t.asset, destinationAsset: target, sourceAmount: t.amount, destinationAmount: dests.reduce((n, d) => n + d.amount, BigInt(0)) });
}

/** The selection's rules hold for every transaction: status, height range, hashes, order and bounds. */
function checkListing(txs: ZephyrWalletTx[], selection: ZephyrHistorySelection, bad: Bad): ReadonlyArray<ZephyrWalletTx> {
  if (txs.length > MAX_TXS_PER_CALL) bad();
  let transfers = 0;
  const heightFilter = selection.minHeight !== undefined || selection.maxHeight !== undefined;
  for (let i = 0; i < txs.length; i++) {
    const tx = txs[i];
    transfers += tx.incomingTransfers.length + (tx.outgoingTransfer === undefined ? 0 : 1);
    if (selection.status === "confirmed" && !tx.isConfirmed) bad();
    if (selection.status === "pool" && !tx.inPool) bad();
    if (selection.status === "failed" && !tx.isFailed) bad();
    if (heightFilter && (!tx.isConfirmed || (selection.minHeight !== undefined && (tx.height as number) < selection.minHeight) || (selection.maxHeight !== undefined && (tx.height as number) > selection.maxHeight))) bad();
    if (selection.hashes !== undefined && !selection.hashes.includes(tx.hash)) bad();
    if (i > 0) {
      const a = txs[i - 1];
      const order = a.isConfirmed === tx.isConfirmed ? (a.isConfirmed && a.height !== tx.height ? (a.height as number) - (tx.height as number) : (a.hash < tx.hash ? -1 : 1)) : (a.isConfirmed ? -1 : 1);
      if (order >= 0 || a.hash === tx.hash) bad();
    }
  }
  if (transfers > MAX_TRANSFERS_PER_CALL) bad();
  if (selection.hashes !== undefined && selection.hashes.some((h) => !txs.some((tx) => tx.hash === h))) bad();
  return Object.freeze(txs);
}

// ------------------------------------------------------------------ bridge JSON

const unexpected: Bad = () => { throw new ZephyrWalletError("NATIVE_ERROR", "UNEXPECTED_RESULT"); };

/** Bridge {"txs":[...]} of get_txs for a selection. */
export function parseBridgeTxs(json: unknown, selection: ZephyrHistorySelection): ReadonlyArray<ZephyrWalletTx> {
  if (typeof json !== "string" || json.charAt(0) !== "{") unexpected();
  let parsed: unknown;
  try { parsed = JSON.parse(json as string); } catch (err) { unexpected(); }
  const f = plainObject(parsed, unexpected);
  exactKeys(f, ["txs"], [], unexpected);
  if (!Array.isArray(f.txs)) unexpected();
  if ((f.txs as unknown[]).length > MAX_TXS_PER_CALL) unexpected();
  return checkListing((f.txs as unknown[]).map((t) => txFromFields(t, unexpected)), selection, unexpected);
}

// ------------------------------------------------------------------ pool refresh

/** Bridge {"poolTxs":n} of refresh_pool: the count of incoming pool transactions the wallet holds now. */
export function parsePoolRefresh(json: unknown): number {
  if (typeof json !== "string" || json.charAt(0) !== "{") unexpected();
  let parsed: unknown;
  try { parsed = JSON.parse(json as string); } catch (err) { unexpected(); }
  const f = plainObject(parsed, unexpected);
  exactKeys(f, ["poolTxs"], [], unexpected);
  if (!Number.isSafeInteger(f.poolTxs) || (f.poolTxs as number) < 0 || (f.poolTxs as number) > MAX_TXS_PER_CALL) unexpected();
  return f.poolTxs as number;
}

/** Strict worker reply of refreshPool. */
export function fromPoolRefreshDto(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > MAX_TXS_PER_CALL) malformed();
  return value as number;
}

// ------------------------------------------------------------------ worker DTOs

/** Worker DTO of one transaction: the bridge's wire shape (uint64 values as decimal strings). */
export interface ZephyrWalletTxDto {
  readonly hash: string; readonly height?: string; readonly timestamp?: string; readonly confirmations: string;
  readonly isConfirmed: boolean; readonly inPool: boolean; readonly isFailed: boolean; readonly isLocked: boolean; readonly isMinerTx: boolean;
  readonly fee?: string; readonly unlockTime: string;
  readonly incoming: ReadonlyArray<{ readonly asset?: string; readonly amount: string; readonly accountIndex: number; readonly subaddressIndex: number }>;
  readonly outgoing?: { readonly asset?: string; readonly amount: string; readonly accountIndex: number; readonly subaddressIndices: ReadonlyArray<number>;
    readonly destinations: ReadonlyArray<{ readonly address?: string; readonly amount: string; readonly asset?: string }> };
}

function withAsset<T extends object>(o: T, a: string | undefined): T & { asset?: string } {
  return a === undefined ? o : Object.assign({ asset: a }, o);
}

export function toTxDto(tx: ZephyrWalletTx): ZephyrWalletTxDto {
  const dto: Record<string, unknown> = { hash: tx.hash };
  if (tx.height !== undefined) dto.height = String(tx.height);
  if (tx.timestamp !== undefined) dto.timestamp = String(tx.timestamp);
  dto.confirmations = String(tx.confirmations);
  dto.isConfirmed = tx.isConfirmed; dto.inPool = tx.inPool; dto.isFailed = tx.isFailed; dto.isLocked = tx.isLocked; dto.isMinerTx = tx.isMinerTx;
  if (tx.fee !== undefined) dto.fee = tx.fee.toString();
  dto.unlockTime = tx.unlockTime.toString();
  dto.incoming = tx.incomingTransfers.map((t) => withAsset({ amount: t.amount.toString(), accountIndex: t.accountIndex, subaddressIndex: t.subaddressIndex as number }, t.asset));
  const o = tx.outgoingTransfer;
  if (o !== undefined) {
    dto.outgoing = withAsset({ amount: o.amount.toString(), accountIndex: o.accountIndex, subaddressIndices: (o.subaddressIndices ?? []).slice(),
      destinations: (o.destinations ?? []).map((d) => withAsset(Object.assign(d.address === undefined ? {} : { address: d.address }, { amount: d.amount.toString() }), d.asset)) }, o.asset);
  }
  return dto as unknown as ZephyrWalletTxDto;
}

const malformed: Bad = () => { throw new ZephyrWalletError("MALFORMED_MESSAGE", "MESSAGE_SHAPE"); };

/** Strict worker reply of a history selection. */
export function fromTxsDto(value: unknown, selection: ZephyrHistorySelection): ReadonlyArray<ZephyrWalletTx> {
  if (!Array.isArray(value) || value.length > MAX_TXS_PER_CALL) malformed();
  return checkListing((value as unknown[]).map((t) => txFromFields(t, malformed)), selection, malformed);
}
