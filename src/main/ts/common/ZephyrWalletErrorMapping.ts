/**
 * Construction and mapping of ZephyrWalletError inside the library: the typed rejections of the
 * supported surface, the fixed identifiers of the native bridge and their mapping, the mapping of
 * any other failure by its call context, and the strict envelope that carries an error across the
 * worker boundary.
 *
 * Internal: the package entry does not export this module, and none of these functions is part of
 * the error class that applications see (common/ZephyrWalletError.ts). No function here reads a
 * native or remote message, a stack, a cause or a field other than the code and the diagnostic.
 */
import ZephyrWalletError, { ZephyrWalletErrorCode, ZephyrWalletErrorDiagnostic } from "./ZephyrWalletError";

/**
 * Fixed identifiers the native bridge can report (src/main/cpp/zephyr_wasm_bridge.cpp, fixed error
 * protocol). This list must equal the identifiers in the bridge source exactly. Each is also an
 * approved diagnostic.
 */
export const BRIDGE_ERROR_IDENTIFIERS = [
  // typed core exceptions, the exact fixed-message tables and the context fallbacks
  "CORE_INVALID_PASSWORD", "CORE_INVALID_MNEMONIC", "CORE_INVALID_KEY", "CORE_INVALID_ADDRESS", "CORE_UNKNOWN_LANGUAGE",
  "CORE_WALLET_DATA", "CORE_LOOKAHEAD", "CORE_CLOSE_FAILED", "CORE_UNCLASSIFIED",
  // owned byte buffers
  "BUFFER_ALLOCATION_FAILED", "NATIVE_BUFFER_FAILED", "BUFFER_FORMAT_FAILED", "BUFFER_TOO_LARGE",
  // the bridge's own argument checks
  "NETWORK_TYPE", "KEYS_ONLY_RESTORE_HEIGHT", "KEYS_ONLY_LOOKAHEAD", "KEYS_ONLY_PASSWORD", "DAEMON_CONNECTION", "CREATE_MODE",
  "SEED_EMPTY", "SEED_LANGUAGE", "SEED_AND_KEYS", "KEYS_MISSING", "REGTEST", "LISTENER", "SAVE_ON_CLOSE",
  // Daemon, sync and balance bindings
  "DAEMON_ADDRESS", "DAEMON_UNREACHABLE", "DAEMON_RESPONSE", "DAEMON_NOT_CONNECTED", "SYNC_FAILED",
  "SYNC_START_HEIGHT", "ASSET_TYPE", "UNEXPECTED_ASSET_TYPE",
  // accounts and subaddresses (and the index checks of the account and asset balance bindings)
  "KEYS_ONLY_ACCOUNTS", "ACCOUNT_NOT_FOUND", "SUBADDRESS_NOT_FOUND", "LISTING_LIMIT", "LABEL_LENGTH", "LABEL_CHARACTERS",
  "SUBADDRESS_INDICES", "ADDRESS_NOT_IN_WALLET", "UNEXPECTED_RESULT",
  // read-only history
  "KEYS_ONLY_HISTORY", "TX_HASH", "HEIGHT_RANGE", "TX_NOT_FOUND",
  // building transactions without relay
  "KEYS_ONLY_TX", "VIEW_ONLY_TX", "MULTISIG", "INTEGRATED_ADDRESS", "TX_ASSET", "TX_PRIORITY", "TOO_MANY_DESTINATIONS", "AMOUNT_ZERO", "AMOUNT_RANGE",
  "ADDRESS_NETWORK", "NOT_ENOUGH_UNLOCKED", "NOT_ENOUGH_MONEY", "NOT_ENOUGH_FOR_FEE", "NOT_ENOUGH_OUTS_TO_MIX", "TX_TOO_LARGE", "TX_BUILD_FAILED",
  // building conversions without relay
  "CONVERSION_PAIR", "CONVERSION_DESTINATIONS", "AMOUNT_PRECISION", "RESERVE_RATIO", "PRICING_RECORD", "CONVERSION_SPLIT", "CONVERSION_AMOUNT",
  // relaying a prepared build
  "RELAY_TOKEN", "RELAY_TOKEN_VOID", "PRICING_RECORD_AGE", "RELAY_HASH_MISMATCH", "RELAY_REQUEST", "RELAY_FAILED", "RELAY_RECORD_FAILED",
  "LOW_RING_SIZE", "DOUBLE_SPEND", "INVALID_INPUT", "INVALID_OUTPUT", "TOO_BIG", "OVERSPEND", "FEE_TOO_LOW", "TOO_FEW_OUTPUTS",
  "TX_EXTRA_TOO_BIG", "SANITY_CHECK_FAILED", "NOT_RELAYED", "REJECTED", "DAEMON_BUSY", "NO_ANSWER", "HTTP_STATUS", "ANSWER_UNREADABLE",
  // the reserve info
  "PRICING_RECORD_UNAVAILABLE",
  // payment proofs and transaction keys
  "KEYS_ONLY_PROOF", "VIEW_ONLY_PROOF", "PROOF_MESSAGE", "TX_FAILED", "TX_KEY_UNAVAILABLE", "ADDRESS_NOT_IN_TX", "TX_NOT_SENT", "PROOF_FAILED"
] as const;

