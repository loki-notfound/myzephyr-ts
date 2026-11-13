import ZephyrWalletError from "./ZephyrWalletError";
import { checkSubaddressIndices, isAddressIndex } from "./ZephyrLifecycleContract";
import { isAssetTypeToken, parseUint64Text } from "./ZephyrBalances";

/**
 * Building transactions of full wallets without relay: buildTransfer builds the transactions of a
 * same-asset transfer, describes them and discards them. The core builds and signs them inside the
 * module; nothing is relayed (the bridge passes relay false, a constant no caller value reaches) and no
 * byte of a built transaction (hex, blob, signed set, key images, transaction key) leaves the module.
 * The description is read-only plain data with bigint amounts in atomic units.
 *
 * The configuration is a small explicit set, validated before the build is dispatched; unknown fields
 * reject. A destination asset other than the source asset rejects before dispatch: conversions are
 * built by buildConversion (common/ZephyrConversion.ts).
 */

/** The core's transaction priorities (0..3): the core's automatic choice, then increasing fees. */
export type ZephyrTxPriority = "default" | "unimportant" | "normal" | "elevated";

/** One destination of a transfer: an address of the wallet's network and an amount in atomic units. */
export interface ZephyrTransferDestinationInput {
  readonly address: string;
  readonly amount: bigint;
}

/** Configuration of buildTransfer; a plain object of own data properties, unknown fields reject. */
export interface ZephyrTransferConfig {
  /** the asset sent: one of the V2 assets ZPH, ZSD, ZRS, ZYS */
  readonly asset: string;
  /** optional; equal to asset (a different asset is a conversion: UNSUPPORTED_CAPABILITY/CONVERSION) */
  readonly destinationAsset?: string;
  /** 1 to 15 destinations */
  readonly destinations: ReadonlyArray<ZephyrTransferDestinationInput>;
  /** the account whose outputs are spent */
  readonly accountIndex: number;
  /** optional: spend only outputs of these subaddresses of the account (distinct, at most 1,000) */
  readonly subaddressIndices?: ReadonlyArray<number>;
  /** default "default" */
  readonly priority?: ZephyrTxPriority;
}

/** One built (and discarded) transaction as the core built it. */
export interface ZephyrBuiltTx {
  /** 64 lowercase hexadecimal characters */
  readonly hash: string;
  /** from the built transaction's inputs */
  readonly sourceAsset: string;
  /** from its outputs; equal to sourceAsset in this version */
  readonly destinationAsset: string;
  /** present only when the build needed one transaction (the core attributes destinations only then) */
  readonly destinations?: ReadonlyArray<{ readonly address: string; readonly amount: bigint }>;
  /** what this transaction sends to the destinations (change excluded) */
  readonly amount: bigint;
  /** the core's fee of this transaction */
  readonly fee: bigint;
  /** the asset the fee is paid in: the source asset */
  readonly feeAsset: string;
  /** amount + fee, in the source asset */
  readonly totalDebited: bigint;
  /** the core's change amount (back to the wallet) */
  readonly change: bigint;
  /** ring members per input, read from the built transaction */
  readonly ringSize: number;
  readonly inputs: number;
  /** outputs of the built transaction, change included */
  readonly outputs: number;
  /** the core's transaction weight */
  readonly weight: number;
  /** the built transaction's unlock time (0) */
  readonly unlockTime: bigint;
}

/** Result of buildTransfer. */
export interface ZephyrTransferBuild {
  readonly txs: ReadonlyArray<ZephyrBuiltTx>;
  /** more than one transaction was needed */
  readonly multipleTxs: boolean;
}

