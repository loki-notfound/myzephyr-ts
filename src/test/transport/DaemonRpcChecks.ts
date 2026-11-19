/**
 * The daemon client against constructed loopback daemons (test only): the /rv/rpc* mounts of redirectServers.cjs
 * (daemonRpcDaemon.cjs). Shared by the Node.js runner and the Chromium page.
 *
 * V02 (the calling context only: the class is never proxied): ZephyrDaemonRpc reads values above 2^53 and the largest
 * uint64 values exactly, leaves an absent field absent, rejects every malformed answer and every failure with a fixed
 * DAEMON_ERROR without node text, follows no redirect, sends exactly one request per supported call and none for an
 * unsupported method, an invalid argument or the construction, and leaves no route allowed after a call.
 */
import { ZephyrDaemonRpc, ZephyrWalletError } from "../../main/ts/index";
import type { ZephyrBlockHeader } from "../../main/ts/index";
import HttpClient from "../../main/ts/common/HttpClient";
import type { RedirectServerStats, RedirectTargets } from "./RedirectChecks";
import { ReserveCheckResult, delta, rejects, rvCounts } from "./ReserveChecks";

/** The constants of daemonRpcDaemon.cjs (GET /__daemonrpc), every integer as decimal text. */
export interface DaemonRpcConstants {
  readonly marker: string;
  readonly height: number;
  readonly big: string;
  readonly u64max: string;
  readonly variants: ReadonlyArray<{ what: string; valid: boolean }>;
}

/** The header the constructed daemon sends for the valid variants (bigHeader of reserveDaemon.cjs). */
function expectedHeader(c: DaemonRpcConstants, height: number, withRecord: boolean): Record<string, unknown> {
  const big = BigInt(c.big), u64 = BigInt(c.u64max);
  const out: Record<string, unknown> = { hash: "b51df7bed1843ca6c90bf3e9156c4e38ba70e1055eef51774119dc892db5cf9d", height, timestamp: Number.MAX_SAFE_INTEGER, size: 102, weight: 102,
    longTermWeight: 176470, depth: 0, difficulty: BigInt("0x9ee85ddd").toString(), cumulativeDifficulty: ((BigInt(5) << BigInt(64)) + big).toString(), majorVersion: 11, minorVersion: 11,
    nonce: 4294967295, minerTxHash: "8c0a560bf85b300c3b19758efbd41aa633cec489e3f52f2d97026ea9d7efa522", numTxs: 0, orphanStatus: false,
    prevHash: "40550cf21c0227e8e144953d80871b7787e6d11129ec06e788a3d6a95a9b77c0", reward: u64.toString() };
  if (withRecord) out.pricingRecord = { spot: big.toString(), movingAverage: u64.toString(), stable: "7046519640000", stableMa: (big + BigInt(2)).toString(), reserve: "725632460000",
    reserveMa: "715810850000", reserveRatio: (big + BigInt(4)).toString(), reserveRatioMa: "2129814930000", yieldPrice: "1995702890000", timestamp: big.toString(),
    signature: "5c5d0107dd75ad4fddacf82bb82b3d4a0db44eb258378a5f1854c022f490da547dc77b8bf2fdc6e42401cd4d473a39fd1dec01b76e9665bf6d0f8d16cc0a219f" };
  return out;
}

function headerText(h: ZephyrBlockHeader): Record<string, unknown> {
  const conv = (o: object): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(o)) out[k] = typeof v === "bigint" ? v.toString() : v !== null && typeof v === "object" ? conv(v) : v;
    return out;
  };
  return conv(h);
}

function sameJson(a: unknown, b: unknown): boolean {
  const norm = (v: unknown): unknown => v !== null && typeof v === "object" ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, norm((v as Record<string, unknown>)[k])])) : v;
  return JSON.stringify(norm(a)) === JSON.stringify(norm(b));
}

