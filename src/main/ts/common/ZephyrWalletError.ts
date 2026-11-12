/**
 * Stable, secret-free errors of the SDK (ZephyrWalletError).
 *
 * The contract is a provisional string code with a fixed message per code and, optionally,
 * one identifier from the approved diagnostic list below. Native exception text, request
 * text (worker function names, URLs, config values), stacks and causes are never carried:
 * they can contain recovery material, passwords, keys or credentials. Only the code and the
 * diagnostic cross the worker boundary; a received envelope is validated strictly and rebuilt.
 *
 * The native bridge reports failures only as fixed identifiers
 * ({"error":"<IDENTIFIER>"}, see BRIDGE_ERROR_IDENTIFIERS); no native text reaches JavaScript.
 * Any other failure (an inherited TypeScript error, an embind conversion error) is mapped by
 * its context to a fixed code without reading its message.
 */
export type ZephyrWalletErrorCode =
  | "UNSUPPORTED_CAPABILITY"
  | "INVALID_CONFIG"
  | "INVALID_RECOVERY_MATERIAL"
  | "WRONG_PASSWORD"
  | "INVALID_WALLET_DATA"
  | "INVALID_ADDRESS"
  | "WALLET_CLOSED"
  | "MALFORMED_MESSAGE"
  | "NATIVE_ERROR"
  | "DAEMON_ERROR";

export const ZEPHYR_WALLET_ERROR_CODES: readonly ZephyrWalletErrorCode[] = [
  "UNSUPPORTED_CAPABILITY",
  "INVALID_CONFIG",
  "INVALID_RECOVERY_MATERIAL",
  "WRONG_PASSWORD",
  "INVALID_WALLET_DATA",
  "INVALID_ADDRESS",
  "WALLET_CLOSED",
  "MALFORMED_MESSAGE",
  "NATIVE_ERROR",
  "DAEMON_ERROR"
];

/** Fixed message per code; no message text is ever taken from a native or remote source. */
export const ZEPHYR_WALLET_ERROR_MESSAGES: Readonly<Record<ZephyrWalletErrorCode, string>> = {
  UNSUPPORTED_CAPABILITY: "Unsupported capability",
  INVALID_CONFIG: "Invalid wallet configuration or argument",
  INVALID_RECOVERY_MATERIAL: "Recovery material was rejected",
  WRONG_PASSWORD: "Wrong wallet password",
  INVALID_WALLET_DATA: "Wallet data could not be opened",
  INVALID_ADDRESS: "Invalid address",
  WALLET_CLOSED: "Wallet is closed",
  MALFORMED_MESSAGE: "Malformed worker message",
  NATIVE_ERROR: "Native wallet operation failed",
  DAEMON_ERROR: "Daemon request failed"
};

/**
 * Approved diagnostic identifiers. Each is a fixed token chosen by SDK code; none is derived
 * from caller input or copied from native exception text (native text is only classified).
 */
