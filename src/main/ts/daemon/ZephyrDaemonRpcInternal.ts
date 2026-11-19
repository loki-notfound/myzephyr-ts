/**
 * The request, the JSON reading and the field checks of daemon/ZephyrDaemonRpc.ts. Internal: the package entry
 * does not export this module, and no declaration the entry reaches refers to it.
 *
 * A node's answer is untrusted. Its text is read by a strict JSON reader of its own that keeps every number as
 * its literal text: an integer becomes a bigint from that text and never passes through a JavaScript number, and a
 * value that is used as a number is range-checked as a bigint first. Every field the class returns is checked for
 * type and range; a failed check rejects with DAEMON_ERROR/DAEMON_RESPONSE. No text of an answer, a status or an
 * error reaches an error or a log.
 */
import HttpClient from "../common/HttpClient";
import ZephyrWalletError from "../common/ZephyrWalletError";
import type { ZephyrDaemonRoute } from "../common/ZephyrDaemonAddress";
import type { ZephyrBlockHeader, ZephyrDaemonInfo, ZephyrPricingRecord } from "./ZephyrDaemonRpc";

/** Bound of one request: no answer within it rejects with DAEMON_UNREACHABLE (as the wallet's JSON requests). */
export const REQUEST_TIMEOUT_MS = 30000;
/** Largest answer read; a longer one rejects with DAEMON_RESPONSE. */
export const MAX_ANSWER_LENGTH = 1048576;
const MAX_DEPTH = 32;

/** A JSON value as read from a node's answer: numbers keep their literal text. */
export type JsonValue = null | boolean | string | JsonNumber | JsonValue[] | JsonObject;
export interface JsonNumber { readonly number: string }
export interface JsonObject { readonly fields: ReadonlyMap<string, JsonValue> }

function response(): never {
  throw new ZephyrWalletError("DAEMON_ERROR", "DAEMON_RESPONSE");
}

/**
 * Strict JSON (RFC 8259) to JsonValue: numbers stay text, duplicate keys and nesting deeper than 32 reject. Any
 * failure rejects with DAEMON_ERROR/DAEMON_RESPONSE; the text is never copied into the error.
 */
export function readJson(text: string): JsonValue {
  let i = 0;
  const ws = () => { while (i < text.length && (text[i] === " " || text[i] === "\t" || text[i] === "\n" || text[i] === "\r")) i++; };
  const value = (depth: number): JsonValue => {
    if (depth > MAX_DEPTH) response();
    ws();
    const c = text[i];
    if (c === "{") {
      i++;
      const fields = new Map<string, JsonValue>();
      ws();
      if (text[i] === "}") { i++; return { fields }; }
      for (;;) {
        ws();
        if (text[i] !== "\"") response();
        const key = string();
        if (fields.has(key)) response();
        ws();
        if (text[i] !== ":") response();
        i++;
        fields.set(key, value(depth + 1));
        ws();
        if (text[i] === ",") { i++; continue; }
        if (text[i] === "}") { i++; return { fields }; }
        response();
      }
    }
    if (c === "[") {
      i++;
      const items: JsonValue[] = [];
      ws();
      if (text[i] === "]") { i++; return items; }
      for (;;) {
        items.push(value(depth + 1));
        ws();
        if (text[i] === ",") { i++; continue; }
        if (text[i] === "]") { i++; return items; }
        response();
      }
    }
    if (c === "\"") return string();
    if (text.startsWith("true", i)) { i += 4; return true; }
    if (text.startsWith("false", i)) { i += 5; return false; }
    if (text.startsWith("null", i)) { i += 4; return null; }
    const m = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?/.exec(text.substring(i, i + 400));
    if (m === null || m[0].length === 0 || m[0].length >= 400) response();
    i += m[0].length;
    return { number: m[0] };
  };
  const string = (): string => {
    i++; // opening quote
    let out = "";
    for (;;) {
      if (i >= text.length) response();
      const c = text.charCodeAt(i);
      if (c === 0x22) { i++; return out; }
      if (c < 0x20) response();
      if (c !== 0x5c) { out += text[i]; i++; continue; }
      const e = text[i + 1];
      i += 2;
      if (e === "\"" || e === "\\" || e === "/") out += e;
      else if (e === "b") out += "\b";
      else if (e === "f") out += "\f";
      else if (e === "n") out += "\n";
      else if (e === "r") out += "\r";
      else if (e === "t") out += "\t";
      else if (e === "u" && /^[0-9a-fA-F]{4}$/.test(text.substring(i, i + 4))) { out += String.fromCharCode(parseInt(text.substring(i, i + 4), 16)); i += 4; }
      else response();
    }
  };
  const result = value(0);
  ws();
  if (i !== text.length) response();
  return result;
}

