/**
 * Constructed daemon of the fee tier checks (test only): a loopback server whose mounts answer what the core's default
 * priority reads (wallet2::adjust_priority: the fee estimate, the pool backlog, the block weight limit and the headers of
 * the last ten blocks) and what a build without funds reads before its own refusal, with one read failing per mount:
 *   /backlog   get_txpool_backlog answers HTTP 500
 *   /headers   the backlog is empty and getblockheadersrange answers HTTP 500
 *   /ok        every read answers (the last ten blocks are nearly empty)
 * On every mount /gethashes.bin answers 40 block hashes from height 1 (the core's fast refresh fills the wallet's chain of
 * hashes with them, so the wallet's height passes the ten blocks adjust_priority needs before it reads headers), and
 * /getblocks.bin answers HTTP 500 (the sync stops there). getblockheaderbyheight answers HTTP 500 (a conversion's pricing
 * record is not read). Every other request is refused with HTTP 404 or a JSON-RPC error. The server records the request
 * names per mount (paths, and the JSON-RPC method of /json_rpc), never a body.
 *
 *   const d = await startPriorityDaemon(); d.base -> "http://127.0.0.1:<port>"; d.requests("/backlog"); d.reset(); await d.close();
 */
"use strict";

const http = require("http");
const crypto = require("crypto");

const MOUNTS = ["/backlog", "/headers", "/ok"];
const HEIGHT = 41; // the daemon's height: 40 hashes from height 1

function rpcMethod(body) {
  try { const j = JSON.parse(body.toString("utf8")); return { id: j.id === undefined ? "0" : j.id, method: typeof j.method === "string" ? j.method : "?" }; } catch (e) { return { id: "0", method: "-" }; }
}

/** epee portable storage (the binary RPC format): a root section of named values */
function varint(n) {
  if (n < 64) return Buffer.from([n << 2]);
  if (n < 16384) { const b = Buffer.alloc(2); b.writeUInt16LE((n << 2) | 1); return b; }
  const b = Buffer.alloc(4); b.writeUInt32LE(((n << 2) | 2) >>> 0); return b;
}
function entry(name, type, value) {
  return Buffer.concat([Buffer.from([name.length]), Buffer.from(name, "ascii"), Buffer.from([type]), value]);
}
function u64(v) { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return b; }
function str(buf) { return Buffer.concat([varint(buf.length), buf]); }
function portable(entries) {
  return Buffer.concat([Buffer.from([0x01, 0x11, 0x01, 0x01, 0x01, 0x01, 0x02, 0x01, 0x01]), varint(entries.length), ...entries]);
}

/** COMMAND_RPC_GET_HASHES_FAST's response: 40 hashes from height 1 (deterministic, not of any chain) */
function hashesAnswer() {
  const ids = [];
  for (let i = 1; i < HEIGHT; i++) ids.push(crypto.createHash("sha256").update("priority-daemon-block-" + i).digest());
  return portable([entry("status", 10, str(Buffer.from("OK"))), entry("untrusted", 11, Buffer.from([0])), entry("credits", 5, u64(0)), entry("top_hash", 10, str(Buffer.alloc(0))),
    entry("m_block_ids", 10, str(Buffer.concat(ids))), entry("start_height", 5, u64(1)), entry("current_height", 5, u64(HEIGHT))]);
}

const INFO = { status: "OK", untrusted: false, height: HEIGHT, target_height: HEIGHT, block_weight_limit: 600000, block_size_limit: 600000, block_weight_median: 300000,
  block_size_median: 300000, adjusted_time: 1795105885, start_time: 1795000000, difficulty: 1, top_block_hash: "00".repeat(32), version: "constructed", synchronized: true,
  mainnet: true, testnet: false, stagenet: false, nettype: "mainnet", offline: false, restricted: true, database_size: 0, update_available: false, busy_syncing: false,
  cumulative_difficulty: 1, tx_count: 0, tx_pool_size: 0, alt_blocks_count: 0, outgoing_connections_count: 0, incoming_connections_count: 0, white_peerlist_size: 0,
  grey_peerlist_size: 0, free_space: 0, credits: 0 };