export const ZEPHYR_WALLET_ERROR_DIAGNOSTICS = [
  // unsupported capabilities
  "FILE_PATH", "DAEMON_CONNECTION", "UNTRUSTED_DAEMON", "REGTEST", "MULTISIG", "SAVE_CURRENT", "CONFIG_FIELD",
  "KEYS_ONLY_RESTORE_HEIGHT", "KEYS_ONLY_LOOKAHEAD", "KEYS_ONLY_DATA", "KEYS_ONLY_PASSWORD", "KEYS_ONLY_NETWORK_TYPE",
  "NETWORK_REQUEST", "WORKER_FUNCTION", "NATIVE_EXPORT", "LISTENER", "SAVE_ON_CLOSE",
  "BALANCE", "SYNC", "TRANSACTIONS", "DAEMON_SETTINGS", "LISTENERS", "RESERVE_PROOF",
  // configuration and argument domains
  "UNKNOWN_FIELD", "FIELD_TYPE", "NETWORK_TYPE", "CREATE_MODE", "SEED_AND_KEYS", "SEED_OFFSET", "SEED_LANGUAGE",
  "RANDOM_RESTORE_HEIGHT", "RESTORE_HEIGHT_RANGE", "LOOKAHEAD_PAIR", "LOOKAHEAD_RANGE", "ADDRESS_INDEX_RANGE",
  "LOG_LEVEL_RANGE", "PASSWORD_TYPE", "CONFIG_TYPE",
  // provisional creation/restore resource policy: lookahead values or their product above 20,000
  "LOOKAHEAD_LIMIT",
  // recovery material and wallet data (TypeScript checks)
  "SEED_EMPTY", "SEED_WORD_COUNT", "KEY_EMPTY", "KEY_FORMAT", "VIEW_KEY_WITHOUT_ADDRESS", "KEYS_MISSING",
  "WALLET_BYTES", "ADDRESS_TYPE",
  // classified core results
  "CORE_INVALID_PASSWORD", "CORE_INVALID_MNEMONIC", "CORE_INVALID_KEY", "CORE_INVALID_ADDRESS",
  "CORE_UNKNOWN_LANGUAGE", "CORE_WALLET_DATA", "CORE_LOOKAHEAD", "CORE_CLOSE_FAILED", "CORE_UNCLASSIFIED",
  // bridge results
  "BUFFER_ALLOCATION_FAILED", "NATIVE_BUFFER_FAILED", "BUFFER_FORMAT_FAILED", "BUFFER_TOO_LARGE", "BUFFER_EMPTY",
  "BUFFER_COPY_FAILED", "BUFFER_RESULT", "RESTORE_HEIGHT_UNREPRESENTABLE", "UNEXPECTED_RESULT",
  // password state after a failed native change; PASSWORD_STATE_UNKNOWN also
  // rejects every ordinary operation of a wallet whose native password state became unknown
  "PASSWORD_CHANGED_WITH_ERROR", "PASSWORD_STATE_UNKNOWN",
  // fixed fallback for a failure that is neither a wallet error nor a bridge result
  "UNCLASSIFIED_ERROR",
  // worker messages
  "MESSAGE_SHAPE", "ARGUMENT_COUNT", "ARGUMENT_TYPE", "WALLET_ID", "DUPLICATE_WALLET_ID", "WALLET_KIND",
  // dedicated wallet workers, both with NATIVE_ERROR: caller cancellation of a construction
  // through its AbortSignal (or context shutdown during it), and a worker that could not be started,
  // reported an uncaught error or exited without being terminated by the SDK
  "CONSTRUCTION_ABORTED", "WORKER_FAILED",
  // read-only daemon access. Address validation (INVALID_CONFIG/DAEMON_ADDRESS), unsupported
  // connection settings (UNSUPPORTED_CAPABILITY/DAEMON_CREDENTIALS, DAEMON_PROXY, UNTRUSTED_DAEMON above),
  // keys-only wallets (UNSUPPORTED_CAPABILITY/KEYS_ONLY_DAEMON), DAEMON_ERROR results: no HTTP answer
  // (unreachable, refused, timed out, blocked by CORS or by the SDK's request allowlist), an answer the
  // core could not use (status, body or node error), no daemon configured or connected; and
  // NATIVE_ERROR/SYNC_FAILED for another sync failure. Balance arguments: INVALID_CONFIG/ASSET_TYPE,
  // SYNC_START_HEIGHT; NATIVE_ERROR/UNEXPECTED_ASSET_TYPE for a core map key outside the core's asset types.
  "DAEMON_ADDRESS", "DAEMON_CREDENTIALS", "DAEMON_PROXY", "KEYS_ONLY_DAEMON",
  "DAEMON_UNREACHABLE", "DAEMON_RESPONSE", "DAEMON_NOT_CONNECTED", "SYNC_FAILED",
  "ASSET_TYPE", "SYNC_START_HEIGHT", "UNEXPECTED_ASSET_TYPE",
  // the separately shipped WebAssembly module, all with NATIVE_ERROR: the file could not be read or
  // fetched; the bytes did not compile or instantiate in this runtime (compilation refused, e.g. by
  // a Content-Security-Policy without 'wasm-unsafe-eval', or a module the glue cannot use); the
  // bytes are not the zephyr.wasm whose SHA-256 the build embedded; the runtime offers no Web Crypto
  // digest (a browser page outside a secure context), so the bytes cannot be checked
  "WASM_MODULE_UNAVAILABLE", "WASM_MODULE_REJECTED", "WASM_MODULE_MISMATCH", "WASM_MODULE_UNVERIFIED",
  // forced stop of one proxied wallet: every pending and later call of a terminated wallet rejects
  // with WALLET_CLOSED/WALLET_TERMINATED; in direct mode terminate rejects with
  // UNSUPPORTED_CAPABILITY/TERMINATE (a call running in the caller's own context cannot be interrupted)
  "WALLET_TERMINATED", "TERMINATE",
  // accounts and subaddresses of full wallets: keys-only wallets reject with
  // UNSUPPORTED_CAPABILITY/KEYS_ONLY_ACCOUNTS; an account or subaddress index the wallet does not have
  // (also for the balance calls with an account or subaddress index), a label that is not a string, is
  // longer than 255 UTF-8 bytes or has a control character or an unpaired surrogate, malformed explicit
  // subaddress indices and a listing above the per-call bounds reject with INVALID_CONFIG; a foreign
  // address with INVALID_ADDRESS/ADDRESS_NOT_IN_WALLET (a malformed one: CORE_INVALID_ADDRESS)
  "KEYS_ONLY_ACCOUNTS", "ACCOUNT_NOT_FOUND", "SUBADDRESS_NOT_FOUND", "LABEL_TYPE", "LABEL_LENGTH", "LABEL_CHARACTERS",
  "SUBADDRESS_INDICES", "LISTING_LIMIT", "ADDRESS_NOT_IN_WALLET",
  // read-only history of full wallets: keys-only wallets reject with UNSUPPORTED_CAPABILITY/KEYS_ONLY_HISTORY;
  // with INVALID_CONFIG a malformed transaction hash, a hash list that is not a non-empty array of distinct
  // hashes, a height range that is not a pair of safe integers from low to high, a subaddress index
  // without an account index, and a hash the wallet's selection does not contain
  "KEYS_ONLY_HISTORY", "TX_HASH", "TX_HASHES", "HEIGHT_RANGE", "QUERY_ACCOUNT_REQUIRED", "TX_NOT_FOUND"
] as const;