function isObject(value: JsonValue | undefined): value is JsonObject {
  return value !== null && value !== undefined && typeof value === "object" && !Array.isArray(value) && (value as JsonObject).fields instanceof Map;
}

function isNumber(value: JsonValue | undefined): value is JsonNumber {
  return value !== null && value !== undefined && typeof value === "object" && !Array.isArray(value) && typeof (value as JsonNumber).number === "string";
}

/** The object at a field (DAEMON_RESPONSE when it is missing or not an object). */
export function objectField(object: JsonObject, name: string): JsonObject {
  const value = object.fields.get(name);
  if (!isObject(value)) response();
  return value;
}

const UINT64_MAX = (BigInt(1) << BigInt(64)) - BigInt(1);
const UINT128_MAX = (BigInt(1) << BigInt(128)) - BigInt(1);
const SAFE_MAX = BigInt(Number.MAX_SAFE_INTEGER);

/** An unsigned integer literal (no sign, fraction or exponent) up to max, from its text. */
function uintOf(value: JsonValue | undefined, max: bigint): bigint {
  if (!isNumber(value) || !/^(0|[1-9][0-9]{0,38})$/.test(value.number)) response();
  const out = BigInt(value.number);
  if (out > max) response();
  return out;
}

/** Field readers: each returns undefined for a missing field when optional, and rejects a wrong type or range. */
export class Fields {
  constructor(private readonly object: JsonObject, private readonly optional: boolean) {}

  private get(name: string): JsonValue | undefined {
    const value = this.object.fields.get(name);
    if (value === undefined && !this.optional) response();
    return value;
  }

  has(name: string): boolean { return this.object.fields.has(name); }

  uint64(name: string): bigint | undefined {
    const value = this.get(name);
    return value === undefined ? undefined : uintOf(value, UINT64_MAX);
  }

  /** an unsigned integer as a number: at most max, which is at most 2^53 - 1 */
  safe(name: string, max: bigint = SAFE_MAX): number | undefined {
    const value = this.get(name);
    return value === undefined ? undefined : Number(uintOf(value, max));
  }

  boolean(name: string): boolean | undefined {
    const value = this.get(name);
    if (value === undefined) return undefined;
    if (typeof value !== "boolean") response();
    return value;
  }

  /** a string matching pattern; empty text gives undefined when emptyAbsent */
  text(name: string, pattern: RegExp, emptyAbsent = false): string | undefined {
    const value = this.get(name);
    if (value === undefined) return undefined;
    if (typeof value !== "string") response();
    if (emptyAbsent && value === "") return undefined;
    if (!pattern.test(value)) response();
    return value;
  }

  /**
   * A wide difficulty "0x<hex>" (unsigned 128-bit) as bigint. When the 64-bit low part and the high part are also
   * present (difficulty and difficulty_top64, or the cumulative pair), they must agree with it.
   */
  wide(name: string, low: string, top: string): bigint | undefined {
    const value = this.get(name);
    if (value === undefined) return undefined;
    if (typeof value !== "string" || !/^0x[0-9a-f]{1,32}$/.test(value)) response();
    const out = BigInt(value);
    if (out > UINT128_MAX) response();
    const lowValue = this.object.fields.get(low), topValue = this.object.fields.get(top);
    if (lowValue !== undefined && uintOf(lowValue, UINT64_MAX) !== (out & UINT64_MAX)) response();
    if (topValue !== undefined && uintOf(topValue, UINT64_MAX) !== (out >> BigInt(64))) response();
    return out;
  }
}

const HASH = /^[0-9a-f]{64}$/;
const SIGNATURE = /^[0-9a-f]{128}$/;
const VERSION_TEXT = /^[\x20-\x7e]{0,64}$/;
const UINT8_MAX = BigInt(255);
const UINT32_MAX = BigInt(4294967295);

