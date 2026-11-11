import ZephyrCheck from "./ZephyrCheck";

/**
 * Results from checking a reserve proof.
 */
export default class ZephyrCheckReserve extends ZephyrCheck {
  
  totalAmount: bigint;
  unconfirmedSpentAmount: bigint;
  
  constructor(check?: Partial<ZephyrCheckReserve>) {
    super(check);
    if (this.totalAmount !== undefined && typeof this.totalAmount !== "bigint") this.totalAmount = BigInt(this.totalAmount);
    if (this.unconfirmedSpentAmount !== undefined && typeof this.unconfirmedSpentAmount !== "bigint") this.unconfirmedSpentAmount = BigInt(this.unconfirmedSpentAmount);
  }
  
  toJson(): any {
    let json: any = Object.assign({}, this);
    if (this.getTotalAmount() !== undefined) json.totalAmount = this.getTotalAmount().toString();
    if (this.getUnconfirmedSpentAmount() !== undefined) json.unconfirmedSpentAmount = this.getUnconfirmedSpentAmount().toString();
    return json;
  }
  
  getTotalAmount(): bigint {
    return this.totalAmount;
  }

  setTotalAmount(totalAmount: bigint): ZephyrCheckReserve {
    this.totalAmount = totalAmount;
    return this;
  }
  
  getUnconfirmedSpentAmount(): bigint {
    return this.unconfirmedSpentAmount;
  }

  setUnconfirmedSpentAmount(unconfirmedSpentAmount: bigint): ZephyrCheckReserve {
    this.unconfirmedSpentAmount = unconfirmedSpentAmount;
    return this;
  }
}