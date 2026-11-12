import ZephyrWalletError from "./ZephyrWalletError";
import { UINT32_MAX } from "./ZephyrLifecycleContract";

/**
 * Balance shapes of the read-only daemon access:
 * - wallet map: ReadonlyMap<asset, bigint> with exactly the core's keys (its zero entries included);
 * - account map: ReadonlyMap<subaddress index, ReadonlyMap<asset, bigint>> with the core's keys only;
 *   a subaddress without an entry in the core's map stays absent;
 * - asset-first scalar: bigint for (asset, account[, subaddress]).
 * Bridge JSON carries decimal strings; the worker boundary carries explicit DTOs (arrays of pairs
 * with decimal strings and numeric subaddress indices). Every value is validated strictly on
 * receipt; nothing absent becomes zero.
 */
export type ZephyrAssetBalances = ReadonlyMap<string, bigint>;
export type ZephyrAccountBalances = ReadonlyMap<number, ZephyrAssetBalances>;

/** Worker DTOs */
export type ZephyrAssetBalancesDto = ReadonlyArray<readonly [string, string]>;
export type ZephyrAccountBalancesDto = ReadonlyArray<readonly [number, ZephyrAssetBalancesDto]>;

const UINT64_MAX = BigInt("18446744073709551615");
const ASSET_TOKEN = /^[A-Z0-9]{1,16}$/;
const DECIMAL = /^(0|[1-9][0-9]{0,19})$/;

function unexpected(): never {
  throw new ZephyrWalletError("NATIVE_ERROR", "UNEXPECTED_RESULT");
}

/** Asset type argument shape (the bridge then requires one of the core's asset types). */
export function isAssetTypeToken(value: unknown): value is string {
  return typeof value === "string" && ASSET_TOKEN.test(value);
}

/** Exact unsigned 64-bit decimal text to bigint. */
export function parseUint64Text(text: unknown): bigint {
  if (typeof text !== "string" || !DECIMAL.test(text)) unexpected();
  const value = BigInt(text);
  if (value > UINT64_MAX) unexpected();
  return value;
}

/** Exact unsigned decimal text to a safe integer (heights and counts). */
export function parseSafeUintText(text: unknown): number {
  const value = parseUint64Text(text);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) unexpected();
  return Number(value);
}

function plainObject(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) unexpected();
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) unexpected();
  return value as Record<string, unknown>;
}

/** Bridge JSON object {"<asset>":"<decimal>",...} to an asset map (NATIVE_ERROR/UNEXPECTED_RESULT otherwise). */
export function parseAssetMapObject(value: unknown): ZephyrAssetBalances {
  return assetMapOf(value);
}

function assetMapOf(value: unknown): Map<string, bigint> {
  const fields = plainObject(value);
  const out = new Map<string, bigint>();
  for (const key of Object.keys(fields)) {
    if (!ASSET_TOKEN.test(key)) unexpected();
    out.set(key, parseUint64Text(fields[key]));
  }
  return out;
}

function parseJson(text: unknown): Record<string, unknown> {
  if (typeof text !== "string" || text.charAt(0) !== "{") unexpected();
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch (err) { unexpected(); }
  const fields = plainObject(parsed);
  const keys = Object.keys(fields);
  if (keys.length !== 1 || keys[0] !== "balances") unexpected();
  return plainObject(fields.balances);
}

/** Bridge JSON {"balances":{"<asset>":"<decimal>"}} to the wallet map. */
export function parseBridgeAssetBalances(text: unknown): ZephyrAssetBalances {
  return assetMapOf(parseJson(text));
}

/** Bridge JSON {"balances":{"<subaddress index>":{"<asset>":"<decimal>"}}} to the account map. */
export function parseBridgeAccountBalances(text: unknown): ZephyrAccountBalances {
  const fields = parseJson(text);
  const out = new Map<number, ZephyrAssetBalances>();
  for (const key of Object.keys(fields)) {
    if (!/^(0|[1-9][0-9]{0,9})$/.test(key) || Number(key) > UINT32_MAX) unexpected();
    out.set(Number(key), assetMapOf(fields[key]));
  }
  return out;
}

export function toAssetBalancesDto(map: ZephyrAssetBalances): ZephyrAssetBalancesDto {
  return Array.from(map.entries()).map(([asset, value]) => [asset, value.toString()] as const);
}

export function toAccountBalancesDto(map: ZephyrAccountBalances): ZephyrAccountBalancesDto {
  return Array.from(map.entries()).map(([index, assets]) => [index, toAssetBalancesDto(assets)] as const);
}

function pairsOf(value: unknown): unknown[][] {
  if (!Array.isArray(value)) throw new ZephyrWalletError("MALFORMED_MESSAGE", "MESSAGE_SHAPE");
  for (const pair of value) if (!Array.isArray(pair) || pair.length !== 2) throw new ZephyrWalletError("MALFORMED_MESSAGE", "MESSAGE_SHAPE");
  return value as unknown[][];
}

/** Strict worker DTO to the wallet map (duplicate or malformed keys reject). */
export function fromAssetBalancesDto(dto: unknown): ZephyrAssetBalances {
  const out = new Map<string, bigint>();
  for (const [asset, value] of pairsOf(dto)) {
    if (typeof asset !== "string" || !ASSET_TOKEN.test(asset) || out.has(asset)) throw new ZephyrWalletError("MALFORMED_MESSAGE", "MESSAGE_SHAPE");
    out.set(asset, parseUint64Text(value));
  }
  return out;
}

/** Strict worker DTO to the account map. */
export function fromAccountBalancesDto(dto: unknown): ZephyrAccountBalances {
  const out = new Map<number, ZephyrAssetBalances>();
  for (const [index, assets] of pairsOf(dto)) {
    if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index > UINT32_MAX || out.has(index)) throw new ZephyrWalletError("MALFORMED_MESSAGE", "MESSAGE_SHAPE");
    out.set(index, fromAssetBalancesDto(assets));
  }
  return out;
}
