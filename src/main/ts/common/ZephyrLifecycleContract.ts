import ZephyrWalletError, { ZephyrWalletErrorDiagnostic, ZephyrWalletErrorCode, ZephyrNativeErrorContext } from "./ZephyrWalletError";

/**
 * Central capability and argument specification of the supported wallet surface.
 *
 * One table drives the worker gate, the per-method argument validation and the backstop for
 * inherited exports. It must match the bindings in src/main/cpp/index.cpp and the exports of the
 * built modules.
 */

// ------------------------------ NUMERIC DOMAINS -----------------------------

/** Largest uint32_t; account/subaddress indices and lookahead counts are uint32 in the bridge/core ABI. */
export const UINT32_MAX = 4294967295;

/** Largest int32_t; the bridge's int log level parameter. */
export const INT32_MAX = 2147483647;

function isIntegerIn(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
}

/** Account or subaddress index: integer 0..2^32-1 (bridge uint32_t; larger values would wrap). */
export function isAddressIndex(value: unknown): value is number {
  return isIntegerIn(value, 0, UINT32_MAX);
}

export function checkAddressIndices(accountIdx: unknown, subaddressIdx: unknown): void {
  if (!isAddressIndex(accountIdx) || !isAddressIndex(subaddressIdx)) throw new ZephyrWalletError("INVALID_CONFIG", "ADDRESS_INDEX_RANGE");
}

/**
 * Lookahead count: integer 1..2^32-1. The core passes the uint64 config value to wallet2 as
 * size_t, which is 32 bits in WASM, and wallet2 rejects zero. Large values are within the ABI
 * but allocate proportionally large subaddress tables in the core.
 */
export function isLookahead(value: unknown): value is number {
  return isIntegerIn(value, 1, UINT32_MAX);
}

/**
 * Provisional local resource policy for wallet creation and restore:
 * each supplied lookahead value is at most 20,000 and accountLookahead x subaddressLookahead is at
 * most 20,000 subaddress-table entries (twice the core default 50 x 200, the largest measured
 * point). Larger values within the ABI domain reject with INVALID_CONFIG/LOOKAHEAD_LIMIT before
 * any native call. Unset lookahead keeps the core default. This bounds only lookahead values the
 * SDK serializes at creation or restore: it is not a bound for opening wallet bytes, whose keys
 * file carries its own lookahead pair (see validateCreateConfig and validateOpenConfig).
 */
export const LOOKAHEAD_ENTRY_LIMIT = 20000;

/**
 * Whether a lookahead pair (each already within the ABI domain 1..2^32-1) satisfies the policy.
 * Checked arithmetic without multiplication: for positive integers a x b <= L exactly when
 * a <= floor(L / b), so no product of two large values is ever formed.
 */
export function isWithinLookaheadLimit(accountLookahead: number, subaddressLookahead: number): boolean {
  if (accountLookahead > LOOKAHEAD_ENTRY_LIMIT || subaddressLookahead > LOOKAHEAD_ENTRY_LIMIT) return false;
  return accountLookahead <= Math.floor(LOOKAHEAD_ENTRY_LIMIT / subaddressLookahead);
}

/**
 * Public restore height: an exact non-negative safe integer (the core stores uint64_t). Values
 * above Number.MAX_SAFE_INTEGER cannot be represented exactly by a number and are rejected.
 */
export function isRestoreHeight(value: unknown): value is number {
  return isIntegerIn(value, 0, Number.MAX_SAFE_INTEGER);
}

/** Checked conversion of the bridge's decimal restore-height text to an exact number. */
export function parseRestoreHeightText(text: unknown): number {
  if (typeof text !== "string" || !/^(0|[1-9][0-9]{0,19})$/.test(text)) throw new ZephyrWalletError("NATIVE_ERROR", "UNEXPECTED_RESULT");
  const value = Number(text);
  if (!Number.isSafeInteger(value) || String(value) !== text) throw new ZephyrWalletError("NATIVE_ERROR", "RESTORE_HEIGHT_UNREPRESENTABLE");
  return value;
}

/** Network type of the core: 0 mainnet, 1 testnet, 2 stagenet. */
export function isNetworkTypeNumber(value: unknown): value is 0 | 1 | 2 {
  return value === 0 || value === 1 || value === 2;
}

