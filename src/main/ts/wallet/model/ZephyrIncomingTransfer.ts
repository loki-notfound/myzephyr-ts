import assert from "assert";
import GenUtils from "../../common/GenUtils";
import ZephyrTransfer from "./ZephyrTransfer";
import ZephyrTxWallet from "./ZephyrTxWallet";

/**
 * Models an incoming transfer of funds to the wallet.
 */
export default class ZephyrIncomingTransfer extends ZephyrTransfer {

  subaddressIndex: number;
  address: string;
  numSuggestedConfirmations: number;
  
  /**
   * Construct the transfer.
   * 
   * @param {ZephyrTransfer} [transfer] is existing state to initialize from (optional)
   */
  constructor(transfer?: Partial<ZephyrIncomingTransfer>) {
    super(transfer);
  }
  
  getIsIncoming(): boolean {
    return true;
  }
  
  getSubaddressIndex(): number {
    return this.subaddressIndex;
  }
  
  setSubaddressIndex(subaddressIndex: number): ZephyrIncomingTransfer {
    this.subaddressIndex = subaddressIndex;
    return this;
  }
  
  getAddress(): string {
    return this.address;
  }

  setAddress(address: string): ZephyrIncomingTransfer {
    this.address = address;
    return this;
  }
  
  /**
   * Return how many confirmations till it's not economically worth re-writing the chain.
   * That is, the number of confirmations before the transaction is highly unlikely to be
   * double spent or overwritten and may be considered settled, e.g. for a merchant to trust
   * as finalized.
   * 
   * @return {number} is the number of confirmations before it's not worth rewriting the chain
   */
  getNumSuggestedConfirmations(): number {
    return this.numSuggestedConfirmations;
  }
  
  setNumSuggestedConfirmations(numSuggestedConfirmations: number): ZephyrIncomingTransfer {
    this.numSuggestedConfirmations = numSuggestedConfirmations;
    return this;
  }

  copy(): ZephyrIncomingTransfer {
    return new ZephyrIncomingTransfer(this.toJson());
  }
  
  /**
   * Updates this transaction by merging the latest information from the given
   * transaction.
   * 
   * Merging can modify or build references to the transfer given so it
   * should not be re-used or it should be copied before calling this method.
   * 
   * @param {ZephyrIncomingTransfer} transfer is the transfer to merge into this one
   * @return {ZephyrIncomingTransfer}
   */
  merge(transfer: ZephyrIncomingTransfer): ZephyrIncomingTransfer {
    super.merge(transfer);
    assert(transfer instanceof ZephyrIncomingTransfer);
    if (this === transfer) return this;
    this.setSubaddressIndex(GenUtils.reconcile(this.getSubaddressIndex(), transfer.getSubaddressIndex()));
    this.setAddress(GenUtils.reconcile(this.getAddress(), transfer.getAddress()));
    this.setNumSuggestedConfirmations(GenUtils.reconcile(this.getNumSuggestedConfirmations(), transfer.getNumSuggestedConfirmations(), {resolveMax: false}));
    return this;
  }
  
  toString(indent = 0) {
    let str = super.toString(indent) + "\n";
    str += GenUtils.kvLine("Subaddress index", this.getSubaddressIndex(), indent);
    str += GenUtils.kvLine("Address", this.getAddress(), indent);
    str += GenUtils.kvLine("Num suggested confirmations", this.getNumSuggestedConfirmations(), indent);
    return str.slice(0, str.length - 1);  // strip last newline
  }

  // -------------------- OVERRIDE COVARIANT RETURN TYPES ---------------------

  setTx(tx: ZephyrTxWallet): ZephyrIncomingTransfer {
    super.setTx(tx);
    return this;
  }
  
  setAmount(amount: bigint): ZephyrIncomingTransfer {
    super.setAmount(amount);
    return this;
  }
  
  setAccountIndex(accountIndex: number): ZephyrIncomingTransfer {
    super.setAccountIndex(accountIndex);
    return this;
  }
}
