/**
 * Base class for results from checking a transaction or reserve proof.
 */
export default class ZephyrCheck {

  isGood?: boolean;
  
  constructor(check?: Partial<ZephyrCheck>) {
    Object.assign(this, check);
  }

  getIsGood(): boolean {
    return this.isGood;
  }

  setIsGood(isGood: boolean): ZephyrCheck {
    this.isGood = isGood;
    return this;
  }
}
