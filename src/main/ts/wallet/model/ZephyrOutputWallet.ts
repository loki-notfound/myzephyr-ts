import assert from "assert";
import GenUtils from "../../common/GenUtils";
import ZephyrError from "../../common/ZephyrError";
import ZephyrKeyImage from "../../daemon/model/ZephyrKeyImage";
import ZephyrOutput from "../../daemon/model/ZephyrOutput";
import ZephyrTx from "../../daemon/model/ZephyrTx";
import ZephyrTxWallet from "./ZephyrTxWallet";

/**
 * Models a Monero output with wallet extensions.
 */
export default class ZephyrOutputWallet extends ZephyrOutput {

  accountIndex: number;
  subaddressIndex: number;
  isSpent: boolean;
  isFrozen: boolean;
  isLocked: boolean;

  /**
   * Construct the model.
   * 
   * @param {ZephyrOutputWallet} [output] is existing state to initialize from (optional)
   */
  constructor(output?: Partial<ZephyrOutputWallet>) {
    super(output);
  }

  getTx(): ZephyrTxWallet {
    return super.getTx() as ZephyrTxWallet;
  }
  
  setTx(tx: ZephyrTx): ZephyrOutputWallet {
    if (tx !== undefined && !(tx instanceof ZephyrTxWallet)) throw new ZephyrError("Wallet output's transaction must be of type ZephyrTxWallet");
    super.setTx(tx);
    return this;
  }
  
  getAccountIndex(): number {
    return this.accountIndex;
  }

  setAccountIndex(accountIndex: number): ZephyrOutputWallet {
    this.accountIndex = accountIndex;
    return this;
  }

  getSubaddressIndex(): number {
    return this.subaddressIndex;
  }

  setSubaddressIndex(subaddressIndex: number): ZephyrOutputWallet {
    this.subaddressIndex = subaddressIndex;
    return this;
  }
  
  getIsSpent(): boolean {
    return this.isSpent;
  }

  setIsSpent(isSpent: boolean): ZephyrOutputWallet {
    this.isSpent = isSpent;
    return this;
  }
  
  /**
   * Indicates if this output has been deemed 'malicious' and will therefore
   * not be spent by the wallet.
   * 
   * @return Boolean is whether or not this output is frozen
   */
  getIsFrozen(): boolean {
    return this.isFrozen;
  }

  setIsFrozen(isFrozen: boolean): ZephyrOutputWallet {
    this.isFrozen = isFrozen;
    return this;
  }
  
  getIsLocked(): boolean {
    if (this.getTx() === undefined) return undefined;
    return (this.getTx() as ZephyrTxWallet).getIsLocked();
  }
  
  copy(): ZephyrOutputWallet {
    return new ZephyrOutputWallet(this.toJson());
  }
  
  toJson(): any {
    let json: any = Object.assign({}, this, super.toJson());
    delete json.tx;
    return json;
  }
  
  /**
   * Updates this output by merging the latest information from the given
   * output.
   * 
   * Merging can modify or build references to the output given so it
   * should not be re-used or it should be copied before calling this method.
   * 
   * @param output is the output to merge into this one
   */
  merge(output: ZephyrOutputWallet): ZephyrOutputWallet {
    assert(output instanceof ZephyrOutputWallet);
    if (this === output) return;
    super.merge(output);
    this.setAccountIndex(GenUtils.reconcile(this.getAccountIndex(), output.getAccountIndex()));
    this.setSubaddressIndex(GenUtils.reconcile(this.getSubaddressIndex(), output.getSubaddressIndex()));
    this.setIsSpent(GenUtils.reconcile(this.getIsSpent(), output.getIsSpent(), {resolveTrue: true})); // output can become spent
    this.setIsFrozen(GenUtils.reconcile(this.getIsFrozen(), output.getIsFrozen()));
    return this;
  }
  
  toString(indent = 0): string {
    let str = super.toString(indent) + "\n"
    str += GenUtils.kvLine("Account index", this.getAccountIndex(), indent);
    str += GenUtils.kvLine("Subaddress index", this.getSubaddressIndex(), indent);
    str += GenUtils.kvLine("Is spent", this.getIsSpent(), indent);
    str += GenUtils.kvLine("Is frozen", this.getIsFrozen(), indent);
    return str.slice(0, str.length - 1);  // strip last newline
  }

  // -------------------- OVERRIDE COVARIANT RETURN TYPES ---------------------

  setKeyImage(keyImage: ZephyrKeyImage): ZephyrOutputWallet {
    super.setKeyImage(keyImage);
    return this;
  }
  
  setAmount(amount: bigint): ZephyrOutputWallet {
    super.setAmount(amount);
    return this;
  }
  
  setIndex(index: number): ZephyrOutputWallet {
    super.setIndex(index);
    return this;
  }
  
  setRingOutputIndices(ringOutputIndices: number[]): ZephyrOutputWallet {
    super.setRingOutputIndices(ringOutputIndices);
    return this;
  }
  
  setStealthPublicKey(stealthPublicKey: string): ZephyrOutputWallet {
    super.setStealthPublicKey(stealthPublicKey);
    return this;
  }
}
