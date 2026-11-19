/**
 * Relay against constructed daemons (test only; the instrumented test module in the Node.js main thread). A wallet
 * without funds keeps a synthetic transaction (the test module's prepare.synthetic hook: a minimal transaction that
 * spends nothing and that no chain would accept) and relays it to the /sink/<mode> daemons of redirectServers.cjs,
 * whose submit answers come from src/test/network/relaySink.cjs: every reason the daemon's reply can give, a busy
 * daemon, an HTTP error, an unreadable answer, a dropped connection, a late answer and a refused connection. Each
 * relay call must send exactly one submit request (counted at the sink, which records body lengths only) or none
 * when it fails before the request; no error carries the sink's node text; a retry sends the same bytes; a refusal
 * voids the token; a kept build prepared while another daemon was configured goes to the daemon configured when
 * relayPrepared is called.
 */
import { createRandomWallet, ZephyrWalletError } from "../../main/ts/index";
import type { ZephyrRelayResult, ZephyrWallet } from "../../main/ts/index";
import LibraryUtils from "../../main/ts/common/LibraryUtils";
import HttpClient from "../../main/ts/common/HttpClient";
import type { Instrumentation } from "../lifecycle/testSupport";

export interface RelayCheckTargets {
  readonly first: string;
  /** a loopback port that was bound and closed again (connection refused) */
  readonly closed: string;
  readonly marker: string;
  readonly sinkStats: () => Promise<{ requests: number; bodyLengths: number[] }>;
}

export interface RelayCheckResult {
  readonly check: { id: string; title: string; status: "pass" | "fail"; notes: string[] };
  readonly outcomes: Record<string, string>;
  readonly submitsPerCall: Record<string, number>;
  /** the test module's record of the module's permit decisions per relay call (relay-permit events) */
  readonly permits: Record<string, string>;
  readonly sinkRequests: number;
  readonly passedInTransport: number;
  readonly refusedInTransport: number;
}

type Hooks = { events: string[]; fail: Record<string, number>; skip: Record<string, number>; kind: Record<string, number> };

function armSynthetic(): void {
  const module = LibraryUtils.getWasmModule() as { __zephyrTsTestHooks?: Hooks };
  module.__zephyrTsTestHooks = { events: [], fail: { "prepare.synthetic": 1 }, skip: {}, kind: {} };
}

function errorText(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  return [err.message, err.stack ?? "", JSON.stringify(err instanceof ZephyrWalletError ? err.toEnvelope() : {})].join(" ");
}

