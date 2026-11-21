/**
 * The core's fee tier fallback against a constructed daemon (test only; the instrumented test module in the Node.js main
 * thread). At the default priority the core's wallet2::adjust_priority reads the fee estimate and the pool backlog and,
 * when the wallet's chain has at least ten blocks, the block weight limit and the headers of the last ten blocks; when a
 * read fails it keeps the priority it was given (the default), which the core's fee lookup maps to the first tier. The function is on
 * the module's exception whitelist, so its catch is active as in a native build (in 2.3.0-sec.2-ts.1 it was not, and a failed
 * read rejected the build with DAEMON_ERROR).
 *
 * A wallet restored at height 30 syncs against priorityDaemon.cjs: the core's fast refresh takes the daemon's block hashes
 * (its height then passes ten), and the sync stops at the blocks the daemon refuses. On each mount (the backlog read fails;
 * the header read fails; every read answers) a transfer, a conversion and a sweep without funds are built with the
 * bridge's balance checks skipped (test hooks build.unchecked, conversion.unchecked, sweep.unchecked), at the default
 * priority and at each explicit priority. Required: no build at the default priority rejects with DAEMON_ERROR; it gives the
 * refusal the same build gives at an explicit priority; the daemon saw the failed read at the default priority (the backlog;
 * the headers after an empty backlog) and no backlog or header read at an explicit priority. The tier itself shows only in
 * a built transaction's fee: it is read in the core's code (wallet2::get_base_fee maps the default to the first tier's fee).
 */
import { createKeysWallet, restoreWalletFromSeed, ZephyrWalletError } from "../../main/ts/index";
import type { ZephyrTxPriority, ZephyrWallet } from "../../main/ts/index";
import LibraryUtils from "../../main/ts/common/LibraryUtils";

export interface PriorityDaemon {
  readonly base: string;
  readonly requests: (mount: string) => string[];
  readonly reset: () => void;
}

export interface PriorityCheckResult {
  readonly check: { id: string; title: string; status: "pass" | "fail"; notes: string[] };
  /** per mount, build and priority: the outcome ("built" or the code/diagnostic) */
  readonly outcomes: Record<string, string>;
  /** per mount, build and priority: the request names the daemon saw during that build */
  readonly requests: Record<string, string[]>;
  readonly heightAfterSync: number;
  readonly hooksPresent: Record<string, boolean>;
}

type Hooks = { events: string[]; fail: Record<string, number>; skip: Record<string, number>; kind: Record<string, number> };

const BACKLOG = "json_rpc get_txpool_backlog";
const HEADERS = "json_rpc getblockheadersrange";

