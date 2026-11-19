/**
 * Balance shapes of the read-only daemon access:
 * - wallet map: ReadonlyMap<asset, bigint> with exactly the core's keys (its zero entries included);
 * - account map: ReadonlyMap<subaddress index, ReadonlyMap<asset, bigint>> with the core's keys only;
 *   a subaddress without an entry in the core's map stays absent;
 * - asset-first scalar: bigint for (asset, account[, subaddress]).
 * Bridge JSON carries decimal strings; the worker boundary carries explicit DTOs (arrays of pairs
 * with decimal strings and numeric subaddress indices). Every value is validated strictly on
 * receipt; nothing absent becomes zero.
 */
export type ZephyrAssetBalances = ReadonlyMap<string, bigint>;
export type ZephyrAccountBalances = ReadonlyMap<number, ZephyrAssetBalances>;
