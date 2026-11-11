/**
 * Monero daemon info.
 */
export default class ZephyrDaemonInfo {

  version: string;
  numAltBlocks: number;
  blockSizeLimit: number;
  blockSizeMedian: number;
  blockWeightLimit: number;
  blockWeightMedian: number;
  bootstrapDaemonAddress: string;
  difficulty: bigint;
  cumulativeDifficulty: bigint;
  freeSpace: bigint;
  numOfflinePeers: number;
  numOnlinePeers: number;
  height: number;
  heightWithoutBootstrap: number;
  networkType: string;
  isRegtest: boolean;
  isOffline: boolean;
  numIncomingConnections: number;
  numOutgoingConnections: number;
  numRpcConnections: number;
  startTimestamp: number;
  adjustedTimestamp: number;
  target: number;
  targetHeight: number;
  topBlockHash: string;
  numTxs: number;
  numTxsPool: number;
  wasBootstrapEverUsed: boolean;
  databaseSize: number;
  updateAvailable: boolean;
  credits: bigint;
  isBusySyncing: boolean;
  isSynchronized: boolean;
  isRestricted: boolean;
  
  constructor(info?: Partial<ZephyrDaemonInfo>) {
    Object.assign(this, info);

    // deserialize bigints
    if (this.difficulty !== undefined && typeof this.difficulty !== "bigint") this.difficulty = BigInt(this.difficulty);
    if (this.cumulativeDifficulty !== undefined && typeof this.cumulativeDifficulty !== "bigint") this.cumulativeDifficulty = BigInt(this.cumulativeDifficulty);
    if (this.credits !== undefined && typeof this.credits !== "bigint") this.credits = BigInt(this.credits);
  }
  
  toJson(): any {
    let json: any = Object.assign([], this);
    if (json.difficulty !== undefined) json.difficulty = json.difficulty.toString();
    if (json.cumulativeDifficulty !== undefined) json.cumulativeDifficulty = json.cumulativeDifficulty.toString();
    if (json.credits !== undefined) json.credits = json.credits.toString();
    return json;
  }
  
  getVersion(): string {
    return this.version;
  }
  
  setVersion(version: string): ZephyrDaemonInfo {
    this.version = version;
    return this;
  }
  
  getNumAltBlocks(): number {
    return this.numAltBlocks;
  }
  
  setNumAltBlocks(numAltBlocks: number): ZephyrDaemonInfo {
    this.numAltBlocks = numAltBlocks;
    return this;
  }
  
  getBlockSizeLimit(): number {
    return this.blockSizeLimit;
  }
  
  setBlockSizeLimit(blockSizeLimit: number): ZephyrDaemonInfo {
    this.blockSizeLimit = blockSizeLimit;
    return this;
  }
  
  getBlockSizeMedian(): number {
    return this.blockSizeMedian;
  }
  
  setBlockSizeMedian(blockSizeMedian: number): ZephyrDaemonInfo {
    this.blockSizeMedian = blockSizeMedian;
    return this;
  }
  
  getBlockWeightLimit(): number {
    return this.blockWeightLimit;
  }
  
  setBlockWeightLimit(blockWeightLimit: number): ZephyrDaemonInfo {
    this.blockWeightLimit = blockWeightLimit;
    return this;
  }
  
  getBlockWeightMedian(): number {
    return this.blockWeightMedian;
  }
  
  setBlockWeightMedian(blockWeightMedian: number): ZephyrDaemonInfo {
    this.blockWeightMedian = blockWeightMedian;
    return this;
  }
  
  getBootstrapDaemonAddress(): string {
    return this.bootstrapDaemonAddress;
  }
  
  setBootstrapDaemonAddress(bootstrapDaemonAddress): ZephyrDaemonInfo {
    this.bootstrapDaemonAddress = bootstrapDaemonAddress;
    return this;
  }
  
  getDifficulty(): bigint {
    return this.difficulty;
  }
  
  setDifficulty(difficulty: bigint): ZephyrDaemonInfo {
    this.difficulty = difficulty;
    return this;
  }
  
  getCumulativeDifficulty(): bigint {
    return this.cumulativeDifficulty;
  }
  
  setCumulativeDifficulty(cumulativeDifficulty: bigint): ZephyrDaemonInfo {
    this.cumulativeDifficulty = cumulativeDifficulty;
    return this;
  }
  
  getFreeSpace(): bigint {
    return this.freeSpace;
  }
  
  setFreeSpace(freeSpace: bigint): ZephyrDaemonInfo {
    this.freeSpace = freeSpace;
    return this;
  }
  
  getNumOfflinePeers(): number {
    return this.numOfflinePeers;
  }
  
  setNumOfflinePeers(numOfflinePeers: number): ZephyrDaemonInfo {
    this.numOfflinePeers = numOfflinePeers;
    return this;
  }
  
  getNumOnlinePeers(): number {
    return this.numOnlinePeers;
  }
  
  setNumOnlinePeers(numOnlinePeers: number): ZephyrDaemonInfo {
    this.numOnlinePeers = numOnlinePeers;
    return this;
  }
  
