/**
 * Constructed daemon answers of the daemon client checks (test only), served by redirectServers.cjs under /rv/<case> for
 * the cases whose name starts with "rpc". Every number is written into the JSON text as its literal digits, so values above
 * 2^53 reach the library exactly as a node would send them; the marker text stands for text supplied by a node.
 *   rpc        get_info, get_block_count, get_last_block_header, get_block_header_by_hash and
 *              get_block_header_by_height; the header at height k is variant k of HEADER_VARIANTS (0 is valid, with
 *              values above 2^53 and 2^64 - 1; 1 and 2 are valid without a pricing record; the others are malformed in
 *              one field)
 *   rpcstatus  every answer has a status that carries the marker
 *   rpcbusy    every answer has the status BUSY
 *   rpcerror   every answer is a JSON-RPC error with the marker
 *   rpchttp    every answer is HTTP 500 with the marker as its body
 *   rpctext    every answer is a 200 text that is not JSON, with the marker
 *   rpchuge    every answer is a valid get_info result padded beyond 1 MiB
 *   rpcredirect every answer is a 302 to /landed of the same server (a client that follows it is counted there)
 */
"use strict";
const path = require("path");
const { json, headerOf, rpcMethod, MARKER, HEIGHT } = require(path.resolve(__dirname, "reserveDaemon.cjs"));

const BIG = BigInt("9007199254740993"); // 2^53 + 1: a JavaScript number would read 9007199254740992
const U64MAX = BigInt("18446744073709551615");
/** The valid header of the daemon client cases: values above 2^53, the largest uint64 values, a 128-bit difficulty. */
function bigHeader(height) {
  const wideCum = (BigInt(5) << BigInt(64)) + BIG; // above 2^64: low part and top part both set
  return Object.assign(headerOf(height, { spot: BIG, moving_average: U64MAX, stable: BigInt("7046519640000"), stable_ma: BIG + BigInt(2), reserve: BigInt("725632460000"),
    reserve_ma: BigInt("715810850000"), reserve_ratio: BIG + BigInt(4), reserve_ratio_ma: BigInt("2129814930000"), yield_price: BigInt("1995702890000"), timestamp: BIG,
    signature: "5c5d0107dd75ad4fddacf82bb82b3d4a0db44eb258378a5f1854c022f490da547dc77b8bf2fdc6e42401cd4d473a39fd1dec01b76e9665bf6d0f8d16cc0a219f" }), {
    reward: U64MAX, nonce: BigInt(4294967295), cumulative_difficulty: wideCum & U64MAX, cumulative_difficulty_top64: wideCum >> BigInt(64), wide_cumulative_difficulty: "0x" + wideCum.toString(16),
    timestamp: BigInt(Number.MAX_SAFE_INTEGER), height: BigInt(height) });
}
const ZERO_RECORD = { spot: BigInt(0), moving_average: BigInt(0), stable: BigInt(0), stable_ma: BigInt(0), reserve: BigInt(0), reserve_ma: BigInt(0), reserve_ratio: BigInt(0),
  reserve_ratio_ma: BigInt(0), yield_price: BigInt(0), timestamp: BigInt(0), signature: "0".repeat(128) };

/**
 * Header variants of the daemon client case "rpc" by height: [description, header JSON text]. Variant 0 is valid;
 * 1 and 2 are valid without a pricing record (the core's empty record; no pricing_record key); every other variant is
 * malformed in one field and must reject with DAEMON_ERROR/DAEMON_RESPONSE.
 */
const HEADER_VARIANTS = (() => {
  const v = [];
  const ok = (what, h) => v.push([what, json(h), true]);
  const bad = (what, text) => v.push([what, text, false]);
  const base = () => bigHeader(v.length);
  const withField = (name, rawValue) => { const h = base(); const t = json(h); return t.replace(new RegExp("\"" + name + "\":[^,}]*"), "\"" + name + "\":" + rawValue); };
  ok("valid: values above 2^53, the largest uint64 values, a cumulative difficulty above 2^64", base());
  ok("the core's empty pricing record", Object.assign(base(), { pricing_record: ZERO_RECORD }));
  { const h = base(); delete h.pricing_record; ok("no pricing_record key", h); }
  bad("reward as a string", withField("reward", "\"3832883784207\""));
  bad("reward negative", withField("reward", "-1"));
  bad("reward with a fraction", withField("reward", "1.5"));
  bad("reward with an exponent", withField("reward", "1e3"));
  bad("reward above 2^64 - 1", withField("reward", "18446744073709551616"));
  bad("hash in upper case", withField("hash", "\"" + "B".repeat(64) + "\""));
  bad("height twice", json(base()).replace("{", "{\"height\":5,"));
  { const h = base(); delete h.hash; bad("no hash", json(h)); }
  bad("pricing record spot as a string", json(base()).replace(/"spot":[0-9]+/, "\"spot\":\"1\""));
  bad("pricing record signature too short", json(base()).replace(/"signature":"[0-9a-f]+"/, "\"signature\":\"abcd\""));
  bad("pricing record timestamp above 2^64 - 1", json(base()).replace(/"timestamp":9007199254740993/, "\"timestamp\":18446744073709551616"));
  bad("wide difficulty disagreeing with its low part", withField("difficulty", "1"));
  bad("nonce above 2^32 - 1", withField("nonce", "4294967296"));
  bad("height 2^53 (not a safe integer)", withField("height", "9007199254740992"));
  bad("major version above 255", withField("major_version", "256"));
  bad("pricing record not an object", json(base()).replace(/"pricing_record":\{[^}]*\}/, "\"pricing_record\":\"" + MARKER + "\""));
  bad("orphan status as a string", withField("orphan_status", "\"false\""));
  bad("a string with a control character", withField("miner_tx_hash", "\"" + MARKER + "\u0001\""));
  bad("a truncated answer", json(base()).substring(0, 200));
  return v;
})();

