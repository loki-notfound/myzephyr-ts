import assert from "assert";
import GenUtils from "../../common/GenUtils";
import ZephyrBlock from "../../daemon/model/ZephyrBlock";
import ZephyrError from "../../common/ZephyrError";
import ZephyrIncomingTransfer from "./ZephyrIncomingTransfer";
import ZephyrOutgoingTransfer from "./ZephyrOutgoingTransfer";
import ZephyrOutputQuery from "./ZephyrOutputQuery";
import ZephyrOutput from "../../daemon/model/ZephyrOutput";
import ZephyrOutputWallet from "./ZephyrOutputWallet";
import ZephyrTransfer from "./ZephyrTransfer";
import ZephyrTransferQuery from "./ZephyrTransferQuery";
import ZephyrTx from "../../daemon/model/ZephyrTx";
import ZephyrTxSet from "./ZephyrTxSet";

/**
 * Models a Monero transaction with wallet extensions.
 */
export default class ZephyrTxWallet extends ZephyrTx {

  txSet: ZephyrTxSet;
  isIncoming: boolean;
  isOutgoing: boolean;
  incomingTransfers: ZephyrIncomingTransfer[];
  outgoingTransfer: ZephyrOutgoingTransfer;
  note: string;
  isLocked: boolean;
  inputSum: bigint;
  outputSum: bigint;
  changeAddress: string;
  changeAmount: bigint;
  numDummyOutputs: number;
  extraHex: string;
  
  /**
   * Construct the model.
   * 
   * @param {Partial<ZephyrTxWallet>} [tx] is existing state to initialize from (optional)
   */
  constructor(tx?: Partial<ZephyrTxWallet>) {
    super(tx);
    this.setTxSet(this.getTxSet()); // preserve reference to tx set
    
    // copy incoming transfers
    if (this.incomingTransfers) {
      this.incomingTransfers = this.incomingTransfers.slice();
      for (let i = 0; i < this.incomingTransfers.length; i++) {
        this.incomingTransfers[i] = new ZephyrIncomingTransfer(this.incomingTransfers[i]).setTx(this);
      }
    }
    
    // copy outgoing transfer
    if (this.outgoingTransfer) {
      this.outgoingTransfer = new ZephyrOutgoingTransfer(this.outgoingTransfer).setTx(this);
    }
    
    // copy inputs
    if (this.inputs) {
      this.inputs = this.inputs.slice();
      for (let i = 0; i < this.inputs.length; i++) {
        this.inputs[i] = new ZephyrOutputWallet(this.inputs[i] as ZephyrOutputWallet).setTx(this);
      }
    }
    
    // copy outputs
    if (this.outputs) {
      this.outputs = this.outputs.slice();
      for (let i = 0; i < this.outputs.length; i++) {
        this.outputs[i] = new ZephyrOutputWallet(this.outputs[i] as ZephyrOutputWallet).setTx(this);
      }
    }
    
    // deserialize bigints
    if (this.inputSum !== undefined && typeof this.inputSum !== "bigint") this.inputSum = BigInt(this.inputSum);
    if (this.outputSum !== undefined && typeof this.outputSum !== "bigint") this.outputSum = BigInt(this.outputSum);
    if (this.changeAmount !== undefined && typeof this.changeAmount !== "bigint") this.changeAmount = BigInt(this.changeAmount);
  }
  
  /**
   * @return {any} json representation of this tx
   */
  toJson(): any {
    let json = Object.assign({}, this, super.toJson()); // merge json onto inherited state
    if (this.getIncomingTransfers() !== undefined) {
      json.incomingTransfers = [];
      for (let incomingTransfer of this.getIncomingTransfers()) json.incomingTransfers.push(incomingTransfer.toJson());
    }
    if (this.getOutgoingTransfer() !== undefined) json.outgoingTransfer = this.getOutgoingTransfer().toJson();
    if (this.getInputSum() !== undefined) json.inputSum = this.getInputSum().toString();
    if (this.getOutputSum() !== undefined) json.outputSum = this.getOutputSum().toString();
    if (this.getChangeAmount() !== undefined) json.changeAmount = this.getChangeAmount().toString();
    delete json.block;  // do not serialize parent block
    delete json.txSet;  // do not serialize parent tx set
    return json;
  }
  
  /**
   * @return {ZephyrTxSet} tx set containing txs
   */
  getTxSet(): ZephyrTxSet {
    return this.txSet;
  }

