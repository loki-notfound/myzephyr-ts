// Type check of the shipped declarations (no emit): every exported type is usable as documented.
import { createRandomWallet, ZephyrWallet, ZephyrWalletData, ZephyrWalletError, ZephyrWalletErrorCode, ZephyrWalletErrorDiagnostic, ZephyrWalletSyncResult,
  ZephyrDaemonConnection, ZephyrWalletConstructionOptions, ZephyrNetworkTypeInput, ZephyrAssetBalances, ZephyrAccountBalances,
  ZephyrAccount, ZephyrSubaddress, ZephyrAddressIndex, ZephyrAccountOptions } from "@loki-notfound/zephyr-ts";

export async function demo(): Promise<bigint> {
  const net: ZephyrNetworkTypeInput = "mainnet";
  const options: ZephyrWalletConstructionOptions = {};
  const w: ZephyrWallet = await createRandomWallet({ networkType: net, password: "x" }, options);
  const data: ZephyrWalletData = await w.getData();
  const balance: bigint = await w.getUnlockedBalance("ZSD", 0);
  const all: ZephyrAssetBalances = await w.getBalance();
  const perAccount: ZephyrAccountBalances = await w.getBalance(0);
  const zsd: bigint | undefined = perAccount.get(0)?.get("ZSD");
  const daemon: ZephyrDaemonConnection | undefined = w.getDaemonConnection();
  const result: ZephyrWalletSyncResult = await w.sync();
  const code: ZephyrWalletErrorCode = "NATIVE_ERROR";
  const diagnostic: ZephyrWalletErrorDiagnostic = "WASM_MODULE_UNVERIFIED";
  const err = new ZephyrWalletError(code, diagnostic);
  const opts: ZephyrAccountOptions = { includeSubaddresses: true };
  const accounts: ReadonlyArray<ZephyrAccount> = await w.getAccounts(opts);
  const first: ZephyrSubaddress | undefined = accounts[0].subaddresses?.[0];
  const created: ZephyrSubaddress = await w.createSubaddress(0, "label");
  const where: ZephyrAddressIndex = await w.getAddressIndex(created.address);
  const zph: bigint | undefined = created.balance.get("ZPH");
  const synced: boolean = await w.isDaemonSynced();
  await w.terminate();
  void data; void all; void zsd; void daemon; void result; void err; void first; void where; void zph; void synced;
  return balance;
}
