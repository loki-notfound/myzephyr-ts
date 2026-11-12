// Browser consumer of the package entry, bundled by Vite without a configuration file. The page
// does not call setWorkerDistPath or setWasmModuleUrl: the bundler emits the worker script and the
// WebAssembly module from the package's defaults. The test harness serves the page with the
// documented Content-Security-Policy, the daemon under the base path /rpc of the same origin, a
// saved disposable wallet at /seed/* and receives the result at /result.
import { createRandomWallet, openWalletData, ZephyrWalletError } from "@loki-notfound/zephyr-ts";

const status = document.getElementById("status");

async function run() {
  const notes = [];
  let pass = false;
  try {
    const { targets } = await (await fetch("/targets.json", { cache: "no-store" })).json();
    const password = "disposable consumer password";
    const created = await createRandomWallet({ networkType: "mainnet", password, server: targets.base });
    const restoreHeight = await created.getRestoreHeight();
    const createdDaemonHeight = await created.getDaemonHeight();
    const address = await created.getPrimaryAddress();
    const data = await created.getData();
    await created.close();
    const reopened = await openWalletData({ networkType: "mainnet", password, keysData: data.keys, cacheData: data.cache });
    const sameAddress = (await reopened.getPrimaryAddress()) === address;
    await reopened.close();
    const get = async (p) => new Uint8Array(await (await fetch(p, { cache: "no-store" })).arrayBuffer());
    const saved = await openWalletData({ networkType: "mainnet", password: new TextDecoder().decode(await get("/seed/password")),
      keysData: await get("/seed/keys"), cacheData: await get("/seed/cache"), server: targets.base });
    const savedHeight = await saved.getHeight();
    const sync = await saved.sync();
    const height = await saved.getHeight();
    const daemonHeight = await saved.getDaemonHeight();
    const balances = await saved.getBalance();
    const history = (await saved.getTxs()).length + (await saved.getTransfers({ direction: "incoming" })).length; // a wallet without funds
    await saved.close();
    let unsupported = "none";
    try { await reopened.createTxs(); } catch (e) { unsupported = e instanceof ZephyrWalletError ? e.code : "other"; } // outside the supported surface
    const atDaemonHeight = restoreHeight <= createdDaemonHeight && createdDaemonHeight - restoreHeight <= 3;
    notes.push("restore height at the daemon height " + atDaemonHeight + "; same address after reopening " + sameAddress);
    notes.push("saved bytes at " + savedHeight + " synced " + sync.numBlocksFetched + " blocks to " + height + " (daemon " + daemonHeight + "); balance keys " + balances.size + "; history entries " + history);
    notes.push("unsupported call: " + unsupported);
    pass = atDaemonHeight && sameAddress && daemonHeight - height <= 1 && height >= savedHeight && daemonHeight - savedHeight <= 2000
      && sync.numBlocksFetched <= daemonHeight - savedHeight + 1 && balances.size === 8 && history === 0 && unsupported === "UNSUPPORTED_CAPABILITY";
  } catch (e) {
    notes.push("FAILED: " + (e instanceof ZephyrWalletError ? e.code + "/" + e.diagnostic : e && e.name));
  }
  status.textContent = pass ? "pass" : "fail";
  await fetch("/result", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ checks: [{ id: "P01", title: "create, save, reopen and one sync through the package entry", status: pass ? "pass" : "fail", notes }] }) });
}

run();