  /**
   * @param {ZephyrTxSet} txSet - tx set containing txs
   * @return {ZephyrTxWallet} this tx for chaining
   */
  setTxSet(txSet: ZephyrTxSet): ZephyrTxWallet {
    this.txSet = txSet;
    return this;
  }

  /**
   * @return {boolean} true if the tx has incoming funds, false otherwise
   */
  getIsIncoming(): boolean {
    return this.isIncoming;
  }

  /**
   * @param {boolean} isIncoming - true if the tx has incoming funds, false otherwise
   * @return {ZephyrTxWallet} this tx for chaining
   */
  setIsIncoming(isIncoming: boolean): ZephyrTxWallet {
    this.isIncoming = isIncoming;
    return this;
  }

  /**
   * @return {boolean} true if the tx has outgoing funds, false otherwise
   */
  getIsOutgoing(): boolean {
    return this.isOutgoing;
  }

  /**
   * @param {boolean} isOutgoing - true if the tx has outgoing funds, false otherwise
   * @return {ZephyrTxWallet} this tx for chaining
   */
  setIsOutgoing(isOutgoing: boolean): ZephyrTxWallet {
    this.isOutgoing = isOutgoing;
    return this;
  }

  /**
   * @return {bigint} amount received in the tx
   */
  getIncomingAmount(): bigint {
    if (this.getIncomingTransfers() === undefined) return undefined;
    let incomingAmt = 0n;
    for (let transfer of this.getIncomingTransfers()) incomingAmt = incomingAmt + transfer.getAmount();
    return incomingAmt;
  }

  /**
   * @return {bigint} amount spent in the tx
   */
  getOutgoingAmount(): bigint {
    return this.getOutgoingTransfer() ? this.getOutgoingTransfer().getAmount() : undefined;
  }

  /**
   * @param {ZephyrTransferQuery} [transferQuery] - query to get specific transfers
   * @return {ZephyrTransfer[]} transfers matching the query
   */
  getTransfers(transferQuery?: ZephyrTransferQuery): ZephyrTransfer[] {
    let transfers = [];
    if (this.getOutgoingTransfer() && (!transferQuery || transferQuery.meetsCriteria(this.getOutgoingTransfer()))) transfers.push(this.getOutgoingTransfer());
    if (this.getIncomingTransfers() !== undefined) {
      for (let transfer of this.getIncomingTransfers()) {
        if (!transferQuery || transferQuery.meetsCriteria(transfer)) transfers.push(transfer);
      }
    }
    return transfers;
  }

  /**
   * @param {ZephyrTransferQuery} transferQuery - query to keep only specific transfers
   * @return {ZephyrTransfer[]} remaining transfers matching the query
   */
  filterTransfers(transferQuery: ZephyrTransferQuery): ZephyrTransfer[] {
    let transfers = [];
    
    // collect outgoing transfer or erase if filtered
    if (this.getOutgoingTransfer() && (!transferQuery || transferQuery.meetsCriteria(this.getOutgoingTransfer()))) transfers.push(this.getOutgoingTransfer());
    else this.setOutgoingTransfer(undefined);
    
    // collect incoming transfers or erase if filtered
    if (this.getIncomingTransfers() !== undefined) {
      let toRemoves = [];
      for (let transfer of this.getIncomingTransfers()) {
        if (transferQuery.meetsCriteria(transfer)) transfers.push(transfer);
        else toRemoves.push(transfer);
      }
      this.setIncomingTransfers(this.getIncomingTransfers().filter(function(transfer) {
        return !toRemoves.includes(transfer);
      }));
      if (this.getIncomingTransfers().length === 0) this.setIncomingTransfers(undefined);
    }
    
    return transfers;
  }
  
  /**
   * @return {ZephyrIncomingTransfer[]} incoming transfers
   */
  getIncomingTransfers(): ZephyrIncomingTransfer[] {
    return this.incomingTransfers;
  }
  
  /**
   * @param {ZephyrIncomingTransfer[]} incomingTransfers - incoming transfers
   * @return {ZephyrTxWallet} this tx for chaining
   */
  setIncomingTransfers(incomingTransfers: ZephyrIncomingTransfer[]): ZephyrTxWallet {
    this.incomingTransfers = incomingTransfers;
    return this;
  }
  
  /**
   * @return {ZephyrOutgoingTransfer} outgoing transfers
   */
  getOutgoingTransfer(): ZephyrOutgoingTransfer {
    return this.outgoingTransfer;
  }
  
