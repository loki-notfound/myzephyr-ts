/**
 * Explicit pool refresh against constructed loopback daemons (test only): the /poolempty, /poolfull and
 * /poolstatus mounts of redirectServers.cjs. refreshPool must send exactly the core's pool request set
 * (the pool hashes, then the transactions it has not scanned before), skip pool transactions that do not
 * parse, carry no node text into its error, leave the history of a wallet without transactions empty,
 * and the history calls after it must send no request. The constructed transactions cannot be made to pay
 * the test wallet (that needs a transaction built and signed for it), so recognition of a real incoming
 * pool transfer is not proven here. Shared by the Node.js runner and the Chromium page.
 */
import { createRandomWallet, ZephyrWallet, ZephyrWalletError } from "../../main/ts/index";
import type { RedirectServerStats, RedirectTargets } from "./RedirectChecks";

export interface PoolRefreshResult {
  readonly check: { id: string; title: string; status: "pass" | "fail"; notes: string[] };
  /** requests per mount and endpoint during each step, from the daemon's own counts */
  readonly steps: Record<string, Record<string, number>>;
  /** field names and hash counts of the /gettransactions requests the daemon saw */
  readonly poolTxRequests: ReadonlyArray<{ kind: string; fields: string[]; hashes: number }>;
  readonly marker: string;
}

/** The constructed pool's request field names of /gettransactions (COMMAND_RPC_GET_TRANSACTIONS of the pinned core). */
export const GET_TRANSACTIONS_FIELDS = ["client", "decode_as_json", "prune", "txs_hashes"];

function poolCounts(stats: RedirectServerStats): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(stats.first)) {
    const path = k.substring(k.indexOf(" ") + 1);
    if (path.startsWith("/pool")) out[k] = v.requests;
  }
  return out;
}

function delta(a: Record<string, number>, b: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of Object.keys(b)) if ((b[k] ?? 0) !== (a[k] ?? 0)) out[k] = b[k] - (a[k] ?? 0);
  return out;
}

function same(a: Record<string, number>, b: Record<string, number>): boolean {
  const ka = Object.keys(a).sort(), kb = Object.keys(b).sort();
  return ka.join() === kb.join() && ka.every((k) => a[k] === b[k]);
}

async function historyEmpty(w: ZephyrWallet, notes: string[], label: string): Promise<number> {
  let calls = 0;
  for (const q of [undefined, { status: "pool" as const }, { direction: "incoming" as const }]) {
    if ((await w.getTxs(q)).length !== 0 || (await w.getTransfers(q)).length !== 0) notes.push(label + ": the history of a wallet without transactions listed something");
    calls += 2;
  }
  return calls;
}

export async function runPoolRefreshCheck(mode: "direct" | "worker", targets: RedirectTargets & { marker: string }): Promise<PoolRefreshResult> {
  const notes: string[] = [];
  const steps: Record<string, Record<string, number>> = {};
  const w = await createRandomWallet({ networkType: "mainnet", password: "pool-refresh", proxyToWorker: mode === "worker" });
  const counts = async () => poolCounts(await targets.stats());
  try {
    // an empty pool: one request for the pool hashes, nothing else
    await w.setDaemonConnection(targets.first + "/poolempty");
    let c0 = await counts();
    const empty = await w.refreshPool();
    let c1 = await counts();
    steps.empty = delta(c0, c1);
    if (empty !== 0) notes.push("empty pool: refreshPool resolved " + empty);
    if (!same(steps.empty, { "POST /poolempty/get_transaction_pool_hashes.bin": 1 })) notes.push("empty pool: requests " + JSON.stringify(steps.empty));
    const calls = await historyEmpty(w, notes, "after the empty pool");
    const c2 = await counts();
    if (!same(c1, c2)) notes.push("history after refreshPool sent requests " + JSON.stringify(delta(c1, c2)));
    // two pool transactions that do not parse: requested once each refresh, skipped, nothing listed
    await w.setDaemonConnection(targets.first + "/poolfull");
    for (const round of ["full1", "full2"]) {
      c0 = await counts();
      const n = await w.refreshPool();
      c1 = await counts();
      steps[round] = delta(c0, c1);
      if (n !== 0) notes.push(round + ": refreshPool resolved " + n);
      if (!same(steps[round], { "POST /poolfull/get_transaction_pool_hashes.bin": 1, "POST /poolfull/gettransactions": 1 })) notes.push(round + ": requests " + JSON.stringify(steps[round]));
      await historyEmpty(w, notes, "after " + round);
    }
    // a node status with a marker text: DAEMON_ERROR/DAEMON_RESPONSE without the text; nothing listed after it
    await w.setDaemonConnection(targets.first + "/poolstatus");
    c0 = await counts();
    try {
      await w.refreshPool();
      notes.push("node status: refreshPool resolved");
    } catch (err) {
      const texts = [String(err), JSON.stringify(err), err instanceof Error ? String(err.stack) : ""];
      if (!(err instanceof ZephyrWalletError && err.code === "DAEMON_ERROR" && err.diagnostic === "DAEMON_RESPONSE")) notes.push("node status: unexpected rejection " + (err instanceof ZephyrWalletError ? err.code + "/" + err.diagnostic : typeof err));
      if (texts.some((t) => t.includes(targets.marker))) notes.push("node status: the node's text reached the error");
    }
    c1 = await counts();
    steps.status = delta(c0, c1);
    if (!same(steps.status, { "POST /poolstatus/get_transaction_pool_hashes.bin": 1 })) notes.push("node status: requests " + JSON.stringify(steps.status));
    await historyEmpty(w, notes, "after the failed refresh");
    // argument and kind rejections before any request
    c0 = await counts();
    try { await (w.refreshPool as (...a: unknown[]) => Promise<number>)(true); notes.push("refreshPool(true) resolved"); } catch (err) { if (!(err instanceof ZephyrWalletError && err.code === "INVALID_CONFIG" && err.diagnostic === "FIELD_TYPE")) notes.push("refreshPool(true): unexpected rejection"); }
    c1 = await counts();
    if (!same(c0, c1)) notes.push("a rejected refreshPool sent a request");
    if (calls !== 6) notes.push("history calls " + calls);
  } finally {
    await w.close();
  }
  try { await w.refreshPool(); notes.push("refreshPool after close resolved"); } catch (err) { if (!(err instanceof ZephyrWalletError && err.code === "WALLET_CLOSED")) notes.push("refreshPool after close: unexpected rejection"); }
  const stats = await targets.stats();
  const poolTxRequests = (stats as unknown as { poolTxRequests?: Array<{ kind: string; fields: string[]; hashes: number }> }).poolTxRequests ?? [];
  const mine = poolTxRequests.slice(-2);
  if (mine.length !== 2 || mine.some((r) => r.kind !== "poolfull" || r.hashes !== 2 || r.fields.join() !== GET_TRANSACTIONS_FIELDS.join() || r.fields.some((f) => /key_image|address/i.test(f)))) notes.push("gettransactions requests " + JSON.stringify(mine));
  return { check: { id: "P01", title: "refreshPool sends exactly the core's pool request set to a constructed daemon (pool hashes, then the unscanned transactions; no key image), skips transactions that do not parse, carries no node text, leaves an empty history empty; history after it sends no request", status: notes.length === 0 ? "pass" : "fail", notes },
    steps, poolTxRequests: mine, marker: targets.marker };
}
