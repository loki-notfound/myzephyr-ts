import ZephyrWalletError from "./ZephyrWalletError";
import { MAX_SUBADDRESSES_PER_CALL, UINT32_MAX, isAddressIndex } from "./ZephyrLifecycleContract";
import { ZephyrAssetBalances, ZephyrAssetBalancesDto, fromAssetBalancesDto, parseAssetMapObject, parseSafeUintText, toAssetBalancesDto } from "./ZephyrBalances";

/**
 * Accounts and subaddresses of full wallets: the public result types, the strict parsers of the
 * bridge's fixed-format JSON and the explicit worker DTOs in both directions.
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

/** Validate account options before any native or worker call; returns includeSubaddresses. */
export function accountOptions(options: unknown): boolean {
  if (options === undefined) return false;
  if (options === null || typeof options !== "object" || Array.isArray(options)) throw new ZephyrWalletError("INVALID_CONFIG", "CONFIG_TYPE");
  for (const key of Object.keys(options)) if (key !== "includeSubaddresses") throw new ZephyrWalletError("INVALID_CONFIG", "UNKNOWN_FIELD");
  const include = (options as { includeSubaddresses?: unknown }).includeSubaddresses;
  if (include !== undefined && typeof include !== "boolean") throw new ZephyrWalletError("INVALID_CONFIG", "FIELD_TYPE");
  return include === true;
}

// ------------------------------------------------------------------ strict shapes

type Bad = () => never;

function plainObject(value: unknown, bad: Bad): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) bad();
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) bad();
  return value as Record<string, unknown>;
}

function exactKeys(fields: Record<string, unknown>, required: readonly string[], optional: readonly string[], bad: Bad): void {
  const keys = Object.keys(fields);
  for (const k of required) if (!Object.prototype.hasOwnProperty.call(fields, k)) bad();
  for (const k of keys) if (!required.includes(k) && !optional.includes(k)) bad();
}

function index(value: unknown, bad: Bad): number {
  if (!isAddressIndex(value)) bad();
  return value as number;
}

function text(value: unknown, bad: Bad): string {
  if (typeof value !== "string") bad();
  return value as string;
}

function address(value: unknown, bad: Bad): string {
  if (typeof value !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{90,110}$/.test(value)) bad();
  return value as string;
}

const SUBADDRESS_KEYS = ["accountIndex", "index", "address", "label", "balance", "unlockedBalance", "isUsed", "numUnspentOutputs"] as const;
const ACCOUNT_KEYS = ["index", "primaryAddress", "label", "subaddressCount", "balance", "unlockedBalance"] as const;

function freezeSubaddress(s: ZephyrSubaddress): ZephyrSubaddress { return Object.freeze(s); }

function freezeAccount(a: ZephyrAccount): ZephyrAccount {
  if (a.subaddresses !== undefined) Object.freeze(a.subaddresses);
  return Object.freeze(a);
}

// ------------------------------------------------------------------ bridge JSON

const unexpected: Bad = () => { throw new ZephyrWalletError("NATIVE_ERROR", "UNEXPECTED_RESULT"); };

function parseJson(value: unknown): unknown {
  if (typeof value !== "string" || (value.charAt(0) !== "{")) unexpected();
  try { return JSON.parse(value as string); } catch (err) { return unexpected(); }
}

function bridgeSubaddress(value: unknown): ZephyrSubaddress {
  const f = plainObject(value, unexpected);
  exactKeys(f, SUBADDRESS_KEYS, [], unexpected);
  if (typeof f.isUsed !== "boolean") unexpected();
  let outputs: number;
  try { outputs = parseSafeUintText(f.numUnspentOutputs); } catch (err) { return unexpected(); }
  return freezeSubaddress({ accountIndex: index(f.accountIndex, unexpected), index: index(f.index, unexpected), address: address(f.address, unexpected), label: text(f.label, unexpected),
    balance: parseAssetMapObject(f.balance), unlockedBalance: parseAssetMapObject(f.unlockedBalance), isUsed: f.isUsed as boolean, numUnspentOutputs: outputs });
}

function bridgeAccount(value: unknown, includeSubaddresses: boolean): ZephyrAccount {
  const f = plainObject(value, unexpected);
  exactKeys(f, includeSubaddresses ? [...ACCOUNT_KEYS, "subaddresses"] : ACCOUNT_KEYS, [], unexpected);
  const idx = index(f.index, unexpected);
  const count = f.subaddressCount;
  if (typeof count !== "number" || !Number.isInteger(count) || count < 1 || count > UINT32_MAX + 1) unexpected();
  const account: { -readonly [K in keyof ZephyrAccount]: ZephyrAccount[K] } = { index: idx, primaryAddress: address(f.primaryAddress, unexpected), label: text(f.label, unexpected),
    subaddressCount: count as number, balance: parseAssetMapObject(f.balance), unlockedBalance: parseAssetMapObject(f.unlockedBalance) };
  if (includeSubaddresses) {
    if (!Array.isArray(f.subaddresses) || f.subaddresses.length !== count) unexpected();
    const subs = (f.subaddresses as unknown[]).map(bridgeSubaddress);
    subs.forEach((s, i) => { if (s.accountIndex !== idx || s.index !== i) unexpected(); });
    if (subs[0].address !== account.primaryAddress || subs[0].label !== account.label) unexpected();
    account.subaddresses = subs;
  }
  return freezeAccount(account);
}

