/**
 * The reserve of the Zephyr network as a full wallet reads it from its daemon (ZephyrWallet.getReserveInfo),
 * with the field names of the Java port's ZephyrReserveInfo.
 *
 * Amounts are bigint in atomic units (10^12 per unit); the core computes them as unsigned 128-bit integers, so
 * they can exceed 2^64 and are kept exactly. The two ratios are dimensionless and come as the shortest decimal
 * text (no exponent, independent of any locale) that reads back as exactly the core's double; parse them with
 * Number() or a decimal library. hfVersion is the hard fork version the daemon reports.
 *
 * assetsMa and equityMa are 0 on every hard fork after version 4 (the core's code path sets them to 0): do not
 * divide by them. When no ZSD circulates, both ratios and the two yield values are 0 (not infinite). A failed
 * read of the pricing record rejects with DAEMON_ERROR/PRICING_RECORD_UNAVAILABLE instead of returning zeros.
 * Internal parsers and worker data shapes are in common/ZephyrReserveInternal.ts.
 */
export interface ZephyrReserveInfo {
  /** ZPH held in the reserve (atomic ZPH) */
  readonly zephReserve: bigint;
  /** ZSD in circulation (atomic ZSD) */
  readonly numStables: bigint;
  /** ZRS in circulation (atomic ZRS) */
  readonly numReserves: bigint;
  /** the reserve's ZPH valued at the oracle's spot price (atomic units of the stable asset) */
  readonly assets: bigint;
  /** the same at the moving-average price; 0 on the current hard fork */
  readonly assetsMa: bigint;
  /** the stable asset outstanding, equal to numStables */
  readonly liabilities: bigint;
  /** assets minus liabilities, or 0 when negative */
  readonly equity: bigint;
  /** the moving-average equity; 0 on the current hard fork */
  readonly equityMa: bigint;
  /** assets / liabilities at the spot price, for example "2.16777771" (216.78 %) */
  readonly reserveRatio: string;
  /** the moving average of that ratio over the pricing record history (0 while the history is too short) */
  readonly reserveRatioMa: string;
  /** the hard fork version the daemon is on */
  readonly hfVersion: number;
  /** ZYS in circulation (atomic ZYS) */
  readonly zyieldCirc: bigint;
  /** the yield reserve (the supply's YIELD entry) */
  readonly zyieldRsv: bigint;
}
