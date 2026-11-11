import ZephyrWalletError, { ZephyrWalletErrorDiagnostic } from "../../common/ZephyrWalletError";
import { isLookahead, isNetworkTypeNumber, isRestoreHeight, isWithinLookaheadLimit } from "../../common/ZephyrLifecycleContract";

/**
 * Explicit wallet-config contract between the TypeScript layer and the fixed Zephyr core.
 *
 * The core's monero_wallet_config::deserialize silently ignores unknown JSON keys, and an
 * empty mnemonic with no keys selects random-wallet creation. Therefore configs are
 * validated before any native call, and only an allowlist of core keys is serialized:
 * seed maps to mnemonic, recovery input never falls back to random creation, and
 * unsupported options are rejected instead of being sent and ignored.
 *
 * Not supported here: a daemon connection (the facade sets it after construction), file system,
 * connection manager, regtest or multisig. Every daemon is trusted by the core, so an explicit
 * isTrustedDaemon false is rejected as unsupported.
 *
 * Numeric domains: restoreHeight is an exact non-negative safe integer (core
 * uint64_t, serialized as exact JSON decimal digits); accountLookahead/subaddressLookahead are
 * integers 1..2^32-1 (wallet2 takes size_t, 32 bits in WASM, and rejects zero). Values outside
 * these domains are rejected here, before any native call, never wrapped or truncated.
 *
 * Lookahead resource policy: a supplied pair must also satisfy each value <= 20,000 and
 * accountLookahead x subaddressLookahead <= 20,000 (LOOKAHEAD_ENTRY_LIMIT); otherwise creation and
 * restore reject with INVALID_CONFIG/LOOKAHEAD_LIMIT before dispatch. The ABI and type checks run
 * first, so their LOOKAHEAD_RANGE and LOOKAHEAD_PAIR errors are unchanged, and keys-only wallets
 * still reject any lookahead as KEYS_ONLY_LOOKAHEAD. Unset lookahead keeps the core default 50 x 200.
 *
 * Opening wallet bytes is not creation: an open config accepts no lookahead field. A full wallet
 * opened from keys bytes without cache rebuilds its subaddress table from the lookahead pair stored
 * inside the encrypted keys file, which the SDK cannot see or bound; keys-only wallet objects
 * (ZephyrWalletKeys) are a separate class that is never opened from bytes. Neither the creation
 * limit nor the provenance of the bytes makes opening arbitrary wallet bytes resource-safe.
 */

/** Recovery intent derived from which recovery fields are present (not from their values). */
export type ZephyrWalletCreateIntent = "random" | "seed" | "keys";

/** Validated and normalized create request. Secret fields are only held, never logged. */
export interface ZephyrValidatedCreateConfig {
  readonly intent: ZephyrWalletCreateIntent;
  readonly networkType: 0 | 1 | 2;
  readonly password: string;
  readonly seed?: string;
  readonly seedOffset?: string;
  readonly primaryAddress?: string;
  readonly privateViewKey?: string;
  readonly privateSpendKey?: string;
  readonly restoreHeight?: number;
  readonly language?: string;
  readonly accountLookahead?: number;
  readonly subaddressLookahead?: number;
}

/** Validated open request for wallet bytes. */
export interface ZephyrValidatedOpenConfig {
  readonly networkType: 0 | 1 | 2;
  readonly password: string;
  readonly keysData: Uint8Array;
  readonly cacheData: Uint8Array;
}

/** JSON object with exactly the keys monero_wallet_config::deserialize reads, for the supported surface. */
export interface ZephyrCoreWalletConfigJson {
  networkType: number;
  password: string;
  path: "";
  mnemonic?: string;
  seedOffset?: string;
  primaryAddress?: string;
  privateViewKey?: string;
  privateSpendKey?: string;
  restoreHeight?: number;
  language?: string;
  accountLookahead?: number;
  subaddressLookahead?: number;
}

const CREATE_FIELDS = new Set(["networkType", "password", "seed", "seedOffset", "primaryAddress", "privateViewKey", "privateSpendKey", "restoreHeight", "language", "accountLookahead", "subaddressLookahead", "proxyToWorker", "path", "server", "isTrustedDaemon", "regtest", "isMultisig", "saveCurrent"]);
const OPEN_FIELDS = new Set(["networkType", "password", "keysData", "cacheData", "proxyToWorker", "path", "server", "isTrustedDaemon", "regtest", "isMultisig", "saveCurrent"]);
const UNSUPPORTED_FIELDS = new Set(["connectionManager", "fs", "cmd", "rejectUnauthorized"]);
const HEX_KEY = /^[0-9a-fA-F]{64}$/;
const SEED_WORD_COUNTS = new Set([12, 13, 24, 25]);

function invalid(diagnostic: ZephyrWalletErrorDiagnostic): ZephyrWalletError {
  return new ZephyrWalletError("INVALID_CONFIG", diagnostic);
}

function invalidRecovery(diagnostic: ZephyrWalletErrorDiagnostic): ZephyrWalletError {
  return new ZephyrWalletError("INVALID_RECOVERY_MATERIAL", diagnostic);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  if (value instanceof Uint8Array || value instanceof Map || value instanceof Set || value instanceof Date) return false;
  return true;
}