/** Bridge log level: int parameter forwarded to epee mlog_set_log_level. */
export function isLogLevel(value: unknown): value is number {
  return isIntegerIn(value, 0, INT32_MAX);
}

// ------------------------------- ACCOUNTS AND LABELS ------------------------

/**
 * Listing bounds of the accounts and subaddresses API (resource policy, provisional): one call
 * returns at most MAX_ACCOUNTS_PER_CALL accounts and at most MAX_SUBADDRESSES_PER_CALL subaddresses,
 * also counted over every account of getAccounts with its subaddresses. A larger listing rejects
 * with INVALID_CONFIG/LISTING_LIMIT before anything crosses the bridge; the caller then pages: an
 * account reports its subaddressCount, and getSubaddresses takes at most MAX_SUBADDRESSES_PER_CALL
 * explicit indices per call.
 */
export const MAX_ACCOUNTS_PER_CALL = 1000;
export const MAX_SUBADDRESSES_PER_CALL = 1000;

/**
 * Label policy: a label is a string of at most LABEL_MAX_BYTES bytes in UTF-8 (the form the core
 * stores) without control characters (U+0000 to U+001F, U+007F to U+009F) and without unpaired
 * UTF-16 surrogates, which have no UTF-8 form. "" clears a label. Violations reject with
 * INVALID_CONFIG and LABEL_TYPE, LABEL_LENGTH or LABEL_CHARACTERS before any native or worker
 * call; the label itself is never copied into an error.
 */
export const LABEL_MAX_BYTES = 255;

export function checkLabel(label: unknown): string {
  if (typeof label !== "string") throw new ZephyrWalletError("INVALID_CONFIG", "LABEL_TYPE");
  let bytes = 0;
  for (let i = 0; i < label.length; i++) {
    const c = label.charCodeAt(i);
    if (c <= 0x1f || (c >= 0x7f && c <= 0x9f)) throw new ZephyrWalletError("INVALID_CONFIG", "LABEL_CHARACTERS");
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = i + 1 < label.length ? label.charCodeAt(i + 1) : 0;
      if (d < 0xdc00 || d > 0xdfff) throw new ZephyrWalletError("INVALID_CONFIG", "LABEL_CHARACTERS");
      bytes += 4;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      throw new ZephyrWalletError("INVALID_CONFIG", "LABEL_CHARACTERS");
    } else {
      bytes += c < 0x80 ? 1 : c < 0x800 ? 2 : 3;
    }
    if (bytes > LABEL_MAX_BYTES) throw new ZephyrWalletError("INVALID_CONFIG", "LABEL_LENGTH");
  }
  return label;
}

/**
 * Explicit subaddress indices of getSubaddresses: a non-empty array of at most
 * MAX_SUBADDRESSES_PER_CALL distinct uint32 indices (INVALID_CONFIG: SUBADDRESS_INDICES for anything
 * else but the count and the domain, LISTING_LIMIT for a longer array, ADDRESS_INDEX_RANGE for an
 * index outside 0..2^32-1). Omitting the array lists every subaddress of the account.
 */
export function checkSubaddressIndices(indices: unknown): readonly number[] {
  if (!Array.isArray(indices) || indices.length === 0) throw new ZephyrWalletError("INVALID_CONFIG", "SUBADDRESS_INDICES");
  if (indices.length > MAX_SUBADDRESSES_PER_CALL) throw new ZephyrWalletError("INVALID_CONFIG", "LISTING_LIMIT");
  const seen = new Set<number>();
  for (const i of indices) {
    if (!isAddressIndex(i)) throw new ZephyrWalletError("INVALID_CONFIG", "ADDRESS_INDEX_RANGE");
    if (seen.has(i)) throw new ZephyrWalletError("INVALID_CONFIG", "SUBADDRESS_INDICES");
    seen.add(i);
  }
  return indices.slice();
}

// ------------------------------- NATIVE EXPORTS -----------------------------

