/**
 * The reserve and the circulating supply against constructed loopback daemons (test only): the /rv/<case> mounts of
 * redirectServers.cjs (reserveDaemon.cjs). Shared by the Node.js runner and the Chromium page.
 *
 * V01 (a wallet in the page or main thread, and in its own worker): getReserveInfo equals the core's formula applied
 * to the constructed supply, pricing record and history (amounts above 2^64 exact, the ratios as the shortest decimal
 * text of the core's double, the moving average from the history, the yield values only from hard fork 6, the zero
 * cases), getCirculatingSupply equals the constructed tally; a failed read of the pricing record (an error answer, a
 * record without the spot price) rejects with DAEMON_ERROR/PRICING_RECORD_UNAVAILABLE; failed supply and history reads
 * and malformed supply data reject with DAEMON_ERROR/DAEMON_RESPONSE; no node text in an error; only the core's request
 * set per call.
 */
import { createRandomWallet, ZephyrWalletError } from "../../main/ts/index";
import type { ZephyrReserveInfo, ZephyrWallet } from "../../main/ts/index";
import { plainDecimal } from "../../main/ts/common/ZephyrReserveInternal";
import type { RedirectServerStats, RedirectTargets } from "./RedirectChecks";

/** The constants of reserveDaemon.cjs (GET /__reserve), every integer as decimal text. */
export interface ReserveConstants {
  readonly marker: string;
  readonly height: number;
  readonly record: Readonly<Record<string, string>>;
  readonly supply: ReadonlyArray<readonly [string, string]>;
  readonly historyRatio: string;
}

export interface ReserveCheckResult {
  readonly check: { id: string; title: string; status: "pass" | "fail"; notes: string[] };
  /** requests per mount, endpoint and method during each step, from the daemon's own counts */
  readonly steps: Record<string, Record<string, number>>;
}

const COIN = BigInt("1000000000000");
const U128 = BigInt(1) << BigInt(128);

export function rvCounts(stats: RedirectServerStats): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(stats.first)) if (k.substring(k.indexOf(" ") + 1).startsWith("/rv/")) out[k] = v.requests;
  return out;
}

export function delta(a: Record<string, number>, b: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of Object.keys(b)) if ((b[k] ?? 0) !== (a[k] ?? 0)) out[k] = b[k] - (a[k] ?? 0);
  return out;
}

export function texts(err: unknown): string[] {
  return [String(err), JSON.stringify(err), err instanceof Error ? String(err.stack) : "", err instanceof Error ? err.message : ""];
}

/** Rejection with exactly code/diagnostic and without the marker; returns a note or undefined. */
export async function rejects(p: Promise<unknown>, code: string, diagnostic: string | undefined, marker: string, what: string): Promise<string | undefined> {
  try {
    await p;
    return what + ": resolved";
  } catch (err) {
    if (texts(err).some((t) => t.includes(marker))) return what + ": the node's text reached the error";
    if (!(err instanceof ZephyrWalletError)) return what + ": untyped rejection";
    if (err.code !== code || err.diagnostic !== diagnostic) return what + ": " + err.code + "/" + err.diagnostic + ", expected " + code + "/" + diagnostic;
    return undefined;
  }
}

/** The core's get_reserve_info (cryptonote::get_reserve_info, hard fork above 4) applied to the constructed data. */
export function expectedReserve(c: ReserveConstants, hf: number, withoutStables: boolean, historyLength: number): Record<string, string | number> {
  const supply = new Map(c.supply.filter(([label]) => !(withoutStables && label === "ZSD")).map(([l, a]) => [l, BigInt(a)] as const));
  const zephReserve = supply.get("ZEPH") ?? supply.get("DJED") ?? BigInt(0);
  const numStables = supply.get("ZEPHUSD") ?? supply.get("ZSD") ?? BigInt(0);
  const numReserves = supply.get("ZEPHRSV") ?? supply.get("ZRS") ?? BigInt(0);
  const full = (zephReserve * BigInt(c.record.spot)) % U128;
  const out: Record<string, string | number> = { zephReserve: zephReserve.toString(), numStables: numStables.toString(), numReserves: numReserves.toString(),
    assetsMa: "0", liabilities: numStables.toString(), equityMa: "0", hfVersion: hf };
  const assets = full / COIN;
  out.assets = assets.toString();
  if (numStables === BigInt(0)) {
    return Object.assign(out, { equity: assets.toString(), reserveRatio: "0", reserveRatioMa: "0", zyieldCirc: "0", zyieldRsv: "0" });
  }
  const ratioInt = full / numStables;
  let ma = BigInt(0);
  if (historyLength >= 719) {
    ma = (BigInt(c.historyRatio) * BigInt(719) + (ratioInt % (BigInt(1) << BigInt(64)))) / BigInt(720);
    ma -= ma % BigInt(10000);
  }
  out.reserveRatio = plainDecimal(Number(ratioInt) / 1e12);
  out.reserveRatioMa = plainDecimal(Number(ma) / 1e12);
  out.equity = (assets > numStables ? assets - numStables : BigInt(0)).toString();
  out.zyieldCirc = hf >= 6 ? (supply.get("ZYIELD") ?? supply.get("ZYS") ?? BigInt(0)).toString() : "0";
  out.zyieldRsv = hf >= 6 ? (supply.get("ZYIELDRSV") ?? supply.get("YIELD") ?? BigInt(0)).toString() : "0";
  return out;
}