export async function runPriorityChecks(daemon: PriorityDaemon): Promise<PriorityCheckResult> {
  const notes: string[] = [];
  const outcomes: Record<string, string> = {};
  const requests: Record<string, string[]> = {};
  const hooksPresent: Record<string, boolean> = {};
  const problems: string[] = [];
  const module = LibraryUtils.getWasmModule() as { __zephyrTsTestHooks?: Hooks };
  const arm = (point: string) => { module.__zephyrTsTestHooks = { events: [], fail: { [point]: 1 }, skip: {}, kind: {} }; };
  const fired = (point: string): boolean => (module.__zephyrTsTestHooks?.events ?? []).includes("injected:" + point);
  const disarm = () => { module.__zephyrTsTestHooks = undefined; };
  const keys = await createKeysWallet({ networkType: "mainnet", proxyToWorker: false });
  const seed = await keys.getSeed();
  await keys.close();
  if (seed === undefined) throw new Error("no seed");
  const w: ZephyrWallet = await restoreWalletFromSeed({ networkType: "mainnet", password: "priority-checks", seed, restoreHeight: 30, server: daemon.base + "/ok", proxyToWorker: false });
  let heightAfterSync = 0;
  try {
    let syncOutcome = "synced";
    try { await w.sync(); } catch (err) { syncOutcome = err instanceof ZephyrWalletError ? err.code + "/" + String(err.diagnostic) : "untyped"; }
    heightAfterSync = await w.getHeight();
    notes.push("sync against the constructed daemon: " + syncOutcome + "; the wallet's height afterwards " + heightAfterSync + " (requests: " + Array.from(new Set(daemon.requests("/ok"))).join(", ") + ")");
    if (heightAfterSync < 10) problems.push("the wallet's chain did not reach ten blocks (" + heightAfterSync + ")");
    const own = await w.getPrimaryAddress();
    const builds: Array<[string, string, (p: ZephyrTxPriority) => Promise<unknown>]> = [
      ["transfer", "build.unchecked", (p) => w.buildTransfer({ asset: "ZPH", destinations: [{ address: own, amount: BigInt("100000000") }], accountIndex: 0, priority: p })],
      ["conversion", "conversion.unchecked", (p) => w.buildConversion({ sourceAsset: "ZSD", destinationAsset: "ZPH", destination: { address: own, amount: BigInt("100000000") }, accountIndex: 0, priority: p })],
      ["sweep", "sweep.unchecked", (p) => w.buildSweepUnlocked({ asset: "ZRS", address: own, accountIndex: 0, priority: p })]];
    for (const mount of ["/backlog", "/headers", "/ok"]) {
      await w.setDaemonConnection(daemon.base + mount);
      for (const [label, point, fn] of builds) {
        for (const p of ["default", "unimportant", "normal", "elevated"] as ZephyrTxPriority[]) {
          const key = mount.substring(1) + " " + label + " " + p;
          daemon.reset();
          arm(point);
          let outcome = "built";
          try { await fn(p); } catch (err) { outcome = err instanceof ZephyrWalletError ? err.code + "/" + String(err.diagnostic) : "untyped"; }
          hooksPresent[point] = (hooksPresent[point] ?? true) && fired(point);
          disarm();
          outcomes[key] = outcome;
          requests[key] = daemon.requests(mount);
        }
        const k = (p: string) => mount.substring(1) + " " + label + " " + p;
        const atDefault = outcomes[k("default")];
        const explicit = ["unimportant", "normal", "elevated"].map((p) => outcomes[k(p)]);
        notes.push(mount.substring(1) + ", " + label + ": default -> " + atDefault + " (" + requests[k("default")].filter((r) => r === BACKLOG || r === HEADERS).join(", ") + "); explicit -> " + explicit.join(", "));
        if (atDefault.startsWith("DAEMON_ERROR")) problems.push(k("default") + " rejected with " + atDefault);
        if (explicit.some((e) => e !== atDefault)) problems.push(k("default") + " differs from the explicit priorities: " + atDefault + " vs " + explicit.join(","));
        const defaultRequests = requests[k("default")];
        if (!defaultRequests.includes(BACKLOG)) problems.push(k("default") + ": no backlog read");
        if (mount === "/backlog" && defaultRequests.includes(HEADERS)) problems.push(k("default") + ": a header read after the failed backlog read");
        if (mount !== "/backlog" && !defaultRequests.includes(HEADERS)) problems.push(k("default") + ": no header read");
        for (const p of ["unimportant", "normal", "elevated"]) {
          if (requests[k(p)].some((r) => r === BACKLOG || r === HEADERS)) problems.push(k(p) + ": a backlog or header read at an explicit priority");
        }
      }
    }
    for (const [point, present] of Object.entries(hooksPresent)) if (!present) problems.push("the test hook " + point + " did not fire");
  } finally {
    disarm();
    await w.close();
  }
  for (const p of problems) notes.push("FAILED: " + p);
  return {
    check: { id: "V03", title: "The core's fee tier fallback against a constructed daemon: at the default priority a failed backlog read and a failed header read leave the transfer, conversion and sweep builds (without funds, the bridge's balance checks skipped) with the refusal the same build gets at an explicit priority, not DAEMON_ERROR; the daemon saw the failed read at the default priority and no backlog or header read at an explicit one", status: problems.length === 0 ? "pass" : "fail", notes },
    outcomes, requests, heightAfterSync, hooksPresent
  };
}
