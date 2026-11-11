import assert from "assert";
import GenUtils from "../../common/GenUtils";
import ZephyrBlock from "./ZephyrBlock";
import ZephyrOutput from "./ZephyrOutput";

/**
 * Represents a transaction on the Monero network.
 */
export default class ZephyrTx {

  static readonly DEFAULT_PAYMENT_ID = "0000000000000000";

  block: ZephyrBlock;
  hash: string;
  version: number;
  isMinerTx: boolean;
  paymentId: string;
  fee: bigint;
  ringSize: number;
  relay: boolean;
  isRelayed: boolean;
  isConfirmed: boolean;
  inTxPool: boolean;
  numConfirmations: number;
  unlockTime: bigint;
  lastRelayedTimestamp: number;
  receivedTimestamp: number;
  isDoubleSpendSeen: boolean;
  key: string;
  fullHex: string;
  prunedHex: string;
  prunableHex: string;
  prunableHash: string;
  size: number;
  weight: number;
  inputs: ZephyrOutput[];
  outputs: ZephyrOutput[];
  outputIndices: number[];
  metadata: string;
  extra: Uint8Array;
  rctSignatures: any;
  rctSigPrunable: any;
  isKeptByBlock: boolean;
  isFailed: boolean;
  lastFailedHeight: number;
  lastFailedHash: string;
  maxUsedBlockHeight: number;
  maxUsedBlockHash: string;
  signatures: string[];
  
  constructor(tx?: Partial<ZephyrTx>) {
    Object.assign(this, tx);
    this.block = undefined;

    // deserialize extra
    if (this.extra !== undefined) this.extra = new Uint8Array(this.extra);
    
    // deserialize bigints
    if (this.fee !== undefined && typeof this.fee !== "bigint") this.fee = BigInt(this.fee);
    if (this.unlockTime !== undefined && typeof this.unlockTime !== "bigint") this.unlockTime = BigInt(this.unlockTime);
    
    // copy inputs
    if (this.inputs) {
      this.inputs = this.inputs.slice();
      for (let i = 0; i < this.inputs.length; i++) {
        this.inputs[i] = new ZephyrOutput(this.inputs[i]).setTx(this);
      }
    }
    
    // copy outputs
    if (this.outputs) {
      this.outputs = this.outputs.slice();
      for (let i = 0; i < this.outputs.length; i++) {
        this.outputs[i] = new ZephyrOutput(this.outputs[i]).setTx(this);
      }
    }
  }
  
  /**
   * @return {ZephyrBlock} tx block
   */
  getBlock(): ZephyrBlock {
    return this.block;
  }
  
  /**
   * @param {ZephyrBlock} block - tx block
   * @return {ZephyrTx} this tx for chaining
   */
  setBlock(block: ZephyrBlock): ZephyrTx {
    this.block = block;
    return this;
  }
  
  /**
   * @return {number} tx height
   */
  getHeight(): number {
    return this.getBlock() === undefined ? undefined : this.getBlock().getHeight();
  }
  
  /**
   * @return {string} tx hash
   */
  getHash(): string {
    return this.hash;
  }
  
  /**
   * @param {string} hash - tx hash
   * @return {ZephyrTx} this tx for chaining
   */
  setHash(hash: string): ZephyrTx {
    this.hash = hash;
    return this;
  }
  
  /**
   * @return {number} tx version
   */
  getVersion(): number {
    return this.version;
  }
  
  /**
   * @param {number} version - tx version
   * @return {ZephyrTx} this tx for chaining
   */
  setVersion(version: number): ZephyrTx {
    this.version = version;
    return this;
  }
  
  /**
   * @return {boolean} true if the tx is a miner tx, false otherwise
   */
  getIsMinerTx(): boolean {
    return this.isMinerTx;
  }
  
  /**
   * @param {boolean} miner - true if the tx is a miner tx, false otherwise
   * @return {ZephyrTx} this tx for chaining
   */
  setIsMinerTx(miner: boolean): ZephyrTx {
    this.isMinerTx = miner;
    return this;
  }
  
  /**
   * @return {string} tx payment id
   */
  getPaymentId(): string {
    return this.paymentId;
  }
  
