import GenUtils from "../../common/GenUtils";

/**
 * Zephyr subaddress model, inherited from monero-ts and not part of the package entry. Renamed with
 * the suffix Inherited so that the package entry can give its own subaddress result the name
 * ZephyrSubaddress.
 */
export default class ZephyrSubaddressInherited {

  accountIndex: number;
  index: number;
  address: string;
  label: string;
  balance: bigint;
  unlockedBalance: bigint;
  numUnspentOutputs: number;
  isUsed: boolean;
  numBlocksToUnlock: number;
  
  constructor(subaddress?: Partial<ZephyrSubaddressInherited>) {
    Object.assign(this, subaddress);
    if (this.balance !== undefined && typeof this.balance !== "bigint") this.balance = BigInt(this.balance);
    if (this.unlockedBalance !== undefined && typeof this.unlockedBalance !== "bigint") this.unlockedBalance = BigInt(this.unlockedBalance);
  }
  
  toJson(): any {
    let json: any = Object.assign({}, this);
    if (json.balance !== undefined) json.balance = json.balance.toString();
    if (json.unlockedBalance !== undefined) json.unlockedBalance = json.unlockedBalance.toString();
    return json;
  }
  
  getAccountIndex(): number {
    return this.accountIndex;
  }

  setAccountIndex(accountIndex: number): ZephyrSubaddressInherited {
    this.accountIndex = accountIndex;
    return this;
  }

  getIndex(): number {
    return this.index;
  }

  setIndex(index: number): ZephyrSubaddressInherited {
    this.index = index;
    return this;
  }
  
  getAddress(): string {
    return this.address;
  }

  setAddress(address: string): ZephyrSubaddressInherited {
    this.address = address;
    return this;
  }

  getLabel(): string {
    return this.label;
  }

  setLabel(label: string): ZephyrSubaddressInherited {
    this.label = label;
    return this;
  }

  getBalance(): bigint {
    return this.balance;
  }

  setBalance(balance: bigint): ZephyrSubaddressInherited {
    this.balance = balance;
    return this;
  }

  getUnlockedBalance(): bigint {
    return this.unlockedBalance;
  }

  setUnlockedBalance(unlockedBalance: bigint): ZephyrSubaddressInherited {
    this.unlockedBalance = unlockedBalance;
    return this;
  }

  getNumUnspentOutputs(): number {
    return this.numUnspentOutputs;
  }

  setNumUnspentOutputs(numUnspentOutputs: number): ZephyrSubaddressInherited {
    this.numUnspentOutputs = numUnspentOutputs;
    return this;
  }

  getIsUsed(): boolean {
    return this.isUsed;
  }

  setIsUsed(isUsed: boolean): ZephyrSubaddressInherited {
    this.isUsed = isUsed;
    return this;
  }

  getNumBlocksToUnlock(): number {
    return this.numBlocksToUnlock;
  }

  setNumBlocksToUnlock(numBlocksToUnlock: number): ZephyrSubaddressInherited {
    this.numBlocksToUnlock = numBlocksToUnlock;
    return this;
  }
  
  toString(indent = 0): string {
    let str = "";
    str += GenUtils.kvLine("Account index", this.getAccountIndex(), indent);
    str += GenUtils.kvLine("Subaddress index", this.getIndex(), indent);
    str += GenUtils.kvLine("Address", this.getAddress(), indent);
    str += GenUtils.kvLine("Label", this.getLabel(), indent);
    str += GenUtils.kvLine("Balance", this.getBalance(), indent);
    str += GenUtils.kvLine("Unlocked balance", this.getUnlockedBalance(), indent);
    str += GenUtils.kvLine("Num unspent outputs", this.getNumUnspentOutputs(), indent);
    str += GenUtils.kvLine("Is used", this.getIsUsed(), indent);
    str += GenUtils.kvLine("Num blocks to unlock", this.getNumBlocksToUnlock(), indent);
    return str.slice(0, str.length - 1);  // strip last newline
  }
}