  getHeight(): number {
    return this.height;
  }
  
  setHeight(height: number): ZephyrDaemonInfo {
    this.height = height;
    return this;
  }
  
  getHeightWithoutBootstrap(): number {
    return this.heightWithoutBootstrap;
  }
  
  setHeightWithoutBootstrap(heightWithoutBootstrap: number): ZephyrDaemonInfo {
    this.heightWithoutBootstrap = heightWithoutBootstrap;
    return this;
  }
  
  getNetworkType(): string {
    return this.networkType;
  }

  setNetworkType(networkType: string) {
    this.networkType = networkType;
    return this;
  }

  getIsRegtest(): boolean {
    return this.isRegtest;
  }

  setIsRegtest(isRegtest: boolean): ZephyrDaemonInfo {
    this.isRegtest = isRegtest;
    return this;
  }

  getIsOffline(): boolean {
    return this.isOffline;
  }
  
  setIsOffline(isOffline: boolean): ZephyrDaemonInfo {
    this.isOffline = isOffline;
    return this;
  }
  
  getNumIncomingConnections(): number {
    return this.numIncomingConnections;
  }
  
  setNumIncomingConnections(numIncomingConnections: number): ZephyrDaemonInfo {
    this.numIncomingConnections = numIncomingConnections;
    return this;
  }
  
  getNumOutgoingConnections(): number {
    return this.numOutgoingConnections;
  }
  
  setNumOutgoingConnections(numOutgoingConnections: number): ZephyrDaemonInfo {
    this.numOutgoingConnections = numOutgoingConnections;
    return this;
  }
  
  getNumRpcConnections(): number {
    return this.numRpcConnections;
  }
  
  setNumRpcConnections(numRpcConnections: number): ZephyrDaemonInfo {
    this.numRpcConnections = numRpcConnections;
    return this;
  }
  
  getStartTimestamp(): number {
    return this.startTimestamp;
  }
  
  setStartTimestamp(startTimestamp: number): ZephyrDaemonInfo {
    this.startTimestamp = startTimestamp;
    return this;
  }
  
  getAdjustedTimestamp(): number {
    return this.adjustedTimestamp;
  }
  
  setAdjustedTimestamp(adjustedTimestamp: number): ZephyrDaemonInfo {
    this.adjustedTimestamp = adjustedTimestamp;
    return this;
  }
  
  getTarget(): number {
    return this.target;
  }
  
  setTarget(target: number): ZephyrDaemonInfo {
    this.target = target;
    return this;
  }
  
  getTargetHeight(): number {
    return this.targetHeight;
  }
  
  setTargetHeight(targetHeight: number): ZephyrDaemonInfo {
    this.targetHeight = targetHeight;
    return this;
  }
  
  getTopBlockHash(): string {
    return this.topBlockHash;
  }
  
  setTopBlockHash(topBlockHash): ZephyrDaemonInfo {
    this.topBlockHash = topBlockHash;
    return this;
  }
  
  getNumTxs(): number {
    return this.numTxs;
  }
  
  setNumTxs(numTxs: number): ZephyrDaemonInfo {
    this.numTxs = numTxs;
    return this;
  }
  
  getNumTxsPool(): number {
    return this.numTxsPool;
  }
  
  setNumTxsPool(numTxsPool): ZephyrDaemonInfo {
    this.numTxsPool = numTxsPool;
    return this;
  }
  
  getWasBootstrapEverUsed(): boolean {
    return this.wasBootstrapEverUsed;
  }
  
  setWasBootstrapEverUsed(wasBootstrapEverUsed): ZephyrDaemonInfo {
    this.wasBootstrapEverUsed = wasBootstrapEverUsed;
    return this;
  }
  
  getDatabaseSize(): number {
    return this.databaseSize;
  }
  
  setDatabaseSize(databaseSize: number): ZephyrDaemonInfo {
    this.databaseSize = databaseSize;
    return this;
  }
  
  getUpdateAvailable(): boolean {
    return this.updateAvailable;
  }
  
  setUpdateAvailable(updateAvailable: boolean): ZephyrDaemonInfo {
    this.updateAvailable = updateAvailable;
    return this;
  }
  
  getCredits(): bigint {
    return this.credits;
  }
  
  setCredits(credits: bigint): ZephyrDaemonInfo {
    this.credits = credits;
    return this;
  }
  
  getIsBusySyncing(): boolean {
    return this.isBusySyncing;
  }
  
  setIsBusySyncing(isBusySyncing: boolean): ZephyrDaemonInfo {
    this.isBusySyncing = isBusySyncing;
    return this;
  }
  
  getIsSynchronized(): boolean {
    return this.isSynchronized;
  }
  
  setIsSynchronized(isSynchronized: boolean): ZephyrDaemonInfo {
    this.isSynchronized = isSynchronized;
    return this;
  }
  
  getIsRestricted(): boolean {
    return this.isRestricted;
  }
  
  setIsRestricted(isRestricted: boolean): ZephyrDaemonInfo {
    this.isRestricted = isRestricted;
    return this;
  }
}