export type ZephyrWalletErrorDiagnostic = typeof ZEPHYR_WALLET_ERROR_DIAGNOSTICS[number];

/** Context of a native failure, used to choose a stable code. */
export type ZephyrNativeErrorContext = "create" | "restore" | "open" | "changePassword" | "address" | "close" | "daemon" | "sync" | "other";

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
  "KEYS_ONLY_HISTORY", "TX_HASH", "HEIGHT_RANGE", "TX_NOT_FOUND"
] as const;

export type ZephyrBridgeErrorIdentifier = typeof BRIDGE_ERROR_IDENTIFIERS[number];

/** Password state the bridge reports after a failed native password change. */
export type ZephyrBridgePasswordState = "unchanged" | "changed" | "unknown";

const BRIDGE_ERROR_RESULT = /^\{"error":"([A-Z_]{1,40})"\}$/;
const BRIDGE_PASSWORD_ERROR_RESULT = /^\{"error":"([A-Z_]{1,40})","passwordState":"(unchanged|changed|unknown)"\}$/;

/** Bridge identifiers whose code does not depend on the call context. */
const BRIDGE_UNSUPPORTED: ReadonlySet<string> = new Set(["KEYS_ONLY_RESTORE_HEIGHT", "KEYS_ONLY_LOOKAHEAD", "KEYS_ONLY_PASSWORD", "DAEMON_CONNECTION", "REGTEST", "LISTENER", "SAVE_ON_CLOSE", "KEYS_ONLY_ACCOUNTS", "KEYS_ONLY_HISTORY"]);
const BRIDGE_INVALID_CONFIG: ReadonlySet<string> = new Set(["NETWORK_TYPE", "CREATE_MODE", "SEED_LANGUAGE", "SEED_AND_KEYS", "CORE_UNKNOWN_LANGUAGE", "CORE_LOOKAHEAD"]);
const BRIDGE_INVALID_RECOVERY: ReadonlySet<string> = new Set(["SEED_EMPTY", "KEYS_MISSING"]);
/** Daemon results keep DAEMON_ERROR and argument checks INVALID_CONFIG in every context */
const BRIDGE_DAEMON: ReadonlySet<string> = new Set(["DAEMON_UNREACHABLE", "DAEMON_RESPONSE", "DAEMON_NOT_CONNECTED"]);
const BRIDGE_INVALID_ARGUMENT: ReadonlySet<string> = new Set(["DAEMON_ADDRESS", "SYNC_START_HEIGHT", "ASSET_TYPE", "ACCOUNT_NOT_FOUND", "SUBADDRESS_NOT_FOUND", "LISTING_LIMIT", "LABEL_LENGTH", "LABEL_CHARACTERS", "SUBADDRESS_INDICES", "TX_HASH", "HEIGHT_RANGE", "TX_NOT_FOUND"]);

