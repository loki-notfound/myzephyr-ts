/**
 * Parsers, validators and worker data shapes of common/ZephyrSweep.ts, which holds the public types. Internal: the package
 * entry does not export this module, and no declaration the entry reaches refers to it.
 */
import ZephyrWalletError from "./ZephyrWalletError";
import * as WalletErrors from "./ZephyrWalletErrorMapping";
import { checkSubaddressIndices, isAddressIndex } from "./ZephyrLifecycleContract";
import { isAssetTypeToken } from "./ZephyrBalancesInternal";
import type { ZephyrTxPriority, ZephyrBuiltTx } from "./ZephyrTransfer";
import type { ZephyrSweepBuild } from "./ZephyrSweep";
import { ADDRESS_TEXT, Bad, MAX_BUILT_TXS, PRIORITIES, TX_HASH, UINT64_MAX, V1_ASSETS, V2_ASSETS, amountOf, countOf, fields, plainData } from "./ZephyrTransferInternal";

const CONFIG_KEYS = ["asset", "destinationAsset", "address", "accountIndex", "subaddressIndices", "priority"];

/** The validated request the bridge and the worker receive. */
export interface ZephyrSweepRequest {
  readonly asset: string;
  readonly address: string;
  readonly accountIndex: number;
  readonly subaddressIndices: readonly number[];
  readonly priority: number;
}

const invalid = (d: "CONFIG_TYPE" | "UNKNOWN_FIELD" | "ASSET_TYPE" | "TX_ASSET" | "ADDRESS_INDEX_RANGE" | "TX_PRIORITY"): never => {
  throw new ZephyrWalletError("INVALID_CONFIG", d);
};

/**
 * Validate a sweep configuration before any native or worker call; returns the normalized request. The fields and their
 * errors are those of the transfer configuration (common/ZephyrTransferInternal.ts), with one address instead of
 * destinations; a destination asset other than the asset (a converting sweep) rejects with UNSUPPORTED_CAPABILITY/CONVERSION.
 */
export function checkSweepConfig(config: unknown): ZephyrSweepRequest {
  const c = plainData(config, () => invalid("CONFIG_TYPE"));
  for (const key of Object.keys(c)) if (!CONFIG_KEYS.includes(key)) invalid("UNKNOWN_FIELD");
  if (!isAssetTypeToken(c.asset)) invalid("ASSET_TYPE");
  const asset = c.asset as string;
  if (V1_ASSETS.includes(asset)) invalid("TX_ASSET");
  if (!V2_ASSETS.includes(asset)) invalid("ASSET_TYPE");
  if (c.destinationAsset !== undefined) {
    if (!isAssetTypeToken(c.destinationAsset)) invalid("ASSET_TYPE");
    if (c.destinationAsset !== asset) throw WalletErrors.unsupported("CONVERSION");
  }
  if (typeof c.address !== "string" || !ADDRESS_TEXT.test(c.address)) throw new ZephyrWalletError("INVALID_ADDRESS", "ADDRESS_TYPE");
  if (!isAddressIndex(c.accountIndex)) invalid("ADDRESS_INDEX_RANGE");
  const subaddressIndices = c.subaddressIndices === undefined ? [] : checkSubaddressIndices(c.subaddressIndices);
  let priority = 0;
  if (c.priority !== undefined) {
    if (typeof c.priority !== "string" || !Object.prototype.hasOwnProperty.call(PRIORITIES, c.priority)) invalid("TX_PRIORITY");
    priority = PRIORITIES[c.priority as ZephyrTxPriority];
  }
  return Object.freeze({ asset, address: c.address as string, accountIndex: c.accountIndex as number, subaddressIndices: Object.freeze(subaddressIndices.slice()), priority });
}

/** Validate a request again (worker side, and before a direct native call); returns a copy. */
export function checkSweepRequest(asset: unknown, address: unknown, accountIndex: unknown, subaddressIndices: unknown, priority: unknown): ZephyrSweepRequest {
  if (typeof priority !== "number" || !Number.isInteger(priority) || priority < 0 || priority > 3) invalid("TX_PRIORITY");
  const names = Object.keys(PRIORITIES) as ZephyrTxPriority[];
  const config: Record<string, unknown> = { asset, address, accountIndex, priority: names[priority as number] };
  if (subaddressIndices !== undefined && !(Array.isArray(subaddressIndices) && subaddressIndices.length === 0)) config.subaddressIndices = subaddressIndices;
  return checkSweepConfig(config);
}

// ------------------------------------------------------------------ results

