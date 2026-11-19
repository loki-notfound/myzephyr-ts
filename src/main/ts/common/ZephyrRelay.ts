import ZephyrWalletError, { ZephyrWalletErrorCode, ZephyrWalletErrorDiagnostic } from "./ZephyrWalletError";
import * as WalletErrors from "./ZephyrWalletErrorMapping";
import { isBridgeErrorIdentifier } from "./ZephyrWalletErrorMapping";
import { ZephyrTransferBuild } from "./ZephyrTransfer";
import { Bad, TX_HASH, ZephyrTransferRequest, buildFromFields, fields, toBuildDto } from "./ZephyrTransferInternal";
import { ZephyrConversionBuild } from "./ZephyrConversion";
import { ZephyrConversionRequest, conversionFromFields, toConversionDto } from "./ZephyrConversionInternal";

/**
 * Relaying a built transaction, in two explicit steps. prepareTransfer and prepareConversion build and describe
 * exactly as buildTransfer and buildConversion do, but keep what they built inside the module, in the wallet's one
 * slot, under a new opaque token; relayPrepared(token) relays exactly that kept build, and discardPrepared(token)
 * voids it. buildTransfer and buildConversion keep discarding what they build.
 *
 * A token is 32 lowercase hexadecimal characters; it names the slot and carries no information. A kept build is
 * void (wiped and released inside the module) after it was relayed completely, after the daemon refused it, after
 * discardPrepared, close, a password change, a newer prepare, a sync after which the wallet's height differs from
 * the height at the build by more than 10 blocks, a conversion whose pricing record has aged, a hash mismatch and
 * after three relay calls. It is never part of the wallet bytes. A void or unknown token rejects with
 * INVALID_CONFIG/RELAY_TOKEN_VOID before any request.
 *
 * The bytes of a kept transaction never leave the module except inside the relay's one submit request; no result,
 * event or error carries them.
 */

/** A prepared same-asset transfer: the token of the kept build and its description (as buildTransfer's). */
export interface ZephyrPreparedTransfer {
  readonly token: string;
  readonly build: ZephyrTransferBuild;
}

/** A prepared conversion: the token of the kept build and its description (as buildConversion's). */
export interface ZephyrPreparedConversion {
  readonly token: string;
  readonly build: ZephyrConversionBuild;
}

/**
 * What happened to one kept transaction in a relay call: accepted by the daemon (now or by an earlier call of the
 * same token), rejected by it, unknown (the request was sent and no usable answer came: it may have reached the
 * network), or not sent (not attempted in this call, refused before sending, or not processed by a busy daemon).
 */
export type ZephyrRelayOutcome = "accepted" | "rejected" | "unknown" | "notSent";

export interface ZephyrRelayedTx {
  /** the hash described when the build was prepared */
  readonly hash: string;
  readonly outcome: ZephyrRelayOutcome;
  /** accepted, and the daemon said it kept the transaction without relaying it (its not_relayed flag) */
  readonly notRelayed: boolean;
  /** the failure of this transaction in this call (also on an accepted one whose record failed in the wallet) */
  readonly code?: ZephyrWalletErrorCode;
  readonly diagnostic?: ZephyrWalletErrorDiagnostic;
}

/** Result of relayPrepared: per kept transaction in the build's order; complete when every one is accepted. */
export interface ZephyrRelayResult {
  readonly txs: ReadonlyArray<ZephyrRelayedTx>;
  readonly complete: boolean;
}

export const RELAY_TOKEN = /^[0-9a-f]{32}$/;
const OUTCOMES: readonly string[] = ["accepted", "rejected", "unknown", "notSent"];
const MAX_KEPT_TXS = 64;

/** A relay token argument, checked before dispatch. */
export function checkRelayToken(token: unknown): string {
  if (typeof token !== "string" || !RELAY_TOKEN.test(token)) throw new ZephyrWalletError("INVALID_CONFIG", "RELAY_TOKEN");
  return token;
}

const unexpected: Bad = () => { throw new ZephyrWalletError("NATIVE_ERROR", "UNEXPECTED_RESULT"); };
const malformed: Bad = () => { throw new ZephyrWalletError("MALFORMED_MESSAGE", "MESSAGE_SHAPE"); };

function parseJson(json: unknown): unknown {
  if (typeof json !== "string" || json.charAt(0) !== "{") unexpected();
  try { return JSON.parse(json as string); } catch (err) { return unexpected(); }
}

function preparedFields(value: unknown, bad: Bad): { token: string; build: unknown } {
  const f = fields(value, ["token", "build"], [], bad);
  if (typeof f.token !== "string" || !RELAY_TOKEN.test(f.token)) bad();
  return { token: f.token as string, build: f.build };
}

/** Bridge {"token","build":{"txs":[...]}} of prepare_txs for a request; the description is checked as buildTransfer's. */
export function parseBridgePreparedTransfer(json: unknown, request: ZephyrTransferRequest): ZephyrPreparedTransfer {
  const p = preparedFields(parseJson(json), unexpected);
  return Object.freeze({ token: p.token, build: buildFromFields(p.build, request, unexpected) });
}

export function toPreparedTransferDto(p: ZephyrPreparedTransfer): unknown {
  return { token: p.token, build: toBuildDto(p.build) };
}

/** Strict worker reply of prepareTransfer. */
export function fromPreparedTransferDto(value: unknown, request: ZephyrTransferRequest): ZephyrPreparedTransfer {
  const p = preparedFields(value, malformed);
  return Object.freeze({ token: p.token, build: buildFromFields(p.build, request, malformed) });
}