/** Embind exports of the release lifecycle module (src/main/cpp/index.cpp). */
export const LIFECYCLE_NATIVE_EXPORTS: readonly string[] = [
  "set_log_level", "get_integrated_address_util", "validate_address",
  "open_wallet_full", "create_full_wallet", "get_full_wallet_seed_languages",
  "create_keys_wallet_random", "create_keys_wallet_from_seed", "create_keys_wallet_from_keys", "get_keys_wallet_seed_languages",
  "is_view_only", "get_version", "get_seed", "get_seed_language", "get_private_spend_key", "get_private_view_key",
  "get_public_view_key", "get_public_spend_key", "get_address", "get_address_index", "get_integrated_address",
  "decode_integrated_address", "get_network_type", "get_restore_height", "get_keys_file_buffer", "get_cache_file_buffer",
  "change_wallet_password", "close",
  // read-only daemon access
  "set_daemon_connection", "is_connected_to_daemon", "get_daemon_height", "set_restore_height_from_daemon", "get_height", "sync",
  "get_balance_wallet", "get_unlocked_balance_wallet", "get_balance_account", "get_unlocked_balance_account",
  "get_balance_asset", "get_unlocked_balance_asset", "is_daemon_synced",
  // accounts and subaddresses
  "get_accounts", "get_account", "create_account", "get_subaddresses", "create_subaddress", "set_subaddress_label"
];

/**
 * Release exports the SDK added that the base commit does not have (the asset-first scalar
 * balances and the restore height of a new wallet from its daemon). Every other release export is an
 * inherited binding adapted to the fixed core.
 */
export const SDK_ADDED_NATIVE_EXPORTS: readonly string[] = ["get_balance_asset", "get_unlocked_balance_asset", "set_restore_height_from_daemon"];

/**
 * Inherited monero-ts bridge exports at the base commit that the SDK does not build. If an
 * unadapted code path reaches one, it gets a typed UNSUPPORTED_CAPABILITY error instead of a
 * TypeError. Together with LIFECYCLE_NATIVE_EXPORTS this must equal the base commit's bindings.
 */
export const UNBUILT_BRIDGE_EXPORTS: readonly string[] = ["get_exception_message", "malloc_binary_from_json", "binary_to_json", "binary_blocks_to_json",
  "get_daemon_connection", "is_daemon_trusted", "get_daemon_max_peer_height",
  "get_height_by_date", "is_synced", "set_restore_height", "set_listener",
  "stop_syncing", "scan_txs", "rescan_spent", "rescan_blockchain",
  "get_balance_subaddress", "get_unlocked_balance_subaddress",
  "get_txs",
  "get_transfers", "get_outputs", "export_outputs", "import_outputs", "export_key_images", "import_key_images", "freeze_output",
  "thaw_output", "is_output_frozen", "get_default_fee_priority", "create_txs", "sweep_output", "sweep_unlocked", "sweep_dust",
  "relay_txs", "describe_tx_set", "sign_txs", "submit_txs", "sign_message", "verify_message", "get_tx_key", "check_tx_key",
  "get_tx_proof", "check_tx_proof", "get_spend_proof", "check_spend_proof", "get_reserve_proof_wallet", "get_reserve_proof_account",
  "check_reserve_proof", "get_tx_notes", "set_tx_notes", "get_address_book_entries", "add_address_book_entry",
  "edit_address_book_entry", "delete_address_book_entry", "tag_accounts", "untag_accounts", "get_account_tags",
  "set_account_tag_label", "get_payment_uri", "parse_payment_uri", "get_attribute", "set_attribute", "is_multisig_import_needed",
  "get_multisig_info", "prepare_multisig", "make_multisig", "exchange_multisig_keys", "export_multisig_hex", "import_multisig_hex",
  "sign_multisig_tx_hex", "submit_multisig_tx_hex"];

/** Inherited EMSCRIPTEN_KEEPALIVE export removed with request_shutdown (absent from the fixed core). */
export const UNBUILT_KEEPALIVE_EXPORTS: readonly string[] = ["_request_wallet_shutdown"];

// ------------------------------ WORKER METHODS ------------------------------

/** One positional worker argument after the object id. */
export interface LifecycleArgSpec {
  readonly kind: "uint32" | "networkType" | "logLevel" | "string" | "optionalString" | "address" | "password"
    | "keysBytes" | "optionalBytes" | "emptyPath" | "absent" | "falseFlag" | "createConfig" | "keysConfig"
    | "boolean" | "daemonUri" | "height" | "assetType" | "label" | "subaddressIndices";
  readonly optional?: boolean;
}