function isDiagnostic(value: unknown): value is ZephyrWalletErrorDiagnostic {
  return typeof value === "string" && (ZEPHYR_WALLET_ERROR_DIAGNOSTICS as readonly string[]).includes(value);
}

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

export default class ZephyrWalletError extends Error {

  readonly code: ZephyrWalletErrorCode;
  readonly diagnostic: ZephyrWalletErrorDiagnostic | undefined;

  constructor(code: ZephyrWalletErrorCode, diagnostic?: ZephyrWalletErrorDiagnostic) {
    const valid = ZephyrWalletError.isCode(code);
    super(ZEPHYR_WALLET_ERROR_MESSAGES[valid ? code : "NATIVE_ERROR"]);
    this.name = "ZephyrWalletError";
    this.code = valid ? code : "NATIVE_ERROR";
    this.diagnostic = valid && isDiagnostic(diagnostic) ? diagnostic : undefined;
  }

  static isCode(value: unknown): value is ZephyrWalletErrorCode {
    return typeof value === "string" && (ZEPHYR_WALLET_ERROR_CODES as readonly string[]).includes(value);
  }

  static isDiagnostic(value: unknown): value is ZephyrWalletErrorDiagnostic {
    return isDiagnostic(value);
  }

  /** Typed rejection of a capability outside the supported surface; raised before any native call. */
  static unsupported(diagnostic: ZephyrWalletErrorDiagnostic): ZephyrWalletError {
    return new ZephyrWalletError("UNSUPPORTED_CAPABILITY", diagnostic);
  }

  static walletClosed(): ZephyrWalletError {
    return new ZephyrWalletError("WALLET_CLOSED");
  }

  /**
   * Stable code for a fixed bridge identifier in a call context. Identifiers with a fixed meaning
   * (unsupported capability, invalid configuration, wrong password) keep it in every context;
   * the others take the code of the call context, which says what failed without native text.
   */
  static fromBridge(context: ZephyrNativeErrorContext, identifier: ZephyrBridgeErrorIdentifier): ZephyrWalletError {
    if (context === "close") return new ZephyrWalletError("NATIVE_ERROR", "CORE_CLOSE_FAILED");
    if (identifier === "CORE_INVALID_PASSWORD") return new ZephyrWalletError("WRONG_PASSWORD", identifier);
    if (BRIDGE_UNSUPPORTED.has(identifier)) return new ZephyrWalletError("UNSUPPORTED_CAPABILITY", identifier);
    if (BRIDGE_INVALID_CONFIG.has(identifier)) return new ZephyrWalletError("INVALID_CONFIG", identifier);
    if (BRIDGE_INVALID_RECOVERY.has(identifier)) return new ZephyrWalletError("INVALID_RECOVERY_MATERIAL", identifier);
    if (BRIDGE_DAEMON.has(identifier)) return new ZephyrWalletError("DAEMON_ERROR", identifier);
    if (BRIDGE_INVALID_ARGUMENT.has(identifier)) return new ZephyrWalletError("INVALID_CONFIG", identifier);
    return ZephyrWalletError.contextError(context, identifier);
  }