/** Own enumerable fields with a defined value (undefined-valued keys are treated as absent). */
function definedEntries(raw: Record<string, unknown>): Map<string, unknown> {
  const out = new Map<string, unknown>();
  for (const key of Object.keys(raw)) {
    if (raw[key] !== undefined) out.set(key, raw[key]);
  }
  return out;
}

export function parseNetworkType(value: unknown): 0 | 1 | 2 {
  if (isNetworkTypeNumber(value)) return value;
  if (value === "mainnet") return 0;
  if (value === "testnet") return 1;
  if (value === "stagenet") return 2;
  throw invalid("NETWORK_TYPE");
}

function optionalString(fields: Map<string, unknown>, key: string): string | undefined {
  const value = fields.get(key);
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw invalid("FIELD_TYPE");
  return value;
}

function optionalRestoreHeight(fields: Map<string, unknown>): number | undefined {
  const value = fields.get("restoreHeight");
  if (value === undefined) return undefined;
  if (!isRestoreHeight(value)) throw invalid("RESTORE_HEIGHT_RANGE");
  return value;
}

function optionalLookahead(fields: Map<string, unknown>, key: string): number | undefined {
  const value = fields.get(key);
  if (value === undefined) return undefined;
  if (!isLookahead(value)) throw invalid("LOOKAHEAD_RANGE");
  return value;
}

/** Shared checks for fields that are known but not supported. */
function checkCommonFields(fields: Map<string, unknown>, allowed: Set<string>): void {
  for (const key of fields.keys()) {
    if (UNSUPPORTED_FIELDS.has(key)) throw ZephyrWalletError.unsupported("CONFIG_FIELD");
    if (!allowed.has(key)) throw invalid("UNKNOWN_FIELD");
  }
  const proxyToWorker = fields.get("proxyToWorker");
  if (proxyToWorker !== undefined && typeof proxyToWorker !== "boolean") throw invalid("FIELD_TYPE");
  const path = fields.get("path");
  if (path !== undefined && path !== "") throw ZephyrWalletError.unsupported("FILE_PATH");
  const server = fields.get("server");
  if (server !== undefined && server !== "") throw ZephyrWalletError.unsupported("DAEMON_CONNECTION");
  const trusted = fields.get("isTrustedDaemon");
  if (trusted === false) throw ZephyrWalletError.unsupported("UNTRUSTED_DAEMON");
  if (trusted !== undefined && trusted !== true) throw invalid("FIELD_TYPE");
  for (const [flag, diagnostic] of [["regtest", "REGTEST"], ["isMultisig", "MULTISIG"], ["saveCurrent", "SAVE_CURRENT"]] as const) {
    const value = fields.get(flag);
    if (value === true) throw ZephyrWalletError.unsupported(diagnostic);
    if (value !== undefined && value !== false) throw invalid("FIELD_TYPE");
  }
}

function normalizeSeed(seed: string): string {
  const words = seed.trim().split(/\s+/).filter((w) => w.length > 0);
  if (words.length === 0) throw invalidRecovery("SEED_EMPTY");
  if (!SEED_WORD_COUNTS.has(words.length)) throw invalidRecovery("SEED_WORD_COUNT");
  return words.join(" ");
}

/**
 * Validate a raw create config before any native call.
 *
 * @param raw - plain object or ZephyrWalletConfig fields
 * @param keysOnly - true for keys-only wallets, which have no restore height or lookahead
 * @param expectedIntent - when given, the derived intent must match it
 */
