/**
 * Parsers and worker data shapes of common/ZephyrReserve.ts (the reserve info and the circulating supply of a full
 * wallet). Internal: the package entry does not export this module, and no declaration the entry reaches refers to it.
 */
import ZephyrWalletError from "./ZephyrWalletError";
import type { ZephyrReserveInfo } from "./ZephyrReserve";

/** The uint128 fields of the reserve info, as the bridge's result lists them. */
const AMOUNT_FIELDS = ["zephReserve", "numStables", "numReserves", "assets", "assetsMa", "liabilities", "equity", "equityMa", "zyieldCirc", "zyieldRsv"] as const;
const RATIO_FIELDS = ["reserveRatio", "reserveRatioMa"] as const;
const RESERVE_FIELDS: readonly string[] = [...AMOUNT_FIELDS, ...RATIO_FIELDS, "hfVersion"];

const UINT128_MAX = (BigInt(1) << BigInt(128)) - BigInt(1);
const DECIMAL = /^(0|[1-9][0-9]{0,38})$/;
const SUPPLY_LABEL = /^[A-Z][A-Z0-9]{0,15}$/;
/** the bridge's ratio text: printf "%.17g" of a finite, non-negative double */
const BRIDGE_RATIO = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?(e[+-][0-9]+)?$/;
/** a ratio as the SDK presents it: plain decimal text without exponent, sign or trailing zeros */
const PLAIN_RATIO = /^(0|[1-9][0-9]{0,308})(\.[0-9]*[1-9])?$/;
const MAX_SUPPLY_ENTRIES = 64;

/** Worker DTOs: decimal text for every amount, the ratio text, the hard fork version as a number. */
export type ZephyrReserveInfoDto = Readonly<Record<string, string | number>>;
export type ZephyrCirculatingSupplyDto = ReadonlyArray<readonly [string, string]>;

function unexpected(): never {
  throw new ZephyrWalletError("NATIVE_ERROR", "UNEXPECTED_RESULT");
}

function malformed(): never {
  throw new ZephyrWalletError("MALFORMED_MESSAGE", "MESSAGE_SHAPE");
}

function plainObject(value: unknown, fail: () => never): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail();
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) fail();
  if (Object.getOwnPropertySymbols(value).length !== 0 || Object.getOwnPropertyNames(value).length !== Object.keys(value).length) fail();
  return value as Record<string, unknown>;
}

function exactKeys(fields: Record<string, unknown>, names: readonly string[], fail: () => never): void {
  const keys = Object.keys(fields);
  if (keys.length !== names.length) fail();
  for (const name of names) if (!Object.prototype.hasOwnProperty.call(fields, name)) fail();
}

/** Canonical decimal text of an unsigned 128-bit value to bigint (string to bigint; never through a number). */
function uint128Of(text: unknown, fail: () => never): bigint {
  if (typeof text !== "string" || !DECIMAL.test(text)) fail();
  const value = BigInt(text);
  if (value > UINT128_MAX) fail();
  return value;
}

/**
 * The shortest plain decimal text that reads back as exactly this finite, non-negative double: JavaScript's own
 * shortest round-trip digits (Number.prototype.toString), with an exponent written out.
 */
export function plainDecimal(value: number): string {
  const text = String(value === 0 ? 0 : value);
  const m = /^([0-9])(?:\.([0-9]+))?e([+-][0-9]+)$/.exec(text);
  if (m === null) return text;
  const digits = m[1] + (m[2] ?? "");
  const point = 1 + Number(m[3]);
  if (point <= 0) return "0." + "0".repeat(-point) + digits;
  if (point >= digits.length) return digits + "0".repeat(point - digits.length);
  return digits.slice(0, point) + "." + digits.slice(point);
}

/** The bridge's 17-digit ratio text to the SDK's ratio text (the same double). */
function ratioOfBridge(text: unknown): string {
  if (typeof text !== "string" || text.length > 40 || !BRIDGE_RATIO.test(text)) unexpected();
  const value = Number(text);
  if (!Number.isFinite(value) || value < 0) unexpected();
  const out = plainDecimal(value);
  if (!PLAIN_RATIO.test(out) || Number(out) !== value) unexpected();
  return out;
}

