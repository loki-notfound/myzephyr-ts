// The construction configuration types against their run-time validation, from one table of object literals.
// Each literal is checked twice: by the TypeScript compiler against the shipped declarations (this file is
// type-checked under strict by bin/test_package.sh and bin/check_guide.sh) and at run time against the
// validation, through the package entry (runConfigCases, run by both scripts). A literal is written as
//   accepted.<fn>(literal)                     the type accepts it and so does the validation
//   rejected.<fn>(literal, "CODE/DIAGNOSTIC")  after a ts-expect-error line: the type rejects it and the
//                                              validation rejects it with that pair
//   undeclared.<fn>(literal)                   after a ts-expect-error line: a field the validation accepts with
//                                              its one value, without effect, which the type leaves out
//   runtimeOnly.<fn>(literal, "CODE/DIAG")     the type accepts it; a value domain or a rule between fields that
//                                              only the validation checks rejects it
// A type that accepts a literal it should reject leaves its ts-expect-error unused, and a type that rejects a
// literal it should accept reports an error: both fail the type check. A validation that disagrees with the
// stated outcome fails the run. Each run passes an already aborted signal, so an accepted configuration ends
// with NATIVE_ERROR/CONSTRUCTION_ABORTED after the whole validation and before any worker, native call or
// request; nothing is constructed.
import {
  createRandomWallet, restoreWalletFromSeed, restoreWalletFromKeys, createKeysWallet, openWalletData, validateAddress, ZephyrWalletError,
  ZephyrRandomWalletConfig, ZephyrSeedWalletConfig, ZephyrKeysWalletConfig, ZephyrKeysOnlyWalletConfig, ZephyrOpenWalletConfig
} from "@loki-notfound/zephyr-ts";

type Fn = "random" | "seed" | "keys" | "keysOnly" | "open";
interface Case { readonly fn: Fn; readonly config: unknown; readonly expect: string; readonly kind: "accepted" | "rejected" | "undeclared" | "runtimeOnly"; readonly label: string }
const CASES: Case[] = [];
const ACCEPTED = "NATIVE_ERROR/CONSTRUCTION_ABORTED";
/** a case is named by its function, its kind and its position among the cases of that function and kind */
function add(fn: Fn, kind: Case["kind"], config: unknown, expect: string): void {
  CASES.push({ fn, kind, config, expect, label: fn + " " + kind + " #" + (CASES.filter((c) => c.fn === fn && c.kind === kind).length + 1) });
}

const accepted = {
  random: (c: ZephyrRandomWalletConfig) => add("random", "accepted", c, ACCEPTED),
  seed: (c: ZephyrSeedWalletConfig) => add("seed", "accepted", c, ACCEPTED),
  keys: (c: ZephyrKeysWalletConfig) => add("keys", "accepted", c, ACCEPTED),
  keysOnly: (c: ZephyrKeysOnlyWalletConfig) => add("keysOnly", "accepted", c, ACCEPTED),
  open: (c: ZephyrOpenWalletConfig) => add("open", "accepted", c, ACCEPTED)
};
const rejected = {
  random: (c: ZephyrRandomWalletConfig, e: string) => add("random", "rejected", c, e),
  seed: (c: ZephyrSeedWalletConfig, e: string) => add("seed", "rejected", c, e),
  keys: (c: ZephyrKeysWalletConfig, e: string) => add("keys", "rejected", c, e),
  keysOnly: (c: ZephyrKeysOnlyWalletConfig, e: string) => add("keysOnly", "rejected", c, e),
  open: (c: ZephyrOpenWalletConfig, e: string) => add("open", "rejected", c, e)
};
const undeclared = {
  random: (c: ZephyrRandomWalletConfig) => add("random", "undeclared", c, ACCEPTED),
  seed: (c: ZephyrSeedWalletConfig) => add("seed", "undeclared", c, ACCEPTED),
  keys: (c: ZephyrKeysWalletConfig) => add("keys", "undeclared", c, ACCEPTED),
  keysOnly: (c: ZephyrKeysOnlyWalletConfig) => add("keysOnly", "undeclared", c, ACCEPTED),
  open: (c: ZephyrOpenWalletConfig) => add("open", "undeclared", c, ACCEPTED)
};
const runtimeOnly = {
  random: (c: ZephyrRandomWalletConfig, e: string) => add("random", "runtimeOnly", c, e),
  seed: (c: ZephyrSeedWalletConfig, e: string) => add("seed", "runtimeOnly", c, e),
  keys: (c: ZephyrKeysWalletConfig, e: string) => add("keys", "runtimeOnly", c, e),
  keysOnly: (c: ZephyrKeysOnlyWalletConfig, e: string) => add("keysOnly", "runtimeOnly", c, e),
  open: (c: ZephyrOpenWalletConfig, e: string) => add("open", "runtimeOnly", c, e)
};