export async function runRelayChecks(targets: RelayCheckTargets): Promise<RelayCheckResult> {
  const notes: string[] = [];
  const outcomes: Record<string, string> = {};
  const submitsPerCall: Record<string, number> = {};
  const permits: Record<string, string> = {};
  const fail = (what: string) => notes.push(what);
  const hooks = () => (LibraryUtils.getWasmModule() as { __zephyrTsTestHooks?: Hooks }).__zephyrTsTestHooks;
  const w: ZephyrWallet = await createRandomWallet({ networkType: "mainnet", password: "relay-checks", proxyToWorker: false });
  const passedBefore = (HttpClient as unknown as { PASSED_RELAY_REQUESTS: number }).PASSED_RELAY_REQUESTS;
  const refusedBefore = (HttpClient as unknown as { REFUSED_RELAY_REQUESTS: number }).REFUSED_RELAY_REQUESTS;
  try {
    const own = await w.getPrimaryAddress();
    const prepare = async (): Promise<string> => {
      armSynthetic();
      const p = await w.prepareTransfer({ asset: "ZPH", destinations: [{ address: own, amount: BigInt("100000000") }], accountIndex: 0 });
      return p.token;
    };
    /** one relay call against a mode; the outcome as "accepted[+notRelayed][ CODE/DIAG]" or "CODE/DIAG" */
    const relay = async (label: string, base: string, token: string): Promise<string> => {
      await w.setDaemonConnection(base);
      const h = hooks();
      if (h !== undefined) h.events = [];
      const s0 = (await targets.sinkStats()).requests;
      let outcome: string;
      try {
        const r: ZephyrRelayResult = await w.relayPrepared(token);
        const t = r.txs[0];
        outcome = t.outcome + (t.notRelayed ? "+notRelayed" : "") + (t.code !== undefined ? " " + t.code + "/" + String(t.diagnostic) : "") + (r.complete ? "" : " incomplete");
      } catch (err) {
        outcome = err instanceof ZephyrWalletError ? err.code + "/" + String(err.diagnostic) : "untyped";
        const text = errorText(err);
        if (text.includes(targets.marker)) fail(label + ": node text in the error"); // the marker only: a stack carries file names and addresses
      }
      submitsPerCall[label] = (await targets.sinkStats()).requests - s0;
      permits[label] = (hooks()?.events ?? []).filter((e) => e.startsWith("relay-permit:")).map((e) => e.substring(13)).join(",");
      outcomes[label] = outcome;
      return outcome;
    };
    const sink = (mode: string) => targets.first + "/sink/" + mode;
    const expectOutcome = (label: string, got: string, want: string, submits: number) => {
      if (got !== want) fail(label + ": " + got + ", expected " + want);
      if (submitsPerCall[label] !== submits) fail(label + ": " + submitsPerCall[label] + " submit requests, expected " + submits);
    };
    // acceptance: the synthetic transaction is accepted by the sink; the core then cannot record it in the wallet
    // (it spends nothing of the wallet), which the result reports on the accepted entry
    let token = await prepare();
    expectOutcome("accept", await relay("accept", sink("accept"), token), "accepted NATIVE_ERROR/RELAY_RECORD_FAILED", 1);
    expectOutcome("accepted token again", await relay("accepted token again", sink("accept"), token), "INVALID_CONFIG/RELAY_TOKEN_VOID", 0);
    token = await prepare();
    expectOutcome("accept-not-relayed", await relay("accept-not-relayed", sink("accept-not-relayed"), token), "accepted+notRelayed NATIVE_ERROR/RELAY_RECORD_FAILED", 1);
    // refusals: one diagnostic per flag of the daemon's reply, without one, and another status; each voids the token
    const reasons: Array<[string, string]> = [["low_mixin", "LOW_RING_SIZE"], ["double_spend", "DOUBLE_SPEND"], ["invalid_input", "INVALID_INPUT"], ["invalid_output", "INVALID_OUTPUT"],
      ["too_big", "TOO_BIG"], ["overspend", "OVERSPEND"], ["fee_too_low", "FEE_TOO_LOW"], ["too_few_outputs", "TOO_FEW_OUTPUTS"], ["tx_extra_too_big", "TX_EXTRA_TOO_BIG"],
      ["sanity_check_failed", "SANITY_CHECK_FAILED"], ["not_relayed", "NOT_RELAYED"]];
    for (const [flag, diag] of reasons) {
      token = await prepare();
      expectOutcome("reject-" + flag, await relay("reject-" + flag, sink("reject-" + flag), token), "TX_REJECTED/" + diag, 1);
    }
    token = await prepare();
    expectOutcome("reject", await relay("reject", sink("reject"), token), "TX_REJECTED/REJECTED", 1);
    expectOutcome("rejected token again", await relay("rejected token again", sink("accept"), token), "INVALID_CONFIG/RELAY_TOKEN_VOID", 0);
    token = await prepare();
    expectOutcome("other-status", await relay("other-status", sink("other-status"), token), "TX_REJECTED/REJECTED", 1);
    // not processed or no usable answer: the token stays for a retry of the same bytes
    const lengths = async () => (await targets.sinkStats()).bodyLengths;
    token = await prepare();
    expectOutcome("busy", await relay("busy", sink("busy"), token), "DAEMON_ERROR/DAEMON_BUSY", 1);
    expectOutcome("http-error", await relay("http-error", sink("http-error"), token), "RELAY_UNKNOWN/HTTP_STATUS", 1);
    expectOutcome("unreadable", await relay("unreadable", sink("unreadable"), token), "RELAY_UNKNOWN/ANSWER_UNREADABLE", 1);
    const l = await lengths();
    if (!(l.length >= 3 && l[l.length - 1] === l[l.length - 2] && l[l.length - 2] === l[l.length - 3])) fail("the retries did not send bodies of the same length");
    expectOutcome("fourth call", await relay("fourth call", sink("accept"), token), "INVALID_CONFIG/RELAY_TOKEN_VOID", 0);
    token = await prepare();
    expectOutcome("drop", await relay("drop", sink("drop"), token), "RELAY_UNKNOWN/NO_ANSWER", 1);
    expectOutcome("retry after drop", await relay("retry after drop", sink("accept"), token), "accepted NATIVE_ERROR/RELAY_RECORD_FAILED", 1);
    token = await prepare();
    expectOutcome("connection refused", await relay("connection refused", targets.closed, token), "DAEMON_ERROR/DAEMON_UNREACHABLE", 0);
    expectOutcome("retry after refused connection", await relay("retry after refused connection", sink("reject-double_spend"), token), "TX_REJECTED/DOUBLE_SPEND", 1);
    token = await prepare();
    expectOutcome("late", await relay("late", sink("late"), token), "RELAY_UNKNOWN/NO_ANSWER", 1);
    await w.discardPrepared(token);
    // a kept build survives setDaemonConnection: prepared while the wallet is configured with the closed port, it is
    // relayed to the daemon configured when relayPrepared is called (the accepting sink); the closed port gets nothing
    await w.setDaemonConnection(targets.closed);
    token = await prepare();
    expectOutcome("daemon changed after prepare", await relay("daemon changed after prepare", sink("accept"), token), "accepted NATIVE_ERROR/RELAY_RECORD_FAILED", 1);
  } catch (err) {
    fail("unexpected failure: " + (err instanceof ZephyrWalletError ? err.code + "/" + String(err.diagnostic) : err instanceof Error ? err.name : typeof err));
  } finally {
    await w.close();
  }
  const passed = (HttpClient as unknown as { PASSED_RELAY_REQUESTS: number }).PASSED_RELAY_REQUESTS - passedBefore;
  const refused = (HttpClient as unknown as { REFUSED_RELAY_REQUESTS: number }).REFUSED_RELAY_REQUESTS - refusedBefore;
  const sinkRequests = (await targets.sinkStats()).requests;
  const sentToSink = Object.values(submitsPerCall).reduce((n, v) => n + v, 0);
  if (passed !== sentToSink + 1) fail("the transport passed " + passed + " submit requests; the sink received " + sentToSink + " and one went to the closed port");
  if (refused !== 0) fail("the transport refused " + refused + " submit requests");
  return { check: { id: "S03", title: "Relay against constructed daemons (test module, a synthetic kept transaction): every reason of the daemon's reply maps to its fixed pair and voids the token; a busy daemon, an HTTP error, an unreadable answer, a dropped connection and a late answer keep it for a retry of the same bytes; a refused connection sends nothing; a kept build survives setDaemonConnection and goes to the daemon configured at the relay call; acceptance (also not relayed) reports the core's failed record of a transaction that spends nothing of the wallet; exactly one submit request per relay call, none for a void token; no node text in any error", status: notes.length === 0 ? "pass" : "fail", notes },
    outcomes, submitsPerCall, permits, sinkRequests, passedInTransport: passed, refusedInTransport: refused };
}