/** A ratio text of a worker DTO: exactly the SDK's form of a finite, non-negative double. */
function ratioOfDto(text: unknown): string {
  if (typeof text !== "string" || text.length > 720 || !PLAIN_RATIO.test(text)) malformed();
  const value = Number(text);
  if (!Number.isFinite(value) || plainDecimal(value) !== text) malformed();
  return text;
}

function hfVersionOf(value: unknown, fail: () => never): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 255) fail();
  return value;
}

function reserveInfoOf(fields: Record<string, unknown>, ratio: (text: unknown) => string, fail: () => never): ZephyrReserveInfo {
  exactKeys(fields, RESERVE_FIELDS, fail);
  const amount = (name: typeof AMOUNT_FIELDS[number]): bigint => uint128Of(fields[name], fail);
  return Object.freeze({
    zephReserve: amount("zephReserve"),
    numStables: amount("numStables"),
    numReserves: amount("numReserves"),
    assets: amount("assets"),
    assetsMa: amount("assetsMa"),
    liabilities: amount("liabilities"),
    equity: amount("equity"),
    equityMa: amount("equityMa"),
    reserveRatio: ratio(fields.reserveRatio),
    reserveRatioMa: ratio(fields.reserveRatioMa),
    hfVersion: hfVersionOf(fields.hfVersion, fail),
    zyieldCirc: amount("zyieldCirc"),
    zyieldRsv: amount("zyieldRsv")
  });
}

function parseJsonObject(text: unknown): Record<string, unknown> {
  if (typeof text !== "string" || text.charAt(0) !== "{" || text.length > 65536) unexpected();
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch (err) { unexpected(); }
  return plainObject(parsed, unexpected);
}

/** Bridge JSON of get_reserve_info to the reserve info (NATIVE_ERROR/UNEXPECTED_RESULT otherwise). */
export function parseBridgeReserveInfo(text: unknown): ZephyrReserveInfo {
  return reserveInfoOf(parseJsonObject(text), ratioOfBridge, unexpected);
}

function supplyOf(entries: ReadonlyArray<readonly [unknown, unknown]>, fail: () => never): Readonly<Record<string, bigint>> {
  if (entries.length > MAX_SUPPLY_ENTRIES) fail();
  const out: Record<string, bigint> = {};
  for (const [label, amount] of entries) {
    if (typeof label !== "string" || !SUPPLY_LABEL.test(label) || Object.prototype.hasOwnProperty.call(out, label)) fail();
    out[label] = uint128Of(amount, fail);
  }
  return Object.freeze(out);
}

/** Bridge JSON {"supply":{"<label>":"<decimal>",...}} of get_circulating_supply to the supply by label. */
export function parseBridgeSupply(text: unknown): Readonly<Record<string, bigint>> {
  const fields = parseJsonObject(text);
  exactKeys(fields, ["supply"], unexpected);
  const supply = plainObject(fields.supply, unexpected);
  return supplyOf(Object.keys(supply).map((label) => [label, supply[label]] as const), unexpected);
}

export function toReserveInfoDto(info: ZephyrReserveInfo): ZephyrReserveInfoDto {
  const out: Record<string, string | number> = {};
  for (const name of AMOUNT_FIELDS) out[name] = info[name].toString();
  for (const name of RATIO_FIELDS) out[name] = info[name];
  out.hfVersion = info.hfVersion;
  return out;
}

/** Strict worker DTO to the reserve info. */
export function fromReserveInfoDto(dto: unknown): ZephyrReserveInfo {
  return reserveInfoOf(plainObject(dto, malformed), ratioOfDto, malformed);
}

export function toSupplyDto(supply: Readonly<Record<string, bigint>>): ZephyrCirculatingSupplyDto {
  return Object.keys(supply).map((label) => [label, supply[label].toString()] as const);
}

/** Strict worker DTO to the supply by label (duplicate or malformed labels reject). */
export function fromSupplyDto(dto: unknown): Readonly<Record<string, bigint>> {
  if (!Array.isArray(dto)) malformed();
  for (const pair of dto) if (!Array.isArray(pair) || pair.length !== 2) malformed();
  return supplyOf(dto as ReadonlyArray<readonly [unknown, unknown]>, malformed);
}