/** get_info of the daemon client case: real field names, values above 2^53 where the daemon has them. */
function infoResult() {
  const cum = (BigInt(3) << BigInt(64)) + BIG;
  return { adjusted_time: BigInt(1795105138), alt_blocks_count: BigInt(2), block_size_limit: BigInt(600000), block_size_median: BigInt(300000), block_weight_limit: BigInt(600000),
    block_weight_median: BigInt(300000), bootstrap_daemon_address: "", busy_syncing: false, credits: BigInt(0), cumulative_difficulty: cum & U64MAX,
    cumulative_difficulty_top64: cum >> BigInt(64), database_size: BigInt("26843545600"), difficulty: BigInt("2668793037"), difficulty_top64: BigInt(0), free_space: U64MAX,
    grey_peerlist_size: BigInt(0), height: BigInt(HEIGHT), height_without_bootstrap: BigInt(0), incoming_connections_count: BigInt(0), mainnet: true, nettype: "mainnet", offline: false,
    outgoing_connections_count: BigInt(0), restricted: true, rpc_connections_count: BigInt(0), stagenet: false, start_time: BigInt(0), status: "OK", synchronized: true, target: BigInt(120),
    target_height: BigInt(0), testnet: false, top_block_hash: "b51df7bed1843ca6c90bf3e9156c4e38ba70e1055eef51774119dc892db5cf9d", top_hash: "", tx_count: BigInt(1271617),
    tx_pool_size: BigInt(2), untrusted: false, update_available: false, version: "", was_bootstrap_ever_used: false, white_peerlist_size: BigInt(0),
    wide_cumulative_difficulty: "0x" + cum.toString(16), wide_difficulty: "0x9f128ccd" };
}

/** Answer one request of /rv/<kind><endpoint> (a daemon client case); send(res, status, headers, payload) is the server's own. */
function answer(kind, endpoint, body, res, send) {
  const { id, method, params } = rpcMethod(body);
  const raw = (text) => send(res, 200, { "content-type": "application/json" }, text);
  const result = (r) => raw("{\"jsonrpc\":\"2.0\",\"id\":" + JSON.stringify(id ?? "0") + ",\"result\":" + (typeof r === "string" ? r : json(r)) + "}");
  const rpcError = () => raw(JSON.stringify({ jsonrpc: "2.0", id: id ?? "0", error: { code: -1, message: MARKER + " error" } }));
  if (endpoint !== "/json_rpc") return send(res, 404, {}, "");
  if (kind === "rpcstatus") return result({ status: MARKER + " status", untrusted: false });
  if (kind === "rpcbusy") return result({ status: "BUSY", untrusted: false });
  if (kind === "rpcerror") return rpcError();
  if (kind === "rpchttp") return send(res, 500, { "content-type": "text/plain" }, MARKER + " internal error");
  if (kind === "rpctext") return send(res, 200, { "content-type": "text/plain" }, MARKER + " not json");
  if (kind === "rpchuge") return result(json(infoResult()).replace("{", "{\"pad\":\"" + "x".repeat(1100000) + "\","));
  if (kind === "rpcredirect") return send(res, 302, { location: "/landed/json_rpc", "content-type": "text/plain" }, MARKER + " moved");
  if (kind === "rpc") {
    if (method === "get_info") return result(infoResult());
    if (method === "get_block_count") return result({ count: BigInt(HEIGHT), status: "OK", untrusted: false });
    if (method === "get_last_block_header") return result("{\"block_header\":" + json(bigHeader(HEIGHT - 1)) + ",\"credits\":0,\"status\":\"OK\",\"top_hash\":\"\",\"untrusted\":false}");
    if (method === "get_block_header_by_hash") return result("{\"block_header\":" + json(bigHeader(HEIGHT - 1)) + ",\"status\":\"OK\",\"untrusted\":false}");
    if (method === "get_block_header_by_height") {
      const k = params && typeof params.height === "number" ? params.height : -1;
      if (k < 0 || k >= HEADER_VARIANTS.length) return result({ status: "Failed: " + MARKER, untrusted: false });
      return result("{\"block_header\":" + HEADER_VARIANTS[k][1] + ",\"status\":\"OK\",\"untrusted\":false}");
    }
    return send(res, 404, {}, "");
  }
  return send(res, 404, {}, "");
}

/** The constants the daemon client checks compare with, as JSON (every integer as decimal text). */
function constants() {
  return { marker: MARKER, height: HEIGHT, big: BIG.toString(), u64max: U64MAX.toString(), variants: HEADER_VARIANTS.map(([what, , valid]) => ({ what, valid })) };
}

const RPC_CASES = ["rpc", "rpcstatus", "rpcbusy", "rpcerror", "rpchttp", "rpctext", "rpchuge", "rpcredirect"];

module.exports = { answer, constants, RPC_CASES };
