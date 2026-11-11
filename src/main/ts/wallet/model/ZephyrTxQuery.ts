import assert from "assert";
import ZephyrBlock from "../../daemon/model/ZephyrBlock";
import ZephyrOutput from "../../daemon/model/ZephyrOutput";
import ZephyrIncomingTransfer from "./ZephyrIncomingTransfer";
import ZephyrOutgoingTransfer from "./ZephyrOutgoingTransfer";
import ZephyrOutputQuery from "./ZephyrOutputQuery";
import ZephyrTransferQuery from "./ZephyrTransferQuery";
import ZephyrTxSet from "./ZephyrTxSet";
import ZephyrTxWallet from "./ZephyrTxWallet";

/**
 * <p>Configuration to query transactions.</p>
 */
export default class ZephyrTxQuery extends ZephyrTxWallet {

  hash: string;
  hashes: string[];
  height: number;
  minHeight: number;
  maxHeight: number;
  includeOutputs: boolean;
  isConfirmed: boolean;
  inTxPool: boolean;
  relay: boolean;
  isRelayed: boolean;
  isFailed: boolean;
  isMinerTx: boolean;
  isLocked: boolean;
  isIncoming: boolean;
  isOutgoing: boolean;
  paymentId: string;
  paymentIds: string[];
  hasPaymentId: boolean;
  transferQuery: Partial<ZephyrTransferQuery>;
  inputQuery: Partial<ZephyrOutputQuery>;
  outputQuery: Partial<ZephyrOutputQuery>;

  /**
   * <p>Construct the transaction query.</p>
   * 
   * <p>Example:</p>
   * 
   * <code>
   * &sol;&sol; get transactions with unlocked incoming transfers to account 0<br>
   * let txs = await wallet.getTxs({<br>
   * &nbsp;&nbsp; isLocked: false,<br>
   * &nbsp;&nbsp; transferQuery: {<br>
   * &nbsp;&nbsp;&nbsp;&nbsp; isIncoming: true,<br>
   * &nbsp;&nbsp;&nbsp;&nbsp; accountIndex: 0<br>
   * &nbsp;&nbsp; }<br>
   * });
   * </code>
   * 
   * <p>All configuration is optional.  All transactions are returned except those that don't meet criteria defined in this query.</p>
   * 
   * @param {ZephyrTxQuery} [query] - tx query configuration
   * @param {string} [query.hash] - get a tx with this hash
   * @param {string[]} [query.txHashes] - get txs with these hashes
   * @param {number} [query.height] - get txs with this height
   * @param {number} [query.minHeight] - get txs with height greater than or equal to this height
   * @param {number} [query.maxHeight] - get txs with height less than or equal to this height
   * @param {boolean} [query.isConfirmed] - get confirmed or unconfirmed txs
   * @param {boolean} [query.inTxPool] - get txs in or out of the tx pool
   * @param {boolean} [query.relay] - get txs with the same relay status
   * @param {boolean} [query.isRelayed] - get relayed or non-relayed txs
   * @param {boolean} [query.isFailed] - get failed or non-failed txs
   * @param {boolean} [query.isMinerTx] - get miner or non-miner txs
   * @param {boolean} [query.isLocked] - get locked or unlocked txs
   * @param {boolean} [query.isIncoming] - get txs with or without incoming transfers
   * @param {boolean} [query.isOutgoing] - get txs with or without outgoing transfers
   * @param {string} [query.paymentId] - get txs with this payment ID
   * @param {string} [query.paymentIds] - get txs with a payment ID among these payment IDs
   * @param {boolean} [query.hasPaymentId] - get txs with or without payment IDs
   * @param {Partial<ZephyrTransferQuery>} [query.transferQuery] - get txs with transfers matching this transfer query
   * @param {Partial<ZephyrOutputQuery>} [query.inputQuery] - get txs with inputs matching this input query
   * @param {Partial<ZephyrOutputQuery>} [query.outputQuery] - get txs with outputs matching this output query
   */
  constructor(query?: Partial<ZephyrTxQuery>) {
    super(query);
    
    // copy queries
    if (this.transferQuery) this.transferQuery = new ZephyrTransferQuery(this.transferQuery);
    if (this.inputQuery) this.inputQuery = new ZephyrOutputQuery(this.inputQuery);
    if (this.outputQuery) this.outputQuery = new ZephyrOutputQuery(this.outputQuery);
    
    // link cycles
    if (this.transferQuery) this.getTransferQuery().setTxQuery(this);
    if (this.inputQuery) this.getInputQuery().setTxQuery(this);
    if (this.outputQuery) this.getOutputQuery().setTxQuery(this);
    
    // alias 'hash' to hashes
    if (this.hash) {
      this.setHashes([this.hash]);
      delete this.hash;
    }
  }
  