export interface LifecycleWorkerMethod {
  /** global: no wallet; create: allocates a wallet under a new id; wallet: needs an existing wallet id */
  readonly scope: "global" | "create" | "wallet";
  /** wallet kinds the method supports (wallet scope only) */
  readonly kinds?: readonly ("full" | "keys")[];
  readonly args: readonly LifecycleArgSpec[];
  /** native exports the method may reach */
  readonly nativeExports: readonly string[];
  readonly errorContext: ZephyrNativeErrorContext;
}

const BOTH = ["full", "keys"] as const;
const FULL = ["full"] as const;

/** Worker functions of the SDK; every other function name is rejected before dispatch. */
export const LIFECYCLE_WORKER_METHODS: Readonly<Record<string, LifecycleWorkerMethod>> = Object.freeze({
  setLogLevel: { scope: "global", args: [{ kind: "logLevel" }], nativeExports: ["set_log_level"], errorContext: "other" },
  getNetworkGuardReport: { scope: "global", args: [], nativeExports: [], errorContext: "other" },
  zephyrUtilsValidateAddress: { scope: "global", args: [{ kind: "address" }, { kind: "networkType" }], nativeExports: ["validate_address"], errorContext: "address" },
  zephyrUtilsGetIntegratedAddress: { scope: "global", args: [{ kind: "networkType" }, { kind: "address" }, { kind: "optionalString", optional: true }], nativeExports: ["get_integrated_address_util"], errorContext: "address" },
  openWalletData: { scope: "create", args: [{ kind: "emptyPath" }, { kind: "password" }, { kind: "networkType" }, { kind: "keysBytes" }, { kind: "optionalBytes" }, { kind: "absent" }, { kind: "falseFlag" }], nativeExports: ["open_wallet_full"], errorContext: "open" },
  createWalletFull: { scope: "create", args: [{ kind: "createConfig" }], nativeExports: ["create_full_wallet"], errorContext: "create" },
  createWalletKeys: { scope: "create", args: [{ kind: "keysConfig" }], nativeExports: ["create_keys_wallet_random", "create_keys_wallet_from_seed", "create_keys_wallet_from_keys"], errorContext: "create" },
  isViewOnly: { scope: "wallet", kinds: BOTH, args: [], nativeExports: ["is_view_only"], errorContext: "other" },
  getNetworkType: { scope: "wallet", kinds: FULL, args: [], nativeExports: ["get_network_type"], errorContext: "other" },
  getSeed: { scope: "wallet", kinds: BOTH, args: [], nativeExports: ["get_seed"], errorContext: "other" },
  getSeedLanguage: { scope: "wallet", kinds: BOTH, args: [], nativeExports: ["get_seed_language"], errorContext: "other" },
  getSeedLanguages: { scope: "wallet", kinds: BOTH, args: [], nativeExports: ["get_full_wallet_seed_languages", "get_keys_wallet_seed_languages"], errorContext: "other" },
  getPrivateSpendKey: { scope: "wallet", kinds: BOTH, args: [], nativeExports: ["get_private_spend_key"], errorContext: "other" },
  getPrivateViewKey: { scope: "wallet", kinds: BOTH, args: [], nativeExports: ["get_private_view_key"], errorContext: "other" },
  getPublicViewKey: { scope: "wallet", kinds: BOTH, args: [], nativeExports: ["get_public_view_key"], errorContext: "other" },
  getPublicSpendKey: { scope: "wallet", kinds: BOTH, args: [], nativeExports: ["get_public_spend_key"], errorContext: "other" },
  getAddress: { scope: "wallet", kinds: BOTH, args: [{ kind: "uint32" }, { kind: "uint32" }], nativeExports: ["get_address"], errorContext: "other" },
  getAddressIndex: { scope: "wallet", kinds: FULL, args: [{ kind: "address" }], nativeExports: ["get_address_index"], errorContext: "address" },
  getIntegratedAddress: { scope: "wallet", kinds: BOTH, args: [{ kind: "optionalString", optional: true }, { kind: "optionalString", optional: true }], nativeExports: ["get_integrated_address"], errorContext: "address" },
  decodeIntegratedAddress: { scope: "wallet", kinds: BOTH, args: [{ kind: "address" }], nativeExports: ["decode_integrated_address"], errorContext: "address" },
  getRestoreHeight: { scope: "wallet", kinds: FULL, args: [], nativeExports: ["get_restore_height"], errorContext: "other" },
  getData: { scope: "wallet", kinds: FULL, args: [], nativeExports: ["is_view_only", "get_keys_file_buffer", "get_cache_file_buffer"], errorContext: "other" },
  changePassword: { scope: "wallet", kinds: FULL, args: [{ kind: "password" }, { kind: "password" }], nativeExports: ["change_wallet_password"], errorContext: "changePassword" },
  // read-only daemon access; the worker re-validates the address from its text
  setDaemonConnection: { scope: "wallet", kinds: FULL, args: [{ kind: "daemonUri" }], nativeExports: ["set_daemon_connection"], errorContext: "daemon" },
  isConnectedToDaemon: { scope: "wallet", kinds: FULL, args: [], nativeExports: ["is_connected_to_daemon"], errorContext: "daemon" },
  getDaemonHeight: { scope: "wallet", kinds: FULL, args: [], nativeExports: ["get_daemon_height"], errorContext: "daemon" },
  setRestoreHeightFromDaemon: { scope: "wallet", kinds: FULL, args: [], nativeExports: ["set_restore_height_from_daemon"], errorContext: "daemon" },
  isDaemonSynced: { scope: "wallet", kinds: FULL, args: [], nativeExports: ["is_daemon_synced"], errorContext: "daemon" },
  getHeight: { scope: "wallet", kinds: FULL, args: [], nativeExports: ["get_height"], errorContext: "other" },
  sync: { scope: "wallet", kinds: FULL, args: [{ kind: "height", optional: true }], nativeExports: ["sync"], errorContext: "sync" },
  getBalances: { scope: "wallet", kinds: FULL, args: [{ kind: "boolean" }], nativeExports: ["get_balance_wallet", "get_unlocked_balance_wallet"], errorContext: "other" },
  getAccountBalances: { scope: "wallet", kinds: FULL, args: [{ kind: "boolean" }, { kind: "uint32" }], nativeExports: ["get_balance_account", "get_unlocked_balance_account"], errorContext: "other" },
  getAssetBalance: { scope: "wallet", kinds: FULL, args: [{ kind: "boolean" }, { kind: "assetType" }, { kind: "uint32" }, { kind: "uint32", optional: true }], nativeExports: ["get_balance_asset", "get_unlocked_balance_asset"], errorContext: "other" },
  // accounts and subaddresses of full wallets; replies are strict DTOs (common/ZephyrAccounts.ts)
  getAccounts: { scope: "wallet", kinds: FULL, args: [{ kind: "boolean" }], nativeExports: ["get_accounts"], errorContext: "other" },
  getAccount: { scope: "wallet", kinds: FULL, args: [{ kind: "uint32" }, { kind: "boolean" }], nativeExports: ["get_account"], errorContext: "other" },
  createAccount: { scope: "wallet", kinds: FULL, args: [{ kind: "label" }], nativeExports: ["create_account"], errorContext: "other" },
  getSubaddresses: { scope: "wallet", kinds: FULL, args: [{ kind: "uint32" }, { kind: "subaddressIndices", optional: true }], nativeExports: ["get_subaddresses"], errorContext: "other" },
  createSubaddress: { scope: "wallet", kinds: FULL, args: [{ kind: "uint32" }, { kind: "label" }], nativeExports: ["create_subaddress"], errorContext: "other" },
  setSubaddressLabel: { scope: "wallet", kinds: FULL, args: [{ kind: "uint32" }, { kind: "uint32" }, { kind: "label" }], nativeExports: ["set_subaddress_label"], errorContext: "other" },
  isClosed: { scope: "wallet", kinds: BOTH, args: [], nativeExports: [], errorContext: "other" },
  prepareClose: { scope: "wallet", kinds: FULL, args: [], nativeExports: [], errorContext: "close" },
  close: { scope: "wallet", kinds: BOTH, args: [{ kind: "falseFlag", optional: true }], nativeExports: ["close"], errorContext: "close" }
});

