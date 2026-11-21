import type { ZephyrWalletErrorCode, ZephyrWalletErrorDiagnostic } from "./ZephyrWalletError";
import type { ZephyrTransferBuild } from "./ZephyrTransfer";
import type { ZephyrConversionBuild } from "./ZephyrConversion";
import type { ZephyrSweepBuild } from "./ZephyrSweep";

/**
 * Relaying a built transaction, in two explicit steps. prepareTransfer, prepareConversion and prepareSweepUnlocked build
 * and describe exactly as buildTransfer, buildConversion and buildSweepUnlocked do, but keep what they built inside the
 * module, in the wallet's one slot, under a new opaque token; relayPrepared(token) relays exactly that kept build, and
 * discardPrepared(token) voids it. The build calls keep discarding what they build.
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

/** A prepared sweep: the token of the kept build and its description (as buildSweepUnlocked's). */
export interface ZephyrPreparedSweep {
  readonly token: string;
  readonly build: ZephyrSweepBuild;
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
