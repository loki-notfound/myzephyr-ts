/**
 * History reads what the last sync stored (test only): with a wallet connected to the loopback daemon
 * of redirectServers.cjs (its /ok mount), getTxs, getTransfers and getTx must send no request. The
 * daemon counts every request; the connection check before the history calls is the positive control.
 * Shared by the Node.js runner and the Chromium page of the redirect checks.
 */
import { createRandomWallet, ZephyrWalletError } from "../../main/ts/index";
import type { RedirectServerStats, RedirectTargets } from "./RedirectChecks";

export interface HistoryRequestResult {
  readonly check: { id: string; title: string; status: "pass" | "fail"; notes: string[] };
  readonly requestsBeforeHistory: number;
  readonly requestsDuringHistory: number;
  readonly historyCalls: number;
}

function okRequests(stats: RedirectServerStats): number {
  return Object.entries(stats.first).filter(([k]) => k.substring(k.indexOf(" ") + 1).startsWith("/ok/")).reduce((n, [, v]) => n + v.requests, 0);
}

export async function runHistoryRequestCheck(mode: "direct" | "worker", targets: RedirectTargets): Promise<HistoryRequestResult> {
  const notes: string[] = [];
  const w = await createRandomWallet({ networkType: "mainnet", password: "history-requests", proxyToWorker: mode === "worker" });
  let before = 0, during = -1, calls = 0;
  try {
    const s0 = okRequests(await targets.stats());
    await w.setDaemonConnection(targets.first + "/ok");
    if ((await w.isConnectedToDaemon()) !== true) notes.push("not connected to the loopback daemon");
    const s1 = okRequests(await targets.stats());
    before = s1 - s0;
    const hash = "cd".repeat(32);
    for (const q of [undefined, { status: "confirmed" as const }, { status: "pool" as const }, { status: "failed" as const }, { asset: "ZPH" }, { minHeight: 0, maxHeight: 10 }]) {
      if ((await w.getTxs(q)).length !== 0 || (await w.getTransfers(q)).length !== 0) notes.push("a wallet without transactions listed something");
      calls += 2;
    }
    try { await w.getTx(hash); notes.push("getTx resolved"); } catch (e) { if (!(e instanceof ZephyrWalletError && e.code === "INVALID_CONFIG" && e.diagnostic === "TX_NOT_FOUND")) notes.push("getTx: unexpected rejection"); }
    calls++;
    during = okRequests(await targets.stats()) - s1;
  } finally {
    await w.close();
  }
  if (!(before > 0)) notes.push("the connection check sent no request (positive control)");
  if (during !== 0) notes.push(during + " requests during " + calls + " history calls");
  return { check: { id: "H01", title: "getTxs, getTransfers and getTx send no request to a connected daemon", status: notes.length === 0 ? "pass" : "fail", notes }, requestsBeforeHistory: before, requestsDuringHistory: during, historyCalls: calls };
}
