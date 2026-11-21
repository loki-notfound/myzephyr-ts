/**
 * Validators and parsers of the payment proofs and transaction keys (ZephyrWallet getTxKey, getTxProof, getSpendProof).
 * Internal: the package entry does not export this module, and no declaration the entry reaches refers to it.
 *
 * The results are strings in the forms the core writes (zephyr 8c6a1202, wallet2::get_tx_proof and get_spend_proof;
 * zephyr-cpp 3a2ee602, monero_wallet_full::get_tx_key): a transaction proof is "OutProofV2" or "InProofV2" followed by one
 * to seventeen pairs of a shared secret (44 base58 characters) and a signature (88), one pair per transaction public key; a
 * spend proof is "SpendProofV1" followed by one 88-character signature per ring member of each input; a transaction key is
 * the key and its additional keys, 64 lowercase hexadecimal characters each. The bridge checks the form before it returns a
 * result; the parsers below check it again, in the caller's context and after a worker. No result text is ever part of an
 * error.
 */
import ZephyrWalletError from "./ZephyrWalletError";
import { checkTxHash } from "./ZephyrHistoryInternal";

/** Longest message accepted by getTxProof and getSpendProof, in UTF-8 bytes (the form the core hashes). */
export const PROOF_MESSAGE_MAX_BYTES = 1024;

const ADDRESS_TEXT = /^[1-9A-HJ-NP-Za-km-z]{90,140}$/;
const BASE58 = "[1-9A-HJ-NP-Za-km-z]";
const TX_PROOF_RESULT = new RegExp("^\\{\"proof\":\"((OutProofV2|InProofV2)(?:" + BASE58 + "{132}){1,17})\"\\}$");
const SPEND_PROOF_RESULT = new RegExp("^\\{\"proof\":\"(SpendProofV1(?:" + BASE58 + "{88}){1,65536})\"\\}$");
const TX_KEY_RESULT = /^\{"txKey":"((?:[0-9a-f]{64}){1,17})"\}$/;

/** The validated request of a proof call that the bridge and the worker receive. */
export interface ZephyrProofRequest {
  readonly txHash: string;
  readonly address: string;
  readonly message: string;
}

/**
 * A proof message: undefined (none, the core's empty message) or a string of at most PROOF_MESSAGE_MAX_BYTES bytes in UTF-8,
 * without U+0000 and without unpaired UTF-16 surrogates (which have no UTF-8 form, so a checker could not reproduce the bytes
 * the core signs); else INVALID_CONFIG/PROOF_MESSAGE. The message itself is never copied into an error.
 */
export function checkProofMessage(message: unknown): string {
  if (message === undefined) return "";
  if (typeof message !== "string") throw new ZephyrWalletError("INVALID_CONFIG", "PROOF_MESSAGE");
  let bytes = 0;
  for (let i = 0; i < message.length; i++) {
    const c = message.charCodeAt(i);
    if (c === 0) throw new ZephyrWalletError("INVALID_CONFIG", "PROOF_MESSAGE");
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = i + 1 < message.length ? message.charCodeAt(i + 1) : 0;
      if (d < 0xdc00 || d > 0xdfff) throw new ZephyrWalletError("INVALID_CONFIG", "PROOF_MESSAGE");
      bytes += 4;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      throw new ZephyrWalletError("INVALID_CONFIG", "PROOF_MESSAGE");
    } else {
      bytes += c < 0x80 ? 1 : c < 0x800 ? 2 : 3;
    }
    if (bytes > PROOF_MESSAGE_MAX_BYTES) throw new ZephyrWalletError("INVALID_CONFIG", "PROOF_MESSAGE");
  }
  return message;
}

/** The address of getTxProof as text: a string of 90 to 140 base58 characters, else INVALID_ADDRESS/ADDRESS_TYPE. */
export function checkProofAddress(address: unknown): string {
  if (typeof address !== "string" || !ADDRESS_TEXT.test(address)) throw new ZephyrWalletError("INVALID_ADDRESS", "ADDRESS_TYPE");
  return address;
}

/** Validate the arguments of getTxProof before any native or worker call (hash, then address, then message). */
export function checkTxProofRequest(txHash: unknown, address: unknown, message: unknown): ZephyrProofRequest {
  return { txHash: checkTxHash(txHash), address: checkProofAddress(address), message: checkProofMessage(message) };
}

/** Validate the arguments of getSpendProof before any native or worker call (hash, then message). */
export function checkSpendProofRequest(txHash: unknown, message: unknown): { readonly txHash: string; readonly message: string } {
  return { txHash: checkTxHash(txHash), message: checkProofMessage(message) };
}

function unexpected(): never {
  throw new ZephyrWalletError("NATIVE_ERROR", "UNEXPECTED_RESULT");
}

/** The transaction key of the bridge's result {"txKey":".."}; anything else rejects with NATIVE_ERROR/UNEXPECTED_RESULT. */
export function parseBridgeTxKey(result: unknown): string {
  const match = typeof result === "string" ? TX_KEY_RESULT.exec(result) : null;
  if (match === null) unexpected();
  return match[1];
}

/** The proof of the bridge's result {"proof":".."} of get_tx_proof, of either kind; anything else rejects with UNEXPECTED_RESULT. */
export function parseBridgeTxProof(result: unknown): string {
  const match = typeof result === "string" ? TX_PROOF_RESULT.exec(result) : null;
  if (match === null) unexpected();
  return match[1];
}

/** The proof of the bridge's result {"proof":".."} of get_spend_proof; anything else rejects with UNEXPECTED_RESULT. */
export function parseBridgeSpendProof(result: unknown): string {
  const match = typeof result === "string" && result.length <= 32 + 88 * 65536 ? SPEND_PROOF_RESULT.exec(result) : null;
  if (match === null) unexpected();
  return match[1];
}

/** A transaction key received from a wallet's worker: the same form, else UNEXPECTED_RESULT. */
export function fromTxKeyDto(dto: unknown): string {
  return typeof dto === "string" ? parseBridgeTxKey("{\"txKey\":\"" + dto + "\"}") : unexpected();
}

/** A transaction proof received from a wallet's worker: the same form, else UNEXPECTED_RESULT. */
export function fromTxProofDto(dto: unknown): string {
  return typeof dto === "string" ? parseBridgeTxProof("{\"proof\":\"" + dto + "\"}") : unexpected();
}

/** A spend proof received from a wallet's worker: the same form, else UNEXPECTED_RESULT. */
export function fromSpendProofDto(dto: unknown): string {
  return typeof dto === "string" ? parseBridgeSpendProof("{\"proof\":\"" + dto + "\"}") : unexpected();
}
