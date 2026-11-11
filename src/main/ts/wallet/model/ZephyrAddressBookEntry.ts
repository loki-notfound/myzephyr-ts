/**
 * Monero address book entry model
 */
export default class ZephyrAddressBookEntry {

  index: number;
  address: string;
  description: string;
  paymentId: string;
  
  constructor(entry?: Partial<ZephyrAddressBookEntry>) {
    Object.assign(this, entry);
  }
  
  toJson(): any {
    return Object.assign({}, this);
  }
  
  getIndex(): number {
    return this.index;
  }
  
  setIndex(index: number): ZephyrAddressBookEntry {
    this.index = index;
    return this;
  }
  
  getAddress(): string {
    return this.address;
  }
  
  setAddress(address: string): ZephyrAddressBookEntry {
    this.address = address;
    return this;
  }
  
  getDescription(): string {
    return this.description;
  }
  
  setDescription(description: string): ZephyrAddressBookEntry {
    this.description = description;
    return this;
  }
  
  getPaymentId(): string {
    return this.paymentId;
  }
  
  setPaymentId(paymentId: string): ZephyrAddressBookEntry {
    this.paymentId = paymentId;
    return this;
  }
}
