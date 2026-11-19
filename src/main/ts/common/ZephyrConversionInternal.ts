/**
 * Parsers, validators, constants and worker data shapes of common/ZephyrConversion.ts, which holds the public
 * types. Internal: the package entry does not export this module, and no declaration the entry
 * reaches refers to it.
 */
import ZephyrWalletError from "./ZephyrWalletError";
import { checkSubaddressIndices, isAddressIndex } from "./ZephyrLifecycleContract";
import { isAssetTypeToken } from "./ZephyrBalancesInternal";
import { ZephyrTxPriority } from "./ZephyrTransfer";
import { ADDRESS_TEXT, Bad, DECIMAL, PRIORITIES, TX_HASH, UINT64_MAX, V1_ASSETS, V2_ASSETS, amountOf, countOf, fields, plainData } from "./ZephyrTransferInternal";
import type { ZephyrConversionBuild } from "./ZephyrConversion";

/** The six V2 conversions, source to destination. */
export const CONVERSION_PAIRS: ReadonlyArray<readonly [string, string]> = Object.freeze([
  ["ZPH", "ZSD"], ["ZSD", "ZPH"], ["ZPH", "ZRS"], ["ZRS", "ZPH"], ["ZSD", "ZYS"], ["ZYS", "ZSD"]
] as const);
/** Atomic units of the fourth decimal: conversion amounts are multiples of it. */
export const CONVERSION_AMOUNT_STEP = BigInt(100000000);
const CONFIG_KEYS = ["sourceAsset", "destinationAsset", "destination", "accountIndex", "subaddressIndices", "priority"];

/** The validated request the bridge and the worker receive: the amount as exact decimal text. */
export interface ZephyrConversionRequest {
  readonly sourceAsset: string;
  readonly destinationAsset: string;
  readonly address: string;
  readonly amount: string;
  readonly accountIndex: number;
  readonly subaddressIndices: readonly number[];
  readonly priority: number;
}

const invalid = (d: "CONFIG_TYPE" | "UNKNOWN_FIELD" | "FIELD_TYPE" | "ASSET_TYPE" | "TX_ASSET" | "CONVERSION_PAIR" | "CONVERSION_DESTINATIONS" | "AMOUNT_ZERO" | "AMOUNT_RANGE"
  | "AMOUNT_PRECISION" | "ADDRESS_INDEX_RANGE" | "TX_PRIORITY"): never => {
  throw new ZephyrWalletError("INVALID_CONFIG", d);
};

function checkAsset(value: unknown): string {
  if (!isAssetTypeToken(value)) invalid("ASSET_TYPE");
  const asset = value as string;
  if (V1_ASSETS.includes(asset)) invalid("TX_ASSET");
  if (!V2_ASSETS.includes(asset)) invalid("ASSET_TYPE");
  return asset;
}

/** Whether source to destination is one of the six V2 conversions. */
export function isConversionPair(source: unknown, destination: unknown): boolean {
  return CONVERSION_PAIRS.some(([s, d]) => s === source && d === destination);
}

/** Validate a conversion configuration before any native or worker call; returns the normalized request. */
export function checkConversionConfig(config: unknown): ZephyrConversionRequest {
  const c = plainData(config, () => invalid("CONFIG_TYPE"));
  for (const key of Object.keys(c)) if (!CONFIG_KEYS.includes(key)) invalid("UNKNOWN_FIELD");
  const sourceAsset = checkAsset(c.sourceAsset);
  const destinationAsset = checkAsset(c.destinationAsset);
  if (!isConversionPair(sourceAsset, destinationAsset)) invalid("CONVERSION_PAIR");
  if (Array.isArray(c.destination)) invalid("CONVERSION_DESTINATIONS");
  const f = plainData(c.destination, () => invalid("FIELD_TYPE"));
  for (const key of Object.keys(f)) if (key !== "address" && key !== "amount") invalid("UNKNOWN_FIELD");
  if (typeof f.address !== "string" || !ADDRESS_TEXT.test(f.address)) throw new ZephyrWalletError("INVALID_ADDRESS", "ADDRESS_TYPE");
  if (typeof f.amount !== "bigint") invalid("FIELD_TYPE");
  const amount = f.amount as bigint;
  if (amount === BigInt(0)) invalid("AMOUNT_ZERO");
  if (amount < BigInt(0) || amount > UINT64_MAX) invalid("AMOUNT_RANGE");
  if (amount % CONVERSION_AMOUNT_STEP !== BigInt(0)) invalid("AMOUNT_PRECISION");
  if (!isAddressIndex(c.accountIndex)) invalid("ADDRESS_INDEX_RANGE");
  const subaddressIndices = c.subaddressIndices === undefined ? [] : checkSubaddressIndices(c.subaddressIndices);
  let priority = 0;
  if (c.priority !== undefined) {
    if (typeof c.priority !== "string" || !Object.prototype.hasOwnProperty.call(PRIORITIES, c.priority)) invalid("TX_PRIORITY");
    priority = PRIORITIES[c.priority as ZephyrTxPriority];
  }
  return Object.freeze({ sourceAsset, destinationAsset, address: f.address as string, amount: amount.toString(), accountIndex: c.accountIndex as number,
    subaddressIndices: Object.freeze(subaddressIndices.slice()), priority });
}