/** At most 15 destinations: a transaction carries at most 16 outputs, one of them change. */
export const MAX_DESTINATIONS = 15;
/** Bound of the transactions one build may return (the core splits only when it must). */
export const MAX_BUILT_TXS = 64;
export const V2_ASSETS: readonly string[] = ["ZPH", "ZSD", "ZRS", "ZYS"];
export const V1_ASSETS: readonly string[] = ["ZEPH", "ZEPHUSD", "ZEPHRSV", "ZYIELD"];
/** The core's priority values (monero_tx_priority 0..3) by name. */
export const PRIORITIES: Readonly<Record<ZephyrTxPriority, number>> = Object.freeze({ default: 0, unimportant: 1, normal: 2, elevated: 3 });
export const UINT64_MAX = BigInt("18446744073709551615");
export const ADDRESS_TEXT = /^[1-9A-HJ-NP-Za-km-z]{90,140}$/;
export const DECIMAL = /^(0|[1-9][0-9]{0,19})$/;
export const TX_HASH = /^[0-9a-f]{64}$/;
const CONFIG_KEYS = ["asset", "destinationAsset", "destinations", "accountIndex", "subaddressIndices", "priority"];

/** The validated request the bridge and the worker receive: amounts as exact decimal text. */
export interface ZephyrTransferRequest {
  readonly asset: string;
  readonly addresses: readonly string[];
  readonly amounts: readonly string[];
  readonly accountIndex: number;
  readonly subaddressIndices: readonly number[];
  readonly priority: number;
}

export type Bad = () => never;
const invalid = (d: "CONFIG_TYPE" | "UNKNOWN_FIELD" | "FIELD_TYPE" | "ASSET_TYPE" | "TX_ASSET" | "DESTINATIONS" | "TOO_MANY_DESTINATIONS" | "AMOUNT_ZERO" | "AMOUNT_RANGE" | "ADDRESS_INDEX_RANGE" | "TX_PRIORITY"): never => {
  throw new ZephyrWalletError("INVALID_CONFIG", d);
};

/** A plain object (or one without prototype) of own enumerable data properties, no symbol keys. */
export function plainData(value: unknown, bad: Bad): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) bad();
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) bad();
  if (Object.getOwnPropertySymbols(value as object).length > 0) bad();
  const descriptors = Object.getOwnPropertyDescriptors(value as object);
  for (const key of Object.keys(descriptors)) if (!("value" in descriptors[key]) || !descriptors[key].enumerable) bad();
  return value as Record<string, unknown>;
}

/** Validate a transfer configuration before any native or worker call; returns the normalized request. */
export function checkTransferConfig(config: unknown): ZephyrTransferRequest {
  const c = plainData(config, () => invalid("CONFIG_TYPE"));
  for (const key of Object.keys(c)) if (!CONFIG_KEYS.includes(key)) invalid("UNKNOWN_FIELD");
  if (!isAssetTypeToken(c.asset)) invalid("ASSET_TYPE");
  const asset = c.asset as string;
  if (V1_ASSETS.includes(asset)) invalid("TX_ASSET");
  if (!V2_ASSETS.includes(asset)) invalid("ASSET_TYPE");
  if (c.destinationAsset !== undefined) {
    if (!isAssetTypeToken(c.destinationAsset)) invalid("ASSET_TYPE");
    if (c.destinationAsset !== asset) throw ZephyrWalletError.unsupported("CONVERSION");
  }
  if (!Array.isArray(c.destinations) || c.destinations.length === 0) invalid("DESTINATIONS");
  const dests = c.destinations as unknown[];
  if (dests.length > MAX_DESTINATIONS) invalid("TOO_MANY_DESTINATIONS");
  const addresses: string[] = [];
  const amounts: string[] = [];
  let sum = BigInt(0);
  for (const d of dests) {
    const f = plainData(d, () => invalid("FIELD_TYPE"));
    for (const key of Object.keys(f)) if (key !== "address" && key !== "amount") invalid("UNKNOWN_FIELD");
    if (typeof f.address !== "string" || !ADDRESS_TEXT.test(f.address)) throw new ZephyrWalletError("INVALID_ADDRESS", "ADDRESS_TYPE");
    if (typeof f.amount !== "bigint") invalid("FIELD_TYPE");
    const amount = f.amount as bigint;
    if (amount === BigInt(0)) invalid("AMOUNT_ZERO");
    if (amount < BigInt(0) || amount > UINT64_MAX) invalid("AMOUNT_RANGE");
    sum += amount;
    if (sum > UINT64_MAX) invalid("AMOUNT_RANGE");
    addresses.push(f.address as string);
    amounts.push(amount.toString());
  }
  if (!isAddressIndex(c.accountIndex)) invalid("ADDRESS_INDEX_RANGE");
  const subaddressIndices = c.subaddressIndices === undefined ? [] : checkSubaddressIndices(c.subaddressIndices);
  let priority = 0;
  if (c.priority !== undefined) {
    if (typeof c.priority !== "string" || !Object.prototype.hasOwnProperty.call(PRIORITIES, c.priority)) invalid("TX_PRIORITY");
    priority = PRIORITIES[c.priority as ZephyrTxPriority];
  }
  return Object.freeze({ asset, addresses: Object.freeze(addresses), amounts: Object.freeze(amounts), accountIndex: c.accountIndex as number,
    subaddressIndices: Object.freeze(subaddressIndices.slice()), priority });
}

