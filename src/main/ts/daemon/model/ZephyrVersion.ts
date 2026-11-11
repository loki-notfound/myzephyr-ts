/**
 * Models a Monero version.
 */
export default class ZephyrVersion {

  number: number;
  isRelease: boolean;
  
  constructor(number: number, isRelease: boolean) {
    this.number = number;
    this.isRelease = isRelease;
  }

  getNumber(): number {
    return this.number;
  }

  setNumber(number: number): ZephyrVersion {
    this.number = number;
    return this;
  }

  getIsRelease(): boolean {
    return this.isRelease;
  }

  setIsRelease(isRelease: boolean): ZephyrVersion {
    this.isRelease = isRelease;
    return this;
  }
  
  copy(): ZephyrVersion {
    return new ZephyrVersion(this.number, this.isRelease);
  }
  
  toJson(): any {
    return Object.assign({}, this);
  }
}
