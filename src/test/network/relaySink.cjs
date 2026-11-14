/**
 * Local sink for submit requests (test only). Every request that would submit or relay a transaction or a
 * block (the daemon's /sendrawtransaction and /send_raw_transaction, and the JSON-RPC methods relay_tx,
 * submit_block, submitblock, send_raw_transaction, sendrawtransaction, also any path ending in one of the
 * submit endpoints) is answered here, by the mode the caller names, and never reaches any upstream: this module
 * has no code that opens a connection. It records the number of requests and the length of each body, never
 * the bytes, and logs nothing of a body.
 *
 * Modes (the answer of the daemon's /sendrawtransaction, core_rpc_server::on_send_raw_tx):
 *   accept               {"status":"OK"} with every flag false
 *   accept-not-relayed   {"status":"OK","not_relayed":true} (the daemon kept it without relaying it)
 *   reject-<flag>        {"status":"Failed"} with that flag true: low_mixin, double_spend, invalid_input,
 *                        invalid_output, too_big, overspend, fee_too_low, too_few_outputs, tx_extra_too_big,
 *                        sanity_check_failed, not_relayed
 *   reject               {"status":"Failed"} with no flag (a refusal without a reason flag)
 *   other-status         {"status":"PAYMENT REQUIRED"}
 *   busy                 {"status":"BUSY"}
 *   http-error           HTTP 500
 *   unreadable           HTTP 200 with a body that is not JSON
 *   drop                 the connection is destroyed after the request was read (no answer)
 *   late                 the accepting answer after LATE_MS (longer than the SDK's 30 s bound for a JSON request)
 * Every reply that carries text carries the marker text in its reason, so that a test can prove that no node
 * text reaches an error.
 */
"use strict";

const SUBMIT_PATHS = ["/sendrawtransaction", "/send_raw_transaction"];
const SUBMIT_METHODS = ["relay_tx", "submit_block", "submitblock", "send_raw_transaction", "sendrawtransaction"];
const FLAGS = ["low_mixin", "double_spend", "invalid_input", "invalid_output", "too_big", "overspend", "fee_too_low", "too_few_outputs", "tx_extra_too_big", "sanity_check_failed", "not_relayed"];
const MODES = ["accept", "accept-not-relayed", "reject", "other-status", "busy", "http-error", "unreadable", "drop", "late"].concat(FLAGS.map((f) => "reject-" + f));
const LATE_MS = 35000;

/** Whether a request (its endpoint below the mount, and its JSON-RPC method or "-") submits or relays. */
function isSubmit(endpoint, method) {
  const e = String(endpoint).toLowerCase();
  return SUBMIT_PATHS.includes(e) || SUBMIT_PATHS.some((p) => e.endsWith(p)) || SUBMIT_METHODS.includes(String(method).toLowerCase());
}

function newStats() {
  return { requests: 0, byMode: {}, bodyLengths: [], unknownModes: 0 };
}

/**
 * Answer one submit request by mode; records its count and body length in stats. headers: extra headers of the
 * reply (CORS). Returns nothing; never forwards.
 */
function answer(mode, body, req, res, stats, marker, headers) {
  stats.requests++;
  stats.byMode[mode] = (stats.byMode[mode] || 0) + 1;
  stats.bodyLengths.push(body.length);
  const flags = {};
  for (const f of FLAGS) flags[f] = false;
  const json = (status, extra) => {
    const p = Buffer.from(JSON.stringify(Object.assign({ status, reason: marker + " reason", untrusted: false, credits: 0, top_hash: "" }, flags, extra || {})));
    res.writeHead(200, Object.assign({ "content-type": "application/json", "content-length": p.length }, headers || {}));
    res.end(p);
  };
  if (mode === "accept") return json("OK", { reason: "" });
  if (mode === "accept-not-relayed") return json("OK", { not_relayed: true, reason: "Not relayed" });
  if (mode === "reject") return json("Failed");
  if (mode === "other-status") return json("PAYMENT REQUIRED");
  if (mode === "busy") return json("BUSY");
  if (mode.startsWith("reject-") && FLAGS.includes(mode.substring(7))) { const extra = {}; extra[mode.substring(7)] = true; return json("Failed", extra); }
  if (mode === "http-error") { const p = Buffer.from(marker + " status body"); res.writeHead(500, Object.assign({ "content-type": "text/plain", "content-length": p.length }, headers || {})); res.end(p); return; }
  if (mode === "unreadable") { const p = Buffer.from(marker + " {not json"); res.writeHead(200, Object.assign({ "content-type": "application/json", "content-length": p.length }, headers || {})); res.end(p); return; }
  if (mode === "drop") { req.socket.destroy(); return; }
  if (mode === "late") { setTimeout(() => { if (!res.destroyed && !req.socket.destroyed) json("OK", { reason: "" }); }, LATE_MS); return; }
  stats.unknownModes++;
  res.writeHead(404, headers || {});
  res.end();
}

module.exports = { isSubmit, newStats, answer, MODES, FLAGS, SUBMIT_PATHS, SUBMIT_METHODS, LATE_MS };
