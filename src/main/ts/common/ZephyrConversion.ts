import type { ZephyrTxPriority } from "./ZephyrTransfer";

/**
 * Building conversions of full wallets without relay: buildConversion builds the one transaction of a
 * conversion between two V2 assets, describes it and discards it. The core builds and signs it inside the
 * module; nothing is relayed (the bridge passes relay false, a constant no caller value reaches) and no byte
 * of the built transaction leaves the module. The description is read-only plain data with bigint amounts
 * in atomic units.
 *
 * The six conversions of the V2 assets: ZPH to ZSD and back, ZPH to ZRS and back, ZSD to ZYS and back. A
 * conversion has exactly one destination, its amount is given in the source asset with at most four
 * decimals (a multiple of 10^8 atomic units), and the core never splits it. The core decides at build time
 * whether the reserve ratio allows the pair (TX_NOT_POSSIBLE/RESERVE_RATIO otherwise) and which rate
 * applies: the pricing record of the wallet's top block, named in the description by its height. The
 * amount the destination receives is the transaction's own minted amount; what the network finally
 * accepts is not proven by a build (nothing is relayed).
 */

/** The destination of a conversion: an address of the wallet's network and the amount converted, in the source asset. */
export interface ZephyrConversionDestinationInput {
  readonly address: string;
  /** atomic units of the source asset, a multiple of 10^8 (at most four decimals) */
  readonly amount: bigint;
}

/** Configuration of buildConversion; a plain object of own data properties, unknown fields reject. */
export interface ZephyrConversionConfig {
  /** the asset converted: ZPH, ZSD, ZRS or ZYS */
  readonly sourceAsset: string;
  /** the asset created; with sourceAsset one of ZPH-ZSD, ZSD-ZPH, ZPH-ZRS, ZRS-ZPH, ZSD-ZYS, ZYS-ZSD */
  readonly destinationAsset: string;
  /** exactly one destination */
  readonly destination: ZephyrConversionDestinationInput;
  /** the account whose outputs are spent */
  readonly accountIndex: number;
  /** optional: spend only outputs of these subaddresses of the account (distinct, at most 1,000) */
  readonly subaddressIndices?: ReadonlyArray<number>;
  /** default "default" */
  readonly priority?: ZephyrTxPriority;
}

/** The one (built and discarded) transaction of a conversion, as the core built it. */
export interface ZephyrConversionBuild {
  /** 64 lowercase hexadecimal characters */
  readonly hash: string;
  /** read from the built transaction's inputs */
  readonly sourceAsset: string;
  /** read from the built transaction's outputs */
  readonly destinationAsset: string;
  /** the caller's destination */
  readonly destination: { readonly address: string; readonly amount: bigint };
  /** the transaction's own burnt amount, in the source asset (equal to the destination's amount) */
  readonly amountBurnt: bigint;
  /** the transaction's own minted amount, in the destination asset: what the destination output carries */
  readonly amountMinted: bigint;
  /** the core's fee of this transaction */
  readonly fee: bigint;
  /** the asset the fee is paid in: the source asset */
  readonly feeAsset: string;
  /** amountBurnt + fee, in the source asset */
  readonly totalDebited: bigint;
  /** the core's change amount (back to the wallet, in the source asset) */
  readonly change: bigint;
  /** ring members per input, read from the built transaction */
  readonly ringSize: number;
  readonly inputs: number;
  /** outputs of the built transaction: the destination, the change and the two zero outputs the core adds to a conversion */
  readonly outputs: number;
  /** the core's transaction weight */
  readonly weight: number;
  /** the built transaction's unlock time (0) */
  readonly unlockTime: bigint;
  /** the transaction's own pricing record height: the block whose pricing record sets the rate */
  readonly pricingRecordHeight: number;
}
