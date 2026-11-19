import type { ZephyrAssetBalances } from "./ZephyrBalances";

/**
 * Accounts and subaddresses of full wallets: the public result types. The strict parsers of the
 * bridge's fixed-format JSON and the explicit worker DTOs in both directions are internal
 * (common/ZephyrAccountsInternal.ts).
 *
 * Results are read-only plain data: frozen objects and arrays with numbers, strings, booleans and
 * the balance maps by asset (ReadonlyMap<string, bigint>, the core's keys: absent keys stay absent,
 * reported zeros stay 0n, historical asset names pass through). No inherited model class appears in
 * a result. An account's label is the label of its subaddress 0, where the core stores it.
 *
 * Labels are caller text stored in the wallet. They are returned only in the label fields of these
 * results; the SDK never copies a label into an error or a log line.
 */

/** One subaddress of a full wallet. */
export interface ZephyrSubaddress {
  readonly accountIndex: number;
  readonly index: number;
  readonly address: string;
  /** "" when none was set */
  readonly label: string;
  /** balance by asset of the outputs received at this subaddress (the core's map; empty without outputs) */
  readonly balance: ZephyrAssetBalances;
  readonly unlockedBalance: ZephyrAssetBalances;
  /** whether the wallet has received any output at this subaddress */
  readonly isUsed: boolean;
  /** unspent outputs at this subaddress as the core counts them */
  readonly numUnspentOutputs: number;
}

/** One account of a full wallet. */
export interface ZephyrAccount {
  readonly index: number;
  /** the address of subaddress 0 of the account */
  readonly primaryAddress: string;
  /** the label of subaddress 0 ("Primary account" for account 0 of a new wallet; "" when none was set) */
  readonly label: string;
  /** number of subaddresses of the account (at least 1); page through them with getSubaddresses */
  readonly subaddressCount: number;
  /** sum over the account's subaddresses by asset (the core's map) */
  readonly balance: ZephyrAssetBalances;
  readonly unlockedBalance: ZephyrAssetBalances;
  /** the account's subaddresses in index order, only when requested */
  readonly subaddresses?: ReadonlyArray<ZephyrSubaddress>;
}

/** The account and subaddress an address of this wallet belongs to. */
export interface ZephyrAddressIndex {
  readonly accountIndex: number;
  readonly subaddressIndex: number;
}

/** Options of getAccounts and getAccount. */
export interface ZephyrAccountOptions {
  /** include every subaddress of each returned account (bounded, see getAccounts) */
  readonly includeSubaddresses?: boolean;
}