  /**
   * @param {string} paymentId - tx payment id
   * @return {ZephyrTx} this tx for chaining
   */
  setPaymentId(paymentId: string): ZephyrTx {
    this.paymentId = paymentId;
    return this;
  }
  
  /**
   * @return {bigint} tx fee
   */
  getFee(): bigint {
    return this.fee;
  }
  
  /**
   * @param {bigint} fee - tx fee
   * @return {ZephyrTx} this tx for chaining
   */
  setFee(fee: bigint): ZephyrTx {
    this.fee = fee;
    return this;
  }
  
  /**
   * @return {number} tx ring size
   */
  getRingSize(): number {
    return this.ringSize;
  }
  
  /**
   * @param {number} ringSize - tx ring size
   * @return {ZephyrTx} this tx for chaining
   */
  setRingSize(ringSize: number): ZephyrTx {
    this.ringSize = ringSize;
    return this;
  }
  
  /**
   * @return {boolean} true if the tx is set to be relayed, false otherwise
   */
  getRelay(): boolean {
    return this.relay;
  }
  
  /**
   * @param {boolean} relay - true if the tx is set to be relayed, false otherwise
   * @return {ZephyrTx} this tx for chaining
   */
  setRelay(relay: boolean): ZephyrTx {
    this.relay = relay;
    return this;
  }
  
  /**
   * @return {boolean} true if the tx is relayed, false otherwise
   */
  getIsRelayed(): boolean {
    return this.isRelayed;
  }
  
  /**
   * @param {boolean} isRelayed - true if the tx is relayed, false otherwise
   * @return {ZephyrTx} this tx for chaining
   */
  setIsRelayed(isRelayed: boolean): ZephyrTx {
    this.isRelayed = isRelayed;
    return this;
  }
  
  /**
   * @return {boolean} true if the tx is confirmed, false otherwise
   */
  getIsConfirmed(): boolean {
    return this.isConfirmed;
  }
  
  /**
   * @param {boolean} isConfirmed - true if the tx is confirmed, false otherwise
   * @return {ZephyrTx} this tx for chaining
   */
  setIsConfirmed(isConfirmed: boolean): ZephyrTx {
    this.isConfirmed = isConfirmed;
    return this;
  }
  
  /**
   * @return {boolean} true if the tx is in the memory pool, false otherwise
   */
  getInTxPool(): boolean {
    return this.inTxPool;
  }
  
  /**
   * @param {boolean} inTxPool - true if the tx is in the memory pool, false otherwise
   * @return {ZephyrTx} this tx for chaining
   */
  setInTxPool(inTxPool: boolean): ZephyrTx {
    this.inTxPool = inTxPool;
    return this;
  }
  
  /**
   * @return {number} number of block confirmations
   */
  getNumConfirmations(): number {
    return this.numConfirmations;
  }
  
  /**
   * @param {number} numConfirmations - number of block confirmations
   * @return {ZephyrTx} this tx for chaining
   */
  setNumConfirmations(numConfirmations: number): ZephyrTx {
    this.numConfirmations = numConfirmations;
    return this;
  }
  
  /**
   * Get the minimum height or timestamp for the transactions to unlock.
   * 
   * @return {bigint} the minimum height or timestamp for the transaction to unlock
   */
  getUnlockTime(): bigint {
    return this.unlockTime;
  }
  
  setUnlockTime(unlockTime: bigint | string | number | undefined): ZephyrTx {
    if (unlockTime !== undefined && typeof unlockTime !== "bigint") unlockTime = BigInt(unlockTime);
    this.unlockTime = unlockTime as bigint | undefined;
    return this;
  }
  
  /**
   * @return {number} timestamp the tx was last relayed from the node
   */
  getLastRelayedTimestamp(): number {
    return this.lastRelayedTimestamp;
  }
  
  /**
   * @param {number} lastRelayedTimestamp - timestamp the tx was last relayed from the node
   * @return {ZephyrTx} this tx for chaining
   */
  setLastRelayedTimestamp(lastRelayedTimestamp: number): ZephyrTx {
    this.lastRelayedTimestamp = lastRelayedTimestamp;
    return this;
  }
  
  /**
   * @return {number} timestamp the tx was received at the node
   */
  getReceivedTimestamp(): number {
    return this.receivedTimestamp;
  }
  