// a syntactically valid 25-word seed (its checksum is not checked before the native call) and key material of
// the right form; none of them is used to build a wallet
const SEED = Array(25).fill("abbey").join(" ");
const KEY = "0".repeat(63) + "1";
const ADDRESS = "Z".repeat(95);
const BYTES = new Uint8Array([1, 2, 3]);

// ------------------------------------------------------------------------------------------- createRandomWallet
accepted.random({ networkType: "mainnet" });
accepted.random({ networkType: 0 });
accepted.random({ networkType: "stagenet", password: "p", language: "English", accountLookahead: 2, subaddressLookahead: 3, proxyToWorker: false });
accepted.random({ networkType: 1, server: "" });
accepted.random({ networkType: 0, server: "http://127.0.0.1:1" });
accepted.random({ networkType: 0, server: { uri: "https://127.0.0.1:1/base" } });
// @ts-expect-error a seed belongs to restoreWalletFromSeed
rejected.random({ networkType: 0, seed: SEED }, "INVALID_CONFIG/CREATE_MODE");
// @ts-expect-error keys belong to restoreWalletFromKeys
rejected.random({ networkType: 0, privateSpendKey: KEY }, "INVALID_CONFIG/CREATE_MODE");
// @ts-expect-error a random wallet takes no restore height
rejected.random({ networkType: 0, restoreHeight: 5 }, "INVALID_CONFIG/RANDOM_RESTORE_HEIGHT");
// @ts-expect-error a seed offset needs a seed
rejected.random({ networkType: 0, seedOffset: "x" }, "INVALID_CONFIG/SEED_OFFSET");
// @ts-expect-error networkType is required
rejected.random({ password: "p" }, "INVALID_CONFIG/NETWORK_TYPE");
// @ts-expect-error not a network type
rejected.random({ networkType: "regtest" }, "INVALID_CONFIG/NETWORK_TYPE");
// @ts-expect-error a password is a string
rejected.random({ networkType: 0, password: 5 }, "INVALID_CONFIG/FIELD_TYPE");
// @ts-expect-error proxyToWorker is a boolean
rejected.random({ networkType: 0, proxyToWorker: "yes" }, "INVALID_CONFIG/FIELD_TYPE");
// @ts-expect-error a lookahead is a number
rejected.random({ networkType: 0, accountLookahead: "2", subaddressLookahead: 3 }, "INVALID_CONFIG/LOOKAHEAD_RANGE");
// @ts-expect-error unknown field
rejected.random({ networkType: 0, colour: "red" }, "INVALID_CONFIG/UNKNOWN_FIELD");
// @ts-expect-error keysData belongs to openWalletData
rejected.random({ networkType: 0, keysData: BYTES }, "INVALID_CONFIG/UNKNOWN_FIELD");
// @ts-expect-error a file path
rejected.random({ networkType: 0, path: "wallet" }, "UNSUPPORTED_CAPABILITY/FILE_PATH");
// @ts-expect-error regtest is not supported
rejected.random({ networkType: 0, regtest: true }, "UNSUPPORTED_CAPABILITY/REGTEST");
// @ts-expect-error multisig is not supported
rejected.random({ networkType: 0, isMultisig: true }, "UNSUPPORTED_CAPABILITY/MULTISIG");
// @ts-expect-error saving to a file is not supported
rejected.random({ networkType: 0, saveCurrent: true }, "UNSUPPORTED_CAPABILITY/SAVE_CURRENT");
// @ts-expect-error every daemon is trusted
rejected.random({ networkType: 0, isTrustedDaemon: false }, "UNSUPPORTED_CAPABILITY/UNTRUSTED_DAEMON");
// @ts-expect-error every daemon is trusted, also with a server
rejected.random({ networkType: 0, server: "http://127.0.0.1:1", isTrustedDaemon: false }, "UNSUPPORTED_CAPABILITY/UNTRUSTED_DAEMON");
// @ts-expect-error a connection manager is not supported
rejected.random({ networkType: 0, connectionManager: {} }, "UNSUPPORTED_CAPABILITY/CONFIG_FIELD");
// @ts-expect-error a file system is not supported
rejected.random({ networkType: 0, fs: {} }, "UNSUPPORTED_CAPABILITY/CONFIG_FIELD");
// @ts-expect-error a command line is not supported
rejected.random({ networkType: 0, cmd: ["x"] }, "UNSUPPORTED_CAPABILITY/CONFIG_FIELD");
// @ts-expect-error certificate settings are not supported
rejected.random({ networkType: 0, rejectUnauthorized: false }, "UNSUPPORTED_CAPABILITY/CONFIG_FIELD");
// @ts-expect-error a server is a string or an object with uri
rejected.random({ networkType: 0, server: 5 }, "INVALID_CONFIG/FIELD_TYPE");
// @ts-expect-error credentials in the server object
rejected.random({ networkType: 0, server: { uri: "http://127.0.0.1:1", username: "u", password: "p" } }, "UNSUPPORTED_CAPABILITY/DAEMON_CREDENTIALS");
// @ts-expect-error a proxy in the server object
rejected.random({ networkType: 0, server: { uri: "http://127.0.0.1:1", proxyUri: "http://127.0.0.1:2" } }, "UNSUPPORTED_CAPABILITY/DAEMON_PROXY");
// @ts-expect-error an untrusted server object
rejected.random({ networkType: 0, server: { uri: "http://127.0.0.1:1", trusted: false } }, "UNSUPPORTED_CAPABILITY/UNTRUSTED_DAEMON");
// @ts-expect-error path "" has no effect
undeclared.random({ networkType: 0, path: "" });
// @ts-expect-error isTrustedDaemon true has no effect
undeclared.random({ networkType: 0, isTrustedDaemon: true });
// @ts-expect-error regtest false has no effect
undeclared.random({ networkType: 0, regtest: false });
// @ts-expect-error isMultisig false has no effect
undeclared.random({ networkType: 0, isMultisig: false });
// @ts-expect-error saveCurrent false has no effect
undeclared.random({ networkType: 0, saveCurrent: false });
// @ts-expect-error trusted true in the server object has no effect
undeclared.random({ networkType: 0, server: { uri: "http://127.0.0.1:1", trusted: true } });
runtimeOnly.random({ networkType: 0, accountLookahead: 2 }, "INVALID_CONFIG/LOOKAHEAD_PAIR");
runtimeOnly.random({ networkType: 0, accountLookahead: 0, subaddressLookahead: 3 }, "INVALID_CONFIG/LOOKAHEAD_RANGE");
runtimeOnly.random({ networkType: 0, accountLookahead: 200, subaddressLookahead: 200 }, "INVALID_CONFIG/LOOKAHEAD_LIMIT");
runtimeOnly.random({ networkType: 0, server: "ftp://127.0.0.1:1" }, "INVALID_CONFIG/DAEMON_ADDRESS");

