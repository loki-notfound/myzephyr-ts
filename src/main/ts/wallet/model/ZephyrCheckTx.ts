import ZephyrCheck from "./ZephyrCheck";

/**
 * Results from checking a transaction key.
 */
export default class ZephyrCheckTx extends ZephyrCheck {

  inTxPool: boolean;
  numConfirmations: number;
  receivedAmount: bigint;
  
  constructor(check?: Partial<ZephyrCheckTx>) {
    super(check);
    if (this.receivedAmount !== undefined && typeof this.receivedAmount !== "bigint") this.receivedAmount = BigInt(this.receivedAmount);
  }
  
  toJson(): any {
    let json: any = Object.assign({}, this);
    if (this.getReceivedAmount() !== undefined) json.receivedAmount = this.getReceivedAmount().toString();
    return json;
  }

  getInTxPool(): boolean {
    return this.inTxPool;
  }
  
  setInTxPool(inTxPool: boolean): ZephyrCheckTx {
    this.inTxPool = inTxPool;
    return this;
  }
  
  getNumConfirmations(): number {
    return this.numConfirmations;
  }
  
  setNumConfirmations(numConfirmations: number): ZephyrCheckTx {
    this.numConfirmations = numConfirmations;
    return this;
  }
  
  getReceivedAmount(): bigint {
    return this.receivedAmount;
  }
  
  setReceivedAmount(receivedAmount: bigint): ZephyrCheckTx {
    this.receivedAmount = receivedAmount;
    return this;
  }
}
