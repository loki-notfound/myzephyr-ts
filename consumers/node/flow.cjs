"use strict";
// The flow both Node consumers run against the module object they loaded.
const fs = require("fs");
const path = require("path");

async function run(z, loader, walletDir, out, extra) {
  const daemon = process.env.ZEPHYR_TS_TEST_DAEMON;
  const result = Object.assign({ loader, steps: [] }, extra);
  const password = "disposable consumer password";
  const created = await z.createRandomWallet({ networkType: "mainnet", password, server: daemon });
  const restoreHeight = await created.getRestoreHeight();
  const daemonHeight = await created.getDaemonHeight();
  const address = await created.getPrimaryAddress();
  const data = await created.getData();
  await created.close();
  result.steps.push("create", "save");
  const reopened = await z.openWalletData({ networkType: "mainnet", password, keysData: data.keys, cacheData: data.cache });
  result.steps.push("reopen");
  const sameAddress = (await reopened.getPrimaryAddress()) === address;
  await reopened.close();
  const read = (name) => fs.readFileSync(path.join(walletDir, name));
  const saved = await z.openWalletData({ networkType: "mainnet", password: read("password.txt").toString("utf8"),
    keysData: new Uint8Array(read("keys.bin")), cacheData: new Uint8Array(read("cache.bin")), server: daemon });
  const savedHeight = await saved.getHeight();
  const sync = await saved.sync();
  const height = await saved.getHeight();
  const daemonHeight2 = await saved.getDaemonHeight();
  const balances = await saved.getBalance();
  await saved.close();
  result.steps.push("sync of the saved wallet bytes");
  try { await z.createRandomWallet({ networkType: "mainnet", password, unknownField: 1 }); result.rejectsUnknown = false; }
  catch (e) { result.rejectsUnknown = e instanceof z.ZephyrWalletError && e.code === "INVALID_CONFIG"; }
  let deepImport = "allowed";
  try { require("@loki-notfound/zephyr-ts/dist/src/main/ts/wallet/ZephyrWalletFull.js"); } catch (e) { deepImport = e.code === "ERR_PACKAGE_PATH_NOT_EXPORTED" ? "blocked" : "error"; }
  Object.assign(result, {
    restoreAtDaemonHeight: restoreHeight <= daemonHeight && daemonHeight - restoreHeight <= 3, sameAddress,
    numBlocksFetched: sync.numBlocksFetched, syncedToDaemon: daemonHeight2 - height <= 1, savedBlocksBelowDaemon: daemonHeight2 - savedHeight,
    onlyNewBlocks: sync.numBlocksFetched <= daemonHeight2 - savedHeight + 1, balanceKeys: Array.from(balances.keys()).sort(), deepImport,
    exports: Object.keys(z).filter((k) => k !== "default" && k !== "__esModule").sort()
  });
  fs.writeFileSync(out, JSON.stringify(result, null, 1) + "\n");
  await z.terminateWorker();
}

module.exports = { run };
