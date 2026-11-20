import { ZEPHYR_WALLET_ERROR_CODES, ZEPHYR_WALLET_ERROR_MESSAGES } from "./ZephyrWalletErrorTables";

/**
 * Stable, secret-free errors of the SDK (ZephyrWalletError).
 *
 * The contract is a provisional string code with a fixed message per code and, optionally,
 * one identifier from the approved diagnostic list below. Native exception text, request
 * text (worker function names, URLs, config values), stacks and causes are never carried:
 * they can contain recovery material, passwords, keys or credentials. Only the code and the
 * diagnostic cross the worker boundary; a received envelope is validated strictly and rebuilt.
 *
 * The native bridge reports failures only as fixed identifiers ({"error":"<IDENTIFIER>"});
 * no native text reaches JavaScript. Any other failure (an inherited TypeScript error, an embind
 * conversion error) is mapped by its context to a fixed code without reading its message. That
 * mapping, the bridge identifiers and the worker envelope are internal
 * (common/ZephyrWalletErrorMapping.ts), as are the code and message tables
 * (common/ZephyrWalletErrorTables.ts); applications use the constructor, code, diagnostic, isCode
 * and isDiagnostic.
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
  | "DAEMON_ERROR"
  | "TX_NOT_POSSIBLE"
  | "TX_REJECTED"
  | "RELAY_UNKNOWN";

/**
 * Approved diagnostic identifiers. Each is a fixed token chosen by SDK code; none is derived
 * from caller input or copied from native exception text (native text is only classified).
 */
