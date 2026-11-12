/**
 * Redirect checks of the transport (test only), shared by the Node.js runner (main thread and wallet
 * worker) and the Chromium page (page and wallet worker). A wallet is pointed at the loopback servers
 * of redirectServers.cjs: every 3xx answer must stay unfollowed (the second server, or the
 * same-origin landing path, receives nothing) and become the fixed daemon failure; nothing of the
 * answer (status text, Location, body) may reach a result or an error. The report holds counts,
 * statuses and SDK error codes only; never a Location value.
 */
import { createRandomWallet, ZephyrWalletError } from "../../main/ts/index";
import type { ZephyrWallet } from "../../main/ts/index";

export const REDIRECT_STATUSES = [301, 302, 303, 307, 308] as const;

/** Counts kept by the loopback servers: key "METHOD /base/endpoint [rpc method]". */
export interface RedirectServerStats {
  readonly first: Record<string, { requests: number; bodyBytes: number }>;
  readonly second: Record<string, { requests: number; bodyBytes: number }>;
  readonly landed: Record<string, { requests: number; bodyBytes: number }>;
  readonly preflights: number;
  readonly redirectsSent: number;
}

export interface RedirectTargets {
  /** origin of the first server */
  readonly first: string;
  /** read the counts of both servers */
  stats(): Promise<RedirectServerStats>;
}

export interface RedirectCaseResult {
  readonly kind: "json" | "same-origin" | "binary" | "control";
  readonly status: number;
  readonly setDaemonConnection: string;
  readonly isConnectedToDaemon: string;
  readonly getDaemonHeight: string;
  readonly sync: string;
  /** requests the first server received under the case's base path (and how many carried a body) */
  readonly firstRequests: number;
  readonly firstRequestsWithBody: number;
  readonly firstPostRequests: number;
  readonly firstBinaryRequests: number;
  /** redirect answers the first server sent in this case */
  readonly redirectsSent: number;
  /** requests the redirect target received in this case (must be 0) */
  readonly secondRequests: number;
  readonly landedRequests: number;
}

export interface RedirectReport {
  readonly env: string;
  readonly mode: "direct" | "worker";
  readonly cases: RedirectCaseResult[];
  readonly checks: { id: string; title: string; status: "pass" | "fail"; notes: string[] }[];
  /** whether any result or error text carried a part of an answer (status text, Location, body) */
  readonly leaked: boolean;
}

const codeOf = (e: unknown): string => e instanceof ZephyrWalletError ? e.code + (e.diagnostic ? "/" + e.diagnostic : "") : "other:" + (e instanceof Error ? e.name : typeof e);

function sum(bucket: Record<string, { requests: number; bodyBytes: number }>, prefix: string, filter: (key: string) => boolean = () => true): { requests: number; withBody: number } {
  let requests = 0;
  let withBody = 0;
  for (const [k, v] of Object.entries(bucket)) {
    const path = k.substring(k.indexOf(" ") + 1);
    if (!path.startsWith(prefix) || !filter(k)) continue;
    requests += v.requests;
    if (v.bodyBytes > 0) withBody += v.requests;
  }
  return { requests, withBody };
}

function delta(after: RedirectServerStats, before: RedirectServerStats, which: "first" | "second" | "landed", prefix: string, filter?: (key: string) => boolean): { requests: number; withBody: number } {
  const a = sum(after[which], prefix, filter);
  const b = sum(before[which], prefix, filter);
  return { requests: a.requests - b.requests, withBody: a.withBody - b.withBody };
}

/** Text of a result or an error that must never contain a part of a redirect answer. */
function leaks(value: unknown): boolean {
  const text = value instanceof Error ? value.message + " " + String((value as { diagnostic?: unknown }).diagnostic ?? "") : String(value);
  return /127\.0\.0\.1|redirected|landed|Moved|Found|See Other|Redirect/i.test(text);
}

export async function runRedirectChecks(env: string, mode: "direct" | "worker", targets: RedirectTargets): Promise<RedirectReport> {
  const cases: RedirectCaseResult[] = [];
  let leaked = false;
  const wallet: ZephyrWallet = await createRandomWallet({ networkType: "mainnet", password: "redirect-checks", proxyToWorker: mode === "worker" });
  const call = async (fn: () => Promise<unknown>): Promise<string> => {
    try { const v = await fn(); if (leaks(v)) leaked = true; return v === undefined ? "resolved" : typeof v === "boolean" ? String(v) : typeof v === "number" ? "number" : typeof v === "object" ? "object" : "value"; }
    catch (e) { if (leaks(e)) leaked = true; return codeOf(e); }
  };
  const runCase = async (kind: RedirectCaseResult["kind"], status: number, base: string): Promise<void> => {
    const before = await targets.stats();
    const setDaemonConnection = await call(() => wallet.setDaemonConnection(targets.first + base));
    const isConnectedToDaemon = await call(() => wallet.isConnectedToDaemon());
    const getDaemonHeight = await call(() => wallet.getDaemonHeight());
    const sync = await call(() => wallet.sync());
    const after = await targets.stats();
    const first = delta(after, before, "first", base + "/");
    const posts = delta(after, before, "first", base + "/", (k) => k.startsWith("POST "));
    const binary = delta(after, before, "first", base + "/", (k) => /\.bin( |$)/.test(k));
    const second = delta(after, before, "second", "/");
    const landed = delta(after, before, "landed", "/");
    cases.push({ kind, status, setDaemonConnection, isConnectedToDaemon, getDaemonHeight, sync, firstRequests: first.requests, firstRequestsWithBody: first.withBody,
      firstPostRequests: posts.requests, firstBinaryRequests: binary.requests, redirectsSent: after.redirectsSent - before.redirectsSent, secondRequests: second.requests, landedRequests: landed.requests });
  };
  try {
    await runCase("control", 200, "/ok");
    for (const s of REDIRECT_STATUSES) await runCase("json", s, "/r" + s);
    for (const s of REDIRECT_STATUSES) await runCase("same-origin", s, "/same" + s);
    for (const s of REDIRECT_STATUSES) await runCase("binary", s, "/bin" + s);
    await call(() => wallet.setDaemonConnection(undefined));
  } finally {
    await wallet.close();
  }
  return { env, mode, cases, checks: judge(cases, leaked), leaked };
}