  /**
   * @param {number} receivedTimestamp - timestamp the tx was received at the node
   * @return {ZephyrTx} this tx for chaining
   */
  setReceivedTimestamp(receivedTimestamp: number): ZephyrTx {
    this.receivedTimestamp = receivedTimestamp;
    return this;
  }
  
  /**
   * @return {boolean} true if a double spend has been seen, false otherwise
   */
  getIsDoubleSpendSeen(): boolean {
    return this.isDoubleSpendSeen;
  }
  
  /**
   * @param {boolean} isDoubleSpendSeen - true if a double spend has been seen, false otherwise
   * @return {ZephyrTx} this tx for chaining
   */
  setIsDoubleSpendSeen(isDoubleSpendSeen: boolean ): ZephyrTx {
    this.isDoubleSpendSeen = isDoubleSpendSeen;
    return this;
  }
  
  /**
   * @return {string} tx key
   */
  getKey(): string {
    return this.key;
  }
  
  /**
   * @param {string} key - tx key
   * @return {ZephyrTx} this tx for chaining
   */
  setKey(key: string): ZephyrTx {
    this.key = key;
    return this;
  }
  
  /**
   * Get full transaction hex. Full hex = pruned hex + prunable hex.
   * 
   * @return {string|undefined} full tx hex
   */
  getFullHex(): string|undefined {
    return this.fullHex;
  }
  
  /**
   * @param {string} fullHex - full tx hex
   * @return {ZephyrTx} this tx for chaining
   */
  setFullHex(fullHex: string): ZephyrTx {
    this.fullHex = fullHex;
    return this;
  }
  
  /**
   * Get pruned transaction hex. Full hex = pruned hex + prunable hex.
   * 
   * @return {string} pruned tx hex
   */
  getPrunedHex(): string {
    return this.prunedHex;
  }
  
  /**
   * @param {string} prunedHex - pruned tx hex
   * @return {ZephyrTx} this tx for chaining
   */
  setPrunedHex(prunedHex: string): ZephyrTx {
    this.prunedHex = prunedHex;
    return this;
  }
  
  /**
   * Get prunable transaction hex which is hex that is removed from a pruned
   * transaction. Full hex = pruned hex + prunable hex.
   * 
   * @return {string} prunable tx hex
   */
  getPrunableHex(): string {
    return this.prunableHex;
  }
  
  /**
   * @param {string} prunableHex - prunable tx hex
   * @return {ZephyrTx} this tx for chaining
   */
  setPrunableHex(prunableHex: string): ZephyrTx {
    this.prunableHex = prunableHex;
    return this;
  }
  
  /**
   * @return {string} prunable tx hash
   */
  getPrunableHash(): string {
    return this.prunableHash;
  }
  
  /**
   * @param {string} prunableHash - prunable tx hash
   * @return {ZephyrTx} this tx for chaining
   */
  setPrunableHash(prunableHash: string): ZephyrTx {
    this.prunableHash = prunableHash;
    return this;
  }
  
  /**
   * @return {number} tx size
   */
  getSize(): number {
    return this.size;
  }
  
  /**
   * @param {number} size - tx size
   * @return {ZephyrTx} this tx for chaining
   */
  setSize(size: number): ZephyrTx {
    this.size = size;
    return this;
  }
  
  /**
   * @return {number} tx weight
   */
  getWeight(): number {
    return this.weight;
  }
  
  /**
   * @param {number} weight - tx weight
   * @return {ZephyrTx} this tx for chaining
   */
  setWeight(weight: number): ZephyrTx {
    this.weight = weight;
    return this;
  }
  
  /**
   * @return {ZephyrOutput[]} tx inputs
   */
  getInputs(): ZephyrOutput[] {
    return this.inputs;
  }
  
  /**
   * @param {ZephyrOutput[]} - tx inputs
   * @return {ZephyrTx} this tx for chaining
   */
  setInputs(inputs: ZephyrOutput[]): ZephyrTx {
    this.inputs = inputs;
    return this;
  }
  
  /**
   * @return {ZephyrOutput[]} tx outputs
   */
  getOutputs(): ZephyrOutput[] {
    return this.outputs;
  }
  
