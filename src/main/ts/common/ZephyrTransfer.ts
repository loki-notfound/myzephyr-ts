/**
 * Building transactions of full wallets without relay: buildTransfer builds the transactions of a
 * same-asset transfer, describes them and discards them. The core builds and signs them inside the
 * module; nothing is relayed (the bridge passes relay false, a constant no caller value reaches) and no
 * byte of a built transaction (hex, blob, signed set, key images, transaction key) leaves the module.
 * The description is read-only plain data with bigint amounts in atomic units.
 *
 * The configuration is a small explicit set, validated before the build is dispatched; unknown fields
 * reject. A destination asset other than the source asset rejects before dispatch: conversions are
 * built by buildConversion (common/ZephyrConversion.ts).
 */

/** The core's transaction priorities (0..3): the core's automatic choice, then increasing fees. */
export type ZephyrTxPriority = "default" | "unimportant" | "normal" | "elevated";

/** One destination of a transfer: an address of the wallet's network and an amount in atomic units. */
export interface ZephyrTransferDestinationInput {
  readonly address: string;
  readonly amount: bigint;
}

/** Configuration of buildTransfer; a plain object of own data properties, unknown fields reject. */
export interface ZephyrTransferConfig {
  /** the asset sent: one of the V2 assets ZPH, ZSD, ZRS, ZYS */
  readonly asset: string;
  /** optional; equal to asset (a different asset is a conversion: UNSUPPORTED_CAPABILITY/CONVERSION) */
  readonly destinationAsset?: string;
  /** 1 to 15 destinations */
  readonly destinations: ReadonlyArray<ZephyrTransferDestinationInput>;
  /** the account whose outputs are spent */
  readonly accountIndex: number;
  /** optional: spend only outputs of these subaddresses of the account (distinct, at most 1,000) */
  readonly subaddressIndices?: ReadonlyArray<number>;
  /** default "default" */
  readonly priority?: ZephyrTxPriority;
}

/** One built (and discarded) transaction as the core built it. */
export interface ZephyrBuiltTx {
  /** 64 lowercase hexadecimal characters */
  readonly hash: string;
  /** from the built transaction's inputs */
  readonly sourceAsset: string;
  /** from its outputs; equal to sourceAsset in this version */
  readonly destinationAsset: string;
  /** present only when the build needed one transaction (the core attributes destinations only then) */
  readonly destinations?: ReadonlyArray<{ readonly address: string; readonly amount: bigint }>;
  /** what this transaction sends to the destinations (change excluded) */
  readonly amount: bigint;
  /** the core's fee of this transaction */
  readonly fee: bigint;
  /** the asset the fee is paid in: the source asset */
  readonly feeAsset: string;
  /** amount + fee, in the source asset */
  readonly totalDebited: bigint;
  /** the core's change amount (back to the wallet) */
  readonly change: bigint;
  /** ring members per input, read from the built transaction */
  readonly ringSize: number;
  readonly inputs: number;
  /** outputs of the built transaction, change included */
  readonly outputs: number;
  /** the core's transaction weight */
  readonly weight: number;
  /** the built transaction's unlock time (0) */
  readonly unlockTime: bigint;
}

/** Result of buildTransfer. */
export interface ZephyrTransferBuild {
  readonly txs: ReadonlyArray<ZephyrBuiltTx>;
  /** more than one transaction was needed */
  readonly multipleTxs: boolean;
}