/** Copy the fields that are present into a new object (absent fields stay absent, never zero). */
function present<T extends object>(fields: { [K in keyof T]: T[K] | undefined }): T {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(fields)) if ((fields as Record<string, unknown>)[key] !== undefined) out[key] = (fields as Record<string, unknown>)[key];
  return Object.freeze(out) as T;
}

/** The pricing record of a block header; undefined for the core's empty record (every value 0, a zero signature). */
export function pricingRecordOf(object: JsonObject): ZephyrPricingRecord | undefined {
  const f = new Fields(object, false);
  const record: ZephyrPricingRecord = Object.freeze({
    spot: f.uint64("spot") as bigint,
    movingAverage: f.uint64("moving_average") as bigint,
    stable: f.uint64("stable") as bigint,
    stableMa: f.uint64("stable_ma") as bigint,
    reserve: f.uint64("reserve") as bigint,
    reserveMa: f.uint64("reserve_ma") as bigint,
    reserveRatio: f.uint64("reserve_ratio") as bigint,
    reserveRatioMa: f.uint64("reserve_ratio_ma") as bigint,
    yieldPrice: f.uint64("yield_price") as bigint,
    timestamp: f.uint64("timestamp") as bigint,
    signature: f.text("signature", SIGNATURE) as string
  });
  const zero = BigInt(0);
  const empty = record.spot === zero && record.movingAverage === zero && record.stable === zero && record.stableMa === zero && record.reserve === zero
    && record.reserveMa === zero && record.reserveRatio === zero && record.reserveRatioMa === zero && record.yieldPrice === zero && record.timestamp === zero
    && /^0{128}$/.test(record.signature);
  return empty ? undefined : record;
}

/** A block header of the daemon's block_header answer; every field but powHash and pricingRecord is required. */
export function blockHeaderOf(object: JsonObject): ZephyrBlockHeader {
  const f = new Fields(object, false);
  const value = object.fields.get("pricing_record");
  if (value !== undefined && !isObject(value)) response();
  const record = value as JsonObject | undefined;
  return present<ZephyrBlockHeader>({
    hash: f.text("hash", HASH) as string,
    height: f.safe("height") as number,
    timestamp: f.safe("timestamp") as number,
    size: f.safe("block_size") as number,
    weight: f.safe("block_weight") as number,
    longTermWeight: f.safe("long_term_weight") as number,
    depth: f.safe("depth") as number,
    difficulty: f.wide("wide_difficulty", "difficulty", "difficulty_top64") as bigint,
    cumulativeDifficulty: f.wide("wide_cumulative_difficulty", "cumulative_difficulty", "cumulative_difficulty_top64") as bigint,
    majorVersion: f.safe("major_version", UINT8_MAX) as number,
    minorVersion: f.safe("minor_version", UINT8_MAX) as number,
    nonce: f.safe("nonce", UINT32_MAX) as number,
    minerTxHash: f.text("miner_tx_hash", HASH) as string,
    numTxs: f.safe("num_txes", UINT32_MAX) as number,
    orphanStatus: f.boolean("orphan_status") as boolean,
    prevHash: f.text("prev_hash", HASH) as string,
    reward: f.uint64("reward") as bigint,
    powHash: f.text("pow_hash", HASH, true),
    pricingRecord: record === undefined ? undefined : pricingRecordOf(record)
  });
}

/** The network type of get_info: nettype, or the mainnet, testnet and stagenet flags (0, 1, 2 as the wallet's). */
function networkTypeOf(f: Fields): 0 | 1 | 2 | undefined {
  const nettype = f.text("nettype", /^(mainnet|testnet|stagenet)$/);
  const flags = (["mainnet", "testnet", "stagenet"] as const).filter((name) => f.boolean(name) === true);
  if (flags.length > 1) response();
  const fromFlags = flags.length === 1 ? (["mainnet", "testnet", "stagenet"] as const).indexOf(flags[0]) as 0 | 1 | 2 : undefined;
  const fromName = nettype === undefined ? undefined : (["mainnet", "testnet", "stagenet"] as const).indexOf(nettype as "mainnet") as 0 | 1 | 2;
  if (fromName !== undefined && fromFlags !== undefined && fromName !== fromFlags) response();
  return fromName !== undefined ? fromName : fromFlags;
}

