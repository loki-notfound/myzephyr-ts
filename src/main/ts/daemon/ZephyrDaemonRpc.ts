/**
 * ZephyrDaemonRpc: read-only access to a Zephyr daemon's JSON-RPC interface, with the names and shapes of the Java
 * port's ZephyrDaemonRpc for what it supports: the node's information, its height and block headers with the
 * oracle's pricing record. The request, the JSON reading and the field checks are in daemon/ZephyrDaemonRpcInternal.ts.
 *
 * It runs in the calling context (it is never proxied to a worker) on the library's transport, under the rules of a
 * wallet's daemon access: requests only to the configured address (allowed for this context while a request runs),
 * no credentials, no proxy taken from the environment, no redirects followed, each request bounded (30 s), failures
 * as DAEMON_ERROR with a fixed diagnostic and never with text of the node. The node's answers are untrusted: every
 * field is checked for type and range, and an integer that can exceed 2^53 goes from the JSON text to a bigint
 * without passing through a JavaScript number.
 *
 * The inherited monero-ts methods that are not checked against a Zephyr daemon are not offered: they are not
 * declared, and called anyway (from JavaScript) they reject with UNSUPPORTED_CAPABILITY/DAEMON_RPC_METHOD before
 * any request (UNSUPPORTED_DAEMON_RPC_METHODS below).
 */
import ZephyrWalletError from "../common/ZephyrWalletError";
import * as WalletErrors from "../common/ZephyrWalletErrorMapping";
import { ZephyrDaemonRoute, parseDaemonAddress } from "../common/ZephyrDaemonAddress";
import { blockHeaderOf, daemonInfoOf, objectField, requestResult, Fields } from "./ZephyrDaemonRpcInternal";

/**
 * The oracle prices a Zephyr block was built with, as the daemon serializes the block header's pricing_record.
 * Every price is in the chain's fixed-point units, times 10^12 like amounts: spot and movingAverage are the price
 * of ZPH in USD; stable and stableMa the rate of ZSD, reserve and reserveMa the rate of ZRS (each with its moving
 * average); reserveRatio and reserveRatioMa the reserve ratio; yieldPrice the price of ZYS. timestamp is the
 * oracle's timestamp in seconds and signature its signature (128 lowercase hexadecimal characters).
 */
export interface ZephyrPricingRecord {
  readonly spot: bigint;
  readonly movingAverage: bigint;
  readonly stable: bigint;
  readonly stableMa: bigint;
  readonly reserve: bigint;
  readonly reserveMa: bigint;
  readonly reserveRatio: bigint;
  readonly reserveRatioMa: bigint;
  readonly yieldPrice: bigint;
  readonly timestamp: bigint;
  readonly signature: string;
}

/**
 * A block header as the daemon reports it. pricingRecord is absent for a block without a pricing record (the
 * core's empty record: every value 0 and a zero signature, as in the blocks before the oracle); powHash is absent
 * when the daemon does not compute it (it answers "" for headers).
 */
export interface ZephyrBlockHeader {
  readonly hash: string;
  readonly height: number;
  readonly timestamp: number;
  readonly size: number;
  readonly weight: number;
  readonly longTermWeight: number;
  readonly depth: number;
  readonly difficulty: bigint;
  readonly cumulativeDifficulty: bigint;
  readonly majorVersion: number;
  readonly minorVersion: number;
  readonly nonce: number;
  readonly minerTxHash: string;
  readonly numTxs: number;
  readonly orphanStatus: boolean;
  readonly prevHash: string;
  readonly reward: bigint;
  readonly powHash?: string;
  readonly pricingRecord?: ZephyrPricingRecord;
}

/**
 * The node's information (get_info), the fields a wallet uses. A field the daemon's answer does not carry is
 * absent, never zero. networkType is 0 (mainnet), 1 (testnet) or 2 (stagenet), as ZephyrWallet.getNetworkType.
 * topBlockHash is absent when the daemon answers "". A restricted daemon (a public node) reports version as "".
 */
export interface ZephyrDaemonInfo {
  readonly version?: string;
  readonly height?: number;
  readonly targetHeight?: number;
  readonly topBlockHash?: string;
  readonly networkType?: 0 | 1 | 2;
  readonly isSynchronized?: boolean;
  readonly isBusySyncing?: boolean;
  readonly isOffline?: boolean;
  readonly isRestricted?: boolean;
  readonly updateAvailable?: boolean;
  readonly adjustedTimestamp?: number;
  readonly target?: number;
  readonly difficulty?: bigint;
  readonly cumulativeDifficulty?: bigint;
  readonly numTxs?: number;
  readonly numTxsPool?: number;
  readonly numAltBlocks?: number;
  readonly blockSizeLimit?: number;
  readonly blockSizeMedian?: number;
  readonly blockWeightLimit?: number;
  readonly blockWeightMedian?: number;
}

/**
 * The inherited monero-ts methods of the daemon client that this class does not offer: called on an instance (or,
 * connectToDaemonRpc, on the class) they reject with UNSUPPORTED_CAPABILITY/DAEMON_RPC_METHOD before any request.
 */