  /**
   * @param {ZephyrOutput[]} outputs - tx outputs
   * @return {ZephyrTx} this tx for chaining
   */
  setOutputs(outputs: ZephyrOutput[]): ZephyrTx {
    this.outputs = outputs;
    return this;
  }
  
  /**
   * @return {number[]} tx output indices
   */
  getOutputIndices(): number[] {
    return this.outputIndices;
  }
  
  /**
   * @param {number[]} outputIndices - tx output indices
   * @return {ZephyrTx} this tx for chaining
   */
  setOutputIndices(outputIndices: number[]): ZephyrTx {
    this.outputIndices = outputIndices;
    return this;
  }
  
  /**
   * @return {string} tx metadata
   */
  getMetadata(): string {
    return this.metadata;
  }
  
  /**
   * @param {string} metadata - tx metadata
   * @return {ZephyrTx} this tx for chaining
   */
  setMetadata(metadata: string): ZephyrTx {
    this.metadata = metadata;
    return this;
  }
  
  /**
   * @return {Uint8Array} tx extra
   */
  getExtra(): Uint8Array {
    return this.extra;
  }
  
  /**
   * @param {Uint8Array} extra - tx extra
   * @return {ZephyrTx} this tx for chaining
   */
  setExtra(extra: Uint8Array): ZephyrTx {
    this.extra = extra;
    return this;
  }

  /**
   * @return {any} RCT signatures
   */
  getRctSignatures(): any {
    return this.rctSignatures;
  }

  /**
   * @param {any} rctSignatures - RCT signatures
   * @return {ZephyrTx} this tx for chaining
   */
  setRctSignatures(rctSignatures: any): ZephyrTx {
    this.rctSignatures = rctSignatures;
    return this;
  }

  /**
   * @return {any} prunable RCT signature data
   */
  getRctSigPrunable(): object {
    return this.rctSigPrunable;
  }

  /**
   * @param {any} rctSigPrunable - prunable RCT signature data
   * @return {ZephyrTx} this tx for chaining
   */
  setRctSigPrunable(rctSigPrunable: any): ZephyrTx {
    this.rctSigPrunable = rctSigPrunable;
    return this;
  }

  /**
   * @return {boolean} true if kept by a block, false otherwise
   */
  getIsKeptByBlock(): boolean {
    return this.isKeptByBlock;
  }

  /**
   * @param {boolean} isKeptByBlock - true if kept by a block, false otherwise
   * @return {ZephyrTx} this tx for chaining
   */
  setIsKeptByBlock(isKeptByBlock: boolean): ZephyrTx {
    this.isKeptByBlock = isKeptByBlock;
    return this;
  }

  /**
   * @return {boolean} true if the tx failed, false otherwise
   */
  getIsFailed(): boolean {
    return this.isFailed;
  }

  /**
   * @param {boolean} isFailed - true if the tx failed, false otherwise
   * @return {ZephyrTx} this tx for chaining
   */
  setIsFailed(isFailed: boolean): ZephyrTx {
    this.isFailed = isFailed;
    return this;
  }

  /**
   * @return {number} block height of the last tx failure
   */
  getLastFailedHeight(): number {
    return this.lastFailedHeight;
  }

  /**
   * @param {number} lastFailedHeight - block height of the last tx failure
   * @return {ZephyrTx} this tx for chaining
   */
  setLastFailedHeight(lastFailedHeight: number): ZephyrTx {
    this.lastFailedHeight = lastFailedHeight;
    return this;
  }

  /**
   * @return {string} block hash of the last tx failure
   */
  getLastFailedHash(): string {
    return this.lastFailedHash;
  }

  /**
   * @param {string} lastFailedHash - block hash of the last tx failure
   * @return {ZephyrTx} this tx for chaining
   */
  setLastFailedHash(lastFailedHash: string): ZephyrTx {
    this.lastFailedHash = lastFailedHash;
    return this;
  }

  /**
   * @return {number} max used block height
   */
  getMaxUsedBlockHeight(): number {
    return this.maxUsedBlockHeight;
  }

  /**
   * @param {number} maxUsedBlockHeight - max used block height
   * @return {ZephyrTx} this tx for chaining
   */
  setMaxUsedBlockHeight(maxUsedBlockHeight: number): ZephyrTx {
    this.maxUsedBlockHeight = maxUsedBlockHeight;
    return this;
  }

