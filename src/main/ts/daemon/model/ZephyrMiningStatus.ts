/**
 * Models daemon mining status.
 */
export default class ZephyrMiningStatus {

  isActive: boolean;
  address: string;
  speed: number;
  numThreads: number;
  isBackground: boolean;
  
  constructor(status?: Partial<ZephyrMiningStatus>) {
    Object.assign(this, status);
  }
  
  toJson() {
    return Object.assign({}, this);
  }
  
  getIsActive(): boolean {
    return this.isActive;
  }
  
  setIsActive(isActive: boolean): ZephyrMiningStatus {
    this.isActive = isActive;
    return this;
  }
  
  getAddress(): string {
    return this.address;
  }
  
  setAddress(address: string): ZephyrMiningStatus {
    this.address = address;
    return this;
  }
  
  getSpeed(): number {
    return this.speed;
  }
  
  setSpeed(speed: number): ZephyrMiningStatus {
    this.speed = speed;
    return this;
  }
  
  getNumThreads(): number {
    return this.numThreads;
  }
  
  setNumThreads(numThreads: number): ZephyrMiningStatus {
    this.numThreads = numThreads;
    return this;
  }
  
  getIsBackground(): boolean {
    return this.isBackground;
  }
  
  setIsBackground(isBackground: boolean): ZephyrMiningStatus {
    this.isBackground = isBackground;
    return this;
  }
}
