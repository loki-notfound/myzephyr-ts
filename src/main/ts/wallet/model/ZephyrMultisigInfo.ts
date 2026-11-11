/**
 * Models information about a multisig wallet.
 */
export default class ZephyrMultisigInfo {

  isMultisig: boolean;
  isReady: boolean;
  threshold: number;
  numParticipants: number;
  
  constructor(multisigInfo?: Partial<ZephyrMultisigInfo>) {
    Object.assign(this, multisigInfo);
  }
  
  toJson(): any {
    return Object.assign({}, this);
  }
  
  getIsMultisig(): boolean {
    return this.isMultisig;
  }
  
  setIsMultisig(isMultisig: boolean): ZephyrMultisigInfo {
    this.isMultisig = isMultisig;
    return this;
  }
  
  getIsReady(): boolean {
    return this.isReady;
  }
  
  setIsReady(isReady: boolean): ZephyrMultisigInfo {
    this.isReady = isReady;
    return this;
  }
  
  getThreshold(): number {
    return this.threshold;
  }
  
  setThreshold(threshold: number): ZephyrMultisigInfo {
    this.threshold = threshold;
    return this;
  }
  
  getNumParticipants(): number {
    return this.numParticipants;
  }
  
  setNumParticipants(numParticipants: number): ZephyrMultisigInfo {
    this.numParticipants = numParticipants;
    return this;
  }
}
