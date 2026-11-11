import ZephyrMessageSignatureType from "./ZephyrMessageSignatureType";

/**
 * Message signature verification result.
 */
export default class ZephyrMessageSignatureResult {

  isGood: boolean;
  isOld: boolean;
  signatureType: ZephyrMessageSignatureType;
  version: number;
  
  constructor(result?: Partial<ZephyrMessageSignatureResult>) {
    Object.assign(this, result);
  }
  
  toJson(): any {
    return Object.assign({}, this);
  }

  getIsGood(): boolean {
    return this.isGood;
  }

  setIsGood(isGood: boolean): ZephyrMessageSignatureResult {
    this.isGood = isGood;
    return this;
  }
  
  getIsOld(): boolean {
    return this.isOld;
  }

  setIsOld(isOld: boolean): ZephyrMessageSignatureResult {
    this.isOld = isOld;
    return this;
  }
  
  getSignatureType(): ZephyrMessageSignatureType {
    return this.signatureType;
  }

  setSignatureType(signatureType: ZephyrMessageSignatureType): ZephyrMessageSignatureResult {
    this.signatureType = signatureType;
    return this;
  }
  
  getVersion(): number {
    return this.version;
  }

  setVersion(version: number): ZephyrMessageSignatureResult {
    this.version = version;
    return this;
  }

}