const UNSUPPORTED_DAEMON_RPC_METHODS: readonly string[] = ["addListener", "checkForUpdate", "downloadUpdate", "flushTxPool", "getAltBlockHashes",
  "getAltChains", "getBlockByHash", "getBlockByHeight", "getBlockHash", "getBlockHashes", "getBlockHeadersByRange", "getBlockTemplate", "getBlocksByHash",
  "getBlocksByHeight", "getBlocksByRange", "getBlocksByRangeChunked", "getDownloadLimit", "getFeeEstimate", "getHardForkInfo", "getKeyImageSpentStatus",
  "getKeyImageSpentStatuses", "getKnownPeers", "getListeners", "getMinerTxSum", "getMiningStatus", "getOutputDistribution", "getOutputHistogram",
  "getOutputs", "getPeerBans", "getPeers", "getPollInterval", "getProcess", "getRpcConnection", "getSyncInfo", "getTx", "getTxHex", "getTxHexes",
  "getTxPool", "getTxPoolHashes", "getTxPoolStats", "getTxs", "getUploadLimit", "getVersion", "isConnected", "isTrusted", "pruneBlockchain",
  "relayTxByHash", "relayTxsByHash", "removeListener", "resetDownloadLimit", "resetUploadLimit", "setDownloadLimit", "setIncomingPeerLimit",
  "setOutgoingPeerLimit", "setPeerBan", "setPeerBans", "setUploadLimit", "startMining", "stop", "stopMining", "stopProcess", "submitBlock",
  "submitBlocks", "submitTxHex", "waitForNextBlockHeader"];

const BLOCK_HASH = /^[0-9a-f]{64}$/;

export class ZephyrDaemonRpc {

  private readonly route: ZephyrDaemonRoute;

  /**
   * A client of the daemon at address: a URL string or { uri }, with the forms and the fixed rejections of a
   * wallet's daemon address (common/ZephyrDaemonAddress.ts): INVALID_CONFIG/DAEMON_ADDRESS for a malformed
   * address, UNSUPPORTED_CAPABILITY with DAEMON_CREDENTIALS, DAEMON_PROXY or UNTRUSTED_DAEMON for credentials, a
   * proxy or an untrusted flag. The constructor contacts no daemon.
   */
  constructor(address: string | { readonly uri: string }) {
    this.route = parseDaemonAddress(address);
  }

  /** The node's information (one get_info request). */
  async getInfo(): Promise<ZephyrDaemonInfo> {
    if (arguments.length > 0) throw new ZephyrWalletError("INVALID_CONFIG", "FIELD_TYPE");
    return daemonInfoOf(await requestResult(this.route, "get_info"));
  }

  /** The node's height: the number of blocks of its chain (one get_block_count request). */
  async getHeight(): Promise<number> {
    if (arguments.length > 0) throw new ZephyrWalletError("INVALID_CONFIG", "FIELD_TYPE");
    return new Fields(await requestResult(this.route, "get_block_count"), false).safe("count") as number;
  }

  /** The header of the node's top block, with its pricing record (one get_last_block_header request). */
  async getLastBlockHeader(): Promise<ZephyrBlockHeader> {
    if (arguments.length > 0) throw new ZephyrWalletError("INVALID_CONFIG", "FIELD_TYPE");
    return blockHeaderOf(objectField(await requestResult(this.route, "get_last_block_header"), "block_header"));
  }

  /**
   * The header of the block at height, a safe integer from 0 (INVALID_CONFIG/BLOCK_HEIGHT otherwise; one
   * get_block_header_by_height request). A height the node does not have rejects with DAEMON_ERROR/DAEMON_RESPONSE.
   */
  async getBlockHeaderByHeight(height: number): Promise<ZephyrBlockHeader> {
    if (arguments.length !== 1 || typeof height !== "number" || !Number.isSafeInteger(height) || height < 0) throw new ZephyrWalletError("INVALID_CONFIG", "BLOCK_HEIGHT");
    return blockHeaderOf(objectField(await requestResult(this.route, "get_block_header_by_height", { height }), "block_header"));
  }

  /**
   * The header of the block with this hash, 64 lowercase hexadecimal characters (INVALID_CONFIG/BLOCK_HASH
   * otherwise; one get_block_header_by_hash request). A hash the node does not have rejects with
   * DAEMON_ERROR/DAEMON_RESPONSE.
   */
  async getBlockHeaderByHash(blockHash: string): Promise<ZephyrBlockHeader> {
    if (arguments.length !== 1 || typeof blockHash !== "string" || !BLOCK_HASH.test(blockHash)) throw new ZephyrWalletError("INVALID_CONFIG", "BLOCK_HASH");
    return blockHeaderOf(objectField(await requestResult(this.route, "get_block_header_by_hash", { hash: blockHash }), "block_header"));
  }

  static {
    // the inherited methods that are not offered: undeclared, rejecting before any request
    const reject = async (): Promise<never> => { throw WalletErrors.unsupported("DAEMON_RPC_METHOD"); };
    for (const name of UNSUPPORTED_DAEMON_RPC_METHODS) Object.defineProperty(ZephyrDaemonRpc.prototype, name, { value: reject, writable: false, enumerable: false, configurable: false });
    Object.defineProperty(ZephyrDaemonRpc, "connectToDaemonRpc", { value: reject, writable: false, enumerable: false, configurable: false });
  }
}