  /**
   * @return {string} max used block hash
   */
  getMaxUsedBlockHash(): string {
    return this.maxUsedBlockHash;
  }

  /**
   * @param {string} maxUsedBlockHash - max used block hash
   * @return {ZephyrTx} this tx for chaining
   */
  setMaxUsedBlockHash(maxUsedBlockHash: string): ZephyrTx {
    this.maxUsedBlockHash = maxUsedBlockHash;
    return this;
  }

  /**
   * @return {string[]} tx signatures
   */
  getSignatures(): string[] {
    return this.signatures;
  }

  /**
   * @param {string[]} signatures - tx signatures
   * @return {ZephyrTx} this tx for chaining
   */
  setSignatures(signatures: string[]): ZephyrTx {
    this.signatures = signatures;
    return this;
  }

  /**
   * @return {ZephyrTx} a copy of this tx
   */
  copy(): ZephyrTx {
    return new ZephyrTx(this);
  }
  
  /**
   * @return {any} json representation of this tx
   */
  toJson(): any {
    let json: any = Object.assign({}, this);
    if (this.getFee() !== undefined) json.fee = this.getFee().toString();
    if (this.getUnlockTime() !== undefined) json.unlockTime = this.getUnlockTime().toString();
    if (this.getInputs()) {
      json.inputs = [];
      for (let input of this.getInputs()) json.inputs.push(input.toJson());
    }
    if (this.getOutputs()) {
      json.outputs = [];
      for (let output of this.getOutputs()) json.outputs.push(output.toJson());
    }
    if (this.getExtra() !== undefined) json.extra = Array.from(this.getExtra(), byte => byte);
    delete json.block;  // do not serialize parent block
    return json;
  }
  