  /**
   * @param {ZephyrOutgoingTransfer} outgoingTransfer - outgoing transfer
   * @return {ZephyrTxWallet} this tx for chaining
   */
  setOutgoingTransfer(outgoingTransfer: ZephyrOutgoingTransfer): ZephyrTxWallet {
    this.outgoingTransfer = outgoingTransfer;
    return this;
  }

  /**
   * @param {ZephyrOutputWallet[]} outputQuery - query to get specific inputs
   * @return {ZephyrOutputWallet[]} inputs matching the query
   */
  getInputsWallet(outputQuery?: ZephyrOutputQuery): ZephyrOutputWallet[] {
    let inputs: ZephyrOutputWallet[] = [];
    for (let output of super.getInputs()) if (!outputQuery || outputQuery.meetsCriteria(output as ZephyrOutputWallet)) inputs.push(output as ZephyrOutputWallet);
    return inputs;
  }

  /**
   * @param {ZephyrOutputWallet[]} inputs - tx inputs
   * @return {ZephyrTxWallet} this tx for chaining
   */
  setInputsWallet(inputs: ZephyrOutputWallet[]): ZephyrTxWallet {
    
    // validate that all inputs are wallet inputs
    if (inputs) {
      for (let output of inputs) {
        if (!(output instanceof ZephyrOutputWallet)) throw new ZephyrError("Wallet transaction inputs must be of type ZephyrOutputWallet");
      }
    }
    super.setInputs(inputs);
    return this;
  }
  
  /**
   * @param {ZephyrOutputQuery} [outputQuery] - query to get specific outputs
   * @return {ZephyrOutputWallet[]} outputs matching the query
   */
  getOutputsWallet(outputQuery?: ZephyrOutputQuery): ZephyrOutputWallet[] {
    let outputs = [];
    for (let output of super.getOutputs()) if (!outputQuery || outputQuery.meetsCriteria(output as ZephyrOutputWallet)) outputs.push(output);
    return outputs;
  }
  
  /**
   * @param {ZephyrOutputWallet[]} outputs - tx outputs
   * @return {ZephyrTxWallet} this tx for chaining
   */
  setOutputsWallet(outputs: ZephyrOutputWallet[]): ZephyrTxWallet {
    
    // validate that all outputs are wallet outputs
    if (outputs) {
      for (let output of outputs) {
        if (!(output instanceof ZephyrOutputWallet)) throw new ZephyrError("Wallet transaction outputs must be of type ZephyrOutputWallet");
      }
    }
    super.setOutputs(outputs);
    return this;
  }
  
  /**
   * @param {ZephyrOutputQuery} outputQuery - query to keep only specific outputs
   * @return {ZephyrTransfer[]} remaining outputs matching the query
   */
  filterOutputs(outputQuery: ZephyrOutputQuery): ZephyrTransfer[] {
    let outputs = [];
    if (super.getOutputs()) {
      let toRemoves = [];
      for (let output of super.getOutputs()) {
        if (!outputQuery || outputQuery.meetsCriteria(output as ZephyrOutputWallet)) outputs.push(output);
        else toRemoves.push(output);
      }
      this.setOutputs(super.getOutputs().filter(function(output) {
        return !toRemoves.includes(output);
      }));
      if (this.getOutputs().length === 0) this.setOutputs(undefined);
    }
    return outputs;
  }
  
  /**
   * @return {string} tx note
   */
  getNote(): string {
    return this.note;
  }
  
  /**
   * @param {string} note - tx note
   * @return {ZephyrTxWallet} this tx for chaining
   */
  setNote(note: string): ZephyrTxWallet {
    this.note = note;
    return this;
  }
  
  /**
   * @return {boolean} true if the tx is locked, false otherwise
   */
  getIsLocked(): boolean {
    return this.isLocked;
  }
  
  /**
   * @param {boolean} isLocked - true if the tx is locked, false otherwise
   * @return {ZephyrTxWallet} this tx for chaining
   */
  setIsLocked(isLocked: boolean): ZephyrTxWallet {
    this.isLocked = isLocked;
    return this;
  }
  
  /**
   * @return {bigint} sum of tx inputs
   */
  getInputSum(): bigint {
    return this.inputSum;
  }
  
  /**
   * @param {bigint} inputSum - sum of tx inputs
   * @return {ZephyrTxWallet} this tx for chaining
   */
  setInputSum(inputSum: bigint): ZephyrTxWallet {
    this.inputSum = inputSum;
    return this;
  }
  
