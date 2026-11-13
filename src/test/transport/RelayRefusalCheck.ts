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