/** The inherited methods ZephyrDaemonRpc does not offer (65 on an instance, connectToDaemonRpc on the class). */
export const UNSUPPORTED_DAEMON_METHODS = ["addListener", "checkForUpdate", "downloadUpdate", "flushTxPool", "getAltBlockHashes", "getAltChains", "getBlockByHash", "getBlockByHeight",
  "getBlockHash", "getBlockHashes", "getBlockHeadersByRange", "getBlockTemplate", "getBlocksByHash", "getBlocksByHeight", "getBlocksByRange", "getBlocksByRangeChunked", "getDownloadLimit",
  "getFeeEstimate", "getHardForkInfo", "getKeyImageSpentStatus", "getKeyImageSpentStatuses", "getKnownPeers", "getListeners", "getMinerTxSum", "getMiningStatus", "getOutputDistribution",
  "getOutputHistogram", "getOutputs", "getPeerBans", "getPeers", "getPollInterval", "getProcess", "getRpcConnection", "getSyncInfo", "getTx", "getTxHex", "getTxHexes", "getTxPool",
  "getTxPoolHashes", "getTxPoolStats", "getTxs", "getUploadLimit", "getVersion", "isConnected", "isTrusted", "pruneBlockchain", "relayTxByHash", "relayTxsByHash", "removeListener",
  "resetDownloadLimit", "resetUploadLimit", "setDownloadLimit", "setIncomingPeerLimit", "setOutgoingPeerLimit", "setPeerBan", "setPeerBans", "setUploadLimit", "startMining", "stop",
  "stopMining", "stopProcess", "submitBlock", "submitBlocks", "submitTxHex", "waitForNextBlockHeader"];