const ZEPHYR_WALLET_ERROR_DIAGNOSTICS = [
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
  // a Content-Security-Policy without 'wasm-unsafe-eval', or a module the glue cannot use), or a wallet
  // worker could not receive the compiled module (Firefox, a worker policy without 'wasm-unsafe-eval'); the
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
  "KEYS_ONLY_HISTORY", "TX_HASH", "TX_HASHES", "HEIGHT_RANGE", "QUERY_ACCOUNT_REQUIRED", "TX_NOT_FOUND",
  // building transactions without relay: UNSUPPORTED_CAPABILITY for keys-only and view-only wallets, a conversion
  // and an integrated address; INVALID_CONFIG for an asset the chain no longer accepts as output (V1), destinations
  // that are not a non-empty array, more than 15 of them, an amount of zero or outside uint64 (or their sum), a
  // priority outside the four; INVALID_ADDRESS/ADDRESS_NETWORK for a valid address of another network;
  // TX_NOT_POSSIBLE when the wallet's unlocked balance (or its balance) in the asset does not cover the amounts, the
  // fee cannot be covered, the chain has too few outputs for the rings, or the transaction would be too large;
  // NATIVE_ERROR/TX_BUILD_FAILED for any other failure of the core's build
  "KEYS_ONLY_TX", "VIEW_ONLY_TX", "CONVERSION", "INTEGRATED_ADDRESS", "TX_ASSET", "DESTINATIONS", "TOO_MANY_DESTINATIONS",
  "AMOUNT_ZERO", "AMOUNT_RANGE", "TX_PRIORITY", "ADDRESS_NETWORK", "NOT_ENOUGH_UNLOCKED", "NOT_ENOUGH_MONEY", "NOT_ENOUGH_FOR_FEE",
  "NOT_ENOUGH_OUTS_TO_MIX", "TX_TOO_LARGE", "TX_BUILD_FAILED",
  // building conversions without relay: INVALID_CONFIG for a pair that is not one of the six V2 conversions, more than
  // one destination, an amount with more than four decimals; TX_NOT_POSSIBLE when the reserve ratio does not allow the
  // pair, the pricing record is missing, unusable or could not be read, the conversion would need more than one
  // transaction, or the converted amount would be zero
  "CONVERSION_PAIR", "CONVERSION_DESTINATIONS", "AMOUNT_PRECISION", "RESERVE_RATIO", "PRICING_RECORD", "CONVERSION_SPLIT", "CONVERSION_AMOUNT",
  // the transport refuses every request that would submit or relay a transaction or a block
  // (UNSUPPORTED_CAPABILITY/RELAY_REQUEST), except the one submit request of a relay call (below)
  "RELAY_REQUEST",
  // relaying a prepared build (common/ZephyrRelay.ts). Before any request: INVALID_CONFIG/RELAY_TOKEN for a value that
  // is not a token, INVALID_CONFIG/RELAY_TOKEN_VOID for an unknown, used or void token, TX_NOT_POSSIBLE/PRICING_RECORD_AGE
  // for a conversion whose pricing record has aged by the wallet's height, NATIVE_ERROR/RELAY_HASH_MISMATCH when a kept
  // transaction is not the described one. The daemon's refusal: TX_REJECTED with the first flag of its reply
  // (LOW_RING_SIZE, DOUBLE_SPEND, INVALID_INPUT, INVALID_OUTPUT, TOO_BIG, OVERSPEND, FEE_TOO_LOW, TOO_FEW_OUTPUTS,
  // TX_EXTRA_TOO_BIG, SANITY_CHECK_FAILED, NOT_RELAYED) or REJECTED without one. Not processed: DAEMON_ERROR/DAEMON_BUSY,
  // DAEMON_UNREACHABLE (connection refused, nothing sent). Sent without a usable answer: RELAY_UNKNOWN/NO_ANSWER,
  // HTTP_STATUS, ANSWER_UNREADABLE. NATIVE_ERROR/RELAY_REQUEST (the transport refused the submit request),
  // RELAY_FAILED (the commit failed before any request), RELAY_RECORD_FAILED (accepted, but the wallet could not record it)
  "RELAY_TOKEN", "RELAY_TOKEN_VOID", "PRICING_RECORD_AGE", "RELAY_HASH_MISMATCH", "RELAY_FAILED", "RELAY_RECORD_FAILED",
  "LOW_RING_SIZE", "DOUBLE_SPEND", "INVALID_INPUT", "INVALID_OUTPUT", "TOO_BIG", "OVERSPEND", "FEE_TOO_LOW", "TOO_FEW_OUTPUTS",
  "TX_EXTRA_TOO_BIG", "SANITY_CHECK_FAILED", "NOT_RELAYED", "REJECTED", "DAEMON_BUSY", "NO_ANSWER", "HTTP_STATUS", "ANSWER_UNREADABLE",
  // the reserve and the circulating supply of full wallets (keys-only wallets: UNSUPPORTED_CAPABILITY/KEYS_ONLY_DAEMON):
  // DAEMON_ERROR/PRICING_RECORD_UNAVAILABLE when the core could not read a usable pricing record of the daemon's top
  // block (it then computes nothing); ZephyrDaemonRpc: UNSUPPORTED_CAPABILITY/DAEMON_RPC_METHOD for every inherited
  // method that is not supported (before any request), INVALID_CONFIG/BLOCK_HEIGHT and BLOCK_HASH for the arguments
  // of the block header calls
  "PRICING_RECORD_UNAVAILABLE", "DAEMON_RPC_METHOD", "BLOCK_HEIGHT", "BLOCK_HASH",
  // listeners and background synchronization of full wallets (keys-only wallets: UNSUPPORTED_CAPABILITY/KEYS_ONLY_DAEMON):
  // INVALID_CONFIG/LISTENER for a listener that is not an object or whose callback is not a function,
  // INVALID_CONFIG/LISTENER_NOT_REGISTERED for removeListener with a listener that is not registered,
  // INVALID_CONFIG/SYNC_PERIOD for a startSyncing period outside 1,000 to 86,400,000 milliseconds
  "LISTENER_NOT_REGISTERED", "SYNC_PERIOD"
] as const;

export type ZephyrWalletErrorDiagnostic = typeof ZEPHYR_WALLET_ERROR_DIAGNOSTICS[number];

function isDiagnostic(value: unknown): value is ZephyrWalletErrorDiagnostic {
  return typeof value === "string" && (ZEPHYR_WALLET_ERROR_DIAGNOSTICS as readonly string[]).includes(value);
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
}
