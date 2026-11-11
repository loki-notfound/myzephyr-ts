/**
 * Represents an account tag.
 */
export default class ZephyrAccountTag {

  tag: string;
  label: string;
  accountIndices: number[];
  
  constructor(accountTag?: Partial<ZephyrAccountTag>) {
    Object.assign(this, accountTag);
  }
  
  getTag(): string {
    return this.tag;
  }
  
  setTag(tag: string): ZephyrAccountTag {
    this.tag = tag;
    return this;
  }
  
  getLabel(): string {
    return this.label;
  }
  
  setLabel(label: string): ZephyrAccountTag {
    this.label = label;
    return this;
  }
  
  getAccountIndices(): number[] {
    return this.accountIndices;
  }
  
  setAccountIndices(accountIndices: number[]): ZephyrAccountTag {
    this.accountIndices = accountIndices;
    return this;
  }
}