export type ZephyrBridgeErrorIdentifier = typeof BRIDGE_ERROR_IDENTIFIERS[number];

/** Password state the bridge reports after a failed native password change. */
export type ZephyrBridgePasswordState = "unchanged" | "changed" | "unknown";

const BRIDGE_ERROR_RESULT = /^\{"error":"([A-Z_]{1,40})"\}$/;
const BRIDGE_PASSWORD_ERROR_RESULT = /^\{"error":"([A-Z_]{1,40})","passwordState":"(unchanged|changed|unknown)"\}$/;

export function isBridgeErrorIdentifier(value: unknown): value is ZephyrBridgeErrorIdentifier {
  return typeof value === "string" && (BRIDGE_ERROR_IDENTIFIERS as readonly string[]).includes(value);
}

/**
 * Identifier of a fixed bridge error result, or undefined if the value is not an error result
 * (string results never start with '{"error"' otherwise). A value that starts like an error
 * result but is not exactly one with an approved identifier rejects with UNEXPECTED_RESULT.
 */
export function bridgeErrorOf(result: unknown): ZephyrBridgeErrorIdentifier | undefined {
  if (typeof result !== "string" || !result.startsWith("{\"error\"")) return undefined;
  const match = BRIDGE_ERROR_RESULT.exec(result);
  if (match === null || !isBridgeErrorIdentifier(match[1])) throw new ZephyrWalletError("NATIVE_ERROR", "UNEXPECTED_RESULT");
  return match[1];
}

/** Parsed error result of change_wallet_password (identifier and the reported password state). */
export function bridgePasswordErrorOf(result: unknown): { identifier: ZephyrBridgeErrorIdentifier; state: ZephyrBridgePasswordState } {
  const match = typeof result === "string" ? BRIDGE_PASSWORD_ERROR_RESULT.exec(result) : null;
  if (match === null || !isBridgeErrorIdentifier(match[1])) throw new ZephyrWalletError("NATIVE_ERROR", "UNEXPECTED_RESULT");
  return { identifier: match[1], state: match[2] as ZephyrBridgePasswordState };
}

/** The only fields that cross the worker boundary. */
export interface ZephyrWalletErrorEnvelope {
  readonly type: "ZephyrWalletError";
  readonly code: ZephyrWalletErrorCode;
  readonly diagnostic?: ZephyrWalletErrorDiagnostic;
}

/** Context of a native failure, used to choose a stable code. */
export type ZephyrNativeErrorContext = "create" | "restore" | "open" | "changePassword" | "address" | "close" | "daemon" | "sync" | "build" | "relay" | "proof" | "other";

/** Bridge identifiers whose code does not depend on the call context. */
const BRIDGE_UNSUPPORTED: ReadonlySet<string> = new Set(["KEYS_ONLY_RESTORE_HEIGHT", "KEYS_ONLY_LOOKAHEAD", "KEYS_ONLY_PASSWORD", "DAEMON_CONNECTION", "REGTEST", "LISTENER", "SAVE_ON_CLOSE", "KEYS_ONLY_ACCOUNTS", "KEYS_ONLY_HISTORY",
  "KEYS_ONLY_TX", "VIEW_ONLY_TX", "MULTISIG", "INTEGRATED_ADDRESS", "KEYS_ONLY_PROOF", "VIEW_ONLY_PROOF"]);
/** Transaction builds the wallet's funds or the chain cannot satisfy */
const BRIDGE_TX_NOT_POSSIBLE: ReadonlySet<string> = new Set(["NOT_ENOUGH_UNLOCKED", "NOT_ENOUGH_MONEY", "NOT_ENOUGH_FOR_FEE", "NOT_ENOUGH_OUTS_TO_MIX", "TX_TOO_LARGE",
  "RESERVE_RATIO", "PRICING_RECORD", "CONVERSION_SPLIT", "CONVERSION_AMOUNT", "PRICING_RECORD_AGE"]);
