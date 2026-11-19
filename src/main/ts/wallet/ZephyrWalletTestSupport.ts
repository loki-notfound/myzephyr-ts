/**
 * Test support of the library: the construction of a full wallet with the intent derived from the
 * fields present, and the counts of the network guard, for the repository's contract and network
 * tests. Internal: the package entry does not export this module, and no declaration the entry
 * reaches refers to it.
 */
import LibraryUtils from "../common/LibraryUtils";
import HttpClient from "../common/HttpClient";
import ZephyrWalletError from "../common/ZephyrWalletError";
import { ZephyrWalletWorkers } from "../common/ZephyrWalletWorkers";
import type { ZephyrWallet, ZephyrWalletConstructionOptions } from "./ZephyrWallet";

/** Report of the network guard in the main context and in the SDK workers that are open now. */
export interface ZephyrNetworkGuardReport {
  readonly mainBlockedRequests: number;
  readonly mainBlockedSummary: Readonly<Record<string, number>>;
  /** Requests the main context's allowlist sent to a configured daemon route, by "METHOD /endpoint rpc-method" */
  readonly mainAllowedRequests: number;
  readonly mainAllowedSummary: Readonly<Record<string, number>>;
  /** sum over the open SDK workers that reported now; undefined if none reported */
  readonly workerBlockedRequests: number | undefined;
  readonly workerBlockedSummary: Readonly<Record<string, number>> | undefined;
  readonly workerAllowedRequests: number | undefined;
  readonly workerAllowedSummary: Readonly<Record<string, number>> | undefined;
  /** number of open workers that reported */
  readonly workerReports: number;
  /** open workers that did not report (a construction in progress is not asked) */
  readonly workersUnreported: number;
}

/** The construction of wallet/ZephyrWallet.ts with the intent derived from the fields present, set when that module loads. */
let createByFields: ((raw: unknown, options?: ZephyrWalletConstructionOptions) => Promise<ZephyrWallet>) | undefined = undefined;

/**
 * Called once by wallet/ZephyrWallet.ts when it loads: the construction and the wallet's constructor stay private
 * to that module, which hands this module its construction with no fixed intent.
 */
export function setCreateWallet(create: (raw: unknown, options?: ZephyrWalletConstructionOptions) => Promise<ZephyrWallet>): void {
  if (createByFields === undefined) createByFields = create;
}

/** Create a full wallet with the intent derived from the fields present (for contract tests). */
export async function createWallet(raw: unknown, options?: ZephyrWalletConstructionOptions): Promise<ZephyrWallet> {
  if (createByFields === undefined) throw new ZephyrWalletError("NATIVE_ERROR", "UNCLASSIFIED_ERROR");
  return createByFields(raw, options);
}

/**
 * Counts of the network guard: requests blocked and requests sent to a configured daemon route,
 * in the main context and in every SDK-owned worker that is open now (utility and wallet workers,
 * queried now). Ended workers are no longer collected by the library; tests read a
 * wallet worker's counts before closing it.
 */
export async function getNetworkGuardReport(): Promise<ZephyrNetworkGuardReport> {
  let reports = 0;
  let unreported = 0;
  let blocked = 0;
  let allowed = 0;
  const blockedSummary: Record<string, number> = {};
  const allowedSummary: Record<string, number> = {};
  for (const channel of LibraryUtils.WORKERS.openChannels()) {
    if (channel.role === "construction") continue;
    let reply: unknown = undefined;
    try { reply = await channel.invoke(undefined, "getNetworkGuardReport", []); } catch (err) { reply = undefined; }
    const counts = ZephyrWalletWorkers.guardCountsOf(reply);
    if (counts === undefined) { unreported++; continue; }
    reports++;
    blocked += counts.blockedRequests;
    allowed += counts.allowedRequests;
    for (const k of Object.keys(counts.blockedRequestSummary)) blockedSummary[k] = (blockedSummary[k] ?? 0) + counts.blockedRequestSummary[k];
    for (const k of Object.keys(counts.allowedRequestSummary)) allowedSummary[k] = (allowedSummary[k] ?? 0) + counts.allowedRequestSummary[k];
  }
  return { mainBlockedRequests: HttpClient.BLOCKED_REQUESTS, mainBlockedSummary: Object.assign({}, HttpClient.BLOCKED_REQUEST_SUMMARY),
    mainAllowedRequests: HttpClient.ALLOWED_REQUESTS, mainAllowedSummary: Object.assign({}, HttpClient.ALLOWED_REQUEST_SUMMARY),
    workerBlockedRequests: reports > 0 ? blocked : undefined, workerBlockedSummary: reports > 0 ? blockedSummary : undefined,
    workerAllowedRequests: reports > 0 ? allowed : undefined, workerAllowedSummary: reports > 0 ? allowedSummary : undefined,
    workerReports: reports, workersUnreported: unreported };
}
