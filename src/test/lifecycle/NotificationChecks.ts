/**
 * Helpers of the listener checks (C47, C48, T25 to T29; the network checks N30 and N31 use them too): a listener that
 * records every callback as text, the notification sequence of the test module's synthetic sync, a value that counts
 * every read of it, and a counter of unhandled promise rejections. Records hold heights, amounts, assets, indices, short
 * hash prefixes and fixed codes only.
 */
import * as F from "../../main/ts/index";

/** One output as text: its fields, its own keys (sorted) and whether it is frozen. */
export function describeOutput(o: F.ZephyrWalletOutput): string {
  const keys = Object.keys(o).sort().join(",");
  return [o.txHash.substring(0, 4), String(o.amount), o.accountIndex ?? "-", o.subaddressIndex ?? "-", o.height ?? "-", o.assetType ?? "-", "keys=" + keys,
    "frozen=" + Object.isFrozen(o), "proto=" + (Object.getPrototypeOf(o) === Object.prototype)].join(":");
}

/** A listener that appends "<name>:<kind>:<fields>" for every callback to sink. */
export function recordingListener(name: string, sink: string[]): F.ZephyrWalletListener {
  return {
    onSyncProgress: (height, startHeight, endHeight, percentDone, message) => { sink.push(name + ":progress:" + height + ":" + startHeight + ":" + endHeight + ":" + percentDone + ":" + message); },
    onNewBlock: (height) => { sink.push(name + ":block:" + height); },
    onBalancesChanged: (balance, unlockedBalance, assetType) => { sink.push(name + ":balance:" + balance + ":" + unlockedBalance + ":" + assetType + ":" + typeof balance); },
    onOutputReceived: (output) => { sink.push(name + ":received:" + describeOutput(output)); },
    onOutputSpent: (output) => { sink.push(name + ":spent:" + describeOutput(output)); },
    onSyncError: (error) => { sink.push(name + ":error:" + error.code + "/" + String(error.diagnostic) + ":" + (error instanceof F.ZephyrWalletError)); }
  };
}

/** The records of one listener, without its name. */
export function recordsOf(sink: readonly string[], name: string): string[] {
  return sink.filter((e) => e.startsWith(name + ":")).map((e) => e.substring(name.length + 1));
}

/** The records a recordingListener makes for the synthetic sync of the test module (see TestSyntheticSync). */
export function expectedSynthetic(blocks: number, start: number, outputs: boolean): string[] {
  const out: string[] = [];
  const pool = (hash: string, amount: string, account: string, subaddress: string, height: string, asset: string, keys: string) => [hash, amount, account, subaddress, height, asset, "keys=" + keys, "frozen=true", "proto=true"].join(":");
  if (outputs) out.push("received:" + pool("aaaa", "1000", "0", "0", "-", "-", "accountIndex,amount,subaddressIndex,txHash"));
  for (let i = 0; i < blocks; i++) {
    const h = start + i;
    out.push("block:" + h);
    out.push("progress:" + h + ":" + start + ":" + (start + blocks) + ":" + String((i + 1) / blocks) + ":Synchronizing");
    if (outputs && i === 1) {
      out.push("received:" + pool("bbbb", "9223372036854775813", "1", "2", String(h), "ZSD", "accountIndex,amount,assetType,height,subaddressIndex,txHash"));
      out.push("balance:9223372036854775813:0:ZSD:bigint");
    }
    if (outputs && i === 2) out.push("spent:" + pool("cccc", "77", "0", "-", String(h), "ZPH", "accountIndex,amount,assetType,height,txHash"));
  }
  return out;
}

/** A value that counts every operation on it (property reads, conversions, key listing); used as a thrown or rejected value. */
export function countingValue(counter: { reads: number }): object {
  return new Proxy(Object.create(null), {
    get: () => { counter.reads++; return undefined; },
    has: () => { counter.reads++; return false; },
    ownKeys: () => { counter.reads++; return []; },
    getOwnPropertyDescriptor: () => { counter.reads++; return undefined; },
    getPrototypeOf: () => { counter.reads++; return null; }
  });
}

/** Counts unhandled promise rejections of this context (Node.js process event, or the browser event) until stopped. */
export function unhandledRejections(): { count(): number; stop(): void } {
  let n = 0;
  const proc = (globalThis as { process?: { on?: unknown; off?: unknown } }).process;
  if (proc !== undefined && typeof proc.on === "function" && typeof proc.off === "function") {
    const handler = () => { n++; };
    (proc.on as (e: string, h: () => void) => void).call(proc, "unhandledRejection", handler);
    return { count: () => n, stop: () => { (proc.off as (e: string, h: () => void) => void).call(proc, "unhandledRejection", handler); } };
  }
  const target = globalThis as unknown as { addEventListener?: (e: string, h: (ev: { preventDefault(): void }) => void) => void; removeEventListener?: (e: string, h: (ev: { preventDefault(): void }) => void) => void };
  const handler = (ev: { preventDefault(): void }) => { n++; ev.preventDefault(); };
  if (typeof target.addEventListener === "function") target.addEventListener("unhandledrejection", handler);
  return { count: () => n, stop: () => { if (typeof target.removeEventListener === "function") target.removeEventListener("unhandledrejection", handler); } };
}

/** Busy-wait the calling thread (a blocked event loop or a slow callback). */
export function busyWait(ms: number): void {
  const end = Date.now() + ms;
  while (Date.now() < end) { /* blocking on purpose */ }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