/** Validate a request again (worker side, and before a direct native call); returns a copy. */
export function checkConversionRequest(sourceAsset: unknown, destinationAsset: unknown, address: unknown, amount: unknown, accountIndex: unknown, subaddressIndices: unknown,
  priority: unknown): ZephyrConversionRequest {
  if (typeof amount !== "string" || !DECIMAL.test(amount)) invalid("AMOUNT_RANGE");
  if (typeof priority !== "number" || !Number.isInteger(priority) || priority < 0 || priority > 3) invalid("TX_PRIORITY");
  const names = Object.keys(PRIORITIES) as ZephyrTxPriority[];
  const config: Record<string, unknown> = { sourceAsset, destinationAsset, destination: { address, amount: BigInt(amount as string) }, accountIndex, priority: names[priority as number] };
  if (subaddressIndices !== undefined && !(Array.isArray(subaddressIndices) && subaddressIndices.length === 0)) config.subaddressIndices = subaddressIndices;
  return checkConversionConfig(config);
}

// ------------------------------------------------------------------ results

const TX_KEYS = ["hash", "sourceAsset", "destinationAsset", "destination", "amountBurnt", "amountMinted", "fee", "feeAsset", "totalDebited", "change", "ringSize", "inputs", "outputs",
  "weight", "unlockTime", "pricingRecordHeight"];

/** The wire shape (the bridge's JSON and the worker DTO): {"tx":{...}}, uint64 values as decimal text. */
export function conversionFromFields(value: unknown, request: ZephyrConversionRequest, bad: Bad): ZephyrConversionBuild {
  const outer = fields(value, ["tx"], [], bad);
  const t = fields(outer.tx, TX_KEYS, [], bad);
  if (typeof t.hash !== "string" || !TX_HASH.test(t.hash)) bad();
  if (t.sourceAsset !== request.sourceAsset || t.destinationAsset !== request.destinationAsset || t.feeAsset !== request.sourceAsset) bad();
  const d = fields(t.destination, ["address", "amount"], [], bad);
  if (d.address !== request.address || d.amount !== request.amount) bad();
  const requested = BigInt(request.amount);
  const amountBurnt = amountOf(t.amountBurnt, bad), amountMinted = amountOf(t.amountMinted, bad), fee = amountOf(t.fee, bad), totalDebited = amountOf(t.totalDebited, bad);
  if (amountBurnt !== requested || amountMinted === BigInt(0) || totalDebited !== amountBurnt + fee) bad();
  const weight = amountOf(t.weight, bad), pricingRecordHeight = amountOf(t.pricingRecordHeight, bad);
  if (weight === BigInt(0) || weight > BigInt(Number.MAX_SAFE_INTEGER)) bad();
  if (pricingRecordHeight === BigInt(0) || pricingRecordHeight > BigInt(Number.MAX_SAFE_INTEGER)) bad();
  const outputs = countOf(t.outputs, 16, bad);
  if (outputs < 2) bad(); // at least the destination output and the change output (the core adds two zero outputs to a conversion)
  return Object.freeze({
    hash: t.hash as string, sourceAsset: request.sourceAsset, destinationAsset: request.destinationAsset,
    destination: Object.freeze({ address: request.address, amount: requested }),
    amountBurnt, amountMinted, fee, feeAsset: request.sourceAsset, totalDebited, change: amountOf(t.change, bad),
    ringSize: countOf(t.ringSize, 1024, bad), inputs: countOf(t.inputs, 65536, bad), outputs, weight: Number(weight), unlockTime: amountOf(t.unlockTime, bad),
    pricingRecordHeight: Number(pricingRecordHeight)
  });
}

const unexpected: Bad = () => { throw new ZephyrWalletError("NATIVE_ERROR", "UNEXPECTED_RESULT"); };
const malformed: Bad = () => { throw new ZephyrWalletError("MALFORMED_MESSAGE", "MESSAGE_SHAPE"); };

/** Bridge {"tx":{...}} of build_conversion for a request; every field is checked against the request. */
export function parseBridgeConversion(json: unknown, request: ZephyrConversionRequest): ZephyrConversionBuild {
  if (typeof json !== "string" || json.charAt(0) !== "{") unexpected();
  let parsed: unknown;
  try { parsed = JSON.parse(json as string); } catch (err) { unexpected(); }
  return conversionFromFields(parsed, request, unexpected);
}

/** Worker DTO of a conversion build: the bridge's wire shape. */
export function toConversionDto(b: ZephyrConversionBuild): unknown {
  return {
    tx: {
      hash: b.hash, sourceAsset: b.sourceAsset, destinationAsset: b.destinationAsset, destination: { address: b.destination.address, amount: b.destination.amount.toString() },
      amountBurnt: b.amountBurnt.toString(), amountMinted: b.amountMinted.toString(), fee: b.fee.toString(), feeAsset: b.feeAsset, totalDebited: b.totalDebited.toString(),
      change: b.change.toString(), ringSize: b.ringSize, inputs: b.inputs, outputs: b.outputs, weight: String(b.weight), unlockTime: b.unlockTime.toString(),
      pricingRecordHeight: String(b.pricingRecordHeight)
    }
  };
}

/** Strict worker reply of buildConversion. */
export function fromConversionDto(value: unknown, request: ZephyrConversionRequest): ZephyrConversionBuild {
  return conversionFromFields(value, request, malformed);
}