/** Bridge {"accounts":[...]}: every account in index order. */
export function parseBridgeAccounts(json: unknown, includeSubaddresses: boolean): ReadonlyArray<ZephyrAccount> {
  const f = plainObject(parseJson(json), unexpected);
  exactKeys(f, ["accounts"], [], unexpected);
  if (!Array.isArray(f.accounts) || f.accounts.length < 1) unexpected();
  const accounts = (f.accounts as unknown[]).map((a) => bridgeAccount(a, includeSubaddresses));
  accounts.forEach((a, i) => { if (a.index !== i) unexpected(); });
  return Object.freeze(accounts);
}

/** Bridge account JSON of the given account index. */
export function parseBridgeAccount(json: unknown, accountIdx: number | undefined, includeSubaddresses: boolean): ZephyrAccount {
  const account = bridgeAccount(parseJson(json), includeSubaddresses);
  if (accountIdx !== undefined && account.index !== accountIdx) unexpected();
  return account;
}

/** Bridge {"subaddresses":[...]}: the requested subaddresses of one account in the requested order (all: index order). */
export function parseBridgeSubaddresses(json: unknown, accountIdx: number, indices: readonly number[] | undefined): ReadonlyArray<ZephyrSubaddress> {
  const f = plainObject(parseJson(json), unexpected);
  exactKeys(f, ["subaddresses"], [], unexpected);
  if (!Array.isArray(f.subaddresses) || f.subaddresses.length > MAX_SUBADDRESSES_PER_CALL) unexpected();
  const subs = (f.subaddresses as unknown[]).map(bridgeSubaddress);
  if (indices !== undefined ? subs.length !== indices.length : subs.length < 1) unexpected();
  subs.forEach((s, i) => { if (s.accountIndex !== accountIdx || s.index !== (indices !== undefined ? indices[i] : i)) unexpected(); });
  return Object.freeze(subs);
}

/** Bridge subaddress JSON of a subaddress created in the given account. */
export function parseBridgeSubaddress(json: unknown, accountIdx: number): ZephyrSubaddress {
  const s = bridgeSubaddress(parseJson(json));
  if (s.accountIndex !== accountIdx) unexpected();
  return s;
}

/** Bridge {"accountIndex":a,"index":i} of get_address_index. */
export function parseBridgeAddressIndex(json: unknown): ZephyrAddressIndex {
  const f = plainObject(parseJson(json), unexpected);
  exactKeys(f, ["accountIndex", "index"], [], unexpected);
  return Object.freeze({ accountIndex: index(f.accountIndex, unexpected), subaddressIndex: index(f.index, unexpected) });
}

// ------------------------------------------------------------------ worker DTOs

export interface ZephyrSubaddressDto {
  readonly accountIndex: number; readonly index: number; readonly address: string; readonly label: string;
  readonly balance: ZephyrAssetBalancesDto; readonly unlockedBalance: ZephyrAssetBalancesDto; readonly isUsed: boolean; readonly numUnspentOutputs: string;
}
export interface ZephyrAccountDto {
  readonly index: number; readonly primaryAddress: string; readonly label: string; readonly subaddressCount: number;
  readonly balance: ZephyrAssetBalancesDto; readonly unlockedBalance: ZephyrAssetBalancesDto; readonly subaddresses?: ReadonlyArray<ZephyrSubaddressDto>;
}
export interface ZephyrAddressIndexDto { readonly accountIndex: number; readonly subaddressIndex: number }

export function toSubaddressDto(s: ZephyrSubaddress): ZephyrSubaddressDto {
  return { accountIndex: s.accountIndex, index: s.index, address: s.address, label: s.label, balance: toAssetBalancesDto(s.balance), unlockedBalance: toAssetBalancesDto(s.unlockedBalance),
    isUsed: s.isUsed, numUnspentOutputs: String(s.numUnspentOutputs) };
}

export function toAccountDto(a: ZephyrAccount): ZephyrAccountDto {
  const dto = { index: a.index, primaryAddress: a.primaryAddress, label: a.label, subaddressCount: a.subaddressCount, balance: toAssetBalancesDto(a.balance), unlockedBalance: toAssetBalancesDto(a.unlockedBalance) };
  return a.subaddresses === undefined ? dto : Object.assign(dto, { subaddresses: a.subaddresses.map(toSubaddressDto) });
}