const TX_KEYS = ["hash", "sourceAsset", "destinationAsset", "amount", "fee", "feeAsset", "totalDebited", "change", "ringSize", "inputs", "outputs", "weight", "unlockTime", "destinations"];

/**
 * The sweep's wire shape (the bridge's JSON and the worker DTO): {"txs":[...]}, uint64 values as decimal text, every
 * transaction with the one destination (the request's address and that transaction's amount). The totals are the sums of
 * the transactions' amounts and fees and must fit uint64.
 */
export function sweepFromFields(value: unknown, request: ZephyrSweepRequest, bad: Bad): ZephyrSweepBuild {
  const f = fields(value, ["txs"], [], bad);
  if (!Array.isArray(f.txs) || f.txs.length === 0 || f.txs.length > MAX_BUILT_TXS) bad();
  const seen = new Set<string>();
  let totalAmount = BigInt(0), totalFee = BigInt(0);
  const txs = (f.txs as unknown[]).map((v) => {
    const t = fields(v, TX_KEYS, [], bad);
    if (typeof t.hash !== "string" || !TX_HASH.test(t.hash) || seen.has(t.hash)) bad();
    seen.add(t.hash as string);
    if (t.sourceAsset !== request.asset || t.destinationAsset !== request.asset || t.feeAsset !== request.asset) bad();
    const amount = amountOf(t.amount, bad), fee = amountOf(t.fee, bad), totalDebited = amountOf(t.totalDebited, bad);
    if (totalDebited !== amount + fee || amount === BigInt(0)) bad();
    totalAmount += amount;
    totalFee += fee;
    const weight = amountOf(t.weight, bad);
    if (weight === BigInt(0) || weight > BigInt(Number.MAX_SAFE_INTEGER)) bad();
    if (!Array.isArray(t.destinations) || t.destinations.length !== 1) bad();
    const d = fields((t.destinations as unknown[])[0], ["address", "amount"], [], bad);
    if (d.address !== request.address || d.amount !== t.amount) bad();
    const tx = {
      hash: t.hash as string, sourceAsset: request.asset, destinationAsset: request.asset,
      destinations: Object.freeze([Object.freeze({ address: request.address, amount })]),
      amount, fee, feeAsset: request.asset, totalDebited, change: amountOf(t.change, bad), ringSize: countOf(t.ringSize, 1024, bad),
      inputs: countOf(t.inputs, 65536, bad), outputs: countOf(t.outputs, 16, bad), weight: Number(weight), unlockTime: amountOf(t.unlockTime, bad)
    };
    return Object.freeze(tx as ZephyrBuiltTx);
  });
  if (totalAmount > UINT64_MAX || totalFee > UINT64_MAX) bad();
  return Object.freeze({ txs: Object.freeze(txs), multipleTxs: txs.length > 1, totalAmount, totalFee });
}

const unexpected: Bad = () => { throw new ZephyrWalletError("NATIVE_ERROR", "UNEXPECTED_RESULT"); };
const malformed: Bad = () => { throw new ZephyrWalletError("MALFORMED_MESSAGE", "MESSAGE_SHAPE"); };

/** Bridge {"txs":[...]} of build_sweep_unlocked for a request; every field is checked against the request. */
export function parseBridgeSweep(json: unknown, request: ZephyrSweepRequest): ZephyrSweepBuild {
  if (typeof json !== "string" || json.charAt(0) !== "{") unexpected();
  let parsed: unknown;
  try { parsed = JSON.parse(json as string); } catch (err) { unexpected(); }
  return sweepFromFields(parsed, request, unexpected);
}

/** Worker DTO of a sweep: the bridge's wire shape (the totals are derived again on the receiving side). */
export function toSweepDto(build: ZephyrSweepBuild): unknown {
  return {
    txs: build.txs.map((t) => ({
      hash: t.hash, sourceAsset: t.sourceAsset, destinationAsset: t.destinationAsset, amount: t.amount.toString(), fee: t.fee.toString(), feeAsset: t.feeAsset,
      totalDebited: t.totalDebited.toString(), change: t.change.toString(), ringSize: t.ringSize, inputs: t.inputs, outputs: t.outputs, weight: String(t.weight),
      unlockTime: t.unlockTime.toString(), destinations: (t.destinations ?? []).map((d) => ({ address: d.address, amount: d.amount.toString() }))
    }))
  };
}

/** Strict worker reply of buildSweepUnlocked. */
export function fromSweepDto(value: unknown, request: ZephyrSweepRequest): ZephyrSweepBuild {
  return sweepFromFields(value, request, malformed);
}
