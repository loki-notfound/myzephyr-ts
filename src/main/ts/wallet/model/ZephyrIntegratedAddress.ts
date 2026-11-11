/**
 * Zephyr integrated address model.
 */
export default class ZephyrIntegratedAddress {
  
  standardAddress: string;
  paymentId: string;
  integratedAddress: string;
  
  constructor(integratedAddress?: Partial<ZephyrIntegratedAddress>) {
    Object.assign(this, integratedAddress);
  }
  
  toJson(): any {
    return Object.assign({}, this);
  }

  getStandardAddress(): string {
    return this.standardAddress;
  }
  
  setStandardAddress(standardAddress: string): ZephyrIntegratedAddress {
    this.standardAddress = standardAddress;
    return this;
  }
  
  getPaymentId(): string {
    return this.paymentId;
  }
  
  setPaymentId(paymentId: string): ZephyrIntegratedAddress {
    this.paymentId = paymentId;
    return this;
  }
  
  getIntegratedAddress(): string {
    return this.integratedAddress;
  }
  
  setIntegratedAddress(integratedAddress: string): ZephyrIntegratedAddress {
    this.integratedAddress = integratedAddress;
    return this;
  }
  
  toString(): string {
    return this.integratedAddress;
  }
}