/** The daemon's get_info result; a field the answer does not carry stays absent. */
export function daemonInfoOf(object: JsonObject): ZephyrDaemonInfo {
  const f = new Fields(object, true);
  return present<ZephyrDaemonInfo>({
    version: f.text("version", VERSION_TEXT),
    height: f.safe("height"),
    targetHeight: f.safe("target_height"),
    topBlockHash: f.text("top_block_hash", HASH, true),
    networkType: networkTypeOf(f),
    isSynchronized: f.boolean("synchronized"),
    isBusySyncing: f.boolean("busy_syncing"),
    isOffline: f.boolean("offline"),
    isRestricted: f.boolean("restricted"),
    updateAvailable: f.boolean("update_available"),
    adjustedTimestamp: f.safe("adjusted_time"),
    target: f.safe("target"),
    difficulty: f.wide("wide_difficulty", "difficulty", "difficulty_top64"),
    cumulativeDifficulty: f.wide("wide_cumulative_difficulty", "cumulative_difficulty", "cumulative_difficulty_top64"),
    numTxs: f.safe("tx_count"),
    numTxsPool: f.safe("tx_pool_size"),
    numAltBlocks: f.safe("alt_blocks_count"),
    blockSizeLimit: f.safe("block_size_limit"),
    blockSizeMedian: f.safe("block_size_median"),
    blockWeightLimit: f.safe("block_weight_limit"),
    blockWeightMedian: f.safe("block_weight_median")
  });
}

/** JSON-RPC methods ZephyrDaemonRpc sends: the only requests it makes (POST <route>/json_rpc). */
export const DAEMON_RPC_METHODS = ["get_info", "get_block_count", "get_last_block_header", "get_block_header_by_height", "get_block_header_by_hash"] as const;
export type ZephyrDaemonRpcMethod = typeof DAEMON_RPC_METHODS[number];

/**
 * One JSON-RPC request through the library's transport (HttpClient: the request allowlist, no credentials, no proxy
 * from the environment, no redirects). The route is allowed for this context only while the request runs. Resolves
 * with the result object of an answer with status OK; everything else rejects with DAEMON_ERROR and a fixed
 * diagnostic: DAEMON_UNREACHABLE (no answer within REQUEST_TIMEOUT_MS), DAEMON_BUSY (status BUSY) or
 * DAEMON_RESPONSE (any other answer: an HTTP status other than 200, a redirect, a body that is not a JSON-RPC
 * answer, an error member, another status).
 */
export async function requestResult(route: ZephyrDaemonRoute, method: ZephyrDaemonRpcMethod, params?: Readonly<Record<string, string | number>>): Promise<JsonObject> {
  const body = JSON.stringify(params === undefined ? { jsonrpc: "2.0", id: "0", method } : { jsonrpc: "2.0", id: "0", method, params });
  const cancellation = HttpClient.createCancelToken();
  let timer: ReturnType<typeof setTimeout> | undefined = undefined;
  let answer: { statusCode?: unknown; body?: unknown };
  HttpClient.addDaemonRoute(route);
  try {
    const request = HttpClient.request({ method: "POST", uri: route.origin + route.basePath + "/json_rpc", body, cancelToken: cancellation.token, resolveWithFullResponse: true });
    const timeout = new Promise<never>((resolve, reject) => {
      timer = setTimeout(() => { cancellation.cancel(); reject(new ZephyrWalletError("DAEMON_ERROR", "DAEMON_UNREACHABLE")); }, REQUEST_TIMEOUT_MS);
    });
    answer = await Promise.race([request, timeout]) as { statusCode?: unknown; body?: unknown };
  } catch (err) {
    // the transport's own refusals are fixed wallet errors; no text of any other failure is read
    if (err instanceof ZephyrWalletError) throw err;
    throw new ZephyrWalletError("DAEMON_ERROR", "DAEMON_UNREACHABLE");
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    HttpClient.removeDaemonRoute(route);
  }
  if (answer === null || typeof answer !== "object" || answer.statusCode !== 200 || typeof answer.body !== "string" || answer.body.length > MAX_ANSWER_LENGTH) response();
  const root = readJson(answer.body);
  if (!isObject(root) || root.fields.has("error")) response();
  const result = objectField(root, "result");
  const status = result.fields.get("status");
  if (status === "BUSY") throw new ZephyrWalletError("DAEMON_ERROR", "DAEMON_BUSY");
  if (status !== "OK") response();
  return result;
}