export interface RelayAllocationResult {
  readonly check: { id: string; title: string; status: "pass" | "fail"; notes: string[] };
  /** allocator bytes in use after minus before, per whole cycle, by path */
  readonly deltas: Record<string, number[]>;
}

/**
 * The allocator around relay failures in the test module (S04), with the wallet in this context (direct) or in its
 * own worker: after two warm-ups, five whole cycles per path (prepare a synthetic kept transaction, relay it, the token
 * void: by the refusal, or by a discard when the failure keeps it). A refused relay (tools::error::tx_rejected from the
 * core's commit, carrying a copy of the transaction) and a relay to a closed port (no connection, thrown through the
 * core's RPC status check) leave nothing; a relay with a void token allocates nothing that stays. The transport keeps
 * the last answer it received until the next request, and its size varies by up to 32 bytes from one answer to the
 * next, so a cycle that ends with a refusal may differ from zero by that much (an allocation trace shows that nothing
 * of a cycle outlives the next one); the sum over the five cycles stays within the same bound.
 */
export async function runRelayAllocationCheck(targets: RelayCheckTargets, hooks: Instrumentation, proxyToWorker: boolean): Promise<RelayAllocationResult> {
  const failures: string[] = [];
  const deltas: Record<string, number[]> = {};
  const fail = (what: string) => failures.push(what);
  await hooks.install();
  const w: ZephyrWallet = await createRandomWallet({ networkType: "mainnet", password: "relay-allocation", proxyToWorker });
  try {
    await hooks.target(w);
    const own = await w.getPrimaryAddress();
    const heap = async (): Promise<number> => (await hooks.state()).heapInUse;
    const cycle = async (want: string): Promise<number> => {
      const h0 = await heap();
      await hooks.resetCounters();
      await hooks.arm({ fail: { "prepare.synthetic": 1 } });
      const p = await w.prepareTransfer({ asset: "ZPH", destinations: [{ address: own, amount: BigInt("100000000") }], accountIndex: 0 });
      let got = "accepted";
      try { await w.relayPrepared(p.token); } catch (err) { got = err instanceof ZephyrWalletError ? err.code + "/" + String(err.diagnostic) : "untyped"; }
      if (got !== want) fail("outcome " + got + ", expected " + want);
      if (got !== "TX_REJECTED/DOUBLE_SPEND") await w.discardPrepared(p.token);
      return (await heap()) - h0;
    };
    const path = async (label: string, server: string, want: string): Promise<void> => {
      await w.setDaemonConnection(server);
      for (let i = 0; i < 2; i++) await cycle(want);
      deltas[label] = [];
      for (let i = 0; i < 5; i++) deltas[label].push(await cycle(want));
    };
    await path("refused by the sink", targets.first + "/sink/reject-double_spend", "TX_REJECTED/DOUBLE_SPEND");
    await path("unreachable daemon", targets.closed, "DAEMON_ERROR/DAEMON_UNREACHABLE");
    await hooks.resetCounters();
    await hooks.arm({ fail: { "prepare.synthetic": 1 } });
    const p = await w.prepareTransfer({ asset: "ZPH", destinations: [{ address: own, amount: BigInt("100000000") }], accountIndex: 0 });
    await w.discardPrepared(p.token);
    deltas["void token"] = [];
    for (let i = 0; i < 5; i++) {
      const h0 = await heap();
      try { await w.relayPrepared(p.token); fail("a void token was relayed"); } catch (err) { /* RELAY_TOKEN_VOID */ }
      deltas["void token"].push((await heap()) - h0);
    }
  } catch (err) {
    fail("unexpected failure: " + (err instanceof ZephyrWalletError ? err.code + "/" + String(err.diagnostic) : err instanceof Error ? err.name : typeof err));
  } finally {
    await w.close();
  }
  const notes = ["allocator growth per cycle (" + (proxyToWorker ? "worker" : "direct") + "): " + Object.entries(deltas).map(([k, v]) => k + " " + v.join(",")).join("; ")];
  const refused = deltas["refused by the sink"] ?? [];
  if (refused.length !== 5 || !refused.every((d) => Math.abs(d) <= 32) || Math.abs(refused.reduce((a, b) => a + b, 0)) > 32) fail("a refused relay left something behind (" + refused.join(",") + ")");
  for (const label of ["unreachable daemon", "void token"]) {
    const v = deltas[label] ?? [];
    if (v.length !== 5 || !v.every((d) => d === 0)) fail(label + ": the allocator did not return to its level (" + v.join(",") + ")");
  }
  return { check: { id: "S04", title: "Relay failures leave nothing in the test module (a wallet in the main thread, and one in its worker, with a synthetic kept transaction): whole cycles of prepare, relay and void to a refusing sink and to a closed port, and relays with a void token, return the allocator to its level (a refusal within the 32-byte size variation of the transport's kept last answer)", status: failures.length === 0 ? "pass" : "fail", notes: notes.concat(failures) }, deltas };
}