// ---------------------------------------------------------------------------------------- restoreWalletFromSeed
accepted.seed({ networkType: 0, seed: SEED });
accepted.seed({ networkType: "testnet", password: "p", seed: SEED, seedOffset: "o", restoreHeight: 10, accountLookahead: 2, subaddressLookahead: 3, proxyToWorker: true, server: "http://127.0.0.1:1" });
// @ts-expect-error the seed is required
rejected.seed({ networkType: 0 }, "INVALID_CONFIG/CREATE_MODE");
// @ts-expect-error keys besides the seed
rejected.seed({ networkType: 0, seed: SEED, privateViewKey: KEY }, "INVALID_CONFIG/SEED_AND_KEYS");
// @ts-expect-error a seed restore takes no language
rejected.seed({ networkType: 0, seed: SEED, language: "English" }, "INVALID_CONFIG/SEED_LANGUAGE");
// @ts-expect-error a seed is a string
rejected.seed({ networkType: 0, seed: 25 }, "INVALID_CONFIG/FIELD_TYPE");
// @ts-expect-error a restore height is a number
rejected.seed({ networkType: 0, seed: SEED, restoreHeight: "10" }, "INVALID_CONFIG/RESTORE_HEIGHT_RANGE");
// @ts-expect-error cacheData belongs to openWalletData
rejected.seed({ networkType: 0, seed: SEED, cacheData: BYTES }, "INVALID_CONFIG/UNKNOWN_FIELD");
// @ts-expect-error path "" has no effect
undeclared.seed({ networkType: 0, seed: SEED, path: "" });
// @ts-expect-error isTrustedDaemon true has no effect
undeclared.seed({ networkType: 0, seed: SEED, server: "http://127.0.0.1:1", isTrustedDaemon: true });
runtimeOnly.seed({ networkType: 0, seed: "abbey abbey" }, "INVALID_RECOVERY_MATERIAL/SEED_WORD_COUNT");
runtimeOnly.seed({ networkType: 0, seed: "   " }, "INVALID_RECOVERY_MATERIAL/SEED_EMPTY");
runtimeOnly.seed({ networkType: 0, seed: SEED, restoreHeight: -1 }, "INVALID_CONFIG/RESTORE_HEIGHT_RANGE");