  copy(): ZephyrTxQuery {
    return new ZephyrTxQuery(this);
  }
  
  toJson(): any {
    let json = Object.assign({}, this, super.toJson()); // merge json onto inherited state
    if (this.getTransferQuery() !== undefined) json.transferQuery = this.getTransferQuery().toJson();
    if (this.getInputQuery() !== undefined) json.inputQuery = this.getInputQuery().toJson();
    if (this.getOutputQuery() !== undefined) json.outputQuery = this.getOutputQuery().toJson();
    delete json.block;  // do not serialize parent block
    return json;
  }
  
  getIsIncoming(): boolean {
    return this.isIncoming;
  }
  
  setIsIncoming(isIncoming: boolean): ZephyrTxQuery {
    this.isIncoming = isIncoming;
    return this;
  }
  
  getIsOutgoing(): boolean {
    return this.isOutgoing;
  }
  
  setIsOutgoing(isOutgoing: boolean): ZephyrTxQuery {
    this.isOutgoing = isOutgoing;
    return this;
  }

  getHashes(): string[] {
    return this.hashes;
  }

  setHashes(hashes: string[]): ZephyrTxQuery {
    this.hashes = hashes;
    return this;
  }
  
  setHash(hash: string): ZephyrTxQuery {
    if (hash === undefined) return this.setHashes(undefined);
    assert(typeof hash === "string");
    return this.setHashes([hash]);
  }
  
  getHasPaymentId(): boolean {
    return this.hasPaymentId;
  }
  
  setHasPaymentId(hasPaymentId: boolean): ZephyrTxQuery {
    this.hasPaymentId = hasPaymentId;
    return this;
  }
  
  getPaymentIds(): string[] {
    return this.paymentIds;
  }

  setPaymentIds(paymentIds: string[]): ZephyrTxQuery {
    this.paymentIds = paymentIds;
    return this;
  }
  
  setPaymentId(paymentId: string): ZephyrTxQuery {
    if (paymentId === undefined) return this.setPaymentIds(undefined);
    assert(typeof paymentId === "string");
    return this.setPaymentIds([paymentId]);
  }
  
  getHeight(): number {
    return this.height;
  }
  
  setHeight(height: number): ZephyrTxQuery {
    this.height = height;
    return this;
  }
  
  getMinHeight(): number {
    return this.minHeight;
  }

  setMinHeight(minHeight: number): ZephyrTxQuery {
    this.minHeight = minHeight;
    return this;
  }

  getMaxHeight(): number {
    return this.maxHeight;
  }

  setMaxHeight(maxHeight: number): ZephyrTxQuery {
    this.maxHeight = maxHeight;
    return this;
  }
  
  getIncludeOutputs(): boolean {
    return this.includeOutputs;
  }

  setIncludeOutputs(includeOutputs: boolean): ZephyrTxQuery {
    this.includeOutputs = includeOutputs;
    return this;
  }
  
  getTransferQuery(): ZephyrTransferQuery {
    return this.transferQuery as ZephyrTransferQuery
  }
  
  setTransferQuery(transferQuery: ZephyrTransferQuery): ZephyrTxQuery {
    this.transferQuery = transferQuery === undefined ? undefined : transferQuery instanceof ZephyrTransferQuery ? transferQuery : new ZephyrTransferQuery(transferQuery);
    if (transferQuery) this.transferQuery.txQuery = this;
    return this;
  }
  
  getInputQuery(): ZephyrOutputQuery {
    return this.inputQuery as ZephyrOutputQuery;
  }
  
  setInputQuery(inputQuery: ZephyrOutputQuery): ZephyrTxQuery {
    this.inputQuery = inputQuery;
    if (inputQuery) inputQuery.txQuery = this;
    return this;
  }
  
  getOutputQuery(): ZephyrOutputQuery {
    return this.outputQuery as ZephyrOutputQuery;
  }
  
  setOutputQuery(outputQuery: ZephyrOutputQuery): ZephyrTxQuery {
    this.outputQuery = outputQuery === undefined ? undefined : outputQuery instanceof ZephyrOutputQuery ? outputQuery : new ZephyrOutputQuery(outputQuery);
    if (outputQuery) this.outputQuery.txQuery = this;
    return this;
  }
  
