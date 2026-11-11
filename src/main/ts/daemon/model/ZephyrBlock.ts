import assert from "assert";
import GenUtils from "../../common/GenUtils";
import ZephyrBlockHeader from "./ZephyrBlockHeader";
import ZephyrTx from "./ZephyrTx";
import ZephyrTxQuery from "../../wallet/model/ZephyrTxQuery";
import ZephyrTxWallet from "../../wallet/model/ZephyrTxWallet";

/**
 * Enumerates types to deserialize to.
 */
enum DeserializationType {
  TX = 0,
  TX_WALLET = 1,
  TX_QUERY = 2
}

/**
 * Models a Monero block in the blockchain.
 */
export default class ZephyrBlock extends ZephyrBlockHeader {

  static DeserializationType = DeserializationType;

  hex: string;
  minerTx: ZephyrTx;
  txs: ZephyrTx[];
  txHashes: string[];

  constructor(block?: Partial<ZephyrBlock>, txType?: DeserializationType) {
    super(block);
    
    // copy miner tx
    if (this.minerTx) {
      this.minerTx = this.deserializeTx(this.minerTx, txType).setBlock(this);
    }
    
    // copy non-miner txs
    if (this.txs) {
      this.txs = this.txs.slice();
      for (let i = 0; i < this.txs.length; i++) {
        this.txs[i] = this.deserializeTx(this.txs[i], txType).setBlock(this);
      }
    }
  }

  getHex(): string {
    return this.hex;
  }
  
  setHex(hex: string): ZephyrBlock {
    this.hex = hex;
    return this;
  }
  
  getMinerTx(): ZephyrTx {
    return this.minerTx;
  }
  
  setMinerTx(minerTx: ZephyrTx): ZephyrBlock {
    this.minerTx = minerTx;
    return this;
  }
  
  getTxs(): ZephyrTx[] {
    return this.txs;
  }
  
  setTxs(txs: ZephyrTx[]): ZephyrBlock {
    this.txs = txs;
    return this;
  }
  
  getTxHashes(): string[] {
    return this.txHashes;
  }
  
  setTxHashes(txHashes: string[]): ZephyrBlock {
    this.txHashes = txHashes;
    return this;
  }
  
  copy(): ZephyrBlock {
    return new ZephyrBlock(this);
  }
  
  toJson(): any {
    let json = super.toJson();
    if (this.getMinerTx() !== undefined) json.minerTx = this.getMinerTx().toJson();
    if (this.getTxs() !== undefined) {
      json.txs = [];
      for (let tx of this.getTxs()) json.txs.push(tx.toJson());
    }
    return json;
  }
  
  merge(block: ZephyrBlock): ZephyrBlock {
    assert(block instanceof ZephyrBlock);
    if (this === block) return this;
    
    // merge header fields
    super.merge(block);
    
    // merge reconcilable block extensions
    this.setHex(GenUtils.reconcile(this.getHex(), block.getHex()));
    this.setTxHashes(GenUtils.reconcile(this.getTxHashes(), block.getTxHashes()));
    
    // merge miner tx
    if (this.getMinerTx() === undefined) this.setMinerTx(block.getMinerTx());
    if (block.getMinerTx() !== undefined) {
      block.getMinerTx().setBlock(this);
      this.getMinerTx().merge(block.getMinerTx());
    }
    
    // merge non-miner txs
    if (block.getTxs() !== undefined) {
      for (let tx of block.getTxs()) {
        tx.setBlock(this);
        ZephyrBlock.mergeTx(this.getTxs(), tx);
      }
    }

    return this;
  }
  
  toString(indent = 0): string {
    let str = super.toString(indent) + "\n";
    str += GenUtils.kvLine("Hex", this.getHex(), indent);
    if (this.getTxs() !== undefined) {
      str += GenUtils.kvLine("Txs", "", indent);
      for (let tx of this.getTxs()) {
        str += tx.toString(indent + 1) + "\n";
      }
    }
    if (this.getMinerTx() !== undefined) {
      str += GenUtils.kvLine("Miner tx", "", indent);
      str += this.getMinerTx().toString(indent + 1) + "\n";
    }
    str += GenUtils.kvLine("Txs hashes", this.getTxHashes(), indent);
    return str[str.length - 1] === "\n" ? str.slice(0, str.length - 1) : str  // strip last newline
  }
  
  // helper to merge txs
  protected static mergeTx(txs, tx) {
    for (let aTx of txs) {
      if (aTx.getHash() === tx.getHash()) {
        aTx.merge(tx);
        return;
      }
    }
    txs.push(tx);
  }

  // -------------------- OVERRIDE COVARIANT RETURN TYPES ---------------------

  setHeight(height: number): ZephyrBlock {
    super.setHeight(height);
    return this;
  }
  
  setTimestamp(timestamp: number): ZephyrBlock {
    super.setTimestamp(timestamp);
    return this;
  }
  
  setSize(size: number): ZephyrBlock {
    super.setSize(size);
    return this;
  }
  
  setWeight(weight: number): ZephyrBlock {
    super.setWeight(weight);
    return this;
  }
  
  setLongTermWeight(longTermWeight: number): ZephyrBlock {
    super.setLongTermWeight(longTermWeight);
    return this;
  }
  
  setDepth(depth: number): ZephyrBlock {
    super.setDepth(depth);
    return this;
  }
  
  setDifficulty(difficulty: bigint): ZephyrBlock {
    super.setDifficulty(difficulty);
    return this;
  }
  
  setCumulativeDifficulty(cumulativeDifficulty: bigint): ZephyrBlock {
    super.setCumulativeDifficulty(cumulativeDifficulty);
    return this;
  }
  
  setMajorVersion(majorVersion: number): ZephyrBlock {
    super.setMajorVersion(majorVersion);
    return this;
  }
  
  setMinorVersion(minorVersion: number): ZephyrBlock {
    super.setMinorVersion(minorVersion);
    return this;
  }
  
  setNonce(nonce: number): ZephyrBlock {
    super.setNonce(nonce);
    return this;
  }
  
  setMinerTxHash(minerTxHash: string): ZephyrBlock {
    super.setMinerTxHash(minerTxHash);
    return this;
  }
  
  setNumTxs(numTxs: number): ZephyrBlock {
    super.setNumTxs(numTxs);
    return this;
  }
  
  setOrphanStatus(orphanStatus: boolean): ZephyrBlock {
    super.setOrphanStatus(orphanStatus);
    return this;
  }
  
  setPrevHash(prevHash: string): ZephyrBlock {
    super.setPrevHash(prevHash);
    return this;
  }
  
  setReward(reward: bigint): ZephyrBlock {
    super.setReward(reward);
    return this;
  }
  
  setPowHash(powHash: string): ZephyrBlock {
    super.setPowHash(powHash);
    return this;
  }

  protected deserializeTx(tx: any, txType?: DeserializationType): ZephyrTx {
    if (txType === undefined) {
      if (!(tx instanceof ZephyrTx)) throw new Error("Must provide DeserializationType if tx is not instanceof ZephyrTx");
      return tx.copy();
    } else if (txType === ZephyrBlock.DeserializationType.TX || txType === undefined) {
      return new ZephyrTx(tx);
    } else if (txType === ZephyrBlock.DeserializationType.TX_WALLET) {
      return new ZephyrTxWallet(tx);
    } else if (txType === ZephyrBlock.DeserializationType.TX_QUERY) {
      return new ZephyrTxQuery(tx);
    } else {
      throw new Error("Unrecognized tx deserialization type: " + txType);
    }
  }
}