  /** Stable error for a value a native callback reported as a failure (never throws). */
  static fromBridgeResult(context: ZephyrNativeErrorContext, result: unknown): ZephyrWalletError {
    try {
      const identifier = bridgeErrorOf(result);
      return identifier === undefined ? new ZephyrWalletError("NATIVE_ERROR", "UNEXPECTED_RESULT") : ZephyrWalletError.fromBridge(context, identifier);
    } catch (err) {
      return err instanceof ZephyrWalletError ? err : new ZephyrWalletError("NATIVE_ERROR", "UNEXPECTED_RESULT");
    }
  }

  /** Throw the stable error for a fixed bridge error result; otherwise return the result unchanged. */
  static checkBridgeResult<T>(context: ZephyrNativeErrorContext, result: T): T {
    const identifier = bridgeErrorOf(result);
    if (identifier !== undefined) throw ZephyrWalletError.fromBridge(context, identifier);
    return result;
  }

  private static contextError(context: ZephyrNativeErrorContext, diagnostic: ZephyrWalletErrorDiagnostic): ZephyrWalletError {
    switch (context) {
      case "open": return new ZephyrWalletError("INVALID_WALLET_DATA", diagnostic);
      case "restore": return new ZephyrWalletError("INVALID_RECOVERY_MATERIAL", diagnostic);
      case "address": return new ZephyrWalletError("INVALID_ADDRESS", diagnostic);
      case "close": return new ZephyrWalletError("NATIVE_ERROR", "CORE_CLOSE_FAILED");
      default: return new ZephyrWalletError("NATIVE_ERROR", diagnostic);
    }
  }

  /**
   * Fixed mapping of any failure that is not already a wallet error: its message, stack, cause
   * and fields are never read. The code depends only on the call context (UNCLASSIFIED_ERROR).
   */
  static fromUnknown(context: ZephyrNativeErrorContext, err: unknown): ZephyrWalletError {
    if (err instanceof ZephyrWalletError) return err;
    return ZephyrWalletError.contextError(context, "UNCLASSIFIED_ERROR");
  }

  toEnvelope(): ZephyrWalletErrorEnvelope {
    return this.diagnostic === undefined ? { type: "ZephyrWalletError", code: this.code } : { type: "ZephyrWalletError", code: this.code, diagnostic: this.diagnostic };
  }

  /** Whether a received value is exactly a valid envelope (see fromEnvelope). */
  static isEnvelope(value: unknown): value is ZephyrWalletErrorEnvelope {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return false;
    const keys = Object.keys(value);
    if (Object.getOwnPropertySymbols(value).length !== 0 || Object.getOwnPropertyNames(value).length !== keys.length) return false;
    for (const key of keys) if (key !== "type" && key !== "code" && key !== "diagnostic") return false;
    const v = value as Record<string, unknown>;
    if (v.type !== "ZephyrWalletError" || !ZephyrWalletError.isCode(v.code)) return false;
    if (Object.prototype.hasOwnProperty.call(v, "diagnostic") && !isDiagnostic(v.diagnostic)) return false;
    return true;
  }

  /**
   * Rebuild an error from a received envelope. The envelope must be a plain object with exactly
   * the fields type and code and, optionally, an approved diagnostic; anything else (extra or
   * non-enumerable fields, an invalid diagnostic, a message, stack or cause) rejects with
   * MALFORMED_MESSAGE. Field values other than code and diagnostic are never read.
   */
  static fromEnvelope(value: unknown): ZephyrWalletError {
    if (!ZephyrWalletError.isEnvelope(value)) return new ZephyrWalletError("MALFORMED_MESSAGE", "MESSAGE_SHAPE");
    return new ZephyrWalletError(value.code, value.diagnostic);
  }
}