/** unreachable: an address that refuses connections (Node.js only; a page's policy allows only the test servers) */
export async function runDaemonRpcCheck(targets: RedirectTargets, c: DaemonRpcConstants, unreachable?: string): Promise<ReserveCheckResult> {
  const notes: string[] = [];
  const steps: Record<string, Record<string, number>> = {};
  const counts = async () => rvCounts(await targets.stats());
  const routes0 = HttpClient.daemonRouteCount();
  const routeLeft = (what: string) => { if (HttpClient.daemonRouteCount() !== routes0) notes.push(what + ": a route stayed allowed"); };
  let c0 = await counts();
  const d = new ZephyrDaemonRpc(targets.first + "/rv/rpc");
  if (Object.keys(delta(c0, await counts())).length !== 0) notes.push("the constructor sent a request");
  routeLeft("constructor");
  const step = async <T>(name: string, method: string, call: () => Promise<T>): Promise<T | undefined> => {
    c0 = await counts();
    let out: T | undefined = undefined;
    try { out = await call(); } catch (err) { notes.push(name + ": rejected " + (err instanceof ZephyrWalletError ? err.code + "/" + err.diagnostic : "untyped")); }
    steps[name] = delta(c0, await counts());
    if (JSON.stringify(steps[name]) !== JSON.stringify({ ["POST /rv/rpc/json_rpc " + method]: 1 })) notes.push(name + ": requests " + JSON.stringify(steps[name]));
    routeLeft(name);
    return out;
  };
  const info = await step("getInfo", "get_info", () => d.getInfo());
  const big = BigInt(c.big);
  const expectedInfo = { version: "", height: c.height, targetHeight: 0, topBlockHash: "b51df7bed1843ca6c90bf3e9156c4e38ba70e1055eef51774119dc892db5cf9d", networkType: 0, isSynchronized: true,
    isBusySyncing: false, isOffline: false, isRestricted: true, updateAvailable: false, adjustedTimestamp: 1795105138, target: 120, difficulty: "2668793037",
    cumulativeDifficulty: ((BigInt(3) << BigInt(64)) + big).toString(), numTxs: 1271617, numTxsPool: 2, numAltBlocks: 2, blockSizeLimit: 600000, blockSizeMedian: 300000,
    blockWeightLimit: 600000, blockWeightMedian: 300000 };
  if (info === undefined || !sameJson(headerText(info as unknown as ZephyrBlockHeader), expectedInfo) || !Object.isFrozen(info)) notes.push("getInfo: " + JSON.stringify(info === undefined ? null : headerText(info as unknown as ZephyrBlockHeader)));
  const height = await step("getHeight", "get_block_count", () => d.getHeight());
  if (height !== c.height) notes.push("getHeight: " + String(height));
  const last = await step("getLastBlockHeader", "get_last_block_header", () => d.getLastBlockHeader());
  if (last === undefined || !sameJson(headerText(last), expectedHeader(c, c.height - 1, true)) || !Object.isFrozen(last) || !Object.isFrozen(last.pricingRecord)) notes.push("getLastBlockHeader: " + JSON.stringify(last === undefined ? null : headerText(last)));
  if (last !== undefined && last.pricingRecord !== undefined && (last.pricingRecord.spot !== big || last.pricingRecord.spot === BigInt(Number(c.big)) || last.reward !== BigInt(c.u64max))) notes.push("getLastBlockHeader: a value above 2^53 went through a number");
  const byHash = await step("getBlockHeaderByHash", "get_block_header_by_hash", () => d.getBlockHeaderByHash("b51df7bed1843ca6c90bf3e9156c4e38ba70e1055eef51774119dc892db5cf9d"));
  if (byHash === undefined || !sameJson(headerText(byHash), expectedHeader(c, c.height - 1, true))) notes.push("getBlockHeaderByHash differs");
  // every header variant by its height
  for (let k = 0; k < c.variants.length; k++) {
    const v = c.variants[k];
    c0 = await counts();
    if (v.valid) {
      try {
        const h = await d.getBlockHeaderByHeight(k);
        if (!sameJson(headerText(h), expectedHeader(c, k, k === 0)) || (k > 0 && "pricingRecord" in h) || "powHash" in h) notes.push("variant " + k + " (" + v.what + "): " + JSON.stringify(headerText(h)));
      } catch (err) { notes.push("variant " + k + " (" + v.what + "): rejected"); }
    } else {
      const n = await rejects(d.getBlockHeaderByHeight(k), "DAEMON_ERROR", "DAEMON_RESPONSE", c.marker, "variant " + k + " (" + v.what + ")");
      if (n !== undefined) notes.push(n);
    }
    const dk = delta(c0, await counts());
    if (JSON.stringify(dk) !== JSON.stringify({ "POST /rv/rpc/json_rpc get_block_header_by_height": 1 })) notes.push("variant " + k + ": requests " + JSON.stringify(dk));
    routeLeft("variant " + k);
  }
  let n = await rejects(d.getBlockHeaderByHeight(999), "DAEMON_ERROR", "DAEMON_RESPONSE", c.marker, "a height the node does not have"); if (n !== undefined) notes.push(n);
  // failures of the transport and of the answer
  for (const [kind, code, diagnostic] of [["rpcstatus", "DAEMON_ERROR", "DAEMON_RESPONSE"], ["rpcbusy", "DAEMON_ERROR", "DAEMON_BUSY"], ["rpcerror", "DAEMON_ERROR", "DAEMON_RESPONSE"],
    ["rpchttp", "DAEMON_ERROR", "DAEMON_RESPONSE"], ["rpctext", "DAEMON_ERROR", "DAEMON_RESPONSE"], ["rpchuge", "DAEMON_ERROR", "DAEMON_RESPONSE"]] as const) {
    const dk = new ZephyrDaemonRpc({ uri: targets.first + "/rv/" + kind });
    c0 = await counts();
    n = await rejects(dk.getInfo(), code, diagnostic, c.marker, kind); if (n !== undefined) notes.push(n);
    n = await rejects(dk.getLastBlockHeader(), code, diagnostic, c.marker, kind + " header"); if (n !== undefined) notes.push(n);
    steps[kind] = delta(c0, await counts());
    if (Object.values(steps[kind]).reduce((a, b) => a + b, 0) !== 2) notes.push(kind + ": requests " + JSON.stringify(steps[kind]));
    routeLeft(kind);
  }
  const statsBefore = await targets.stats();
  n = await rejects(new ZephyrDaemonRpc(targets.first + "/rv/rpcredirect").getInfo(), "DAEMON_ERROR", "DAEMON_RESPONSE", c.marker, "a redirecting daemon"); if (n !== undefined) notes.push(n);
  const statsAfter = await targets.stats();
  const landed = (st: RedirectServerStats) => Object.values(st.landed).reduce((a, v) => a + v.requests, 0) + Object.values(st.second).reduce((a, v) => a + v.requests, 0);
  if (landed(statsAfter) !== landed(statsBefore)) notes.push("the redirect was followed");
  if (statsAfter.first["POST /rv/rpcredirect/json_rpc get_info"]?.requests !== (statsBefore.first["POST /rv/rpcredirect/json_rpc get_info"]?.requests ?? 0) + 1) notes.push("the redirecting daemon did not see exactly one request");
  if (unreachable !== undefined) { n = await rejects(new ZephyrDaemonRpc(unreachable).getHeight(), "DAEMON_ERROR", "DAEMON_UNREACHABLE", c.marker, "an unreachable daemon"); if (n !== undefined) notes.push(n); }
  routeLeft("failures");
  // no request: unsupported methods, invalid arguments
  c0 = await counts();
  const untyped = d as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
  let unsupported = 0;
  for (const name of UNSUPPORTED_DAEMON_METHODS) {
    if (typeof untyped[name] !== "function") { notes.push(name + ": not defined"); continue; }
    n = await rejects(untyped[name](1, 2), "UNSUPPORTED_CAPABILITY", "DAEMON_RPC_METHOD", c.marker, name);
    if (n !== undefined) notes.push(n); else unsupported++;
  }
  n = await rejects((ZephyrDaemonRpc as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>).connectToDaemonRpc(targets.first + "/rv/rpc"), "UNSUPPORTED_CAPABILITY", "DAEMON_RPC_METHOD", c.marker, "connectToDaemonRpc");
  if (n !== undefined) notes.push(n); else unsupported++;
  for (const [what, call, diagnostic] of [["height -1", () => d.getBlockHeaderByHeight(-1), "BLOCK_HEIGHT"], ["height 1.5", () => d.getBlockHeaderByHeight(1.5), "BLOCK_HEIGHT"],
    ["height 2^53", () => d.getBlockHeaderByHeight(2 ** 53), "BLOCK_HEIGHT"], ["height as text", () => untyped.getBlockHeaderByHeight("1"), "BLOCK_HEIGHT"],
    ["hash in upper case", () => d.getBlockHeaderByHash("B".repeat(64)), "BLOCK_HASH"], ["hash too short", () => d.getBlockHeaderByHash("ab"), "BLOCK_HASH"],
    ["getInfo(1)", () => untyped.getInfo(1), "FIELD_TYPE"], ["getHeight(1)", () => untyped.getHeight(1), "FIELD_TYPE"], ["getLastBlockHeader(1)", () => untyped.getLastBlockHeader(1), "FIELD_TYPE"]] as const) {
    n = await rejects((call as () => Promise<unknown>)(), "INVALID_CONFIG", diagnostic, c.marker, what); if (n !== undefined) notes.push(n);
  }
  steps.rejected = delta(c0, await counts());
  if (Object.keys(steps.rejected).length !== 0) notes.push("a rejected call sent a request " + JSON.stringify(steps.rejected));
  routeLeft("rejections");
  notes.push(unsupported + " unsupported methods rejected before any request");
  const failing = notes.filter((x) => !/^[0-9]+ unsupported methods rejected before any request$/.test(x));
  if (unsupported !== UNSUPPORTED_DAEMON_METHODS.length + 1) failing.push("unsupported " + unsupported);
  return { check: { id: "V02", title: "ZephyrDaemonRpc against constructed daemons: values above 2^53 and 2^64 - 1 exact, absent fields absent, every malformed answer and failure a fixed DAEMON_ERROR without node text, no redirect followed, one request per call and none for an unsupported method, an invalid argument or the construction, no route left allowed", status: failing.length === 0 ? "pass" : "fail", notes }, steps };
}
