/**
 * Constructed daemon answers of the reserve checks (test only), served by redirectServers.cjs under /rv/<case>. Every
 * number is written into the JSON text as its literal digits, so values above 2^53 reach the library exactly as a node
 * would send them. The marker text stands for text supplied by a node: the checks require that none of it reaches an
 * error. The cases are what the core's get_reserve_info and get_circulating_supply ask; the expected values are computed
 * by the checks from the constants exported here with the core's formula (ReserveChecks.ts):
 *   big        hard fork 11, supply amounts and the reserve's value above 2^64, a pricing record history of 719 records
 *   hf5        as big at hard fork 5: the core leaves the two yield values 0
 *   zero       as big without ZSD in the supply: both ratios and the yield values 0, equity = assets
 *   short      as big with a history of 718 records: the moving average ratio 0
 *   nopr       the block header request answers a JSON-RPC error with the marker: the pricing record is not read
 *   norates    the block header's pricing record lacks the spot price: the core does not use it
 *   supplyrpc  get_circulating_supply answers a JSON-RPC error with the marker
 *   supplyhttp get_circulating_supply answers HTTP 500 with the marker
 *   historyrpc get_pricing_record_history answers a JSON-RPC error with the marker
 *   supplybad  a supply label that is not an upper-case token
 *   supplyhuge a supply amount above 2^128 - 1
 */
"use strict";

const MARKER = "MARKERreservenodetext";
const HEIGHT = 1000; // get_info height: the core reads the pricing record of block HEIGHT - 1
const COIN = BigInt("1000000000000");

/** The pricing record of the wallet cases (block HEIGHT - 1). */
const RECORD = {
  spot: BigInt("141914030000"), moving_average: BigInt("140063330000"), stable: BigInt("7046519640000"), stable_ma: BigInt("7154921140000"),
  reserve: BigInt("725632460000"), reserve_ma: BigInt("715810850000"), reserve_ratio: BigInt("2167777710000"), reserve_ratio_ma: BigInt("2129814930000"),
  yield_price: BigInt("1995702890000"), timestamp: BigInt("1795105885"), signature: "ab".repeat(64)
};
/** The supply of the wallet cases: ZPH, ZSD, ZRS, ZYS, DJED and YIELD as on mainnet, scaled beyond 2^64. */
const SUPPLY = [["ZPH", "1240954425862925678600000"], ["ZSD", "34183859225006742700000"], ["ZRS", "387649108627498191500000"], ["ZYS", "14180324471836441800000"],
  ["DJED", "522169789164262298900000"], ["YIELD", "28299755788598648300000"]];
/** reserve_ratio of every record of the wallet cases' pricing record history */
const HISTORY_RATIO = BigInt("2100000000000");

function lit(v) { return typeof v === "bigint" ? v.toString() : JSON.stringify(v); }
/** JSON text of a flat or nested object whose bigint values are written as integer literals */
function json(o) {
  if (Array.isArray(o)) return "[" + o.map(json).join(",") + "]";
  if (o !== null && typeof o === "object") return "{" + Object.keys(o).map((k) => JSON.stringify(k) + ":" + json(o[k])).join(",") + "}";
  return lit(o);
}

function recordJson(r) { return Object.assign({}, r); }

function headerOf(height, record) {
  return { block_size: BigInt(102), block_weight: BigInt(102), cumulative_difficulty: BigInt("57842669312539860"), cumulative_difficulty_top64: BigInt(0), depth: BigInt(0),
    difficulty: BigInt("2666028509"), difficulty_top64: BigInt(0), hash: "b51df7bed1843ca6c90bf3e9156c4e38ba70e1055eef51774119dc892db5cf9d", height: BigInt(height),
    long_term_weight: BigInt(176470), major_version: BigInt(11), miner_tx_hash: "8c0a560bf85b300c3b19758efbd41aa633cec489e3f52f2d97026ea9d7efa522", minor_version: BigInt(11),
    nonce: BigInt(32613), num_txes: BigInt(0), orphan_status: false, pow_hash: "", prev_hash: "40550cf21c0227e8e144953d80871b7787e6d11129ec06e788a3d6a95a9b77c0",
    pricing_record: record, reward: BigInt("3832883784207"), timestamp: BigInt(1795105885), wide_cumulative_difficulty: "0xcd7f99ed3bfcd4", wide_difficulty: "0x9ee85ddd" };
}