/** Validate a request again (worker side, and before a direct native call); returns a copy. */
export function checkTransferRequest(asset: unknown, addresses: unknown, amounts: unknown, accountIndex: unknown, subaddressIndices: unknown, priority: unknown): ZephyrTransferRequest {
  if (!Array.isArray(addresses) || !Array.isArray(amounts) || addresses.length !== amounts.length) invalid("DESTINATIONS");
  const destinations = (addresses as unknown[]).map((a, i) => {
    const amount = (amounts as unknown[])[i];
    if (typeof amount !== "string" || !DECIMAL.test(amount)) invalid("AMOUNT_RANGE");
    return { address: a, amount: BigInt(amount as string) };
  });
  if (typeof priority !== "number" || !Number.isInteger(priority) || priority < 0 || priority > 3) invalid("TX_PRIORITY");
  const names = Object.keys(PRIORITIES) as ZephyrTxPriority[];
  const config: Record<string, unknown> = { asset, destinations, accountIndex, priority: names[priority as number] };
  if (subaddressIndices !== undefined && !(Array.isArray(subaddressIndices) && subaddressIndices.length === 0)) config.subaddressIndices = subaddressIndices;
  return checkTransferConfig(config);
}

// ------------------------------------------------------------------ results

export function fields(value: unknown, required: readonly string[], optional: readonly string[], bad: Bad): Record<string, unknown> {
  const f = plainData(value, bad);
  for (const k of required) if (!Object.prototype.hasOwnProperty.call(f, k)) bad();
  for (const k of Object.keys(f)) if (!required.includes(k) && !optional.includes(k)) bad();
  return f;
}

export function amountOf(value: unknown, bad: Bad): bigint {
  try { return parseUint64Text(value); } catch (err) { return bad(); }
}

export function countOf(value: unknown, max: number, bad: Bad): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > max) bad();
  return value as number;
}

const TX_KEYS = ["hash", "sourceAsset", "destinationAsset", "amount", "fee", "feeAsset", "totalDebited", "change", "ringSize", "inputs", "outputs", "weight", "unlockTime"];

