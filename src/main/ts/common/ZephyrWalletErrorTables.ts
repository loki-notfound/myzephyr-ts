/**
 * The code table and the fixed message per code of common/ZephyrWalletError.ts, which holds the public
 * error class and types. Internal: the package entry does not export this module, and no declaration the
 * entry reaches refers to it.
 */
import type { ZephyrWalletErrorCode } from "./ZephyrWalletError";

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
  "DAEMON_ERROR",
  "TX_NOT_POSSIBLE",
  "TX_REJECTED",
  "RELAY_UNKNOWN"
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
  DAEMON_ERROR: "Daemon request failed",
  TX_NOT_POSSIBLE: "Transaction not possible",
  TX_REJECTED: "Transaction rejected by the daemon",
  RELAY_UNKNOWN: "Relay outcome unknown"
};