  /**
   * @return {bigint} sum of tx outputs
   */
  getOutputSum(): bigint {
    return this.outputSum;
  }
  
  /**
   * @param {bigint} outputSum - sum of tx outputs
   * @return {ZephyrTxWallet} this tx for chaining
   */
  setOutputSum(outputSum: bigint): ZephyrTxWallet {
    this.outputSum = outputSum;
    return this;
  }
  
  /**
   * @return {string} change address
   */
  getChangeAddress(): string {
    return this.changeAddress;
  }
  
  /**
   * @param {string} changeAddress - change address
   * @return {ZephyrTxWallet} this tx for chaining
   */
  setChangeAddress(changeAddress: string): ZephyrTxWallet {
    this.changeAddress = changeAddress;
    return this;
  }
  
  /**
   * @return {bigint} change amount
   */
  getChangeAmount(): bigint {
    return this.changeAmount;
  }
  
  /**
   * @param {bigint} changeAmount - change amount
   * @return {ZephyrTxWallet} this tx for chaining
   */
  setChangeAmount(changeAmount: bigint): ZephyrTxWallet {
    this.changeAmount = changeAmount;
    return this;
  }
  
  /**
   * @return {number} number of dummy outputs
   */
  getNumDummyOutputs(): number {
    return this.numDummyOutputs;
  }
  
  /**
   * @param {number} numDummyOutputs - number of dummy outputs
   * @return {ZephyrTxWallet} this tx for chaining
   */
  setNumDummyOutputs(numDummyOutputs: number): ZephyrTxWallet {
    this.numDummyOutputs = numDummyOutputs;
    return this;
  }
  
  /**
   * @return {string} tx extra as hex
   */
  getExtraHex(): string {
    return this.extraHex;
  }
  
  /**
   * @param {string} extraHex - tx extra as hex
   * @return {ZephyrTxWallet} this tx for chaining
   */
  setExtraHex(extraHex: string): ZephyrTxWallet {
    this.extraHex = extraHex;
    return this;
  }
  
  /**
   * @return {ZephyrTxWallet} a copy of this tx
   */
  copy(): ZephyrTxWallet {
    return new ZephyrTxWallet(this);
  }
  
  /**
   * Updates this transaction by merging the latest information from the given
   * transaction.
   * 
   * Merging can modify or build references to the transaction given so it
   * should not be re-used or it should be copied before calling this method.
   * 
   * @param {ZephyrTxWallet} tx - the transaction to merge into this transaction
   */
  merge(tx: ZephyrTxWallet): ZephyrTxWallet {
    assert(tx instanceof ZephyrTxWallet);
    if (this === tx) return this;
    
    // merge base classes
    super.merge(tx);
    
    // merge tx set if they're different which comes back to merging txs
    //import ZephyrTxSet from "./ZephyrTxSet";
    if (this.getTxSet() !== tx.getTxSet()) {
      if (this.getTxSet() == undefined) {
        this.setTxSet(new ZephyrTxSet().setTxs([this]));
      }
      if (tx.getTxSet() === undefined) {
        tx.setTxSet(new ZephyrTxSet().setTxs([tx]));
      }
      this.getTxSet().merge(tx.getTxSet());
      return this;
    }
    
    // merge incoming transfers
    if (tx.getIncomingTransfers()) {
      if (this.getIncomingTransfers() === undefined) this.setIncomingTransfers([]);
      for (let transfer of tx.getIncomingTransfers()) {
        transfer.setTx(this);
        ZephyrTxWallet.mergeIncomingTransfer(this.getIncomingTransfers(), transfer);
      }
    }
    
    // merge outgoing transfer
    if (tx.getOutgoingTransfer()) {
      tx.getOutgoingTransfer().setTx(this);
      if (this.getOutgoingTransfer() === undefined) this.setOutgoingTransfer(tx.getOutgoingTransfer());
      else this.getOutgoingTransfer().merge(tx.getOutgoingTransfer());
    }
    
    // merge simple extensions
    this.setIsIncoming(GenUtils.reconcile(this.getIsIncoming(), tx.getIsIncoming(), {resolveTrue: true}));  // outputs seen on confirmation
    this.setIsOutgoing(GenUtils.reconcile(this.getIsOutgoing(), tx.getIsOutgoing()));
    this.setNote(GenUtils.reconcile(this.getNote(), tx.getNote()));
    this.setIsLocked(GenUtils.reconcile(this.getIsLocked(), tx.getIsLocked(), {resolveTrue: false})); // tx can become unlocked
    this.setInputSum(GenUtils.reconcile(this.getInputSum(), tx.getInputSum()));
    this.setOutputSum(GenUtils.reconcile(this.getOutputSum(), tx.getOutputSum()));
    this.setChangeAddress(GenUtils.reconcile(this.getChangeAddress(), tx.getChangeAddress()));
    this.setChangeAmount(GenUtils.reconcile(this.getChangeAmount(), tx.getChangeAmount()));
    this.setNumDummyOutputs(GenUtils.reconcile(this.getNumDummyOutputs(), tx.getNumDummyOutputs()));
    this.setExtraHex(GenUtils.reconcile(this.getExtraHex(), tx.getExtraHex()));
    
    return this;  // for chaining
  }
  
