// Offline checks of the packed package through its entry only, shared by the platform tests: the
// Node consumer (main thread and wallet workers), the browser page of this consumer (?offline, wallet
// in a worker) and the Electron consumer (main process and renderer). No daemon is configured and no
// request leaves the runtime. Wallets are random or derived from the fixed public vector below, and
// discarded; results carry check ids, outcomes, codes and counts only, never keys, seeds or bytes.
//
//   runOfflineChecks(z, { proxyToWorker, log }) -> { checks: [{ id, title, status, notes, ms }] }
// z is the module object of "@loki-notfound/zephyr-ts" as the caller loaded it.

// A fixed public test vector (no funds, never to be funded): the private spend key 1. Every platform
// must derive the same address, view key and seed from it.
export const VECTOR = {
  privateSpendKey: "0100000000000000000000000000000000000000000000000000000000000000",
  primaryAddress: "ZEPHYR2gFxHJ8QgRfFWTzmJ8QgRfFWTzmJ8QgRfFWTzmJ8QgRfFeHmZ8KqWuoqLiiLXLqNPDAgFMcEqbudpnaZPuQ4Uu8uYKkUK1B",
  publicViewKey: "7db1402bcabb40ad2e2059b5671ad9503b2dcb52bb559e7f88c60889dde9037d",
  seedHead: "abducts abducts abducts" // the first three words of the seed
};

export const EXPORTS = ["ZephyrDaemonRpc", "ZephyrWallet", "ZephyrWalletError", "createKeysWallet", "createRandomWallet", "openWalletData", "restoreWalletFromKeys",
  "restoreWalletFromSeed", "setWasmModuleUrl", "setWorkerDistPath", "terminateWorker", "validateAddress"];

export const CHECKS = [
  ["K01", "The entry exports exactly the supported names"],
  ["K02", "Random wallets on mainnet, testnet and stagenet: address shape, network type, address validation across networks"],
  ["K03", "The fixed key vector derives the recorded address, view key and seed"],
  ["K04", "Seed, keys-only, spend-key, view-only and full key restores of a random wallet agree"],
  ["K05", "Wallet bytes: getData and openWalletData over two generations keep address, network, seed and restore height"],
  ["K06", "Wrong password and malformed bytes reject with fixed codes; the module stays usable"],
  ["K07", "Password change: a wrong old password rejects, the new one reopens, the old one is rejected"],
  ["K08", "Configuration rejections before construction: unknown field, conflicting material, bad seed checksum, unsupported option, daemon credentials"],
  ["K09", "Accounts and subaddresses with labels survive getData and reopening; balances of a new wallet are zero in all eight assets"],
  ["K10", "Offline history, daemon and unsupported calls: empty listings, TX_NOT_FOUND, not connected, DAEMON_NOT_CONNECTED, UNSUPPORTED_CAPABILITY"],
  ["K11", "Close is idempotent; calls after close reject WALLET_CLOSED; a forced stop ends a wallet in a worker (direct mode: TERMINATE)"]
];

class CheckFailure extends Error {}
function expect(condition, what) { if (!condition) throw new CheckFailure(what); }
const codeOf = (e) => (e && typeof e === "object" && "code" in e ? String(e.code) : "untyped:" + (e && e.name ? e.name : typeof e));
const fullCode = (e) => codeOf(e) + (e && e.diagnostic ? "/" + e.diagnostic : "");