function headers() {
  const out = [];
  for (let h = HEIGHT - 11; h < HEIGHT - 1; h++) {
    out.push({ block_size: 1000, block_weight: 1000, long_term_weight: 1000, height: h, depth: HEIGHT - 1 - h, hash: crypto.createHash("sha256").update("priority-daemon-block-" + h).digest("hex"),
      prev_hash: "00".repeat(32), major_version: 11, minor_version: 11, timestamp: 1795105885, nonce: 0, orphan_status: false, reward: 0, difficulty: 1, num_txes: 0,
      miner_tx_hash: "00".repeat(32), cumulative_difficulty: 1 });
  }
  return out;
}

function startPriorityDaemon() {
  const log = {};
  for (const m of MOUNTS) log[m] = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const url = new URL(req.url, "http://127.0.0.1");
      const mount = MOUNTS.find((m) => url.pathname === m || url.pathname.startsWith(m + "/"));
      const send = (status, type, payload) => { res.writeHead(status, { "Content-Type": type, "Content-Length": Buffer.byteLength(payload) }); res.end(payload); };
      if (mount === undefined) { send(404, "text/plain", "not found"); return; }
      const endpoint = url.pathname.substring(mount.length) || "/";
      const name = endpoint === "/json_rpc" ? "json_rpc " + rpcMethod(body).method : endpoint;
      log[mount].push(name);
      const result = (id, r) => send(200, "application/json", JSON.stringify({ jsonrpc: "2.0", id, result: r }));
      const fail = () => send(500, "text/plain", "constructed failure");
      if (endpoint === "/gethashes.bin" || endpoint === "/get_hashes.bin") { send(200, "application/octet-stream", hashesAnswer()); return; }
      if (endpoint === "/getheight" || endpoint === "/get_height") { send(200, "application/json", JSON.stringify({ height: HEIGHT, status: "OK", untrusted: false })); return; }
      if (endpoint === "/getinfo" || endpoint === "/get_info") { send(200, "application/json", JSON.stringify(INFO)); return; }
      if (endpoint !== "/json_rpc") { fail(); return; } // /getblocks.bin and every other path
      const { id, method } = rpcMethod(body);
      switch (method) {
        case "get_version": result(id, { version: 196621, release: true, status: "OK", untrusted: false }); return;
        case "get_info": case "getinfo": result(id, INFO); return;
        case "hard_fork_info": result(id, { version: 11, enabled: true, earliest_height: 0, state: 2, threshold: 0, votes: 0, voting: 11, window: 0, status: "OK", untrusted: false }); return;
        case "get_fee_estimate": result(id, { fee: 20000, fees: [20000, 80000, 320000, 4000000], quantization_mask: 10000, status: "OK", untrusted: false }); return;
        case "get_block_count": case "getblockcount": result(id, { count: HEIGHT, status: "OK", untrusted: false }); return;
        case "get_txpool_backlog":
          if (mount === "/backlog") { fail(); return; }
          result(id, { backlog: "", status: "OK", untrusted: false }); return;
        case "getblockheadersrange": case "get_block_headers_range":
          if (mount === "/headers") { fail(); return; }
          result(id, { headers: headers(), status: "OK", untrusted: false }); return;
        case "getblockheaderbyheight": case "get_block_header_by_height": fail(); return;
        default: send(200, "application/json", JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } }));
      }
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => {
    const port = server.address().port;
    resolve({
      base: "http://127.0.0.1:" + port,
      port,
      requests: (mount) => log[mount].slice(),
      reset: () => { for (const m of MOUNTS) log[m].length = 0; },
      close: () => new Promise((r) => server.close(r))
    });
  }));
}

module.exports = { startPriorityDaemon, PRIORITY_DAEMON_HEIGHT: HEIGHT };