  /**
   * @param {number} [indent] - starting indentation
   * @param {boolean} [oneLine] - string is one line if true, multiple lines if false
   * @return {string} string representation of this tx
   */
  toString(indent = 0, oneLine = false): string {
    let str = "";
    
    // represent tx with one line string
    // TODO: proper csv export
    if (oneLine) {
      str += this.getHash() + ", ";
      str += (this.getIsConfirmed() ? this.getBlock().getTimestamp() : this.getReceivedTimestamp()) + ", ";
      str += this.getIsConfirmed() + ", ";
      str += (this.getOutgoingAmount() ? this.getOutgoingAmount().toString() : "") + ", ";
      str += this.getIncomingAmount() ? this.getIncomingAmount().toString() : "";
      return str;
    }
    
    // otherwise stringify all fields
    str += super.toString(indent) + "\n";
    str += GenUtils.kvLine("Is incoming", this.getIsIncoming(), indent);
    str += GenUtils.kvLine("Incoming amount", this.getIncomingAmount(), indent);
    if (this.getIncomingTransfers() !== undefined) {
      str += GenUtils.kvLine("Incoming transfers", "", indent);
      for (let i = 0; i < this.getIncomingTransfers().length; i++) {
        str += GenUtils.kvLine(i + 1, "", indent + 1);
        str += this.getIncomingTransfers()[i].toString(indent + 2) + "\n";
      }
    }
    str += GenUtils.kvLine("Is outgoing", this.getIsOutgoing(), indent);
    str += GenUtils.kvLine("Outgoing amount", this.getOutgoingAmount(), indent);
    if (this.getOutgoingTransfer() !== undefined) {
      str += GenUtils.kvLine("Outgoing transfer", "", indent);
      str += this.getOutgoingTransfer().toString(indent + 1) + "\n";
    }
    str += GenUtils.kvLine("Note", this.getNote(), indent);
    str += GenUtils.kvLine("Is locked", this.getIsLocked(), indent);
    str += GenUtils.kvLine("Input sum", this.getInputSum(), indent);
    str += GenUtils.kvLine("Output sum", this.getOutputSum(), indent);
    str += GenUtils.kvLine("Change address", this.getChangeAddress(), indent);
    str += GenUtils.kvLine("Change amount", this.getChangeAmount(), indent);
    str += GenUtils.kvLine("Num dummy outputs", this.getNumDummyOutputs(), indent);
    str += GenUtils.kvLine("Extra hex", this.getExtraHex(), indent);
    return str.slice(0, str.length - 1);  // strip last newline
  }
  
  // private helper to merge transfers
  protected static mergeIncomingTransfer(transfers, transfer) {
    for (let aTransfer of transfers) {
      if (aTransfer.getAccountIndex() === transfer.getAccountIndex() && aTransfer.getSubaddressIndex() === transfer.getSubaddressIndex()) {
        aTransfer.merge(transfer);
        return;
      }
    }
    transfers.push(transfer);
  }

  // -------------------- OVERRIDE COVARIANT RETURN TYPES ---------------------

  setBlock(block: ZephyrBlock): ZephyrTxWallet {
    super.setBlock(block);
    return this;
  }

  setHash(hash: string): ZephyrTxWallet {
    super.setHash(hash);
    return this;
  }

  setVersion(version: number): ZephyrTxWallet {
    super.setVersion(version);
    return this;
  }

  setIsMinerTx(isMinerTx: boolean): ZephyrTxWallet {
    super.setIsMinerTx(isMinerTx);
    return this;
  }

  setPaymentId(paymentId: string): ZephyrTxWallet {
    super.setPaymentId(paymentId);
    return this;
  }

  setFee(fee: bigint): ZephyrTxWallet {
    super.setFee(fee);
    return this;
  }