  meetsCriteria(tx: ZephyrTxWallet, queryChildren?: boolean): boolean {
    if (!(tx instanceof ZephyrTxWallet)) throw new Error("Tx not given to ZephyrTxQuery.meetsCriteria(tx)");
    if (queryChildren === undefined) queryChildren = true;
    
    // filter on tx
    if (this.getHash() !== undefined && this.getHash() !== tx.getHash()) return false;
    if (this.getPaymentId() !== undefined && this.getPaymentId() !== tx.getPaymentId()) return false;
    if (this.getIsConfirmed() !== undefined && this.getIsConfirmed() !== tx.getIsConfirmed()) return false;
    if (this.getInTxPool() !== undefined && this.getInTxPool() !== tx.getInTxPool()) return false;
    if (this.getRelay() !== undefined && this.getRelay() !== tx.getRelay()) return false;
    if (this.getIsRelayed() !== undefined && this.getIsRelayed() !== tx.getIsRelayed()) return false;
    if (this.getIsFailed() !== undefined && this.getIsFailed() !== tx.getIsFailed()) return false;
    if (this.getIsMinerTx() !== undefined && this.getIsMinerTx() !== tx.getIsMinerTx()) return false;
    if (this.getIsLocked() !== undefined && this.getIsLocked() !== tx.getIsLocked()) return false;
    
    // filter on having a payment id
    if (this.getHasPaymentId() !== undefined) {
      if (this.getHasPaymentId() && tx.getPaymentId() === undefined) return false;
      if (!this.getHasPaymentId() && tx.getPaymentId() !== undefined) return false;
    }
    
    // filter on incoming
    if (this.getIsIncoming() !== undefined) {
      if (this.getIsIncoming() && !tx.getIsIncoming()) return false;
      if (!this.getIsIncoming() && tx.getIsIncoming()) return false;
    }
    
    // filter on outgoing
    if (this.getIsOutgoing() !== undefined) {
      if (this.getIsOutgoing() && !tx.getIsOutgoing()) return false;
      if (!this.getIsOutgoing() && tx.getIsOutgoing()) return false;
    }
    
    // filter on remaining fields
    let txHeight = tx.getBlock() === undefined ? undefined : tx.getBlock().getHeight();
    if (this.getHashes() !== undefined && !this.getHashes().includes(tx.getHash())) return false;
    if (this.getPaymentIds() !== undefined && !this.getPaymentIds().includes(tx.getPaymentId())) return false;
    if (this.getHeight() !== undefined && (txHeight === undefined || txHeight !== this.getHeight())) return false;
    if (this.getMinHeight() !== undefined && txHeight !== undefined && txHeight < this.getMinHeight()) return false; // do not filter unconfirmed
    if (this.getMaxHeight() !== undefined && (txHeight === undefined || txHeight > this.getMaxHeight())) return false;
    // TODO: filtering not complete
    
    // done if not querying transfers or outputs
    if (!queryChildren) return true;
    
    // at least one transfer must meet transfer filter if defined
    if (this.getTransferQuery() !== undefined) {
      let matchFound = false;
      if (tx.getOutgoingTransfer() && this.getTransferQuery().meetsCriteria(tx.getOutgoingTransfer(), false)) matchFound = true;
      else if (tx.getIncomingTransfers()) {
        for (let incomingTransfer of tx.getIncomingTransfers()) {
          if (this.getTransferQuery().meetsCriteria(incomingTransfer, false)) {
            matchFound = true;
            break;
          }
        }
      }
      if (!matchFound) return false;
    }
    
    // at least one input must meet input query if defined
    if (this.getInputQuery() !== undefined) {
      if (tx.getInputs() === undefined || tx.getInputs().length === 0) return false;
      let matchFound = false;
      for (let input of tx.getInputsWallet()) {
        if (this.getInputQuery().meetsCriteria(input, false)) {
          matchFound = true;
          break;
        }
      }
      if (!matchFound) return false;
    }
    
    // at least one output must meet output query if defined
    if (this.getOutputQuery() !== undefined) {
      if (tx.getOutputs() === undefined || tx.getOutputs().length === 0) return false;
      let matchFound = false;
      for (let output of tx.getOutputsWallet()) {
        if (this.getOutputQuery().meetsCriteria(output, false)) {
          matchFound = true;
          break;
        }
      }
      if (!matchFound) return false;
    }
    
    return true;  // transaction meets filter criteria
  }

  // ------------------- OVERRIDE CO-VARIANT RETURN TYPES ---------------------

  setIncomingTransfers(incomingTransfers: ZephyrIncomingTransfer[]): ZephyrTxQuery {
    super.setIncomingTransfers(incomingTransfers);
    return this;
  }

  setOutgoingTransfer(outgoingTransfer: ZephyrOutgoingTransfer): ZephyrTxQuery {
    super.setOutgoingTransfer(outgoingTransfer);
    return this;
  }

  setOutputs(outputs: ZephyrOutput[]): ZephyrTxQuery {
    super.setOutputs(outputs);
    return this;
  }

  setNote(note: string): ZephyrTxQuery {
    super.setNote(note);
    return this;
  }
  
  setIsLocked(isLocked: boolean): ZephyrTxQuery {
    super.setIsLocked(isLocked);
    return this;
  }

  setBlock(block: ZephyrBlock): ZephyrTxQuery {
    super.setBlock(block);
    return this;
  }
  