/** Bridge {"token","build":{"tx":{...}}} of prepare_conversion for a request; the description is checked as buildConversion's. */
export function parseBridgePreparedConversion(json: unknown, request: ZephyrConversionRequest): ZephyrPreparedConversion {
  const p = preparedFields(parseJson(json), unexpected);
  return Object.freeze({ token: p.token, build: conversionFromFields(p.build, request, unexpected) });
}

export function toPreparedConversionDto(p: ZephyrPreparedConversion): unknown {
  return { token: p.token, build: toConversionDto(p.build) };
}

/** Strict worker reply of prepareConversion. */
export function fromPreparedConversionDto(value: unknown, request: ZephyrConversionRequest): ZephyrPreparedConversion {
  const p = preparedFields(value, malformed);
  return Object.freeze({ token: p.token, build: conversionFromFields(p.build, request, malformed) });
}

/**
 * The relay result's checks, shared by the bridge's shape (an entry's failure as a bridge identifier, "error") and the
 * worker DTO (as code and diagnostic): hashes distinct, outcomes known, notRelayed only on an accepted entry, a failure
 * only where one can be, at least one entry accepted (a call that accepted nothing rejects instead), complete exactly
 * when every entry is accepted. With hashes: the entries' hashes must equal the prepared build's, in order.
 */
function relayFromFields(value: unknown, bad: Bad, entry: (e: Record<string, unknown>) => { code?: ZephyrWalletErrorCode; diagnostic?: ZephyrWalletErrorDiagnostic }, hashes?: readonly string[]): ZephyrRelayResult {
  const f = fields(value, ["txs", "complete"], [], bad);
  if (!Array.isArray(f.txs) || f.txs.length === 0 || f.txs.length > MAX_KEPT_TXS || typeof f.complete !== "boolean") bad();
  const seen = new Set<string>();
  let accepted = 0;
  const txs = (f.txs as unknown[]).map((v) => {
    const t = fields(v, ["hash", "outcome", "notRelayed"], ["error", "code", "diagnostic"], bad);
    if (typeof t.hash !== "string" || !TX_HASH.test(t.hash) || seen.has(t.hash)) bad();
    seen.add(t.hash as string);
    if (typeof t.outcome !== "string" || !OUTCOMES.includes(t.outcome) || typeof t.notRelayed !== "boolean") bad();
    if (t.notRelayed === true && t.outcome !== "accepted") bad();
    if (t.outcome === "accepted") accepted++;
    const failure = entry(t);
    if (failure.code !== undefined && failure.code === "TX_REJECTED" && t.outcome !== "rejected") bad();
    if (t.outcome === "rejected" && failure.code === undefined) bad();
    const tx: Record<string, unknown> = { hash: t.hash, outcome: t.outcome, notRelayed: t.notRelayed };
    if (failure.code !== undefined) { tx.code = failure.code; if (failure.diagnostic !== undefined) tx.diagnostic = failure.diagnostic; }
    return Object.freeze(tx as unknown as ZephyrRelayedTx);
  });
  if (accepted === 0 || f.complete !== (accepted === txs.length)) bad();
  if (hashes !== undefined && (hashes.length !== txs.length || txs.some((t, i) => t.hash !== hashes[i]))) bad();
  return Object.freeze({ txs: Object.freeze(txs), complete: f.complete as boolean });
}

/** Bridge result of relay_prepared ({"txs":[...],"complete":bool}); hashes: the prepared build's, when known. */
export function parseBridgeRelay(json: unknown, hashes?: readonly string[]): ZephyrRelayResult {
  return relayFromFields(parseJson(json), unexpected, (t) => {
    if (t.code !== undefined || t.diagnostic !== undefined) unexpected();
    if (t.error === undefined) return {};
    if (!isBridgeErrorIdentifier(t.error)) unexpected();
    const err = WalletErrors.fromBridge("relay", t.error as never);
    return { code: err.code, diagnostic: err.diagnostic };
  }, hashes);
}

/** Worker DTO of a relay result: code and diagnostic per failed entry. */
export function toRelayDto(r: ZephyrRelayResult): unknown {
  return {
    txs: r.txs.map((t) => {
      const o: Record<string, unknown> = { hash: t.hash, outcome: t.outcome, notRelayed: t.notRelayed };
      if (t.code !== undefined) o.code = t.code;
      if (t.diagnostic !== undefined) o.diagnostic = t.diagnostic;
      return o;
    }),
    complete: r.complete
  };
}

/** Strict worker reply of relayPrepared. */
export function fromRelayDto(value: unknown, hashes?: readonly string[]): ZephyrRelayResult {
  return relayFromFields(value, malformed, (t) => {
    if (t.error !== undefined) malformed();
    if (t.code === undefined) { if (t.diagnostic !== undefined) malformed(); return {}; }
    if (!ZephyrWalletError.isCode(t.code) || (t.diagnostic !== undefined && !ZephyrWalletError.isDiagnostic(t.diagnostic))) malformed();
    return { code: t.code as ZephyrWalletErrorCode, diagnostic: t.diagnostic as ZephyrWalletErrorDiagnostic | undefined };
  }, hashes);
}

/** Bridge result of discard_prepared: "true" when a kept build was voided, "false" when the token named none. */
export function parseBridgeDiscard(result: unknown): boolean {
  if (result === "true") return true;
  if (result === "false") return false;
  return unexpected();
}
