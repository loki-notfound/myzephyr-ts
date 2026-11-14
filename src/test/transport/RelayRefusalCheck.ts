/**
 * No relay in the transport (test only): with a wallet connected to the /ok daemon of redirectServers.cjs
 * (so that its route is configured), every request that would submit or relay a transaction or a block
 * (/sendrawtransaction, /send_raw_transaction, JSON-RPC relay_tx, submit_block, submitblock,
 * send_raw_transaction, sendrawtransaction) is refused by the SDK's transport before anything is sent:
 * UNSUPPORTED_CAPABILITY/RELAY_REQUEST, counted, and the daemon receives nothing. A JSON-RPC get_version
 * on the same route is the positive control. Runs in the calling context's transport (Node.js main thread
 * and the Chromium page); the wallet worker's transport is the same code in the same bundle.
 */
import { createRandomWallet, ZephyrWalletError } from "../../main/ts/index";
import HttpClient from "../../main/ts/common/HttpClient";
import type { RedirectServerStats, RedirectTargets } from "./RedirectChecks";

export interface RelayRefusalResult {
  readonly check: { id: string; title: string; status: "pass" | "fail"; notes: string[] };
  readonly refused: number;
  readonly attempts: number;
  readonly daemonRequestsDuringAttempts: number;
  readonly controlRequests: number;
}

function okRequests(stats: RedirectServerStats): number {
  return Object.entries(stats.first).filter(([k]) => k.substring(k.indexOf(" ") + 1).startsWith("/ok/")).reduce((n, [, v]) => n + v.requests, 0);
}

export async function runRelayRefusalCheck(targets: RedirectTargets): Promise<RelayRefusalResult> {
  const notes: string[] = [];
  const w = await createRandomWallet({ networkType: "mainnet", password: "relay-refusal", proxyToWorker: false });
  let refused = 0, attempts = 0, during = -1, control = -1;
  try {
    await w.setDaemonConnection(targets.first + "/ok");
    const base = targets.first + "/ok";
    const json = (method: string) => JSON.stringify({ jsonrpc: "2.0", id: "0", method, params: {} });
    const requests: Array<[string, Record<string, unknown>]> = [
      ["/sendrawtransaction", { method: "POST", uri: base + "/sendrawtransaction", body: JSON.stringify({ tx_as_hex: "00", do_not_relay: false }) }],
      ["/send_raw_transaction", { method: "POST", uri: base + "/send_raw_transaction", body: JSON.stringify({ tx_as_hex: "00" }) }],
      ["/SendRawTransaction", { method: "POST", uri: base + "/SendRawTransaction", body: "{}" }]
    ];
    for (const m of ["relay_tx", "submit_block", "submitblock", "send_raw_transaction", "sendrawtransaction"]) requests.push(["json_rpc " + m, { method: "POST", uri: base + "/json_rpc", body: json(m) }]);
    const refusedBefore = (HttpClient as unknown as { REFUSED_RELAY_REQUESTS: number }).REFUSED_RELAY_REQUESTS;
    const s0 = okRequests(await targets.stats());
    for (const [label, req] of requests) {
      attempts++;
      try {
        await HttpClient.request(req);
        notes.push(label + ": sent");
      } catch (err) {
        if (!(err instanceof ZephyrWalletError && err.code === "UNSUPPORTED_CAPABILITY" && err.diagnostic === "RELAY_REQUEST")) notes.push(label + ": unexpected rejection");
      }
    }
    const s1 = okRequests(await targets.stats());
    during = s1 - s0;
    refused = (HttpClient as unknown as { REFUSED_RELAY_REQUESTS: number }).REFUSED_RELAY_REQUESTS - refusedBefore;
    // positive control on the same route
    const reply = await HttpClient.request({ method: "POST", uri: base + "/json_rpc", body: json("get_version") }) as { statusCode?: number };
    control = okRequests(await targets.stats()) - s1;
    if (reply.statusCode !== 200) notes.push("control: status " + reply.statusCode);
  } finally {
    await w.close();
  }
  if (during !== 0) notes.push(during + " refused requests reached the daemon");
  if (refused !== attempts) notes.push("refusal count " + refused + " of " + attempts);
  if (control !== 1) notes.push("the positive control reached the daemon " + control + " times");
  return { check: { id: "S01", title: "The transport refuses every submit or relay request before sending it (UNSUPPORTED_CAPABILITY/RELAY_REQUEST, counted, nothing reaches the daemon); a read request on the same route is sent", status: notes.length === 0 ? "pass" : "fail", notes },
    refused, attempts, daemonRequestsDuringAttempts: during, controlRequests: control };
}

export interface ScopedPassResult {
  readonly check: { id: string; title: string; status: "pass" | "fail"; notes: string[] };
  readonly outcomes: Record<string, string>;
  readonly daemonSubmits: number;
}

