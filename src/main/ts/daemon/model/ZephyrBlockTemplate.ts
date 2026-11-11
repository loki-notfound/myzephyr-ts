/**
 * Monero block template to mine.
 */
export default class ZephyrBlockTemplate {

  blockTemplateBlob: string;
  blockHashingBlob: string;
  difficulty: bigint;
  expectedReward: bigint;
  height: number;
  prevId: string;
  reservedOffset: number;
  seedHeight: number;
  seedHash: string;
  nextSeedHash: string;
  
  constructor(template?: Partial<ZephyrBlockTemplate>) {
    Object.assign(this, template);
    if (this.expectedReward !== undefined && typeof this.expectedReward !== "bigint") this.expectedReward = BigInt(this.expectedReward);
    if (this.difficulty !== undefined && typeof this.difficulty !== "bigint") this.difficulty = BigInt(this.difficulty);
  }
  
  toJson(): any {
    let json: any = Object.assign({}, this);
    if (this.getExpectedReward() !== undefined) json.expectedReward = this.getExpectedReward().toString();
    if (this.getDifficulty() !== undefined) json.difficulty = this.getDifficulty().toString();
    return json;
  }
  
  getBlockTemplateBlob(): string {
    return this.blockTemplateBlob;
  }
  
  setBlockTemplateBlob(blockTemplateBlob: string): ZephyrBlockTemplate {
    this.blockTemplateBlob = blockTemplateBlob;
    return this;
  }
  
  getBlockHashingBlob(): string {
    return this.blockHashingBlob;
  }
  
  setBlockHashingBlob(blockHashingBlob: string): ZephyrBlockTemplate {
    this.blockHashingBlob = blockHashingBlob;
    return this;
  }
  
  getDifficulty(): bigint {
    return this.difficulty;
  }
  
  setDifficulty(difficulty: bigint): ZephyrBlockTemplate {
    this.difficulty = difficulty;
    return this;
  }
  
  getExpectedReward(): bigint {
    return this.expectedReward;
  }
  
  setExpectedReward(expectedReward: bigint): ZephyrBlockTemplate {
    this.expectedReward = expectedReward;
    return this;
  }
  
  getHeight(): number {
    return this.height;
  }
  
  setHeight(height: number): ZephyrBlockTemplate {
    this.height = height;
    return this;
  }
  
  getPrevHash(): string {
    return this.prevId;
  }
  
  setPrevHash(prevId: string): ZephyrBlockTemplate {
    this.prevId = prevId;
    return this;
  }
  
  getReservedOffset(): number {
    return this.reservedOffset;
  }
  
  setReservedOffset(reservedOffset: number): ZephyrBlockTemplate {
    this.reservedOffset = reservedOffset;
    return this;
  }
  
  getSeedHeight(): number {
    return this.height;
  }
  
  setSeedHeight(seedHeight: number): ZephyrBlockTemplate {
    this.seedHeight = seedHeight;
    return this;
  }
  
  getSeedHash(): string {
    return this.seedHash;
  }
  
  setSeedHash(seedHash: string): ZephyrBlockTemplate {
    this.seedHash = seedHash;
    return this;
  }
  
  getNextSeedHash(): string {
    return this.nextSeedHash
  }
  
  setNextSeedHash(nextSeedHash: string): ZephyrBlockTemplate {
    this.nextSeedHash = nextSeedHash;
    return this;
  }
}