// ---------------------------------------------------------------------------------------- restoreWalletFromKeys
accepted.keys({ networkType: 0, primaryAddress: ADDRESS, privateViewKey: KEY });
accepted.keys({ networkType: 0, privateSpendKey: KEY });
accepted.keys({ networkType: 0, primaryAddress: ADDRESS, privateViewKey: KEY, privateSpendKey: KEY, password: "p", restoreHeight: 1, language: "English",
  accountLookahead: 1, subaddressLookahead: 1, proxyToWorker: false, server: { uri: "http://127.0.0.1:1" } });
// @ts-expect-error a seed belongs to restoreWalletFromSeed
rejected.keys({ networkType: 0, seed: SEED }, "INVALID_CONFIG/CREATE_MODE");
// @ts-expect-error a key is a string
rejected.keys({ networkType: 0, privateSpendKey: 1 }, "INVALID_CONFIG/FIELD_TYPE");
// @ts-expect-error a seed offset needs a seed
rejected.keys({ networkType: 0, privateSpendKey: KEY, seedOffset: "o" }, "INVALID_CONFIG/SEED_OFFSET");
// @ts-expect-error unknown field
rejected.keys({ networkType: 0, privateSpendKey: KEY, publicViewKey: KEY }, "INVALID_CONFIG/UNKNOWN_FIELD");
// @ts-expect-error regtest false has no effect
undeclared.keys({ networkType: 0, privateSpendKey: KEY, regtest: false });
runtimeOnly.keys({ networkType: 0 }, "INVALID_CONFIG/CREATE_MODE");
runtimeOnly.keys({ networkType: 0, privateViewKey: KEY }, "INVALID_RECOVERY_MATERIAL/VIEW_KEY_WITHOUT_ADDRESS");
runtimeOnly.keys({ networkType: 0, privateSpendKey: "xyz" }, "INVALID_RECOVERY_MATERIAL/KEY_FORMAT");
runtimeOnly.keys({ networkType: 0, privateSpendKey: " " }, "INVALID_RECOVERY_MATERIAL/KEY_EMPTY");