export function toAddressIndexDto(i: ZephyrAddressIndex): ZephyrAddressIndexDto {
  return { accountIndex: i.accountIndex, subaddressIndex: i.subaddressIndex };
}

const malformed: Bad = () => { throw new ZephyrWalletError("MALFORMED_MESSAGE", "MESSAGE_SHAPE"); };

function dtoSubaddress(value: unknown): ZephyrSubaddress {
  const f = plainObject(value, malformed);
  exactKeys(f, SUBADDRESS_KEYS, [], malformed);
  if (typeof f.isUsed !== "boolean") malformed();
  let outputs: number;
  try { outputs = parseSafeUintText(f.numUnspentOutputs); } catch (err) { return malformed(); }
  return freezeSubaddress({ accountIndex: index(f.accountIndex, malformed), index: index(f.index, malformed), address: address(f.address, malformed), label: text(f.label, malformed),
    balance: fromAssetBalancesDto(f.balance), unlockedBalance: fromAssetBalancesDto(f.unlockedBalance), isUsed: f.isUsed as boolean, numUnspentOutputs: outputs });
}

function dtoAccount(value: unknown, includeSubaddresses: boolean): ZephyrAccount {
  const f = plainObject(value, malformed);
  exactKeys(f, includeSubaddresses ? [...ACCOUNT_KEYS, "subaddresses"] : ACCOUNT_KEYS, [], malformed);
  const idx = index(f.index, malformed);
  const count = f.subaddressCount;
  if (typeof count !== "number" || !Number.isInteger(count) || count < 1 || count > UINT32_MAX + 1) malformed();
  const account: { -readonly [K in keyof ZephyrAccount]: ZephyrAccount[K] } = { index: idx, primaryAddress: address(f.primaryAddress, malformed), label: text(f.label, malformed),
    subaddressCount: count as number, balance: fromAssetBalancesDto(f.balance), unlockedBalance: fromAssetBalancesDto(f.unlockedBalance) };
  if (includeSubaddresses) {
    if (!Array.isArray(f.subaddresses) || f.subaddresses.length !== count || count > MAX_SUBADDRESSES_PER_CALL) malformed();
    const subs = (f.subaddresses as unknown[]).map(dtoSubaddress);
    subs.forEach((s, i) => { if (s.accountIndex !== idx || s.index !== i) malformed(); });
    account.subaddresses = subs;
  }
  return freezeAccount(account);
}

/** Strict worker reply of getAccounts. */
export function fromAccountsDto(value: unknown, includeSubaddresses: boolean, maxAccounts: number): ReadonlyArray<ZephyrAccount> {
  if (!Array.isArray(value) || value.length < 1 || value.length > maxAccounts) malformed();
  const accounts = (value as unknown[]).map((a) => dtoAccount(a, includeSubaddresses));
  accounts.forEach((a, i) => { if (a.index !== i) malformed(); });
  if (includeSubaddresses && accounts.reduce((n, a) => n + a.subaddressCount, 0) > MAX_SUBADDRESSES_PER_CALL) malformed();
  return Object.freeze(accounts);
}

/** Strict worker reply of getAccount and createAccount. */
export function fromAccountDto(value: unknown, accountIdx: number | undefined, includeSubaddresses: boolean): ZephyrAccount {
  const account = dtoAccount(value, includeSubaddresses);
  if (accountIdx !== undefined && account.index !== accountIdx) malformed();
  return account;
}

/** Strict worker reply of getSubaddresses. */
export function fromSubaddressesDto(value: unknown, accountIdx: number, indices: readonly number[] | undefined): ReadonlyArray<ZephyrSubaddress> {
  if (!Array.isArray(value) || value.length > MAX_SUBADDRESSES_PER_CALL) malformed();
  const subs = (value as unknown[]).map(dtoSubaddress);
  if (indices !== undefined ? subs.length !== indices.length : subs.length < 1) malformed();
  subs.forEach((s, i) => { if (s.accountIndex !== accountIdx || s.index !== (indices !== undefined ? indices[i] : i)) malformed(); });
  return Object.freeze(subs);
}

/** Strict worker reply of createSubaddress. */
export function fromSubaddressDto(value: unknown, accountIdx: number): ZephyrSubaddress {
  const s = dtoSubaddress(value);
  if (s.accountIndex !== accountIdx) malformed();
  return s;
}

/** Strict worker reply of getAddressIndex. */
export function fromAddressIndexDto(value: unknown): ZephyrAddressIndex {
  const f = plainObject(value, malformed);
  exactKeys(f, ["accountIndex", "subaddressIndex"], [], malformed);
  return Object.freeze({ accountIndex: index(f.accountIndex, malformed), subaddressIndex: index(f.subaddressIndex, malformed) });
}