  setRingSize(ringSize: number): ZephyrTxWallet {
    super.setRingSize(ringSize);
    return this;
  }

  setRelay(relay: boolean): ZephyrTxWallet {
    super.setRelay(relay);
    return this;
  }

  setIsRelayed(isRelayed: boolean): ZephyrTxWallet {
    super.setIsRelayed(isRelayed);
    return this;
  }

  setIsConfirmed(isConfirmed: boolean): ZephyrTxWallet {
    super.setIsConfirmed(isConfirmed);
    return this;
  }

  setInTxPool(inTxPool: boolean): ZephyrTxWallet {
    super.setInTxPool(inTxPool);
    return this;
  }

  setNumConfirmations(numConfirmations: number): ZephyrTxWallet {
    super.setNumConfirmations(numConfirmations);
    return this;
  }

  setUnlockTime(unlockTime: bigint): ZephyrTxWallet {
    super.setUnlockTime(unlockTime);
    return this;
  }

  setLastRelayedTimestamp(lastRelayedTimestamp: number): ZephyrTxWallet {
    super.setLastRelayedTimestamp(lastRelayedTimestamp);
    return this;
  }

  setReceivedTimestamp(receivedTimestamp: number): ZephyrTxWallet {
    super.setReceivedTimestamp(receivedTimestamp);
    return this;
  }

  setIsDoubleSpendSeen(isDoubleSpendSeen: boolean): ZephyrTxWallet {
    super.setIsDoubleSpendSeen(isDoubleSpendSeen);
    return this;
  }

  setKey(key: string): ZephyrTxWallet {
    super.setKey(key);
    return this;
  }

  setFullHex(fullHex: string): ZephyrTxWallet {
    super.setFullHex(fullHex);
    return this;
  }

  setPrunedHex(prunedHex: string): ZephyrTxWallet {
    super.setPrunedHex(prunedHex);
    return this;
  }

  setPrunableHex(prunableHex: string): ZephyrTxWallet {
    super.setPrunableHex(prunableHex);
    return this;
  }

  setPrunableHash(prunableHash: string): ZephyrTxWallet {
    super.setPrunableHash(prunableHash);
    return this;
  }

  setSize(size: number): ZephyrTxWallet {
    super.setSize(size);
    return this;
  }

  setWeight(weight: number): ZephyrTxWallet {
    super.setWeight(weight);
    return this;
  }

  setInputs(inputs: ZephyrOutput[]): ZephyrTxWallet {
    super.setInputs(inputs);
    return this;
  }

  setOutputs(outputs: ZephyrOutput[]): ZephyrTxWallet {
    super.setOutputs(outputs);
    return this;
  }

  setOutputIndices(outputIndices: number[]): ZephyrTxWallet {
    super.setOutputIndices(outputIndices);
    return this;
  }

  setMetadata(metadata: string): ZephyrTxWallet {
    super.setMetadata(metadata);
    return this;
  }

  setExtra(extra: Uint8Array): ZephyrTxWallet {
    super.setExtra(extra);
    return this;
  }

  setRctSignatures(rctSignatures: any): ZephyrTxWallet {
    super.setRctSignatures(rctSignatures);
    return this;
  }

  setRctSigPrunable(rctSigPrunable: any): ZephyrTxWallet {
    super.setRctSigPrunable(rctSigPrunable);
    return this;
  }

  setIsKeptByBlock(isKeptByBlock: boolean): ZephyrTxWallet {
    super.setIsKeptByBlock(isKeptByBlock);
    return this;
  }

  setIsFailed(isFailed: boolean): ZephyrTxWallet {
    super.setIsFailed(isFailed);
    return this;
  }

  setLastFailedHeight(lastFailedHeight: number): ZephyrTxWallet {
    super.setLastFailedHeight(lastFailedHeight);
    return this;
  }

  setLastFailedHash(lastFailedHash: string): ZephyrTxWallet {
    super.setLastFailedHash(lastFailedHash);
    return this;
  }

  setMaxUsedBlockHeight(maxUsedBlockHeight: number): ZephyrTxWallet {
    super.setMaxUsedBlockHeight(maxUsedBlockHeight);
    return this;
  }

  setMaxUsedBlockHash(maxUsedBlockHash: string): ZephyrTxWallet {
    super.setMaxUsedBlockHash(maxUsedBlockHash);
    return this;
  }

  setSignatures(signatures: string[]): ZephyrTxWallet {
    super.setSignatures(signatures);
    return this;
  }
}