// ---------------------------------------------------------------------------------------------- createKeysWallet
accepted.keysOnly({ networkType: 0 });
accepted.keysOnly({ networkType: 0, language: "English", proxyToWorker: false });
accepted.keysOnly({ networkType: 0, seed: SEED, seedOffset: "o" });
accepted.keysOnly({ networkType: 0, primaryAddress: ADDRESS, privateViewKey: KEY, privateSpendKey: KEY, language: "English" });
accepted.keysOnly({ networkType: 0, privateSpendKey: KEY });
accepted.keysOnly({ networkType: 0, password: "p", seed: SEED });
// @ts-expect-error a keys-only wallet has no restore height
rejected.keysOnly({ networkType: 0, seed: SEED, restoreHeight: 1 }, "UNSUPPORTED_CAPABILITY/KEYS_ONLY_RESTORE_HEIGHT");
// @ts-expect-error a keys-only wallet has no lookahead
rejected.keysOnly({ networkType: 0, accountLookahead: 1, subaddressLookahead: 1 }, "UNSUPPORTED_CAPABILITY/KEYS_ONLY_LOOKAHEAD");
// @ts-expect-error a keys-only wallet takes no daemon
rejected.keysOnly({ networkType: 0, server: "http://127.0.0.1:1" }, "UNSUPPORTED_CAPABILITY/KEYS_ONLY_DAEMON");
// @ts-expect-error a seed with keys
rejected.keysOnly({ networkType: 0, seed: SEED, privateSpendKey: KEY }, "INVALID_CONFIG/SEED_AND_KEYS");
// @ts-expect-error a seed with a language
rejected.keysOnly({ networkType: 0, seed: SEED, language: "English" }, "INVALID_CONFIG/SEED_LANGUAGE");
// @ts-expect-error a seed offset needs a seed
rejected.keysOnly({ networkType: 0, privateSpendKey: KEY, seedOffset: "o" }, "INVALID_CONFIG/SEED_OFFSET");
// @ts-expect-error networkType is required
rejected.keysOnly({ seed: SEED }, "INVALID_CONFIG/NETWORK_TYPE");
// @ts-expect-error a file path
rejected.keysOnly({ networkType: 0, path: "wallet" }, "UNSUPPORTED_CAPABILITY/FILE_PATH");
// @ts-expect-error path "" has no effect
undeclared.keysOnly({ networkType: 0, path: "" });
// @ts-expect-error saveCurrent false has no effect
undeclared.keysOnly({ networkType: 0, seed: SEED, saveCurrent: false });
runtimeOnly.keysOnly({ networkType: 0, privateViewKey: KEY }, "INVALID_RECOVERY_MATERIAL/VIEW_KEY_WITHOUT_ADDRESS");
runtimeOnly.keysOnly({ networkType: 0, seed: "abbey" }, "INVALID_RECOVERY_MATERIAL/SEED_WORD_COUNT");