/** The daemon answered a relay's submit request and refused the transaction */
const BRIDGE_TX_REJECTED: ReadonlySet<string> = new Set(["LOW_RING_SIZE", "DOUBLE_SPEND", "INVALID_INPUT", "INVALID_OUTPUT", "TOO_BIG", "OVERSPEND", "FEE_TOO_LOW",
  "TOO_FEW_OUTPUTS", "TX_EXTRA_TOO_BIG", "SANITY_CHECK_FAILED", "NOT_RELAYED", "REJECTED"]);
/** A relay's submit request was sent and no usable answer came: the transaction may or may not have reached the network */
const BRIDGE_RELAY_UNKNOWN: ReadonlySet<string> = new Set(["NO_ANSWER", "HTTP_STATUS", "ANSWER_UNREADABLE"]);
const BRIDGE_INVALID_CONFIG: ReadonlySet<string> = new Set(["NETWORK_TYPE", "CREATE_MODE", "SEED_LANGUAGE", "SEED_AND_KEYS", "CORE_UNKNOWN_LANGUAGE", "CORE_LOOKAHEAD"]);
const BRIDGE_INVALID_RECOVERY: ReadonlySet<string> = new Set(["SEED_EMPTY", "KEYS_MISSING"]);
/** Daemon results keep DAEMON_ERROR and argument checks INVALID_CONFIG in every context */
const BRIDGE_DAEMON: ReadonlySet<string> = new Set(["DAEMON_UNREACHABLE", "DAEMON_RESPONSE", "DAEMON_NOT_CONNECTED", "DAEMON_BUSY", "PRICING_RECORD_UNAVAILABLE"]);
const BRIDGE_INVALID_ARGUMENT: ReadonlySet<string> = new Set(["DAEMON_ADDRESS", "SYNC_START_HEIGHT", "ASSET_TYPE", "ACCOUNT_NOT_FOUND", "SUBADDRESS_NOT_FOUND", "LISTING_LIMIT", "LABEL_LENGTH", "LABEL_CHARACTERS", "SUBADDRESS_INDICES", "TX_HASH", "HEIGHT_RANGE", "TX_NOT_FOUND",
  "TX_ASSET", "TX_PRIORITY", "TOO_MANY_DESTINATIONS", "AMOUNT_ZERO", "AMOUNT_RANGE", "CONVERSION_PAIR", "CONVERSION_DESTINATIONS", "AMOUNT_PRECISION", "RELAY_TOKEN", "RELAY_TOKEN_VOID",
  "PROOF_MESSAGE", "TX_FAILED", "TX_KEY_UNAVAILABLE", "ADDRESS_NOT_IN_TX", "TX_NOT_SENT"]);

/** Typed rejection of a capability outside the supported surface; raised before any native call. */
export function unsupported(diagnostic: ZephyrWalletErrorDiagnostic): ZephyrWalletError {
  return new ZephyrWalletError("UNSUPPORTED_CAPABILITY", diagnostic);
}

export function walletClosed(): ZephyrWalletError {
  return new ZephyrWalletError("WALLET_CLOSED");
}

/**
 * Stable code for a fixed bridge identifier in a call context. Identifiers with a fixed meaning
 * (unsupported capability, invalid configuration, wrong password) keep it in every context;
 * the others take the code of the call context, which says what failed without native text.
 */
export function fromBridge(context: ZephyrNativeErrorContext, identifier: ZephyrBridgeErrorIdentifier): ZephyrWalletError {
  if (context === "close") return new ZephyrWalletError("NATIVE_ERROR", "CORE_CLOSE_FAILED");
  if (identifier === "CORE_INVALID_PASSWORD") return new ZephyrWalletError("WRONG_PASSWORD", identifier);
  if (BRIDGE_UNSUPPORTED.has(identifier)) return new ZephyrWalletError("UNSUPPORTED_CAPABILITY", identifier);
  if (BRIDGE_INVALID_CONFIG.has(identifier)) return new ZephyrWalletError("INVALID_CONFIG", identifier);
  if (BRIDGE_INVALID_RECOVERY.has(identifier)) return new ZephyrWalletError("INVALID_RECOVERY_MATERIAL", identifier);
  if (BRIDGE_DAEMON.has(identifier)) return new ZephyrWalletError("DAEMON_ERROR", identifier);
  if (BRIDGE_INVALID_ARGUMENT.has(identifier)) return new ZephyrWalletError("INVALID_CONFIG", identifier);
  if (BRIDGE_TX_NOT_POSSIBLE.has(identifier)) return new ZephyrWalletError("TX_NOT_POSSIBLE", identifier);
  if (BRIDGE_TX_REJECTED.has(identifier)) return new ZephyrWalletError("TX_REJECTED", identifier);
  if (BRIDGE_RELAY_UNKNOWN.has(identifier)) return new ZephyrWalletError("RELAY_UNKNOWN", identifier);
  if (identifier === "ADDRESS_NETWORK") return new ZephyrWalletError("INVALID_ADDRESS", identifier);
  return contextError(context, identifier);
}