function rpcMethod(body) {
  try { const j = JSON.parse(body.toString("utf8")); return { id: j.id, method: typeof j.method === "string" ? j.method : "?", params: j.params }; } catch (e) { return { id: "0", method: "-", params: undefined }; }
}

/** Answer one request of /rv/<kind><endpoint> (a wallet case); send(res, status, headers, payload) is the server's own. */
function answer(kind, endpoint, body, res, send) {
  const { id, method, params } = rpcMethod(body);
  const raw = (text) => send(res, 200, { "content-type": "application/json" }, text);
  const result = (r) => raw("{\"jsonrpc\":\"2.0\",\"id\":" + JSON.stringify(id ?? "0") + ",\"result\":" + (typeof r === "string" ? r : json(r)) + "}");
  const rpcError = () => raw(JSON.stringify({ jsonrpc: "2.0", id: id ?? "0", error: { code: -1, message: MARKER + " error" } }));
  if (endpoint === "/getheight" || endpoint === "/get_height") return raw(json({ height: BigInt(HEIGHT), status: "OK", untrusted: false }));
  if (endpoint !== "/json_rpc") return send(res, 404, {}, "");
  // wallet cases: what the core asks
  const hf = kind === "hf5" ? 5 : 11;
  if (method === "get_version") return result({ version: BigInt(196621), release: true, status: "OK", untrusted: false, current_height: BigInt(HEIGHT), target_height: BigInt(0), hard_forks: [] });
  if (method === "get_info" || method === "getinfo") return result({ status: "OK", height: BigInt(HEIGHT), target_height: BigInt(0), synchronized: true, untrusted: false, mainnet: true, nettype: "mainnet", version: "" });
  if (method === "hard_fork_info") return result({ version: BigInt(hf), enabled: true, earliest_height: BigInt(0), state: BigInt(0), status: "OK", threshold: BigInt(0), untrusted: false, votes: BigInt(0), voting: BigInt(hf), window: BigInt(0) });
  if (method === "getblockheaderbyheight" || method === "get_block_header_by_height") {
    if (kind === "nopr") return rpcError();
    const record = kind === "norates" ? Object.assign({}, RECORD, { spot: BigInt(0) }) : RECORD;
    return result("{\"block_header\":" + json(Object.assign(headerOf(HEIGHT - 1, recordJson(record)), { major_version: BigInt(hf), minor_version: BigInt(hf) })) + ",\"status\":\"OK\",\"untrusted\":false}");
  }
  if (method === "get_circulating_supply") {
    if (kind === "supplyrpc") return rpcError();
    if (kind === "supplyhttp") return send(res, 500, { "content-type": "text/plain" }, MARKER + " internal error");
    let tally = SUPPLY;
    if (kind === "zero") tally = SUPPLY.filter(([label]) => label !== "ZSD");
    if (kind === "supplybad") tally = SUPPLY.concat([["zph", "1"]]);
    if (kind === "supplyhuge") tally = SUPPLY.concat([["HUGE", "340282366920938463463374607431768211456"]]);
    return result({ status: "OK", supply_tally: tally.map(([currency_label, amount]) => ({ amount, currency_label })) });
  }
  if (method === "get_pricing_record_history") {
    if (kind === "historyrpc") return rpcError();
    const n = kind === "short" ? 718 : 719;
    const history = [];
    for (let i = 0; i < n; i++) history.push(Object.assign({}, RECORD, { reserve_ratio: HISTORY_RATIO }));
    return result({ pricing_record_history: history, status: "OK" });
  }
  return send(res, 404, {}, "");
}

/** The constants the checks compute their expectations from, as JSON (every integer as decimal text). */
function constants() {
  const rec = {};
  for (const k of Object.keys(RECORD)) rec[k] = RECORD[k].toString();
  return { marker: MARKER, height: HEIGHT, record: rec, supply: SUPPLY, historyRatio: HISTORY_RATIO.toString() };
}

const WALLET_CASES = ["big", "hf5", "zero", "short", "nopr", "norates", "supplyrpc", "supplyhttp", "historyrpc", "supplybad", "supplyhuge"];

module.exports = { answer, constants, json, headerOf, rpcMethod, MARKER, HEIGHT, COIN, RECORD, SUPPLY, HISTORY_RATIO, WALLET_CASES, CASE_PATTERN: /^\/rv\/([a-z0-9]{1,16})(\/.*)$/ };