// ------------------------------------------------------------------------------------------------ openWalletData
accepted.open({ networkType: 0, keysData: BYTES });
accepted.open({ networkType: "mainnet", password: "p", keysData: BYTES, cacheData: new Uint8Array(0), proxyToWorker: false, server: "http://127.0.0.1:1" });
// @ts-expect-error the keys bytes are required
rejected.open({ networkType: 0, cacheData: BYTES }, "INVALID_WALLET_DATA/WALLET_BYTES");
// @ts-expect-error the keys bytes are a Uint8Array
rejected.open({ networkType: 0, keysData: [1, 2, 3] }, "INVALID_WALLET_DATA/WALLET_BYTES");
// @ts-expect-error opening takes no seed
rejected.open({ networkType: 0, keysData: BYTES, seed: SEED }, "INVALID_CONFIG/UNKNOWN_FIELD");
// @ts-expect-error opening takes no lookahead
rejected.open({ networkType: 0, keysData: BYTES, accountLookahead: 1, subaddressLookahead: 1 }, "INVALID_CONFIG/UNKNOWN_FIELD");
// @ts-expect-error opening takes no restore height
rejected.open({ networkType: 0, keysData: BYTES, restoreHeight: 1 }, "INVALID_CONFIG/UNKNOWN_FIELD");
// @ts-expect-error networkType is required
rejected.open({ keysData: BYTES }, "INVALID_CONFIG/NETWORK_TYPE");
// @ts-expect-error a file path
rejected.open({ networkType: 0, keysData: BYTES, path: "wallet" }, "UNSUPPORTED_CAPABILITY/FILE_PATH");
// @ts-expect-error a file system is not supported
rejected.open({ networkType: 0, keysData: BYTES, fs: {} }, "UNSUPPORTED_CAPABILITY/CONFIG_FIELD");
// @ts-expect-error path "" has no effect
undeclared.open({ networkType: 0, keysData: BYTES, path: "" });
// @ts-expect-error isTrustedDaemon true has no effect
undeclared.open({ networkType: 0, keysData: BYTES, isTrustedDaemon: true });
runtimeOnly.open({ networkType: 0, keysData: new Uint8Array(0) }, "INVALID_WALLET_DATA/WALLET_BYTES");

// ------------------------------------------------------------------------------------------------ validateAddress
// the declared parameter is a string; the run-time check is unchanged and still rejects anything else
async function validateAddressTypes(): Promise<string[]> {
  const out: string[] = [];
  // @ts-expect-error the address is a string
  try { await validateAddress(5, "mainnet"); out.push("validateAddress(5) accepted"); } catch (e) { if (pair(e) !== "INVALID_ADDRESS/ADDRESS_TYPE") out.push("validateAddress(5): " + pair(e)); }
  try { await validateAddress("", "mainnet"); out.push("validateAddress(\"\") accepted"); } catch (e) { if (pair(e) !== "INVALID_ADDRESS/ADDRESS_TYPE") out.push("validateAddress(\"\"): " + pair(e)); }
  return out;
}

function pair(e: unknown): string {
  return e instanceof ZephyrWalletError ? e.code + (e.diagnostic ? "/" + e.diagnostic : "") : "untyped";
}

const RUN = {
  random: (c: unknown, o: { signal: AbortSignal }) => createRandomWallet(c as ZephyrRandomWalletConfig, o),
  seed: (c: unknown, o: { signal: AbortSignal }) => restoreWalletFromSeed(c as ZephyrSeedWalletConfig, o),
  keys: (c: unknown, o: { signal: AbortSignal }) => restoreWalletFromKeys(c as ZephyrKeysWalletConfig, o),
  keysOnly: (c: unknown, o: { signal: AbortSignal }) => createKeysWallet(c as ZephyrKeysOnlyWalletConfig, o),
  open: (c: unknown, o: { signal: AbortSignal }) => openWalletData(c as ZephyrOpenWalletConfig, o)
};

/** Runs every case against the validation; returns the counts and one line per difference (no value of a case). */
export async function runConfigCases(): Promise<{ total: number; byKind: Record<string, number>; differences: string[] }> {
  const differences: string[] = [];
  const byKind: Record<string, number> = {};
  const controller = new AbortController();
  controller.abort();
  for (const c of CASES) {
    byKind[c.fn + " " + c.kind] = (byKind[c.fn + " " + c.kind] || 0) + 1;
    let got: string;
    try {
      const w = await RUN[c.fn](c.config, { signal: controller.signal });
      await w.close();
      got = "constructed";
    } catch (e) { got = pair(e); }
    if (got !== c.expect) differences.push(c.label + ": " + got + ", expected " + c.expect);
  }
  differences.push(...await validateAddressTypes());
  return { total: CASES.length, byKind, differences };
}