  /**
   * Updates this transaction by merging the latest information from the given
   * transaction.
   * 
   * @param {ZephyrTx} tx - the transaction to update this transaction with
   * @return {ZephyrTx} this for method chaining
   */
  merge(tx: ZephyrTx): ZephyrTx {
    assert(tx instanceof ZephyrTx);
    if (this === tx) return this;
    
    // merge blocks if they're different
    if (this.getBlock() !== tx.getBlock()) {
      if (this.getBlock() === undefined) {
        this.setBlock(tx.getBlock());
        this.getBlock().getTxs[this.getBlock().getTxs().indexOf(tx)] = this; // update block to point to this tx
      } else if (tx.getBlock() !== undefined) {
        this.getBlock().merge(tx.getBlock()); // comes back to merging txs
        return this;
      }
    }
    
    // otherwise merge tx fields
    this.setHash(GenUtils.reconcile(this.getHash(), tx.getHash()));
    this.setVersion(GenUtils.reconcile(this.getVersion(), tx.getVersion()));
    this.setPaymentId(GenUtils.reconcile(this.getPaymentId(), tx.getPaymentId()));
    this.setFee(GenUtils.reconcile(this.getFee(), tx.getFee()));
    this.setRingSize(GenUtils.reconcile(this.getRingSize(), tx.getRingSize()));
    this.setIsConfirmed(GenUtils.reconcile(this.getIsConfirmed(), tx.getIsConfirmed(), {resolveTrue: true})); // tx can become confirmed
    this.setIsMinerTx(GenUtils.reconcile(this.getIsMinerTx(), tx.getIsMinerTx()));
    this.setRelay(GenUtils.reconcile(this.getRelay(), tx.getRelay(), {resolveTrue: true}));       // tx can become relayed
    this.setIsRelayed(GenUtils.reconcile(this.getIsRelayed(), tx.getIsRelayed(), {resolveTrue: true})); // tx can become relayed
    this.setIsDoubleSpendSeen(GenUtils.reconcile(this.getIsDoubleSpendSeen(), tx.getIsDoubleSpendSeen(), {resolveTrue: true})); // double spend can become seen
    this.setKey(GenUtils.reconcile(this.getKey(), tx.getKey()));
    this.setFullHex(GenUtils.reconcile(this.getFullHex(), tx.getFullHex()));
    this.setPrunedHex(GenUtils.reconcile(this.getPrunedHex(), tx.getPrunedHex()));
    this.setPrunableHex(GenUtils.reconcile(this.getPrunableHex(), tx.getPrunableHex()));
    this.setPrunableHash(GenUtils.reconcile(this.getPrunableHash(), tx.getPrunableHash()));
    this.setSize(GenUtils.reconcile(this.getSize(), tx.getSize()));
    this.setWeight(GenUtils.reconcile(this.getWeight(), tx.getWeight()));
    this.setOutputIndices(GenUtils.reconcile(this.getOutputIndices(), tx.getOutputIndices()));
    this.setMetadata(GenUtils.reconcile(this.getMetadata(), tx.getMetadata()));
    this.setExtra(GenUtils.reconcile(this.getExtra(), tx.getExtra()));
    this.setRctSignatures(GenUtils.reconcile(this.getRctSignatures(), tx.getRctSignatures()));
    this.setRctSigPrunable(GenUtils.reconcile(this.getRctSigPrunable(), tx.getRctSigPrunable()));
    this.setIsKeptByBlock(GenUtils.reconcile(this.getIsKeptByBlock(), tx.getIsKeptByBlock()));
    this.setIsFailed(GenUtils.reconcile(this.getIsFailed(), tx.getIsFailed(), {resolveTrue: true}));
    this.setLastFailedHeight(GenUtils.reconcile(this.getLastFailedHeight(), tx.getLastFailedHeight()));
    this.setLastFailedHash(GenUtils.reconcile(this.getLastFailedHash(), tx.getLastFailedHash()));
    this.setMaxUsedBlockHeight(GenUtils.reconcile(this.getMaxUsedBlockHeight(), tx.getMaxUsedBlockHeight()));
    this.setMaxUsedBlockHash(GenUtils.reconcile(this.getMaxUsedBlockHash(), tx.getMaxUsedBlockHash()));
    this.setSignatures(GenUtils.reconcile(this.getSignatures(), tx.getSignatures()));
    this.setUnlockTime(GenUtils.reconcile(this.getUnlockTime(), tx.getUnlockTime()));
    this.setNumConfirmations(GenUtils.reconcile(this.getNumConfirmations(), tx.getNumConfirmations(), {resolveMax: true})); // num confirmations can increase
    
    // merge inputs
    if (tx.getInputs()) {
      for (let merger of tx.getInputs()) {
        let merged = false;
        merger.setTx(this);
        if (!this.getInputs()) this.setInputs([]);
        for (let mergee of this.getInputs()) {
          if (mergee.getKeyImage().getHex() === merger.getKeyImage().getHex()) {
            mergee.merge(merger);
            merged = true;
            break;
          }
        }
        if (!merged) this.getInputs().push(merger);
      }
    }
    
    // merge outputs
    if (tx.getOutputs()) {
      for (let output of tx.getOutputs()) output.setTx(this);
      if (!this.getOutputs()) this.setOutputs(tx.getOutputs());
      else {
        
        // merge outputs if key image or stealth public key present, otherwise append
        for (let merger of tx.getOutputs()) {
          let merged = false;
          merger.setTx(this);
          for (let mergee of this.getOutputs()) {
            if ((merger.getKeyImage() && mergee.getKeyImage().getHex() === merger.getKeyImage().getHex()) ||
                (merger.getStealthPublicKey() && mergee.getStealthPublicKey() === merger.getStealthPublicKey())) {
             mergee.merge(merger);
             merged = true;
             break;
            }
          }
          if (!merged) this.getOutputs().push(merger); // append output
        }
      }
    }
    
    // handle unrelayed -> relayed -> confirmed
    if (this.getIsConfirmed()) {
      this.setInTxPool(false);
      this.setReceivedTimestamp(undefined);
      this.setLastRelayedTimestamp(undefined);
    } else {
      this.setInTxPool(GenUtils.reconcile(this.getInTxPool(), tx.getInTxPool(), {resolveTrue: true})); // unrelayed -> tx pool
      this.setReceivedTimestamp(GenUtils.reconcile(this.getReceivedTimestamp(), tx.getReceivedTimestamp(), {resolveMax: false})); // take earliest receive time
      this.setLastRelayedTimestamp(GenUtils.reconcile(this.getLastRelayedTimestamp(), tx.getLastRelayedTimestamp(), {resolveMax: true}));  // take latest relay time
    }
    
    return this;  // for chaining
  }
  