export function validateCreateConfig(raw: unknown, keysOnly: boolean, expectedIntent?: ZephyrWalletCreateIntent): ZephyrValidatedCreateConfig {
  if (!isPlainObject(raw)) throw invalid("CONFIG_TYPE");
  const fields = definedEntries(raw);
  checkCommonFields(fields, CREATE_FIELDS);
  const networkType = parseNetworkType(fields.get("networkType"));
  const password = optionalString(fields, "password") ?? "";
  const seed = optionalString(fields, "seed");
  const seedOffset = optionalString(fields, "seedOffset");
  const primaryAddress = optionalString(fields, "primaryAddress");
  const privateViewKey = optionalString(fields, "privateViewKey");
  const privateSpendKey = optionalString(fields, "privateSpendKey");
  const language = optionalString(fields, "language");
  const restoreHeight = optionalRestoreHeight(fields);
  const accountLookahead = optionalLookahead(fields, "accountLookahead");
  const subaddressLookahead = optionalLookahead(fields, "subaddressLookahead");

  // intent comes from the presence of recovery fields, so empty recovery input is an error, not a random wallet
  const hasKeys = primaryAddress !== undefined || privateViewKey !== undefined || privateSpendKey !== undefined;
  const intent: ZephyrWalletCreateIntent = seed !== undefined ? "seed" : hasKeys ? "keys" : "random";
  if (expectedIntent !== undefined && intent !== expectedIntent) throw invalid("CREATE_MODE");
  if (seed !== undefined && hasKeys) throw invalid("SEED_AND_KEYS");
  if (seedOffset !== undefined && intent !== "seed") throw invalid("SEED_OFFSET");
  if ((accountLookahead === undefined) !== (subaddressLookahead === undefined)) throw invalid("LOOKAHEAD_PAIR");
  if (keysOnly && restoreHeight !== undefined) throw ZephyrWalletError.unsupported("KEYS_ONLY_RESTORE_HEIGHT");
  if (keysOnly && accountLookahead !== undefined) throw ZephyrWalletError.unsupported("KEYS_ONLY_LOOKAHEAD");
  if (accountLookahead !== undefined && subaddressLookahead !== undefined && !isWithinLookaheadLimit(accountLookahead, subaddressLookahead)) throw invalid("LOOKAHEAD_LIMIT");

  if (intent === "random") {
    // a random wallet's restore height is the core's date-based estimate; an explicit one is rejected
    if (restoreHeight !== undefined) throw invalid("RANDOM_RESTORE_HEIGHT");
    return { intent, networkType, password, language, accountLookahead, subaddressLookahead };
  }
  if (intent === "seed") {
    if (language !== undefined) throw invalid("SEED_LANGUAGE");
    const normalized = normalizeSeed(seed as string);
    return { intent, networkType, password, seed: normalized, seedOffset: seedOffset === "" ? undefined : seedOffset, restoreHeight, accountLookahead, subaddressLookahead };
  }
  // keys
  for (const [name, value] of [["primaryAddress", primaryAddress], ["privateViewKey", privateViewKey], ["privateSpendKey", privateSpendKey]] as const) {
    void name;
    if (value !== undefined && value.trim() === "") throw invalidRecovery("KEY_EMPTY");
  }
  if (privateViewKey !== undefined && !HEX_KEY.test(privateViewKey)) throw invalidRecovery("KEY_FORMAT");
  if (privateSpendKey !== undefined && !HEX_KEY.test(privateSpendKey)) throw invalidRecovery("KEY_FORMAT");
  if (privateViewKey !== undefined && primaryAddress === undefined) throw invalidRecovery("VIEW_KEY_WITHOUT_ADDRESS");
  if (primaryAddress === undefined && privateSpendKey === undefined) throw invalidRecovery("KEYS_MISSING");
  return { intent, networkType, password, primaryAddress, privateViewKey, privateSpendKey, restoreHeight, language, accountLookahead, subaddressLookahead };
}

/** Validate a raw open-from-bytes config before any native call. */
export function validateOpenConfig(raw: unknown): ZephyrValidatedOpenConfig {
  if (!isPlainObject(raw)) throw invalid("CONFIG_TYPE");
  const fields = definedEntries(raw);
  checkCommonFields(fields, OPEN_FIELDS);
  const networkType = parseNetworkType(fields.get("networkType"));
  const password = optionalString(fields, "password") ?? "";
  const keysData = fields.get("keysData");
  const cacheData = fields.get("cacheData");
  if (!(keysData instanceof Uint8Array) || keysData.length === 0) throw new ZephyrWalletError("INVALID_WALLET_DATA", "WALLET_BYTES");
  if (cacheData !== undefined && !(cacheData instanceof Uint8Array)) throw new ZephyrWalletError("INVALID_WALLET_DATA", "WALLET_BYTES");
  return { networkType, password, keysData, cacheData: cacheData instanceof Uint8Array ? cacheData : new Uint8Array(0) };
}

/**
 * Serialize a validated create config to the exact core keys. Seed maps to mnemonic. A seed
 * intent always carries a non-empty mnemonic, so the core cannot take its random branch.
 */
export function toCoreConfigJson(config: ZephyrValidatedCreateConfig, keysOnly: boolean): ZephyrCoreWalletConfigJson {
  const json: ZephyrCoreWalletConfigJson = { networkType: config.networkType, password: config.password, path: "" };
  if (config.intent === "seed") {
    if (config.seed === undefined || config.seed.length === 0) throw invalidRecovery("SEED_EMPTY");
    json.mnemonic = config.seed;
    if (config.seedOffset !== undefined) json.seedOffset = config.seedOffset;
  } else if (config.intent === "keys") {
    if (config.primaryAddress !== undefined) json.primaryAddress = config.primaryAddress;
    if (config.privateViewKey !== undefined) json.privateViewKey = config.privateViewKey;
    if (config.privateSpendKey !== undefined) json.privateSpendKey = config.privateSpendKey;
  }
  if (config.language !== undefined) json.language = config.language;
  if (!keysOnly) {
    if (config.restoreHeight !== undefined) json.restoreHeight = config.restoreHeight;
    if (config.accountLookahead !== undefined && config.subaddressLookahead !== undefined) {
      json.accountLookahead = config.accountLookahead;
      json.subaddressLookahead = config.subaddressLookahead;
    }
  }
  return json;
}

/** Field values of a ZephyrWalletConfig-like object as a plain object for validation. */
export function configFields(config: unknown): unknown {
  if (!isPlainObject(config)) return config;
  return Object.assign({}, config);
}
