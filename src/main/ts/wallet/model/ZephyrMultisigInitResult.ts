/**
 * Models the result of initializing a multisig wallet which results in the
 * multisig wallet's address xor another multisig hex to share with
 * participants to create the wallet.
 */
export default class ZephyrMultisigInitResult {

  address: string;
  multisigHex: string;

  constructor(result?: Partial<ZephyrMultisigInitResult>) {
    Object.assign(this, result);
  }
  
  toJson(): any {
    return Object.assign({}, this);
  }
  
  getAddress(): string {
    return this.address;
  }
  
  setAddress(address: string): ZephyrMultisigInitResult {
    this.address = address;
    return this;
  }
  
  getMultisigHex(): string {
    return this.multisigHex;
  }
  
  setMultisigHex(multisigHex: string): ZephyrMultisigInitResult {
    this.multisigHex = multisigHex;
    return this;
  }
}