function randomPassword() {
  const b = new Uint8Array(16);
  globalThis.crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

export async function runOfflineChecks(z, opts) {
  const proxyToWorker = opts.proxyToWorker;
  const log = opts.log || (() => undefined);
  const deadlineMs = opts.deadlineMs || 300000;
  const checks = [];
  const W = (config) => Object.assign({ proxyToWorker }, config);

  async function rejects(promise, code, what, notes) {
    try { await promise; } catch (e) {
      notes.push(what + " -> " + fullCode(e));
      expect(e instanceof z.ZephyrWalletError, what + ": not a ZephyrWalletError");
      const want = code.split("/");
      expect(e.code === want[0] && (want.length === 1 || e.diagnostic === want[1]), what + ": expected " + code + ", got " + fullCode(e));
      return;
    }
    throw new CheckFailure(what + ": resolved, expected " + code);
  }

  async function check(id, fn) {
    const title = CHECKS.find((c) => c[0] === id)[1];
    const result = { id, title, status: "fail", notes: [], ms: 0 };
    checks.push(result);
    const t0 = Date.now();
    let timer;
    try {
      await Promise.race([fn(result.notes), new Promise((_, reject) => { timer = setTimeout(() => reject(new CheckFailure("deadline")), deadlineMs); })]);
      result.status = "pass";
    } catch (e) {
      result.notes.push("FAILED: " + (e instanceof CheckFailure ? e.message : fullCode(e)));
    } finally {
      clearTimeout(timer);
      result.ms = Date.now() - t0;
    }
    log(id + " " + result.status);
  }

  const pw = randomPassword();
  const st = {};

  await check("K01", async (notes) => {
    const names = Object.keys(z).filter((k) => k !== "default" && k !== "__esModule" && k !== "module.exports").sort();
    notes.push(names.length + " names");
    expect(names.join() === EXPORTS.join(), "exports differ: " + names.join(" "));
  });

  await check("K02", async (notes) => {
    const base = await z.createRandomWallet(W({ networkType: "mainnet", password: pw }));
    st.base = base;
    st.address = await base.getPrimaryAddress();
    expect(st.address.length === 101 && st.address.startsWith("ZEPH"), "mainnet address shape");
    expect((await base.getNetworkType()) === 0, "mainnet network type");
    await z.validateAddress(st.address, "mainnet", proxyToWorker);
    for (const [name, type] of [["testnet", 1], ["stagenet", 2]]) {
      const w = await z.createRandomWallet(W({ networkType: name, password: pw }));
      const a = await w.getPrimaryAddress();
      expect((await w.getNetworkType()) === type, name + " network type");
      await z.validateAddress(a, name, proxyToWorker);
      await rejects(z.validateAddress(a, "mainnet", proxyToWorker), "INVALID_ADDRESS", name + " address as mainnet", notes);
      await w.close();
    }
    await rejects(z.validateAddress(st.address.substring(0, 100) + (st.address.endsWith("x") ? "y" : "x"), "mainnet", proxyToWorker), "INVALID_ADDRESS", "changed checksum", notes);
    const restore = await base.getRestoreHeight();
    expect(Number.isSafeInteger(restore) && restore > 0, "date-based restore height of a random wallet");
  });

  await check("K03", async (notes) => {
    const k = await z.createKeysWallet(W({ networkType: "mainnet", privateSpendKey: VECTOR.privateSpendKey }));
    const address = await k.getPrimaryAddress(); const view = await k.getPublicViewKey(); const seed = await k.getSeed();
    await k.close();
    const f = await z.restoreWalletFromKeys(W({ networkType: "mainnet", password: pw, privateSpendKey: VECTOR.privateSpendKey, restoreHeight: 1 }));
    const fullAddress = await f.getPrimaryAddress();
    await f.close();
    notes.push("address " + address.substring(0, 12) + "...; seed of " + seed.split(" ").length + " words");
    expect(address === VECTOR.primaryAddress, "vector address differs");
    expect(view === VECTOR.publicViewKey, "vector public view key differs");
    expect(seed.split(" ").slice(0, 3).join(" ") === VECTOR.seedHead, "vector seed differs");
    expect(fullAddress === address, "full and keys-only vector addresses differ");
  });

  await check("K04", async (notes) => {
    const b = st.base;
    expect(b !== undefined, "base wallet from K02");
    const seed = await b.getSeed();
    expect(seed.split(" ").length === 25 && (await b.getSeedLanguage()) === "English", "25-word English seed");
    const pv = await b.getPrivateViewKey(); const ps = await b.getPrivateSpendKey(); const pubv = await b.getPublicViewKey(); const pubs = await b.getPublicSpendKey();
    for (const key of [pv, ps, pubv, pubs]) expect(/^[0-9a-f]{64}$/.test(key), "64 hex digits");
    expect(!(await b.isViewOnly()), "not view-only");
    st.seed = seed;
    const k = await z.createKeysWallet(W({ networkType: 0, seed }));
    expect((await k.getPrimaryAddress()) === st.address && (await k.getPublicSpendKey()) === pubs, "keys-only from seed");
    expect((await k.getAddress(0, 1)) === (await b.getAddress(0, 1)), "subaddress 0/1");
    await k.close();
    const f = await z.restoreWalletFromSeed(W({ networkType: 0, password: pw, seed }));
    expect((await f.getPrimaryAddress()) === st.address && (await f.getRestoreHeight()) === 0, "full from seed");
    await f.close();
    const s = await z.restoreWalletFromKeys(W({ networkType: 0, password: pw, privateSpendKey: ps }));
    expect((await s.getPrimaryAddress()) === st.address && (await s.getSeed()) === seed, "spend key only");
    await s.close();
    const v = await z.restoreWalletFromKeys(W({ networkType: 0, password: pw, primaryAddress: st.address, privateViewKey: pv, restoreHeight: 1000 }));
    expect((await v.getPrimaryAddress()) === st.address && (await v.isViewOnly()) && (await v.getRestoreHeight()) === 1000, "view-only");
    await v.close();
    const o1 = await z.restoreWalletFromSeed(W({ networkType: 0, password: pw, seed, seedOffset: "platform" }));
    const o2 = await z.createKeysWallet(W({ networkType: 0, seed, seedOffset: "platform" }));
    const oa = await o1.getPrimaryAddress();
    expect(oa !== st.address && oa === (await o2.getPrimaryAddress()), "seed offset");
    await o1.close(); await o2.close();
    notes.push("seed, keys-only, spend-key, view-only and offset restores agree");
  });

  await check("K05", async (notes) => {
    const r = await z.restoreWalletFromSeed(W({ networkType: 0, password: pw, seed: st.seed, restoreHeight: 123456 }));
    const d = await r.getData();
    await r.close();
    expect(d.keys instanceof Uint8Array && d.cache instanceof Uint8Array && d.keys.length > 0 && d.cache.length > 0, "bytes");
    st.keys = d.keys.slice(); st.cache = d.cache.slice();
    const o = await z.openWalletData(W({ networkType: 0, password: pw, keysData: st.keys.slice(), cacheData: st.cache.slice() }));
    expect((await o.getPrimaryAddress()) === st.address && (await o.getNetworkType()) === 0 && (await o.getRestoreHeight()) === 123456 && (await o.getSeed()) === st.seed, "first reopen");
    const d2 = await o.getData();
    await o.close();
    const o2 = await z.openWalletData(W({ networkType: 0, password: pw, keysData: d2.keys, cacheData: d2.cache }));
    expect((await o2.getPrimaryAddress()) === st.address && (await o2.getRestoreHeight()) === 123456, "second reopen");
    await o2.close();
    const t = await z.createRandomWallet(W({ networkType: "testnet", password: pw }));
    const ta = await t.getPrimaryAddress(); const td = await t.getData(); await t.close();
    const t2 = await z.openWalletData(W({ networkType: "testnet", password: pw, keysData: td.keys, cacheData: td.cache }));
    expect((await t2.getPrimaryAddress()) === ta && (await t2.getNetworkType()) === 1, "testnet reopen");
    await t2.close();
    notes.push("keys " + st.keys.length + " bytes, cache " + st.cache.length + " bytes");
  });

  await check("K06", async (notes) => {
    const open = (password, keysData, cacheData) => z.openWalletData(W({ networkType: 0, password, keysData, cacheData }));
    await rejects(open(pw + "x", st.keys.slice(), st.cache.slice()), "WRONG_PASSWORD", "wrong password", notes);
    await rejects(open("", st.keys.slice(), st.cache.slice()), "WRONG_PASSWORD", "empty password", notes);
    await rejects(open(pw, st.keys.slice(0, st.keys.length >> 1), st.cache.slice()), "INVALID_WALLET_DATA", "truncated keys", notes);
    const junk = new Uint8Array(1024); globalThis.crypto.getRandomValues(junk);
    await rejects(open(pw, junk, new Uint8Array(0)), "INVALID_WALLET_DATA", "random bytes", notes);
    await rejects(open(pw, new Uint8Array(0), st.cache.slice()), "INVALID_WALLET_DATA", "empty keys", notes);
    await rejects(open(pw, "not bytes", undefined), "INVALID_WALLET_DATA", "a string", notes);
    const ok = await open(pw, st.keys.slice(), st.cache.slice());
    expect((await ok.getPrimaryAddress()) === st.address, "usable after the failures");
    await ok.close();
  });

  await check("K07", async (notes) => {
    const w = await z.openWalletData(W({ networkType: 0, password: pw, keysData: st.keys.slice(), cacheData: st.cache.slice() }));
    await rejects(w.changePassword(pw + "-wrong", "x" + pw), "WRONG_PASSWORD", "wrong old password", notes);
    const next = randomPassword();
    await w.changePassword(pw, next);
    const d = await w.getData();
    await w.close();
    const n = await z.openWalletData(W({ networkType: 0, password: next, keysData: d.keys.slice(), cacheData: d.cache.slice() }));
    expect((await n.getPrimaryAddress()) === st.address && (await n.getRestoreHeight()) === 123456, "reopen with the new password");
    await n.close();
    await rejects(z.openWalletData(W({ networkType: 0, password: pw, keysData: d.keys.slice(), cacheData: d.cache.slice() })), "WRONG_PASSWORD", "old password after the change", notes);
  });

  await check("K08", async (notes) => {
    const words = st.seed.split(" ");
    const other = words.slice(0, 24).find((x) => x.substring(0, 3) !== words[24].substring(0, 3));
    await rejects(z.createRandomWallet(W({ networkType: 0, password: pw, unknownField: 1 })), "INVALID_CONFIG", "unknown field", notes);
    await rejects(z.createRandomWallet(W({ networkType: 0, password: pw, seed: st.seed })), "INVALID_CONFIG", "random with a seed", notes);
    await rejects(z.restoreWalletFromSeed(W({ networkType: 0, password: pw, seed: words.slice(0, 24).concat([other]).join(" ") })), "INVALID_RECOVERY_MATERIAL", "bad seed checksum", notes);
    await rejects(z.restoreWalletFromSeed(W({ networkType: 0, password: pw })), "INVALID_CONFIG", "seed restore without a seed", notes);
    await rejects(z.createRandomWallet(W({ password: pw })), "INVALID_CONFIG", "no network type", notes);
    await rejects(z.createRandomWallet(W({ networkType: 0, password: pw, isTrustedDaemon: false })), "UNSUPPORTED_CAPABILITY", "untrusted daemon flag", notes);
    await rejects(z.createRandomWallet(W({ networkType: 0, password: pw, path: "wallet-file" })), "UNSUPPORTED_CAPABILITY", "a file path", notes);
    await rejects(z.createRandomWallet(W({ networkType: 0, password: pw, server: "http://user:secret@127.0.0.1:1" })), "UNSUPPORTED_CAPABILITY/DAEMON_CREDENTIALS", "daemon credentials", notes);
    await rejects(z.createRandomWallet(W({ networkType: 0, password: pw }), { other: 1 }), "INVALID_CONFIG/UNKNOWN_FIELD", "unknown construction option", notes);
  });

  await check("K09", async (notes) => {
    const w = await z.openWalletData(W({ networkType: 0, password: pw, keysData: st.keys.slice(), cacheData: st.cache.slice() }));
    const account = await w.createAccount("Savings");
    const sub = await w.createSubaddress(account.index, "Shop");
    await w.setSubaddressLabel(account.index, sub.index, "Online shop");
    expect(account.index === 1 && sub.accountIndex === 1 && sub.index === 1, "indices");
    expect((await w.getAddress(1, 1)) === sub.address, "address of the new subaddress");
    const idx = await w.getAddressIndex(sub.address);
    expect(idx.accountIndex === 1 && idx.subaddressIndex === 1, "address index");
    const balance = await w.getBalance();
    const keys = Array.from(balance.keys()).sort();
    expect(keys.length === 8 && Array.from(balance.values()).every((v) => v === 0n), "eight assets at 0n");
    const d = await w.getData();
    await w.close();
    const o = await z.openWalletData(W({ networkType: 0, password: pw, keysData: d.keys, cacheData: d.cache }));
    const accounts = await o.getAccounts({ includeSubaddresses: true });
    expect(accounts.length === 2 && accounts[1].label === "Savings" && accounts[1].subaddresses[1].label === "Online shop", "labels after reopening");
    expect(Object.isFrozen(accounts), "frozen results");
    await rejects(o.getAccount(7), "INVALID_CONFIG/ACCOUNT_NOT_FOUND", "an account the wallet does not have", notes);
    await o.close();
    notes.push("balance assets " + keys.join(" "));
  });

  await check("K10", async (notes) => {
    const w = await z.openWalletData(W({ networkType: 0, password: pw, keysData: st.keys.slice(), cacheData: st.cache.slice() }));
    expect((await w.getTxs()).length === 0 && (await w.getTransfers()).length === 0, "empty history");
    await rejects(w.getTx("00".repeat(32)), "INVALID_CONFIG/TX_NOT_FOUND", "unknown transaction", notes);
    expect((await w.isConnectedToDaemon()) === false, "not connected without a daemon");
    await rejects(w.isDaemonSynced(), "DAEMON_ERROR/DAEMON_NOT_CONNECTED", "isDaemonSynced without a daemon", notes);
    await rejects(w.createTxs(), "UNSUPPORTED_CAPABILITY", "an inherited send call", notes);
    await w.close();
  });

  await check("K11", async (notes) => {
    const w = await z.openWalletData(W({ networkType: 0, password: pw, keysData: st.keys.slice(), cacheData: st.cache.slice() }));
    const c1 = w.close(); const c2 = w.close();
    expect(c1 === c2, "a second close returns the same promise");
    await c1;
    expect(w.isClosed(), "isClosed");
    await rejects(w.getPrimaryAddress(), "WALLET_CLOSED", "a call after close", notes);
    await w.close();
    const t = await z.openWalletData(W({ networkType: 0, password: pw, keysData: st.keys.slice(), cacheData: st.cache.slice() }));
    if (proxyToWorker) {
      const pending = t.getData();
      await t.terminate();
      await rejects(pending, "WALLET_CLOSED/WALLET_TERMINATED", "a call pending at the forced stop", notes);
      await rejects(t.getPrimaryAddress(), "WALLET_CLOSED/WALLET_TERMINATED", "a call after the forced stop", notes);
      await t.close();
    } else {
      await rejects(t.terminate(), "UNSUPPORTED_CAPABILITY/TERMINATE", "forced stop in direct mode", notes);
      await t.close();
    }
    if (st.base) { await st.base.close(); st.base = undefined; }
  });

  if (st.base) await st.base.close().catch(() => undefined);
  return { checks };
}