/** Own-key lookup of a worker method; prototype names and unknown names give undefined. */
export function lifecycleWorkerMethod(name: unknown): LifecycleWorkerMethod | undefined {
  if (typeof name !== "string" || !Object.prototype.hasOwnProperty.call(LIFECYCLE_WORKER_METHODS, name)) return undefined;
  return LIFECYCLE_WORKER_METHODS[name];
}

/** Worker object and callback ids: GenUtils UUIDs or similar tokens; bounded and own-key safe. */
export function isWorkerId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9-]{1,64}$/.test(value);
}

function fail(code: ZephyrWalletErrorCode, diagnostic: ZephyrWalletErrorDiagnostic): never {
  throw new ZephyrWalletError(code, diagnostic);
}

/**
 * Validate positional worker arguments against a method spec before normalization or dispatch.
 * Config objects are checked here for shape only; their full validation runs before any
 * normalization in the worker handler (validateCreateConfig).
 */
export function validateWorkerArgs(method: LifecycleWorkerMethod, args: readonly unknown[]): void {
  const required = method.args.filter((a) => !a.optional).length;
  if (args.length < required || args.length > method.args.length) fail("MALFORMED_MESSAGE", "ARGUMENT_COUNT");
  for (let i = 0; i < args.length; i++) {
    const value = args[i];
    const spec = method.args[i];
    if (spec.optional && value === undefined) continue;
    switch (spec.kind) {
      case "uint32": if (!isAddressIndex(value)) fail("INVALID_CONFIG", "ADDRESS_INDEX_RANGE"); break;
      case "networkType": if (!isNetworkTypeNumber(value)) fail("INVALID_CONFIG", "NETWORK_TYPE"); break;
      case "logLevel": if (!isLogLevel(value)) fail("INVALID_CONFIG", "LOG_LEVEL_RANGE"); break;
      case "string": if (typeof value !== "string") fail("MALFORMED_MESSAGE", "ARGUMENT_TYPE"); break;
      case "optionalString": if (value !== undefined && typeof value !== "string") fail("MALFORMED_MESSAGE", "ARGUMENT_TYPE"); break;
      case "address": if (typeof value !== "string" || value.length === 0) fail("INVALID_ADDRESS", "ADDRESS_TYPE"); break;
      case "password": if (typeof value !== "string") fail("INVALID_CONFIG", "PASSWORD_TYPE"); break;
      case "keysBytes": if (!(value instanceof Uint8Array) || value.length === 0) fail("INVALID_WALLET_DATA", "WALLET_BYTES"); break;
      case "optionalBytes": if (value !== undefined && !(value instanceof Uint8Array)) fail("INVALID_WALLET_DATA", "WALLET_BYTES"); break;
      case "emptyPath": if (value !== undefined && value !== "") { if (typeof value === "string") fail("UNSUPPORTED_CAPABILITY", "FILE_PATH"); fail("MALFORMED_MESSAGE", "ARGUMENT_TYPE"); } break;
      case "absent": if (value !== undefined && value !== null && value !== "") fail("UNSUPPORTED_CAPABILITY", "DAEMON_CONNECTION"); break;
      case "falseFlag": if (value === true) fail("UNSUPPORTED_CAPABILITY", method.errorContext === "close" ? "SAVE_ON_CLOSE" : "REGTEST"); if (value !== undefined && value !== false) fail("MALFORMED_MESSAGE", "ARGUMENT_TYPE"); break;
      case "boolean": if (typeof value !== "boolean") fail("MALFORMED_MESSAGE", "ARGUMENT_TYPE"); break;
      case "daemonUri": if (value !== undefined && (typeof value !== "string" || value.length === 0 || value.length > 512)) fail("INVALID_CONFIG", "DAEMON_ADDRESS"); break;
      case "height": if (!isRestoreHeight(value)) fail("INVALID_CONFIG", "SYNC_START_HEIGHT"); break;
      case "assetType": if (typeof value !== "string" || !/^[A-Z0-9]{1,16}$/.test(value)) fail("INVALID_CONFIG", "ASSET_TYPE"); break;
      case "label": checkLabel(value); break;
      case "subaddressIndices": checkSubaddressIndices(value); break;
      case "createConfig":
      case "keysConfig": if (value === null || typeof value !== "object" || Array.isArray(value)) fail("INVALID_CONFIG", "CONFIG_TYPE"); break;
    }
  }
}
