import type { ZephyrTxPriority, ZephyrBuiltTx } from "./ZephyrTransfer";

/**
 * Sweeping the unlocked balance of an account: buildSweepUnlocked builds the transactions that send everything unlocked
 * of one V2 asset in one account (or in chosen subaddresses of it) to one address, describes them and discards them;
 * prepareSweepUnlocked keeps them for relayPrepared (common/ZephyrRelay.ts). The name is the Java port's sweepUnlocked;
 * the two explicit steps replace its relay flag. The core builds and signs the transactions inside the module (the
 * core's sweep_unlocked with the relay flag fixed to false); nothing is relayed by a build and no byte of a built
 * transaction leaves the module.
 *
 * What the core sweeps: every unlocked output of the asset in the account, or in the given subaddresses, except outputs
 * worth less than the fee of spending them (the core ignores those); locked outputs stay. With an account index and no
 * subaddress indices the core sweeps every subaddress of the account that has an unlocked balance of the asset. It
 * splits a sweep into several transactions when the outputs do not fit into one. Source and destination asset are the
 * same: a converting sweep is not offered (UNSUPPORTED_CAPABILITY/CONVERSION).
 */

/** Configuration of buildSweepUnlocked and prepareSweepUnlocked; a plain object of own data properties, unknown fields reject. */
export interface ZephyrSweepUnlockedConfig {
  /** the asset swept: one of the V2 assets ZPH, ZSD, ZRS, ZYS */
  readonly asset: string;
  /** optional; equal to asset (a different asset would be a converting sweep: UNSUPPORTED_CAPABILITY/CONVERSION) */
  readonly destinationAsset?: string;
  /** the one destination: an address of the wallet's network */
  readonly address: string;
  /** required: the account whose unlocked outputs are swept (the Java port sweeps every account without it) */
  readonly accountIndex: number;
  /** optional: sweep only the outputs of these subaddresses of the account (distinct, at most 1,000) */
  readonly subaddressIndices?: ReadonlyArray<number>;
  /** default "default" */
  readonly priority?: ZephyrTxPriority;
}

/** Result of buildSweepUnlocked: the built (and discarded) transactions and their totals. */
export interface ZephyrSweepBuild {
  /**
   * one entry per transaction, as buildTransfer describes them; each carries destinations with the one address and the
   * amount that transaction sends to it
   */
  readonly txs: ReadonlyArray<ZephyrBuiltTx>;
  /** more than one transaction was needed */
  readonly multipleTxs: boolean;
  /** what the transactions send to the address together: the sum of their amounts, in the asset */
  readonly totalAmount: bigint;
  /** the sum of their fees, in the asset */
  readonly totalFee: bigint;
}
