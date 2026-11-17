/**
 * Construction and mapping of ZephyrWalletError inside the library: the typed rejections of the
 * supported surface, the fixed mapping of bridge identifiers and of any other failure by its call
 * context, and the strict envelope that carries an error across the worker boundary.
 *
 * Internal: the package entry does not export this module, and none of these functions is part of
 * the error class that applications see (common/ZephyrWalletError.ts). No function here reads a
 * native or remote message, a stack, a cause or a field other than the code and the diagnostic.
 */
import ZephyrWalletError, { ZephyrBridgeErrorIdentifier, ZephyrWalletErrorDiagnostic, ZephyrWalletErrorEnvelope, bridgeErrorOf } from "./ZephyrWalletError";

/** Context of a native failure, used to choose a stable code. */
export type ZephyrNativeErrorContext = "create" | "restore" | "open" | "changePassword" | "address" | "close" | "daemon" | "sync" | "build" | "relay" | "other";

/** Bridge identifiers whose code does not depend on the call context. */
const BRIDGE_UNSUPPORTED: ReadonlySet<string> = new Set(["KEYS_ONLY_RESTORE_HEIGHT", "KEYS_ONLY_LOOKAHEAD", "KEYS_ONLY_PASSWORD", "DAEMON_CONNECTION", "REGTEST", "LISTENER", "SAVE_ON_CLOSE", "KEYS_ONLY_ACCOUNTS", "KEYS_ONLY_HISTORY",
  "KEYS_ONLY_TX", "VIEW_ONLY_TX", "MULTISIG", "INTEGRATED_ADDRESS"]);
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
const BRIDGE_DAEMON: ReadonlySet<string> = new Set(["DAEMON_UNREACHABLE", "DAEMON_RESPONSE", "DAEMON_NOT_CONNECTED", "DAEMON_BUSY"]);
const BRIDGE_INVALID_ARGUMENT: ReadonlySet<string> = new Set(["DAEMON_ADDRESS", "SYNC_START_HEIGHT", "ASSET_TYPE", "ACCOUNT_NOT_FOUND", "SUBADDRESS_NOT_FOUND", "LISTING_LIMIT", "LABEL_LENGTH", "LABEL_CHARACTERS", "SUBADDRESS_INDICES", "TX_HASH", "HEIGHT_RANGE", "TX_NOT_FOUND",
  "TX_ASSET", "TX_PRIORITY", "TOO_MANY_DESTINATIONS", "AMOUNT_ZERO", "AMOUNT_RANGE", "CONVERSION_PAIR", "CONVERSION_DESTINATIONS", "AMOUNT_PRECISION", "RELAY_TOKEN", "RELAY_TOKEN_VOID"]);

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