  /**
   * @param {number} [indent] - starting indentation
   * @return {string} string representation of this tx
   */
  toString(indent = 0): string {
    let str = "";
    str += GenUtils.getIndent(indent) + "=== TX ===\n";
    str += GenUtils.kvLine("Tx hash", this.getHash(), indent);
    str += GenUtils.kvLine("Height", this.getHeight(), indent);
    str += GenUtils.kvLine("Version", this.getVersion(), indent);
    str += GenUtils.kvLine("Is miner tx", this.getIsMinerTx(), indent);
    str += GenUtils.kvLine("Payment ID", this.getPaymentId(), indent);
    str += GenUtils.kvLine("Fee", this.getFee(), indent);
    str += GenUtils.kvLine("Ring size", this.getRingSize(), indent);
    str += GenUtils.kvLine("Relay", this.getRelay(), indent);
    str += GenUtils.kvLine("Is relayed", this.getIsRelayed(), indent);
    str += GenUtils.kvLine("Is confirmed", this.getIsConfirmed(), indent);
    str += GenUtils.kvLine("In tx pool", this.getInTxPool(), indent);
    str += GenUtils.kvLine("Num confirmations", this.getNumConfirmations(), indent);
    str += GenUtils.kvLine("Unlock time", this.getUnlockTime(), indent);
    str += GenUtils.kvLine("Last relayed time", this.getLastRelayedTimestamp(), indent);
    str += GenUtils.kvLine("Received time", this.getReceivedTimestamp(), indent);
    str += GenUtils.kvLine("Is double spend", this.getIsDoubleSpendSeen(), indent);
    str += GenUtils.kvLine("Key", this.getKey(), indent);
    str += GenUtils.kvLine("Full hex", this.getFullHex(), indent);
    str += GenUtils.kvLine("Pruned hex", this.getPrunedHex(), indent);
    str += GenUtils.kvLine("Prunable hex", this.getPrunableHex(), indent);
    str += GenUtils.kvLine("Prunable hash", this.getPrunableHash(), indent);
    str += GenUtils.kvLine("Size", this.getSize(), indent);
    str += GenUtils.kvLine("Weight", this.getWeight(), indent);
    str += GenUtils.kvLine("Output indices", this.getOutputIndices(), indent);
    str += GenUtils.kvLine("Metadata", this.getMetadata(), indent);
    str += GenUtils.kvLine("Extra", this.getExtra(), indent);
    str += GenUtils.kvLine("RCT signatures", this.getRctSignatures(), indent);
    str += GenUtils.kvLine("RCT sig prunable", this.getRctSigPrunable(), indent);
    str += GenUtils.kvLine("Kept by block", this.getIsKeptByBlock(), indent);
    str += GenUtils.kvLine("Is failed", this.getIsFailed(), indent);
    str += GenUtils.kvLine("Last failed height", this.getLastFailedHeight(), indent);
    str += GenUtils.kvLine("Last failed hash", this.getLastFailedHash(), indent);
    str += GenUtils.kvLine("Max used block height", this.getMaxUsedBlockHeight(), indent);
    str += GenUtils.kvLine("Max used block hash", this.getMaxUsedBlockHash(), indent);
    str += GenUtils.kvLine("Signatures", this.getSignatures(), indent);
    if (this.getInputs() !== undefined) {
      str += GenUtils.kvLine("Inputs", "", indent);
      for (let i = 0; i < this.getInputs().length; i++) {
        str += GenUtils.kvLine(i + 1, "", indent + 1);
        str += this.getInputs()[i].toString(indent + 2);
        str += '\n'
      }
    }
    if (this.getOutputs() !== undefined) {
      str += GenUtils.kvLine("Outputs", "", indent);
      for (let i = 0; i < this.getOutputs().length; i++) {
        str += GenUtils.kvLine(i + 1, "", indent + 1);
        str += this.getOutputs()[i].toString(indent + 2);
        str += '\n'
      }
    }
    return str.slice(0, str.length - 1);  // strip last newline
  }
}