/** The build's wire shape (the bridge's JSON and the worker DTO): {"txs":[...]}, uint64 values as decimal text. */
function buildFromFields(value: unknown, request: ZephyrTransferRequest, bad: Bad): ZephyrTransferBuild {
  const f = fields(value, ["txs"], [], bad);
  if (!Array.isArray(f.txs) || f.txs.length === 0 || f.txs.length > MAX_BUILT_TXS) bad();
  const list = f.txs as unknown[];
  const single = list.length === 1;
  const wanted = request.amounts.reduce((n, a) => n + BigInt(a), BigInt(0));
  let sent = BigInt(0);
  const seen = new Set<string>();
  const txs = list.map((v) => {
    const t = fields(v, TX_KEYS, single ? ["destinations"] : [], bad);
    if (typeof t.hash !== "string" || !TX_HASH.test(t.hash) || seen.has(t.hash)) bad();
    seen.add(t.hash as string);
    if (t.sourceAsset !== request.asset || t.destinationAsset !== request.asset || t.feeAsset !== request.asset) bad();
    const amount = amountOf(t.amount, bad), fee = amountOf(t.fee, bad), totalDebited = amountOf(t.totalDebited, bad);
    if (totalDebited !== amount + fee || amount === BigInt(0)) bad();
    sent += amount;
    const weight = amountOf(t.weight, bad);
    if (weight === BigInt(0) || weight > BigInt(Number.MAX_SAFE_INTEGER)) bad();
    const tx: Record<string, unknown> = { hash: t.hash, sourceAsset: request.asset, destinationAsset: request.asset };
    if (single) {
      if (!Array.isArray(t.destinations) || t.destinations.length !== request.addresses.length) bad();
      tx.destinations = Object.freeze((t.destinations as unknown[]).map((d, i) => {
        const df = fields(d, ["address", "amount"], [], bad);
        if (df.address !== request.addresses[i] || df.amount !== request.amounts[i]) bad();
        return Object.freeze({ address: request.addresses[i], amount: BigInt(request.amounts[i]) });
      }));
    }
    Object.assign(tx, { amount, fee, feeAsset: request.asset, totalDebited, change: amountOf(t.change, bad), ringSize: countOf(t.ringSize, 1024, bad),
      inputs: countOf(t.inputs, 65536, bad), outputs: countOf(t.outputs, 16, bad), weight: Number(weight), unlockTime: amountOf(t.unlockTime, bad) });
    if (single && (tx.outputs as number) < request.addresses.length) bad();
    return Object.freeze(tx as unknown as ZephyrBuiltTx);
  });
  if (sent !== wanted) bad();
  return Object.freeze({ txs: Object.freeze(txs), multipleTxs: txs.length > 1 });
}

const unexpected: Bad = () => { throw new ZephyrWalletError("NATIVE_ERROR", "UNEXPECTED_RESULT"); };
const malformed: Bad = () => { throw new ZephyrWalletError("MALFORMED_MESSAGE", "MESSAGE_SHAPE"); };

/** Bridge {"txs":[...]} of build_txs for a request; every field is checked against the request. */
export function parseBridgeBuild(json: unknown, request: ZephyrTransferRequest): ZephyrTransferBuild {
  if (typeof json !== "string" || json.charAt(0) !== "{") unexpected();
  let parsed: unknown;
  try { parsed = JSON.parse(json as string); } catch (err) { unexpected(); }
  return buildFromFields(parsed, request, unexpected);
}

/** Worker DTO of a build: the bridge's wire shape. */
export function toBuildDto(build: ZephyrTransferBuild): unknown {
  return {
    txs: build.txs.map((t) => {
      const o: Record<string, unknown> = { hash: t.hash, sourceAsset: t.sourceAsset, destinationAsset: t.destinationAsset, amount: t.amount.toString(), fee: t.fee.toString(),
        feeAsset: t.feeAsset, totalDebited: t.totalDebited.toString(), change: t.change.toString(), ringSize: t.ringSize, inputs: t.inputs, outputs: t.outputs,
        weight: String(t.weight), unlockTime: t.unlockTime.toString() };
      if (t.destinations !== undefined) o.destinations = t.destinations.map((d) => ({ address: d.address, amount: d.amount.toString() }));
      return o;
    })
  };
}

/** Strict worker reply of buildTransfer. */
export function fromBuildDto(value: unknown, request: ZephyrTransferRequest): ZephyrTransferBuild {
  return buildFromFields(value, request, malformed);
}