/** Stable error for a value a native callback reported as a failure (never throws). */
export function fromBridgeResult(context: ZephyrNativeErrorContext, result: unknown): ZephyrWalletError {
  try {
    const identifier = bridgeErrorOf(result);
    return identifier === undefined ? new ZephyrWalletError("NATIVE_ERROR", "UNEXPECTED_RESULT") : fromBridge(context, identifier);
  } catch (err) {
    return err instanceof ZephyrWalletError ? err : new ZephyrWalletError("NATIVE_ERROR", "UNEXPECTED_RESULT");
  }
}

/** Throw the stable error for a fixed bridge error result; otherwise return the result unchanged. */
export function checkBridgeResult<T>(context: ZephyrNativeErrorContext, result: T): T {
  const identifier = bridgeErrorOf(result);
  if (identifier !== undefined) throw fromBridge(context, identifier);
  return result;
}

function contextError(context: ZephyrNativeErrorContext, diagnostic: ZephyrWalletErrorDiagnostic): ZephyrWalletError {
  switch (context) {
    case "open": return new ZephyrWalletError("INVALID_WALLET_DATA", diagnostic);
    case "restore": return new ZephyrWalletError("INVALID_RECOVERY_MATERIAL", diagnostic);
    case "address": return new ZephyrWalletError("INVALID_ADDRESS", diagnostic);
    case "build": return new ZephyrWalletError(diagnostic === "CORE_INVALID_ADDRESS" ? "INVALID_ADDRESS" : "NATIVE_ERROR", diagnostic);
    case "proof": return new ZephyrWalletError(diagnostic === "CORE_INVALID_ADDRESS" ? "INVALID_ADDRESS" : "NATIVE_ERROR", diagnostic);
    case "close": return new ZephyrWalletError("NATIVE_ERROR", "CORE_CLOSE_FAILED");
    default: return new ZephyrWalletError("NATIVE_ERROR", diagnostic);
  }
}

/**
 * Fixed mapping of any failure that is not already a wallet error: its message, stack, cause
 * and fields are never read. The code depends only on the call context (UNCLASSIFIED_ERROR).
 */
export function fromUnknown(context: ZephyrNativeErrorContext, err: unknown): ZephyrWalletError {
  if (err instanceof ZephyrWalletError) return err;
  return contextError(context, "UNCLASSIFIED_ERROR");
}

/** The envelope of an error: the only fields that cross the worker boundary (code and, if set, diagnostic). */
export function toEnvelope(error: ZephyrWalletError): ZephyrWalletErrorEnvelope {
  return error.diagnostic === undefined ? { type: "ZephyrWalletError", code: error.code } : { type: "ZephyrWalletError", code: error.code, diagnostic: error.diagnostic };
}

/** Whether a received value is exactly a valid envelope (see fromEnvelope). */
export function isEnvelope(value: unknown): value is ZephyrWalletErrorEnvelope {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return false;
  const keys = Object.keys(value);
  if (Object.getOwnPropertySymbols(value).length !== 0 || Object.getOwnPropertyNames(value).length !== keys.length) return false;
  for (const key of keys) if (key !== "type" && key !== "code" && key !== "diagnostic") return false;
  const v = value as Record<string, unknown>;
  if (v.type !== "ZephyrWalletError" || !ZephyrWalletError.isCode(v.code)) return false;
  if (Object.prototype.hasOwnProperty.call(v, "diagnostic") && !ZephyrWalletError.isDiagnostic(v.diagnostic)) return false;
  return true;
}

/**
 * Rebuild an error from a received envelope. The envelope must be a plain object with exactly
 * the fields type and code and, optionally, an approved diagnostic; anything else (extra or
 * non-enumerable fields, an invalid diagnostic, a message, stack or cause) rejects with
 * MALFORMED_MESSAGE. Field values other than code and diagnostic are never read.
 */
export function fromEnvelope(value: unknown): ZephyrWalletError {
  if (!isEnvelope(value)) return new ZephyrWalletError("MALFORMED_MESSAGE", "MESSAGE_SHAPE");
  return new ZephyrWalletError(value.code, value.diagnostic);
}
