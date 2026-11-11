/**
 * Models the result from submitting a tx to a daemon.
 */
export default class ZephyrSubmitTxResult {

  isGood: boolean;
  isRelayed: boolean;
  isDoubleSpendSeen: boolean;
  isFeeTooLow: boolean;
  isMixinTooLow: boolean;
  hasInvalidInput: boolean;
  hasInvalidOutput: boolean;
  hasTooFewOutputs: boolean;
  isOverspend: boolean;
  reason: string;
  isTooBig: boolean;
  sanityCheckFailed: boolean;
  credits: bigint;
  topBlockHash: string;
  isTxExtraTooBig: boolean;
  isNonzeroUnlockTime: boolean;
  
  constructor(result?: Partial<ZephyrSubmitTxResult>) {
    Object.assign(this, result);
    if (this.credits !== undefined && typeof this.credits !== "bigint") this.credits = BigInt(this.credits);
  }
  
  toJson(): any {
    let json: any = Object.assign({}, this);
    if (json.credits !== undefined) json.credits = json.credits.toString();
    return json;
  }
  
  getIsGood(): boolean {
    return this.isGood;
  }
  
  setIsGood(isGood: boolean): ZephyrSubmitTxResult {
    this.isGood = isGood;
    return this;
  }
  
  getIsRelayed(): boolean {
    return this.isRelayed;
  }
  
  setIsRelayed(isRelayed: boolean) {
    this.isRelayed = isRelayed;
    return this;
  }
  
  getIsDoubleSpendSeen(): boolean {
    return this.isDoubleSpendSeen;
  }
  
  setIsDoubleSpendSeen(isDoubleSpendSeen: boolean): ZephyrSubmitTxResult {
    this.isDoubleSpendSeen = isDoubleSpendSeen
    return this;
  }
  
  getIsFeeTooLow(): boolean {
    return this.isFeeTooLow;
  }
  
  setIsFeeTooLow(isFeeTooLow: boolean): ZephyrSubmitTxResult {
    this.isFeeTooLow = isFeeTooLow;
    return this;
  }
  
  getIsMixinTooLow(): boolean {
    return this.isMixinTooLow;
  }
  
  setIsMixinTooLow(isMixinTooLow: boolean): ZephyrSubmitTxResult {
    this.isMixinTooLow = isMixinTooLow;
    return this;
  }
  
  getHasInvalidInput(): boolean {
    return this.hasInvalidInput;
  }
  
  setHasInvalidInput(hasInvalidInput: boolean): ZephyrSubmitTxResult {
    this.hasInvalidInput = hasInvalidInput;
    return this;
  }
  
  getHasInvalidOutput(): boolean {
    return this.hasInvalidOutput;
  }
  
  setHasInvalidOutput(hasInvalidOutput: boolean): ZephyrSubmitTxResult {
    this.hasInvalidOutput = hasInvalidOutput;
    return this;
  }
  
  getHasTooFewOutputs(): boolean {
    return this.hasTooFewOutputs;
  }
  
  setHasTooFewOutputs(hasTooFewOutputs: boolean): ZephyrSubmitTxResult {
    this.hasTooFewOutputs = hasTooFewOutputs;
    return this;
  }
  
  getIsOverspend(): boolean {
    return this.isOverspend;
  }
  
  setIsOverspend(isOverspend: boolean): ZephyrSubmitTxResult {
    this.isOverspend = isOverspend;
    return this;
  }
  
  getReason(): string {
    return this.reason;
  }
  
  setReason(reason): ZephyrSubmitTxResult {
    this.reason = reason;
    return this;
  }
  
  getIsTooBig(): boolean {
    return this.isTooBig;
  }
  
  setIsTooBig(isTooBig: boolean) {
    this.isTooBig = isTooBig;
    return this;
  }
  
  getSanityCheckFailed(): boolean {
    return this.sanityCheckFailed;
  }
  
  setSanityCheckFailed(sanityCheckFailed): ZephyrSubmitTxResult {
    this.sanityCheckFailed = sanityCheckFailed;
    return this;
  }
  
  getCredits(): bigint {
    return this.credits;
  }
  
  setCredits(credits): ZephyrSubmitTxResult {
    this.credits = credits;
    return this;
  }
  
  getTopBlockHash(): string {
    return this.topBlockHash;
  }
  
  setTopBlockHash(topBlockHash: string): ZephyrSubmitTxResult {
    this.topBlockHash = topBlockHash;
    return this;
  }

  getIsTxExtraTooBig(): boolean {
    return this.isTxExtraTooBig;
  }
  
  setIsTxExtraTooBig(isTxExtraTooBig: boolean): ZephyrSubmitTxResult {
    this.isTxExtraTooBig = isTxExtraTooBig;
    return this;
  }

  getIsNonzeroUnlockTime(): boolean {
    return this.isNonzeroUnlockTime;
  }
  
  setIsNonzeroUnlockTime(isNonzeroUnlockTime: boolean): ZephyrSubmitTxResult {
    this.isNonzeroUnlockTime = isNonzeroUnlockTime;
    return this;
  }
}