  setVersion(version: number): ZephyrTxQuery {
    super.setVersion(version);
    return this;
  }

  setIsMinerTx(isMinerTx: boolean): ZephyrTxQuery {
    super.setIsMinerTx(isMinerTx);
    return this;
  }

  setFee(fee: bigint): ZephyrTxQuery {
    super.setFee(fee);
    return this;
  }

  setRingSize(ringSize: number): ZephyrTxQuery {
    super.setRingSize(ringSize);
    return this;
  }

  setRelay(relay: boolean): ZephyrTxQuery {
    super.setRelay(relay);
    return this;
  }

  setIsRelayed(isRelayed: boolean): ZephyrTxQuery {
    super.setIsRelayed(isRelayed);
    return this;
  }

  setIsConfirmed(isConfirmed: boolean): ZephyrTxQuery {
    super.setIsConfirmed(isConfirmed);
    return this;
  }

  setInTxPool(inTxPool: boolean): ZephyrTxQuery {
    super.setInTxPool(inTxPool);
    return this;
  }

  setNumConfirmations(numConfirmations: number): ZephyrTxQuery {
    super.setNumConfirmations(numConfirmations);
    return this;
  }

  setUnlockTime(unlockTime: bigint): ZephyrTxQuery {
    super.setUnlockTime(unlockTime);
    return this;
  }

  setLastRelayedTimestamp(lastRelayedTimestamp: number): ZephyrTxQuery {
    super.setLastRelayedTimestamp(lastRelayedTimestamp);
    return this;
  }

  setReceivedTimestamp(receivedTimestamp: number): ZephyrTxQuery {
    super.setReceivedTimestamp(receivedTimestamp);
    return this;
  }

  setIsDoubleSpendSeen(isDoubleSpendSeen: boolean): ZephyrTxQuery {
    super.setIsDoubleSpendSeen(isDoubleSpendSeen);
    return this;
  }

  setKey(key: string): ZephyrTxQuery {
    super.setKey(key);
    return this;
  }

  setFullHex(hex: string): ZephyrTxQuery {
    super.setFullHex(hex);
    return this;
  }

  setPrunedHex(prunedHex: string): ZephyrTxQuery {
    super.setPrunedHex(prunedHex);
    return this;
  }

  setPrunableHex(prunableHex: string): ZephyrTxQuery {
    super.setPrunableHex(prunableHex);
    return this;
  }

  setPrunableHash(prunableHash: string): ZephyrTxQuery {
    super.setPrunableHash(prunableHash);
    return this;
  }

  setSize(size: number): ZephyrTxQuery {
    super.setSize(size);
    return this;
  }

  setWeight(weight: number): ZephyrTxQuery {
    super.setWeight(weight);
    return this;
  }

  setInputs(inputs: ZephyrOutput[]): ZephyrTxQuery {
    super.setInputs(inputs);
    return this;
  }

  setOutputIndices(outputIndices: number[]): ZephyrTxQuery {
    super.setOutputIndices(outputIndices);
    return this;
  }

  setMetadata(metadata: string): ZephyrTxQuery {
    super.setMetadata(metadata);
    return this;
  }

  setTxSet(txSet: ZephyrTxSet): ZephyrTxQuery {
    super.setTxSet(txSet);
    return this;
  }

  setExtra(extra: Uint8Array): ZephyrTxQuery {
    super.setExtra(extra);
    return this;
  }

  setRctSignatures(rctSignatures: any): ZephyrTxQuery {
    super.setRctSignatures(rctSignatures)
    return this;
  }

  setRctSigPrunable(rctSigPrunable: any): ZephyrTxQuery {
    super.setRctSigPrunable(rctSigPrunable);
    return this;
  }

  setIsKeptByBlock(isKeptByBlock: boolean): ZephyrTxQuery {
    super.setIsKeptByBlock(isKeptByBlock)
    return this;
  }

  setIsFailed(isFailed: boolean): ZephyrTxQuery {
    super.setIsFailed(isFailed);
    return this;
  }
  
  setLastFailedHeight(lastFailedHeight: number): ZephyrTxQuery {
    super.setLastFailedHeight(lastFailedHeight);
    return this;
  }

  setLastFailedHash(lastFailedId: string): ZephyrTxQuery {
    super.setLastFailedHash(lastFailedId);
    return this;
  }

  setMaxUsedBlockHeight(maxUsedBlockHeight: number): ZephyrTxQuery {
    super.setMaxUsedBlockHeight(maxUsedBlockHeight);
    return this;
  }

  setMaxUsedBlockHash(maxUsedBlockId: string): ZephyrTxQuery {
    super.setMaxUsedBlockHash(maxUsedBlockId);
    return this;
  }

  setSignatures(signatures: string[]): ZephyrTxQuery {
    super.setSignatures(signatures);
    return this;
  }
}
