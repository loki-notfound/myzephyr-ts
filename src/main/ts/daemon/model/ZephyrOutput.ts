import assert from "assert";
import GenUtils from "../../common/GenUtils";
import ZephyrError from "../../common/ZephyrError";
import ZephyrKeyImage from "./ZephyrKeyImage";
import ZephyrTx from "./ZephyrTx";

/**
 * Models a Monero transaction output.
 */
export default class ZephyrOutput {

  tx: ZephyrTx;
  keyImage: Partial<ZephyrKeyImage>;
  amount: bigint;
  index: number;
  ringOutputIndices: number[];
  stealthPublicKey: string;
  
  /**
   * Construct the model.
   * 
   * @param {ZephyrOutput} [output] is existing state to initialize from (optional)
   */
  constructor(output?: Partial<ZephyrOutput>) {
    Object.assign(this, output);

    // deserialize fields if necessary
    if (this.amount !== undefined && typeof this.amount !== "bigint") this.amount = BigInt(this.amount);
    if (this.keyImage) this.keyImage = this.keyImage instanceof ZephyrKeyImage ? this.keyImage.copy() : new ZephyrKeyImage(this.keyImage);
  }
  
  getTx(): ZephyrTx {
    return this.tx;
  }
  
  setTx(tx: ZephyrTx): ZephyrOutput {
    this.tx = tx;
    return this;
  }
  
  getKeyImage(): ZephyrKeyImage {
    return this.keyImage as ZephyrKeyImage;
  }

  setKeyImage(keyImage: ZephyrKeyImage): ZephyrOutput {
    this.keyImage = keyImage === undefined ? undefined : keyImage instanceof ZephyrKeyImage ? keyImage : new ZephyrKeyImage(keyImage);
    return this;
  }
  
  getAmount(): bigint {
    return this.amount;
  }

  setAmount(amount: bigint): ZephyrOutput {
    this.amount = amount;
    return this;
  }
  
  getIndex(): number {
    return this.index;
  }
  
  setIndex(index: number): ZephyrOutput {
    this.index = index;
    return this;
  }
  
  getRingOutputIndices(): number[] {
    return this.ringOutputIndices;
  }
  
  setRingOutputIndices(ringOutputIndices: number[]): ZephyrOutput {
    this.ringOutputIndices = ringOutputIndices;
    return this;
  }
  
  getStealthPublicKey(): string {
    return this.stealthPublicKey;
  }
  
  setStealthPublicKey(stealthPublicKey: string): ZephyrOutput {
    this.stealthPublicKey = stealthPublicKey;
    return this;
  }
  
  copy(): ZephyrOutput {
    return new ZephyrOutput(this);
  }
  
  toJson(): any {
    let json: any = Object.assign({}, this);
    if (this.getAmount() !== undefined) json.amount = this.getAmount().toString();
    if (this.getKeyImage() !== undefined) json.keyImage = this.getKeyImage() ? this.getKeyImage().toJson() : undefined;
    delete json.tx;
    return json;
  }
  
  merge(output: ZephyrOutput): ZephyrOutput {
    assert(output instanceof ZephyrOutput);
    if (this === output) return this;
    
    // merge txs if they're different which comes back to merging outputs
    if (this.getTx() !== output.getTx()) this.getTx().merge(output.getTx());
    
    // otherwise merge output fields
    else {
      if (this.getKeyImage() === undefined) this.setKeyImage(output.getKeyImage());
      else if (output.getKeyImage() !== undefined) this.getKeyImage().merge(output.getKeyImage());
      this.setAmount(GenUtils.reconcile(this.getAmount(), output.getAmount()));
      this.setIndex(GenUtils.reconcile(this.getIndex(), output.getIndex()));
    }

    return this;
  }
  
  toString(indent = 0): string {
    let str = "";
    if (this.getKeyImage() !== undefined) {
      str += GenUtils.kvLine("Key image", "", indent);
      str += this.getKeyImage().toString(indent + 1) + "\n";
    }
    str += GenUtils.kvLine("Amount", this.getAmount(), indent);
    str += GenUtils.kvLine("Index", this.getIndex(), indent);
    str += GenUtils.kvLine("Ring output indices", this.getRingOutputIndices(), indent);
    str += GenUtils.kvLine("Stealth public key", this.getStealthPublicKey(), indent);
    return str === "" ? str : str.slice(0, str.length - 1);  // strip last newline
  }
}