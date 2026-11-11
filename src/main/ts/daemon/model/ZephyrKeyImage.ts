import assert from "assert";
import GenUtils from "../../common/GenUtils";
import ZephyrError from "../../common/ZephyrError";

/**
 * Models a Monero key image.
 */
export default class ZephyrKeyImage {
  
  hex: string;
  signature: string;
  
  /**
   * Construct the model.
   * 
   * @param {string|Partial<ZephyrKeyImage>} [keyImageOrHex] is a ZephyrKeyImage or hex string to initialize from (optional)
   * @param {string} [signature] is the key image's signature
   */
  constructor(hexOrKeyImage?: string | Partial<ZephyrKeyImage>, signature?: string) {
    if (typeof hexOrKeyImage === "string") {
      this.setHex(hexOrKeyImage);
      this.setSignature(signature);
    } else {
      Object.assign(this, hexOrKeyImage);
    }
  }

  getHex(): string {
    return this.hex;
  }

  setHex(hex: string): ZephyrKeyImage {
    this.hex = hex;
    return this;
  }

  getSignature(): string {
    return this.signature;
  }

  setSignature(signature: string): ZephyrKeyImage {
    this.signature = signature;
    return this;
  }
  
  copy(): ZephyrKeyImage {
    return new ZephyrKeyImage(this);
  }
  
  toJson() {
    return Object.assign({}, this);
  }
  
  merge(keyImage: ZephyrKeyImage): ZephyrKeyImage {
    assert(keyImage instanceof ZephyrKeyImage);
    if (keyImage === this) return this;
    this.setHex(GenUtils.reconcile(this.getHex(), keyImage.getHex()));
    this.setSignature(GenUtils.reconcile(this.getSignature(), keyImage.getSignature()));
    return this;
  }
  
  toString(indent = 0): string {
    let str = "";
    str += GenUtils.kvLine("Hex", this.getHex(), indent);
    str += GenUtils.kvLine("Signature", this.getSignature(), indent);
    return str.slice(0, str.length - 1);  // strip last newline
  }
}
