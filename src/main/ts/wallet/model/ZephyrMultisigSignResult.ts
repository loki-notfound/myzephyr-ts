/**
 * Models the result of signing multisig tx hex.
 */
export default class ZephyrMultisigSignResult {

  signedMultisigTxHex: string;
  txHashes: string[];
  
  constructor(result?: Partial<ZephyrMultisigSignResult>) {
    Object.assign(this, result);
  }
  
  toJson(): any {
    return Object.assign({}, this);
  }
  
  getSignedMultisigTxHex(): string {
    return this.signedMultisigTxHex;
  }

  setSignedMultisigTxHex(signedTxMultisigHex: string): ZephyrMultisigSignResult {
    this.signedMultisigTxHex = signedTxMultisigHex;
    return this;
  }

  getTxHashes(): string[] {
    return this.txHashes;
  }

  setTxHashes(txHashes: string[]): ZephyrMultisigSignResult {
    this.txHashes = txHashes;
    return this;
  }
}
