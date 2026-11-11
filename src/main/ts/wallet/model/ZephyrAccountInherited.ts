import assert from "assert";
import GenUtils from "../../common/GenUtils";
import ZephyrSubaddressInherited from "./ZephyrSubaddressInherited";

/**
 * Monero account model, inherited from monero-ts and not part of the package entry. Renamed with the
 * suffix Inherited so that the package entry can give its own account result the name ZephyrAccount;
 * this class keeps the inherited scalar balances of the unported paths.
 */
export default class ZephyrAccountInherited {

  index: number;
  primaryAddress: string;
  balance: bigint;
  unlockedBalance: bigint;
  label: string;
  tag: string;
  subaddresses: ZephyrSubaddressInherited[];
  
  constructor(account?: Partial<ZephyrAccountInherited>) {
    Object.assign(this, account);

    // deserialize balances
    if (this.balance !== undefined && typeof this.balance !== "bigint") this.balance = BigInt(this.balance);
    if (this.unlockedBalance !== undefined && typeof this.unlockedBalance !== "bigint") this.unlockedBalance = BigInt(this.unlockedBalance);

    // copy subaddresses
    if (this.subaddresses) {
      for (let i = 0; i < this.subaddresses.length; i++) {
        this.subaddresses[i] = new ZephyrSubaddressInherited(this.subaddresses[i]);
      }
    }
  }
  
  toJson(): any {
    let json: any = Object.assign({}, this);
    if (json.balance !== undefined) json.balance = json.balance.toString();
    if (json.unlockedBalance !== undefined) json.unlockedBalance = json.unlockedBalance.toString();
    if (json.subaddresses !== undefined) {
      for (let i = 0; i < json.subaddresses.length; i++) {
        json.subaddresses[i] = json.subaddresses[i].toJson();
      }
    }
    return json;
  }
  
  getIndex(): number {
    return this.index;
  }
  
  setIndex(index: number): ZephyrAccountInherited {
    this.index = index;
    return this;
  }
  
  getPrimaryAddress(): string {
    return this.primaryAddress;
  }

  setPrimaryAddress(primaryAddress: string): ZephyrAccountInherited {
    this.primaryAddress = primaryAddress;
    return this;
  }
  
  getBalance(): bigint {
    return this.balance;
  }
  
  setBalance(balance: bigint): ZephyrAccountInherited {
    this.balance = balance;
    return this;
  }
  
  getUnlockedBalance(): bigint {
    return this.unlockedBalance;
  }
  
  setUnlockedBalance(unlockedBalance: bigint): ZephyrAccountInherited {
    this.unlockedBalance = unlockedBalance;
    return this;
  }

  getLabel(): string {
    return this.label;
  }
  
  setLabel(label: string): ZephyrAccountInherited {
    this.label = label;
    return this;
  }
  
  getTag(): string {
    return this.tag;
  }
  
  setTag(tag: string): ZephyrAccountInherited {
    this.tag = tag;
    return this;
  }
  
  getSubaddresses(): ZephyrSubaddressInherited[] {
    return this.subaddresses;
  }
  
  setSubaddresses(subaddresses: ZephyrSubaddressInherited[]): ZephyrAccountInherited  {
    assert(subaddresses === undefined || Array.isArray(subaddresses), "Given subaddresses must be undefined or an array of subaddresses");
    this.subaddresses = subaddresses;
    if (subaddresses) {
      for (let subaddress of subaddresses) {
        subaddress.setAccountIndex(this.index);
      }
    }
    return this;
  }
  
  toString(indent = 0): string {
    let str = "";
    str += GenUtils.kvLine("Index", this.getIndex(), indent);
    str += GenUtils.kvLine("Primary address", this.getPrimaryAddress(), indent);
    str += GenUtils.kvLine("Balance", this.getBalance(), indent);
    str += GenUtils.kvLine("Unlocked balance", this.getUnlockedBalance(), indent);
    str += GenUtils.kvLine("Label", this.getTag(), indent);
    str += GenUtils.kvLine("Tag", this.getTag(), indent);
    if (this.getSubaddresses() !== undefined) {
      str += GenUtils.kvLine("Subaddresses", "", indent)
      for (let i = 0; i < this.getSubaddresses().length; i++) {
        str += GenUtils.kvLine(i + 1, "", indent + 1);
        str += this.getSubaddresses()[i].toString(indent + 2) + "\n";
      }
    }
    return str.slice(0, str.length - 1);  // strip last newline
  }
}