/** Expected outcomes, fixed: a redirect is a daemon failure and nothing reaches its target. */
export const EXPECTED = {
  control: ["resolved", "true", "number"],
  json: ["resolved", "false", "DAEMON_ERROR/DAEMON_NOT_CONNECTED", "DAEMON_ERROR/DAEMON_NOT_CONNECTED"],
  binary: ["resolved", "true", "number", "DAEMON_ERROR/DAEMON_RESPONSE"]
} as const;

export function judge(cases: readonly RedirectCaseResult[], leaked: boolean): RedirectReport["checks"] {
  const checks: RedirectReport["checks"] = [];
  const add = (id: string, title: string, notes: string[]) => checks.push({ id, title, status: notes.length === 0 ? "pass" : "fail", notes });
  const control = cases.filter((c) => c.kind === "control");
  add("R00", "Positive control: the loopback daemon is reached and answers", control.length === 1 && control[0].firstRequests > 0 && control[0].secondRequests === 0
    && [control[0].setDaemonConnection, control[0].isConnectedToDaemon, control[0].getDaemonHeight].join() === EXPECTED.control.join() ? [] : ["control: " + JSON.stringify(control)]);
  const of = (kind: RedirectCaseResult["kind"]) => cases.filter((c) => c.kind === kind);
  const statusesOf = (list: readonly RedirectCaseResult[]) => list.map((c) => c.status).join();
  const notes1: string[] = [];
  const json = of("json");
  if (statusesOf(json) !== REDIRECT_STATUSES.join()) notes1.push("statuses " + statusesOf(json));
  for (const c of json) {
    const got = [c.setDaemonConnection, c.isConnectedToDaemon, c.getDaemonHeight, c.sync];
    if (got.join() !== EXPECTED.json.join()) notes1.push(c.status + ": " + got.join());
    if (c.secondRequests !== 0) notes1.push(c.status + ": the redirect target received " + c.secondRequests + " requests");
    if (c.firstPostRequests < 1 || c.firstRequestsWithBody < 1 || c.redirectsSent < 1) notes1.push(c.status + ": no POST with a body was redirected");
  }
  add("R01", "3xx to another loopback server (POST with a JSON body): never followed, the target receives nothing, the call fails as a daemon failure", notes1);
  const notes2: string[] = [];
  const same = of("same-origin");
  if (statusesOf(same) !== REDIRECT_STATUSES.join()) notes2.push("statuses " + statusesOf(same));
  for (const c of same) {
    const got = [c.setDaemonConnection, c.isConnectedToDaemon, c.getDaemonHeight, c.sync];
    if (got.join() !== EXPECTED.json.join()) notes2.push(c.status + ": " + got.join());
    if (c.landedRequests !== 0 || c.secondRequests !== 0) notes2.push(c.status + ": the redirect target received " + (c.landedRequests + c.secondRequests) + " requests");
    if (c.redirectsSent < 1) notes2.push(c.status + ": no redirect sent");
  }
  add("R02", "3xx to the same origin (another path of the same server): never followed", notes2);
  const notes3: string[] = [];
  const bin = of("binary");
  if (statusesOf(bin) !== REDIRECT_STATUSES.join()) notes3.push("statuses " + statusesOf(bin));
  for (const c of bin) {
    const got = [c.setDaemonConnection, c.isConnectedToDaemon, c.getDaemonHeight, c.sync];
    if (got.join() !== EXPECTED.binary.join()) notes3.push(c.status + ": " + got.join());
    if (c.secondRequests !== 0) notes3.push(c.status + ": the redirect target received " + c.secondRequests + " requests");
    if (c.firstBinaryRequests < 1 || c.redirectsSent < 1) notes3.push(c.status + ": the sync made no binary request");
  }
  add("R03", "3xx to a binary request of a running sync: never followed, the sync fails as a daemon failure", notes3);
  add("R04", "No part of a redirect answer (status text, Location, body) reaches a result or an error", leaked ? ["leaked"] : []);
  return checks;
}