function submitRequests(stats: RedirectServerStats): number {
  return Object.entries(stats.first).filter(([k]) => /\/(sendrawtransaction|send_raw_transaction)$/i.test(k) || / (relay_tx|submit_block|submitblock|send_raw_transaction|sendrawtransaction)$/.test(k))
    .reduce((n, [, v]) => n + v.requests, 0);
}

/**
 * The transport's one way (test only): a submit request passes only with the id of an open relay scope (which the
 * module opens around its one commit), as POST to exactly the scope's URI on a configured route, without a JSON-RPC
 * method, once per scope. Without a scope, with a closed or used scope, to another path or route, with another
 * method or as relay_tx, the request is refused before sending (UNSUPPORTED_CAPABILITY/RELAY_REQUEST) and the daemon
 * receives nothing. Exactly one request reaches the /ok daemon. Runs in the calling context's transport.
 */
export async function runScopedPassCheck(targets: RedirectTargets): Promise<ScopedPassResult> {
  const notes: string[] = [];
  const outcomes: Record<string, string> = {};
  const H = HttpClient as unknown as { openRelayScope: (s: unknown, u: unknown, c: unknown) => void; closeRelayScope: (s: unknown) => void };
  const w = await createRandomWallet({ networkType: "mainnet", password: "scoped-pass", proxyToWorker: false });
  // a second wallet in the same context with its own configured route: its submit path must not pass on the first's scope
  const other = await createRandomWallet({ networkType: "mainnet", password: "scoped-pass-other", proxyToWorker: false });
  let daemonSubmits = -1;
  try {
    await w.setDaemonConnection(targets.first + "/ok");
    await other.setDaemonConnection(targets.first + "/poolempty");
    const base = targets.first + "/ok";
    const body = JSON.stringify({ client: "", tx_as_hex: "00", do_not_relay: false, do_sanity_checks: true });
    const scope = "0123456789abcdef0123456789abcdef";
    const s0 = submitRequests(await targets.stats());
    const attempt = async (label: string, req: Record<string, unknown>, want: "sent" | "refused") => {
      let got: string;
      try { await HttpClient.request(req); got = "sent"; } catch (err) { got = err instanceof ZephyrWalletError && err.code === "UNSUPPORTED_CAPABILITY" && err.diagnostic === "RELAY_REQUEST" ? "refused" : "other"; }
      outcomes[label] = got;
      if (got !== want) notes.push(label + ": " + got + ", expected " + want);
    };
    const req = (uri: string, extra: Record<string, unknown> = {}) => Object.assign({ method: "POST", uri, body, relayScope: scope }, extra);
    await attempt("scope id without an open scope", req(base + "/sendrawtransaction"), "refused");
    H.openRelayScope(scope, base + "/sendrawtransaction", 1);
    await attempt("another endpoint", req(base + "/send_raw_transaction"), "refused");
    await attempt("another route", req(targets.first + "/poolfull/sendrawtransaction"), "refused");
    await attempt("another wallet's configured route", req(targets.first + "/poolempty/sendrawtransaction"), "refused");
    await attempt("another method", req(base + "/sendrawtransaction", { method: "GET" }), "refused");
    await attempt("relay_tx with the scope id", req(base + "/json_rpc", { body: JSON.stringify({ jsonrpc: "2.0", id: "0", method: "relay_tx", params: {} }) }), "refused");
    await attempt("another scope id", req(base + "/sendrawtransaction", { relayScope: "f".repeat(32) }), "refused");
    await attempt("no scope id", { method: "POST", uri: base + "/sendrawtransaction", body }, "refused");
    await attempt("the permitted request", req(base + "/sendrawtransaction"), "sent");
    await attempt("a second request for the scope", req(base + "/sendrawtransaction"), "refused");
    H.closeRelayScope(scope);
    H.openRelayScope(scope, base + "/sendrawtransaction", 1);
    H.closeRelayScope(scope);
    await attempt("a closed scope", req(base + "/sendrawtransaction"), "refused");
    H.openRelayScope(scope, base + "/sendrawtransaction", 2);
    await attempt("a scope opened for two requests (never opened)", req(base + "/sendrawtransaction"), "refused");
    daemonSubmits = submitRequests(await targets.stats()) - s0;
  } finally {
    await w.close();
    await other.close();
  }
  if (daemonSubmits !== 1) notes.push(daemonSubmits + " submit requests reached the daemon, expected 1");
  return { check: { id: "S02", title: "The transport's one way: a submit request passes only with the id of an open relay scope, as POST to exactly that scope's URI on a configured route, without a JSON-RPC method, once; every other form (no or another scope, a closed or used scope, another endpoint, route, another wallet's route or method, relay_tx) is refused before sending; exactly one request reaches the daemon", status: notes.length === 0 ? "pass" : "fail", notes },
    outcomes, daemonSubmits };
}