function reserveText(info: ZephyrReserveInfo): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(info)) out[k] = typeof v === "bigint" ? v.toString() : v;
  return out;
}

const RESERVE_METHODS = ["get_info", "hard_fork_info", "getblockheaderbyheight", "get_circulating_supply", "get_pricing_record_history"];

export async function runReserveWalletCheck(mode: "direct" | "worker", targets: RedirectTargets, c: ReserveConstants): Promise<ReserveCheckResult> {
  const notes: string[] = [];
  const steps: Record<string, Record<string, number>> = {};
  const counts = async () => rvCounts(await targets.stats());
  const w: ZephyrWallet = await createRandomWallet({ networkType: "mainnet", password: "reserve-check", proxyToWorker: mode === "worker" });
  try {
    const value = async (kind: string, hf: number, withoutStables: boolean, history: number) => {
      await w.setDaemonConnection(targets.first + "/rv/" + kind);
      const c0 = await counts();
      const info = await w.getReserveInfo();
      const c1 = await counts();
      steps[kind + ".reserve"] = delta(c0, c1);
      const expected = expectedReserve(c, hf, withoutStables, history);
      const actual = reserveText(info);
      if (JSON.stringify(actual, Object.keys(expected).sort()) !== JSON.stringify(expected, Object.keys(expected).sort()) || Object.keys(actual).length !== 13) notes.push(kind + ": reserve info " + JSON.stringify(actual) + " expected " + JSON.stringify(expected));
      if (!Object.isFrozen(info) || Object.getPrototypeOf(info) !== Object.prototype) notes.push(kind + ": the reserve info is not a frozen plain object");
      if (typeof info.zephReserve !== "bigint" || typeof info.reserveRatio !== "string" || typeof info.hfVersion !== "number") notes.push(kind + ": field types");
      const methods = Object.keys(steps[kind + ".reserve"]).map((k) => k.split(" ").pop() as string);
      if (methods.some((m) => !RESERVE_METHODS.includes(m)) || RESERVE_METHODS.slice(1).some((m) => steps[kind + ".reserve"]["POST /rv/" + kind + "/json_rpc " + m] !== 1)) notes.push(kind + ": requests " + JSON.stringify(steps[kind + ".reserve"]));
      return info;
    };
    const big = await value("big", 11, false, 719);
    if (big.zephReserve <= BigInt("18446744073709551615") || big.assets <= BigInt("18446744073709551615")) notes.push("big: the constructed amounts do not exceed 2^64");
    await value("hf5", 5, false, 719);
    await value("zero", 11, true, 719);
    await value("short", 11, false, 718);
    // the supply of the big case
    await w.setDaemonConnection(targets.first + "/rv/big");
    let c0 = await counts();
    const supply = await w.getCirculatingSupply();
    let c1 = await counts();
    steps["big.supply"] = delta(c0, c1);
    const expectedSupply = c.supply.map(([l, a]) => l + "=" + a).sort().join(",");
    if (Object.keys(supply).map((l) => l + "=" + supply[l].toString()).join(",") !== expectedSupply) notes.push("big: supply " + Object.keys(supply).join(","));
    if (!Object.isFrozen(supply) || Object.values(supply).some((v) => typeof v !== "bigint")) notes.push("big: the supply is not a frozen record of bigint");
    if (JSON.stringify(steps["big.supply"]) !== JSON.stringify({ "POST /rv/big/json_rpc get_circulating_supply": 1 })) notes.push("big: supply requests " + JSON.stringify(steps["big.supply"]));
    // failures: fixed errors without node text
    const fail = async (kind: string, reserve: [string, string], supplyCode: [string, string] | undefined) => {
      await w.setDaemonConnection(targets.first + "/rv/" + kind);
      c0 = await counts();
      const n1 = await rejects(w.getReserveInfo(), reserve[0], reserve[1], c.marker, kind + ": getReserveInfo");
      if (n1 !== undefined) notes.push(n1);
      if (supplyCode !== undefined) { const n2 = await rejects(w.getCirculatingSupply(), supplyCode[0], supplyCode[1], c.marker, kind + ": getCirculatingSupply"); if (n2 !== undefined) notes.push(n2); }
      c1 = await counts();
      steps[kind] = delta(c0, c1);
    };
    await fail("nopr", ["DAEMON_ERROR", "PRICING_RECORD_UNAVAILABLE"], undefined);
    await fail("norates", ["DAEMON_ERROR", "PRICING_RECORD_UNAVAILABLE"], undefined);
    await fail("supplyrpc", ["DAEMON_ERROR", "DAEMON_RESPONSE"], ["DAEMON_ERROR", "DAEMON_RESPONSE"]);
    await fail("supplyhttp", ["DAEMON_ERROR", "DAEMON_RESPONSE"], ["DAEMON_ERROR", "DAEMON_RESPONSE"]);
    await fail("historyrpc", ["DAEMON_ERROR", "DAEMON_RESPONSE"], undefined);
    await w.setDaemonConnection(targets.first + "/rv/supplybad");
    let n = await rejects(w.getCirculatingSupply(), "DAEMON_ERROR", "DAEMON_RESPONSE", c.marker, "supplybad: getCirculatingSupply"); if (n !== undefined) notes.push(n);
    await w.setDaemonConnection(targets.first + "/rv/supplyhuge");
    n = await rejects(w.getCirculatingSupply(), "DAEMON_ERROR", "DAEMON_RESPONSE", c.marker, "supplyhuge: getCirculatingSupply"); if (n !== undefined) notes.push(n);
    if (steps.nopr["POST /rv/nopr/json_rpc get_circulating_supply"] !== undefined) notes.push("nopr: the core read on after the failed pricing record read");
    // argument and connection rejections before any request
    c0 = await counts();
    n = await rejects((w.getReserveInfo as (...a: unknown[]) => Promise<unknown>)(1), "INVALID_CONFIG", "FIELD_TYPE", c.marker, "getReserveInfo(1)"); if (n !== undefined) notes.push(n);
    n = await rejects((w.getCirculatingSupply as (...a: unknown[]) => Promise<unknown>)(1), "INVALID_CONFIG", "FIELD_TYPE", c.marker, "getCirculatingSupply(1)"); if (n !== undefined) notes.push(n);
    await w.setDaemonConnection(undefined);
    n = await rejects(w.getReserveInfo(), "DAEMON_ERROR", "DAEMON_NOT_CONNECTED", c.marker, "getReserveInfo without a daemon"); if (n !== undefined) notes.push(n);
    n = await rejects(w.getCirculatingSupply(), "DAEMON_ERROR", "DAEMON_NOT_CONNECTED", c.marker, "getCirculatingSupply without a daemon"); if (n !== undefined) notes.push(n);
    c1 = await counts();
    if (Object.keys(delta(c0, c1)).length !== 0) notes.push("a rejected call sent a request " + JSON.stringify(delta(c0, c1)));
  } finally {
    await w.close();
  }
  const closed = await rejects(w.getReserveInfo(), "WALLET_CLOSED", undefined, c.marker, "getReserveInfo after close");
  if (closed !== undefined) notes.push(closed);
  return { check: { id: "V01", title: "getReserveInfo and getCirculatingSupply against constructed daemons: the core's values exactly (amounts above 2^64, the ratios' shortest decimal text, the moving average, the yield values from hard fork 6, the zero cases); a failed pricing record read rejects DAEMON_ERROR/PRICING_RECORD_UNAVAILABLE; failed supply and history reads and malformed supply DAEMON_ERROR/DAEMON_RESPONSE; no node text; the core's request set only", status: notes.length === 0 ? "pass" : "fail", notes }, steps };
}

