import assert from "assert";
import GenUtils from "../common/GenUtils";
import ZephyrAccountInherited from "./model/ZephyrAccountInherited";
import ZephyrAccountTag from "./model/ZephyrAccountTag";
import ZephyrAddressBookEntry from "./model/ZephyrAddressBookEntry";
import ZephyrBlock from "../daemon/model/ZephyrBlock";
import ZephyrCheckReserve from "./model/ZephyrCheckReserve";
import ZephyrCheckTx from "./model/ZephyrCheckTx";
import ZephyrConnectionManager from "../common/ZephyrConnectionManager";
import ZephyrConnectionManagerListener from "../common/ZephyrConnectionManagerListener";
import ZephyrError from "../common/ZephyrError";
import ZephyrIncomingTransfer from "./model/ZephyrIncomingTransfer";
import ZephyrIntegratedAddress from "./model/ZephyrIntegratedAddress";
import ZephyrKeyImage from "../daemon/model/ZephyrKeyImage";
import ZephyrKeyImageExportResult from "./model/ZephyrKeyImageExportResult";
import ZephyrKeyImageImportResult from "./model/ZephyrKeyImageImportResult";
import ZephyrMessageSignatureResult from "./model/ZephyrMessageSignatureResult";
import ZephyrMessageSignatureType from "./model/ZephyrMessageSignatureType";
import ZephyrMultisigInfo from "./model/ZephyrMultisigInfo";
import ZephyrMultisigInitResult from "./model/ZephyrMultisigInitResult";
import ZephyrMultisigSignResult from "./model/ZephyrMultisigSignResult";
import ZephyrOutputQuery from "./model/ZephyrOutputQuery";
import ZephyrOutputWallet from "./model/ZephyrOutputWallet";
import ZephyrOutgoingTransfer from "./model/ZephyrOutgoingTransfer";
import ZephyrRpcConnection from "../common/ZephyrRpcConnection";
import ZephyrSubaddressInherited from "./model/ZephyrSubaddressInherited";
import ZephyrSyncResult from "./model/ZephyrSyncResult";
import ZephyrTransfer from "./model/ZephyrTransfer";
import ZephyrTransferQuery from "./model/ZephyrTransferQuery";
import ZephyrTxConfig from "./model/ZephyrTxConfig";
import ZephyrTxPriority from "./model/ZephyrTxPriority";
import ZephyrTxQuery from "./model/ZephyrTxQuery";
import ZephyrTxWallet from "./model/ZephyrTxWallet";
import ZephyrTxSet from "./model/ZephyrTxSet";
import ZephyrUtils from "../common/ZephyrUtils";
import ZephyrVersion from "../daemon/model/ZephyrVersion";
import ZephyrWalletListener from "./model/ZephyrWalletListener";

/**
 * Copyright (c) woodser
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

/**
 * Monero wallet interface and default implementations.
 * 
 * @interface
 */
export default class ZephyrWalletBase {

  // static variables
  static readonly DEFAULT_LANGUAGE = "English";

  // state variables
  protected connectionManager: ZephyrConnectionManager;
  protected connectionManagerListener: ZephyrConnectionManagerListener;
  protected listeners: ZephyrWalletListener[] = [];
  protected listenerGeneration = 0;
  protected _isClosed = false;

  /**
   * Hidden constructor.
   * 
   * @private
   */
  constructor() {
    // no code needed
  }
  
  /**
   * Register a listener to receive wallet notifications.
   * 
   * @param {ZephyrWalletListener} listener - listener to receive wallet notifications
   * @return {Promise<void>}
   */
  async addListener(listener: ZephyrWalletListener): Promise<void> {
    assert(listener instanceof ZephyrWalletListener, "Listener must be instance of ZephyrWalletListener");
    this.listeners.push(listener);
  }
  
  /**
   * Unregister a listener to receive wallet notifications.
   * 
   * @param {ZephyrWalletListener} listener - listener to unregister
   * @return {Promise<void>}
   */
  async removeListener(listener): Promise<void> {
    let idx = this.listeners.indexOf(listener);
    if (idx > -1) this.listeners.splice(idx, 1);
    else throw new ZephyrError("Listener is not registered with wallet");
  }
  
  /**
   * Get the listeners registered with the wallet.
   * 
   * @return {ZephyrWalletListener[]} the registered listeners
   */
  getListeners(): ZephyrWalletListener[] {
    return this.listeners;
  }
  
  /**
   * Indicates if the wallet is view-only, meaning it does not have the private
   * spend key and can therefore only observe incoming outputs.
   * 
   * @return {Promise<boolean>} true if the wallet is view-only, false otherwise
   */
  async isViewOnly(): Promise<boolean> {
    throw new ZephyrError("Not supported");
  }
  
  /**
   * Set the wallet's daemon connection.
   * 
   * @param {ZephyrRpcConnection | string} [uriOrConnection] - daemon's URI or connection (defaults to offline)
   * @param {boolean} [isTrusted] - indicates if the daemon is trusted (defaults to trusted if local address)
   * @return {Promise<void>}
   */
  async setDaemonConnection(uriOrConnection?: Partial<ZephyrRpcConnection> | string, isTrusted?: boolean): Promise<void> {
    throw new ZephyrError("Not supported");
  }
  
  /**
   * Get the wallet's daemon connection.
   * 
   * @return {Promise<ZephyrRpcConnection>} the wallet's daemon connection
   */
  async getDaemonConnection(): Promise<ZephyrRpcConnection> {
    throw new ZephyrError("Not supported");
  }

  /**
   * Set the wallet's daemon connection manager.
   * 
   * @param {ZephyrConnectionManager} connectionManager manages connections to monerod
   * @return {Promise<void>}
   */
  async setConnectionManager(connectionManager?: ZephyrConnectionManager): Promise<void> {
    if (this.connectionManager) this.connectionManager.removeListener(this.connectionManagerListener);
    this.connectionManager = connectionManager;
    if (!connectionManager) return;
    let that = this;
    if (!this.connectionManagerListener) this.connectionManagerListener = new class extends ZephyrConnectionManagerListener {
      async onConnectionChanged(connection: ZephyrRpcConnection | undefined) {
        if (that._isClosed) return;
        try {
          await that.setDaemonConnection(connection);
        } catch (err) {
          if (!(err instanceof ZephyrError) || !that._isClosed) throw err; // ignore a connection change racing with wallet shutdown
        }
      }
    };
    connectionManager.addListener(this.connectionManagerListener);
    await this.setDaemonConnection(connectionManager.getConnection());
  }

  /**
   * Get the wallet's daemon connection manager.
   * 
   * @return {Promise<ZephyrConnectionManager>} the wallet's daemon connection manager
   */
  async getConnectionManager(): Promise<ZephyrConnectionManager> {
    return this.connectionManager;
  }
  
  /**
   * Indicates if the wallet is connected to daemon.
   * 
   * @return {Promise<boolean>} true if the wallet is connected to a daemon, false otherwise
   */
  async isConnectedToDaemon(): Promise<boolean> {
    throw new ZephyrError("Not supported");
  }
  
  /**
   * Gets the version of the wallet.
   * 
   * @return {Promise<ZephyrVersion>} the version of the wallet
   */
  async getVersion(): Promise<ZephyrVersion> {
    throw new ZephyrError("Not supported");
  }
  
  /**
   * Get the wallet's path.
   * 
   * @return {Promise<string>} the path the wallet can be opened with
   */
  async getPath(): Promise<string> {
    throw new ZephyrError("Not supported");
  }
  
  /**
   * Get the wallet's mnemonic phrase or seed.
   * 
   * @return {Promise<string>} the wallet's mnemonic phrase or seed.
   */
  async getSeed(): Promise<string> {
    throw new ZephyrError("Not supported");
  }
  
  /**
   * Get the language of the wallet's mnemonic phrase or seed.
   * 
   * @return {Promise<string>} the language of the wallet's mnemonic phrase or seed.
   */
  async getSeedLanguage(): Promise<string> {
    throw new ZephyrError("Not supported");
  }
  
  /**
   * Get the wallet's private view key.
   * 
   * @return {Promise<string>} the wallet's private view key
   */
  async getPrivateViewKey(): Promise<string> {
    throw new ZephyrError("Not supported");
  }
  
  /**
   * Get the wallet's private spend key.
   * 
   * @return {Promise<string>} the wallet's private spend key
   */
  async getPrivateSpendKey(): Promise<string> {
    throw new ZephyrError("Not supported");
  }
  
  /**
   * Get the wallet's public view key.
   * 
   * @return {Promise<string>} the wallet's public view key
   */
  async getPublicViewKey(): Promise<string> {
    throw new ZephyrError("Not supported");
  }
  
  /**
   * Get the wallet's public spend key.
   * 
   * @return {Promise<string>} the wallet's public spend key
   */
  async getPublicSpendKey(): Promise<string> {
    throw new ZephyrError("Not supported");
  }
    
  /**
   * Get the wallet's primary address.
   * 
   * @return {Promise<string>} the wallet's primary address
   */
  async getPrimaryAddress(): Promise<string> {
    return await this.getAddress(0, 0);
  }
  
  /**
   * Get the address of a specific subaddress.
   * 
   * @param {number} accountIdx - the account index of the address's subaddress
   * @param {number} subaddressIdx - the subaddress index within the account
   * @return {Promise<string>} the receive address of the specified subaddress
   */
  async getAddress(accountIdx: number, subaddressIdx: number): Promise<string> {
    throw new ZephyrError("Not supported");
  }
  
  /**
   * Get the account and subaddress index of the given address.
   * 
   * @param {string} address - address to get the account and subaddress index from
   * @return {Promise<ZephyrSubaddressInherited>} the account and subaddress indices
   */
  async getAddressIndex(address: string): Promise<ZephyrSubaddressInherited> {
    throw new ZephyrError("Not supported");
  }
  
  /**
   * Get an integrated address based on the given standard address and payment
   * ID. Uses the wallet's primary address if an address is not given.
   * Generates a random payment ID if a payment ID is not given.
   * 
   * @param {string} standardAddress is the standard address to generate the integrated address from (wallet's primary address if undefined)
   * @param {string} paymentId is the payment ID to generate an integrated address from (randomly generated if undefined)
   * @return {Promise<ZephyrIntegratedAddress>} the integrated address
   */
  async getIntegratedAddress(standardAddress?: string, paymentId?: string): Promise<ZephyrIntegratedAddress> {
    throw new ZephyrError("Not supported");
  }
  
  /**
   * Decode an integrated address to get its standard address and payment id.
   * 
   * @param {string} integratedAddress - integrated address to decode
   * @return {Promise<ZephyrIntegratedAddress>} the decoded integrated address including standard address and payment id
   */
  async decodeIntegratedAddress(integratedAddress: string): Promise<ZephyrIntegratedAddress> {
    throw new ZephyrError("Not supported");
  }
  
  /**
   * Get the block height that the wallet is synced to.
   * 
   * @return {Promise<number>} the block height that the wallet is synced to
   */
  async getHeight(): Promise<number> {
    throw new ZephyrError("Not supported");
  }
  
  /**
   * Get the blockchain's height.
   * 
   * @return {Promise<number>} the blockchain's height
   */
  async getDaemonHeight(): Promise<number> {
    throw new ZephyrError("Not supported");
  }
  
  /**
   * Get the blockchain's height by date as a conservative estimate for scanning.
   * 
   * @param {number} year - year of the height to get
   * @param {number} month - month of the height to get as a number between 1 and 12
   * @param {number} day - day of the height to get as a number between 1 and 31
   * @return {Promise<number>} the blockchain's approximate height at the given date
   */
  async getHeightByDate(year: number, month: number, day: number): Promise<number> {
    throw new ZephyrError("Not supported");
  }
  
  /**
   * Synchronize the wallet with the daemon as a one-time synchronous process.
   * 
   * @param {ZephyrWalletListener|number} [listenerOrStartHeight] - listener xor start height (defaults to no sync listener, the last synced block)
   * @param {number} [startHeight] - startHeight if not given in first arg (defaults to last synced block)
   * @return {Promise<void>}
   */
  async sync(listenerOrStartHeight?: ZephyrWalletListener | number, startHeight?: number): Promise<ZephyrSyncResult> {
    throw new ZephyrError("Not supported");
  }
  
  /**
   * Start background synchronizing with a maximum period between syncs.
   * 
   * @param {number} [syncPeriodInMs] - maximum period between syncs in milliseconds (default is wallet-specific)
   * @return {Promise<void>}
   */
  async startSyncing(syncPeriodInMs?: number): Promise<void> {
    throw new ZephyrError("Not supported");
  }
  
  /**
   * Stop synchronizing the wallet with the daemon.
   * 
   * @return {Promise<void>}
   */
  async stopSyncing(): Promise<void> {
    throw new ZephyrError("Not supported");
  }
  
  /**
   * Scan transactions by their hash/id.
   * 
   * @param {string[]} txHashes - tx hashes to scan
   * @return {Promise<void>}
   */
  async scanTxs(txHashes: string[]): Promise<void> {
    throw new ZephyrError("Not supported");
  }
  
  /**
   * <p>Rescan the blockchain for spent outputs.</p>
   * 
   * <p>Note: this can only be called with a trusted daemon.</p>
   * 
   * <p>Example use case: peer multisig hex is import when connected to an untrusted daemon,
   * so the wallet will not rescan spent outputs.  Then the wallet connects to a trusted
   * daemon.  This method should be manually invoked to rescan outputs.</p>
   * 
   * @return {Promise<void>}
   */
  async rescanSpent(): Promise<void> {
    throw new ZephyrError("Not supported");
  }
  
  /**
   * <p>Rescan the blockchain from scratch, losing any information which cannot be recovered from
   * the blockchain itself.</p>
   * 
   * <p>WARNING: This method discards local wallet data like destination addresses, tx secret keys,
   * tx notes, etc.</p>
   * 
   * @return {Promise<void>}
   */
  async rescanBlockchain(): Promise<void> {
    throw new ZephyrError("Not supported");
  }
  
  /**
   * Get the balance of the wallet, account, or subaddress.
   * 
   * @param {number} [accountIdx] - index of the account to get the balance of (default all accounts)
   * @param {number} [subaddressIdx] - index of the subaddress to get the balance of (default all subaddresses)
   * @return {Promise<bigint>} the balance of the wallet, account, or subaddress
   */
  async getBalance(accountIdx?: number, subaddressIdx?: number): Promise<bigint> {
    throw new ZephyrError("Not supported");
  }
  
  /**
   * Get the unlocked balance of the wallet, account, or subaddress.
   * 
   * @param {number} [accountIdx] - index of the account to get the unlocked balance of (optional)
   * @param {number} [subaddressIdx] - index of the subaddress to get the unlocked balance of (optional)
   * @return {Promise<bigint>} the unlocked balance of the wallet, account, or subaddress
   */
  async getUnlockedBalance(accountIdx?: number, subaddressIdx?: number): Promise<bigint> {
    throw new ZephyrError("Not supported");
  }
  
  /**
   * Get the number of blocks until the next and last funds unlock. Ignores txs with unlock time as timestamp.
   * 
   * @return {Promise<number[]>} the number of blocks until the next and last funds unlock in elements 0 and 1, respectively, or undefined if no balance
   */
  async getNumBlocksToUnlock(): Promise<number[]|undefined> {
    
    // get balances
    let balance = await this.getBalance();
    if (balance === 0n) return [undefined, undefined]; // skip if no balance
    let unlockedBalance = await this.getUnlockedBalance();
    
    // compute number of blocks until next funds available
    let txs: ZephyrTxWallet[];
    let height: number;
    let numBlocksToNextUnlock = undefined;
    if (unlockedBalance > 0n) numBlocksToNextUnlock = 0;
    else {
      txs = await this.getTxs({isLocked: true}); // get locked txs
      height = await this.getHeight(); // get most recent height
      for (let tx of txs) {
        if (!tx.getIsConfirmed() && ZephyrUtils.isTimestamp(tx.getUnlockTime())) continue;
        let numBlocksToUnlock = Math.max((tx.getIsConfirmed() ? tx.getHeight() : height) + 10, Number(tx.getUnlockTime())) - height;
        numBlocksToNextUnlock = numBlocksToNextUnlock === undefined ? numBlocksToUnlock : Math.min(numBlocksToNextUnlock, numBlocksToUnlock);
      }
    }
    
    // compute number of blocks until all funds available
    let numBlocksToLastUnlock = undefined;
    if (balance === unlockedBalance) {
      if (unlockedBalance > 0n) numBlocksToLastUnlock = 0;
    } else {
      if (!txs) {
        txs = await this.getTxs({isLocked: true}); // get locked txs
        height = await this.getHeight(); // get most recent height
      }
      for (let tx of txs) {
        if (!tx.getIsConfirmed() && ZephyrUtils.isTimestamp(tx.getUnlockTime())) continue;
        let numBlocksToUnlock = Math.max((tx.getIsConfirmed() ? tx.getHeight() : height) + 10, Number(tx.getUnlockTime())) - height;
        numBlocksToLastUnlock = numBlocksToLastUnlock === undefined ? numBlocksToUnlock : Math.max(numBlocksToLastUnlock, numBlocksToUnlock);
      }
    }
    
    return [numBlocksToNextUnlock, numBlocksToLastUnlock];
  }
  
  /**
   * Get accounts with a given tag.
   * 
   * @param {boolean} includeSubaddresses - include subaddresses if true
   * @param {string} tag - tag for filtering accounts, all accounts if undefined
   * @return {Promise<ZephyrAccountInherited[]>} all accounts with the given tag
   */
  async getAccounts(includeSubaddresses?: boolean, tag?: string): Promise<ZephyrAccountInherited[]> {
    throw new ZephyrError("Not supported");
  }
  
  /**
   * Get an account.
   * 
   * @param {number} accountIdx - index of the account to get
   * @param {boolean} includeSubaddresses - include subaddresses if true
   * @return {Promise<ZephyrAccountInherited>} the retrieved account
   */
  async getAccount(accountIdx: number, includeSubaddresses?: boolean): Promise<ZephyrAccountInherited> {
    throw new ZephyrError("Not supported");
  }
  
  /**
   * Create a new account with a label for the first subaddress.
   * 
   * @param {string} [label] - label for account's first subaddress (optional)
   * @return {Promise<ZephyrAccountInherited>} the created account
   */
  async createAccount(label?: string): Promise<ZephyrAccountInherited> {
    throw new ZephyrError("Not supported");
  }

  /**
   * Set an account label.
   * 
   * @param {number} accountIdx - index of the account to set the label for
   * @param {string} label - the label to set
   * @return {Promise<void>}
   */
  async setAccountLabel(accountIdx: number, label: string): Promise<void> {
    await this.setSubaddressLabel(accountIdx, 0, label);
  }
  
  /**
   * Get subaddresses in an account.
   * 
   * @param {number} accountIdx - account to get subaddresses within
   * @param {number[]} [subaddressIndices] - indices of subaddresses to get (optional)
   * @return {Promise<ZephyrSubaddressInherited[]>} the retrieved subaddresses
   */
  async getSubaddresses(accountIdx: number, subaddressIndices?: number[]): Promise<ZephyrSubaddressInherited[]> {
    throw new ZephyrError("Not supported");
  }
  
  /**
   * Get a subaddress.
   * 
   * @param {number} accountIdx - index of the subaddress's account
   * @param {number} subaddressIdx - index of the subaddress within the account
   * @return {Promise<ZephyrSubaddressInherited>} the retrieved subaddress
   */
  async getSubaddress(accountIdx: number, subaddressIdx: number): Promise<ZephyrSubaddressInherited> {
    assert(accountIdx >= 0);
    assert(subaddressIdx >= 0);
    return (await this.getSubaddresses(accountIdx, [subaddressIdx]))[0];
  }
  
  /**
   * Create a subaddress within an account.
   * 
   * @param {number} accountIdx - index of the account to create the subaddress within
   * @param {string} [label] - the label for the subaddress (optional)
   * @return {Promise<ZephyrSubaddressInherited>} the created subaddress
   */
  async createSubaddress(accountIdx: number, label?: string): Promise<ZephyrSubaddressInherited> {
    throw new ZephyrError("Not supported");
  }

  /**
   * Set a subaddress label.
   * 
   * @param {number} accountIdx - index of the account to set the label for
   * @param {number} subaddressIdx - index of the subaddress to set the label for
   * @param {Promise<string>} label - the label to set
   */
  async setSubaddressLabel(accountIdx: number, subaddressIdx: number, label: string): Promise<void> {
    throw new ZephyrError("Not supported");
  }
  
  /**
   * Get a wallet transaction by hash.
   * 
   * @param {string} txHash - hash of a transaction to get
   * @return {Promise<ZephyrTxWallet> } the identified transaction or undefined if not found
   */
  async getTx(txHash: string): Promise<ZephyrTxWallet|undefined> {
    let txs = await this.getTxs([txHash]);
    return txs.length === 0 ? undefined : txs[0]; 
  }
  
  /**
   * <p>Get wallet transactions.  Wallet transactions contain one or more
   * transfers that are either incoming or outgoing to the wallet.<p>
   * 
   * <p>Results can be filtered by passing a query object.  Transactions must
   * meet every criteria defined in the query in order to be returned.  All
   * criteria are optional and no filtering is applied when not defined.</p>
   * 
   * @param {string[] | ZephyrTxQuery} [query] - configures the query (optional)
   * @param {boolean} [query.isConfirmed] - get txs that are confirmed or not (optional)
   * @param {boolean} [query.inTxPool] - get txs that are in the tx pool or not (optional)
   * @param {boolean} [query.isRelayed] - get txs that are relayed or not (optional)
   * @param {boolean} [query.isFailed] - get txs that are failed or not (optional)
   * @param {boolean} [query.isMinerTx] - get miner txs or not (optional)
   * @param {string} [query.hash] - get a tx with the hash (optional)
   * @param {string[]} [query.hashes] - get txs with the hashes (optional)
   * @param {string} [query.paymentId] - get transactions with the payment id (optional)
   * @param {string[]} [query.paymentIds] - get transactions with the payment ids (optional)
   * @param {boolean} [query.hasPaymentId] - get transactions with a payment id or not (optional)
   * @param {number} [query.minHeight] - get txs with height >= the given height (optional)
   * @param {number} [query.maxHeight] - get txs with height <= the given height (optional)
   * @param {boolean} [query.isOutgoing] - get txs with an outgoing transfer or not (optional)
   * @param {boolean} [query.isIncoming] - get txs with an incoming transfer or not (optional)
   * @param {ZephyrTransferQuery} [query.transferQuery] - get txs that have a transfer that meets this query (optional)
   * @param {boolean} [query.includeOutputs] - specifies that tx outputs should be returned with tx results (optional)
   * @return {Promise<ZephyrTxWallet[]>} wallet transactions per the configuration
   */
  async getTxs(query?: string[] | Partial<ZephyrTxQuery>): Promise<ZephyrTxWallet[]> {
    throw new ZephyrError("Not supported");
  }

  /**
   * <p>Get incoming and outgoing transfers to and from this wallet.  An outgoing
   * transfer represents a total amount sent from one or more subaddresses
   * within an account to individual destination addresses, each with their
   * own amount.  An incoming transfer represents a total amount received into
   * a subaddress within an account.  Transfers belong to transactions which
   * are stored on the blockchain.</p>
   * 
   * <p>Results can be filtered by passing a query object.  Transfers must
   * meet every criteria defined in the query in order to be returned.  All
   * criteria are optional and no filtering is applied when not defined.</p>
   * 
   * @param {ZephyrTransferQuery} [query] - configures the query (optional)
   * @param {boolean} [query.isOutgoing] - get transfers that are outgoing or not (optional)
   * @param {boolean} [query.isIncoming] - get transfers that are incoming or not (optional)
   * @param {string} [query.address] - wallet's address that a transfer either originated from (if outgoing) or is destined for (if incoming) (optional)
   * @param {number} [query.accountIndex] - get transfers that either originated from (if outgoing) or are destined for (if incoming) a specific account index (optional)
   * @param {number} [query.subaddressIndex] - get transfers that either originated from (if outgoing) or are destined for (if incoming) a specific subaddress index (optional)
   * @param {int[]} [query.subaddressIndices] - get transfers that either originated from (if outgoing) or are destined for (if incoming) specific subaddress indices (optional)
   * @param {bigint} [query.amount] - amount being transferred (optional)
   * @param {ZephyrDestination[] | ZephyrDestinationModel[]} [query.destinations] - individual destinations of an outgoing transfer, which is local wallet data and NOT recoverable from the blockchain (optional)
   * @param {boolean} [query.hasDestinations] - get transfers that have destinations or not (optional)
   * @param {ZephyrTxQuery} [query.txQuery] - get transfers whose transaction meets this query (optional)
   * @return {Promise<ZephyrTransfer[]>} wallet transfers that meet the query
   */
  async getTransfers(query?: Partial<ZephyrTransferQuery>): Promise<ZephyrTransfer[]> {
    throw new ZephyrError("Not supported");
  }
  
  /**
   * Get incoming transfers.
   * 
   * @param {Partial<ZephyrTransferQuery>} [query] - configures the query (optional)
   * @param {string} [query.address] - get incoming transfers to a specific address in the wallet (optional)
   * @param {number} [query.accountIndex] - get incoming transfers to a specific account index (optional)
   * @param {number} [query.subaddressIndex] - get incoming transfers to a specific subaddress index (optional)
   * @param {int[]} [query.subaddressIndices] - get transfers destined for specific subaddress indices (optional)
   * @param {bigint} [query.amount] - amount being transferred (optional)
   * @param {ZephyrTxQuery} [query.txQuery] - get transfers whose transaction meets this query (optional)
   * @return {Promise<ZephyrIncomingTransfer[]>} incoming transfers that meet the query
   */
  async getIncomingTransfers(query?: Partial<ZephyrTransferQuery>): Promise<ZephyrIncomingTransfer[]> {
    const queryNormalized: ZephyrTransferQuery = ZephyrWalletBase.normalizeTransferQuery(query);
    if (queryNormalized.getIsIncoming() === false) throw new ZephyrError("Transfer query contradicts getting incoming transfers");
    queryNormalized.setIsIncoming(true);
    return this.getTransfers(queryNormalized) as unknown as ZephyrIncomingTransfer[];
  }
  
  /**
   * Get outgoing transfers.
   * 
   * @param {Partial<ZephyrTransferQuery>} [query] - configures the query (optional)
   * @param {string} [query.address] - get outgoing transfers from a specific address in the wallet (optional)
   * @param {number} [query.accountIndex] - get outgoing transfers from a specific account index (optional)
   * @param {number} [query.subaddressIndex] - get outgoing transfers from a specific subaddress index (optional)
   * @param {int[]} [query.subaddressIndices] - get outgoing transfers from specific subaddress indices (optional)
   * @param {bigint} [query.amount] - amount being transferred (optional)
   * @param {ZephyrDestination[] | ZephyrDestinationModel[]} [query.destinations] - individual destinations of an outgoing transfer, which is local wallet data and NOT recoverable from the blockchain (optional)
   * @param {boolean} [query.hasDestinations] - get transfers that have destinations or not (optional)
   * @param {ZephyrTxQuery} [query.txQuery] - get transfers whose transaction meets this query (optional)
   * @return {Promise<ZephyrOutgoingTransfer[]>} outgoing transfers that meet the query
   */
  async getOutgoingTransfers(query?: Partial<ZephyrTransferQuery>): Promise<ZephyrOutgoingTransfer[]> {
    const queryNormalized: ZephyrTransferQuery = ZephyrWalletBase.normalizeTransferQuery(query);
    if (queryNormalized.getIsOutgoing() === false) throw new ZephyrError("Transfer query contradicts getting outgoing transfers");
    queryNormalized.setIsOutgoing(true);
    return this.getTransfers(queryNormalized) as unknown as ZephyrOutgoingTransfer[];
  }
  
  /**
   * <p>Get outputs created from previous transactions that belong to the wallet
   * (i.e. that the wallet can spend one time).  Outputs are part of
   * transactions which are stored in blocks on the blockchain.</p>
   * 
   * <p>Results can be filtered by passing a query object.  Outputs must
   * meet every criteria defined in the query in order to be returned.  All
   * filtering is optional and no filtering is applied when not defined.</p>
   * 
   * @param {Parital<ZephyrOutputQuery>} [query] - configures the query (optional)
   * @param {number} [query.accountIndex] - get outputs associated with a specific account index (optional)
   * @param {number} [query.subaddressIndex] - get outputs associated with a specific subaddress index (optional)
   * @param {int[]} [query.subaddressIndices] - get outputs associated with specific subaddress indices (optional)
   * @param {bigint} [query.amount] - get outputs with a specific amount (optional)
   * @param {bigint} [query.minAmount] - get outputs greater than or equal to a minimum amount (optional)
   * @param {bigint} [query.maxAmount] - get outputs less than or equal to a maximum amount (optional)
   * @param {boolean} [query.isSpent] - get outputs that are spent or not (optional)
   * @param {string|ZephyrKeyImage} [query.keyImage] - get output with a key image or which matches fields defined in a ZephyrKeyImage (optional)
   * @param {ZephyrTxQuery} [query.txQuery] - get outputs whose transaction meets this filter (optional)
   * @return {Promise<ZephyrOutputWallet[]>} the queried outputs
   */
  async getOutputs(query?: Partial<ZephyrOutputQuery>): Promise<ZephyrOutputWallet[]> {
    throw new ZephyrError("Not supported");
  }
  
  /**
   * Export outputs in hex format.
   *
   * @param {boolean} [all] - export all outputs if true, else export the outputs since the last export (default false)
   * @return {Promise<string>} outputs in hex format
   */
  async exportOutputs(all = false): Promise<string> {
    throw new ZephyrError("Not supported");
  }
  
  /**
   * Import outputs in hex format.
   * 
   * @param {string} outputsHex - outputs in hex format
   * @return {Promise<number>} the number of outputs imported
   */
  async importOutputs(outputsHex: string): Promise<number> {
    throw new ZephyrError("Not supported");
  }
  
  /**
   * Export signed key images.
   * 
   * @param {boolean} [all] - export all key images if true, else export the key images since the last export (default false)
   * @return {Promise<ZephyrKeyImageExportResult>} the wallet's signed key images and their offset among the wallet's outputs
   */
  async exportKeyImages(all = false): Promise<ZephyrKeyImageExportResult> {
    throw new ZephyrError("Not supported");
  }
  
  /**
   * Import signed key images and verify their spent status.
   * 
   * @param {ZephyrKeyImage[]} keyImages - images to import and verify (requires hex and signature)
   * @param {number} [offset] - offset of the first key image among the wallet's outputs (default 0)
   * @return {Promise<ZephyrKeyImageImportResult>} results of the import
   */
  async importKeyImages(keyImages: ZephyrKeyImage[], offset = 0): Promise<ZephyrKeyImageImportResult> {
    throw new ZephyrError("Not supported");
  }
  
  /**
   * Get new key images from the last imported outputs.
   * 
   * @return {Promise<ZephyrKeyImage[]>} the key images from the last imported outputs
   */
  async getNewKeyImagesFromLastImport(): Promise<ZephyrKeyImage[]> {
    throw new ZephyrError("Not supported");
  }
  
  /**
   * Freeze an output.
   * 
   * @param {string} keyImage - key image of the output to freeze
   * @return {Promise<void>}
   */
  async freezeOutput(keyImage: string): Promise<void> {
    throw new ZephyrError("Not supported");
  }
  
  /**
   * Thaw a frozen output.
   * 
   * @param {string} keyImage - key image of the output to thaw
   * @return {Promise<void>}
   */
  async thawOutput(keyImage: string): Promise<void> {
    throw new ZephyrError("Not supported");
  }
  
  /**
   * Check if an output is frozen.
   * 
   * @param {string} keyImage - key image of the output to check if frozen
   * @return {Promise<boolean>} true if the output is frozen, false otherwise
   */
  async isOutputFrozen(keyImage: string): Promise<boolean> {
    throw new ZephyrError("Not supported");
  }

  /**
   * Get the current default fee priority (unimportant, normal, elevated, etc).
   * 
   * @return {Promise<ZephyrTxPriority>} the current fee priority
   */
  async getDefaultFeePriority(): Promise<ZephyrTxPriority> {
    throw new ZephyrError("Not supported");
  }
  
  /**
   * Create a transaction to transfer funds from this wallet.
   * 
   * @param {ZephyrTxConfig} config - configures the transaction to create (required)
   * @param {string} config.address - single destination address (required unless `destinations` provided)
   * @param {bigint|string} config.amount - single destination amount (required unless `destinations` provided)
   * @param {number} config.accountIndex - source account index to transfer funds from (required)
   * @param {number} [config.subaddressIndex] - source subaddress index to transfer funds from (optional)
   * @param {number[]} [config.subaddressIndices] - source subaddress indices to transfer funds from (optional)
   * @param {boolean} [config.relay] - relay the transaction to peers to commit to the blockchain (default false)
   * @param {ZephyrTxPriority} [config.priority] - transaction priority (default ZephyrTxPriority.NORMAL)
   * @param {ZephyrDestination[]} config.destinations - addresses and amounts in a multi-destination tx (required unless `address` and `amount` provided)
   * @param {number[]} [config.subtractFeeFrom] - list of destination indices to split the transaction fee (optional)
   * @param {string} [config.paymentId] - transaction payment ID (optional)
   * @param {bigint|string} [config.unlockTime] - minimum height or timestamp for the transaction to unlock (default 0)
   * @return {Promise<ZephyrTxWallet>} the created transaction
   */
  async createTx(config: Partial<ZephyrTxConfig>): Promise<ZephyrTxWallet> {
    const configNormalized: ZephyrTxConfig = ZephyrWalletBase.normalizeCreateTxsConfig(config);
    if (configNormalized.getCanSplit() !== undefined) assert.equal(configNormalized.getCanSplit(), false, "Cannot split transactions using createTx(); use createTxs()");
    configNormalized.setCanSplit(false);
    return (await this.createTxs(configNormalized))[0];
  }
  
  /**
   * Create one or more transactions to transfer funds from this wallet.
   * 
   * @param {Partial<ZephyrTxConfig>} config - configures the transactions to create (required)
   * @param {string} config.address - single destination address (required unless `destinations` provided)
   * @param {bigint|string} config.amount - single destination amount (required unless `destinations` provided)
   * @param {number} config.accountIndex - source account index to transfer funds from (required)
   * @param {number} [config.subaddressIndex] - source subaddress index to transfer funds from (optional)
   * @param {int[]} [config.subaddressIndices] - source subaddress indices to transfer funds from (optional)
   * @param {boolean} [config.relay] - relay the transactions to peers to commit to the blockchain (default false)
   * @param {ZephyrTxPriority} [config.priority] - transaction priority (default ZephyrTxPriority.NORMAL)
   * @param {ZephyrDestination[] | ZephyrDestinationModel[]} config.destinations - addresses and amounts in a multi-destination tx (required unless `address` and `amount` provided)
   * @param {string} [config.paymentId] - transaction payment ID (optional)
   * @param {bigint|string} [config.unlockTime] - minimum height or timestamp for the transactions to unlock (default 0)
   * @param {boolean} [config.canSplit] - allow funds to be transferred using multiple transactions (default true)
   * @return {Promise<ZephyrTxWallet[]>} the created transactions
   */
  async createTxs(config: Partial<ZephyrTxConfig>): Promise<ZephyrTxWallet[]> {
    throw new ZephyrError("Not supported");
  }
  
  /**
   * Sweep an output by key image.
   * 
   * @param {Partial<ZephyrTxConfig>} config - configures the transaction to create (required)
   * @param {string} config.address - single destination address (required)
   * @param {string} config.keyImage - key image to sweep (required)
   * @param {boolean} [config.relay] - relay the transaction to peers to commit to the blockchain (default false)
   * @param {bigint|string} [config.unlockTime] - minimum height or timestamp for the transaction to unlock (default 0)
   * @param {ZephyrTxPriority} [config.priority] - transaction priority (default ZephyrTxPriority.NORMAL)
   * @return {Promise<ZephyrTxWallet>} the created transaction
   */
  async sweepOutput(config: Partial<ZephyrTxConfig>): Promise<ZephyrTxWallet> {
    throw new ZephyrError("Not supported");
  }

  /**
   * Sweep all unlocked funds according to the given configuration.
   * 
   * @param {Partial<ZephyrTxConfig>} config - configures the transactions to create (required)
   * @param {string} config.address - single destination address (required)
   * @param {number} [config.accountIndex] - source account index to sweep from (optional, defaults to all accounts)
   * @param {number} [config.subaddressIndex] - source subaddress index to sweep from (optional, defaults to all subaddresses)
   * @param {number[]} [config.subaddressIndices] - source subaddress indices to sweep from (optional)
   * @param {boolean} [config.relay] - relay the transactions to peers to commit to the blockchain (default false)
   * @param {ZephyrTxPriority} [config.priority] - transaction priority (default ZephyrTxPriority.NORMAL)
   * @param {bigint|string} [config.unlockTime] - minimum height or timestamp for the transactions to unlock (default 0)
   * @param {boolean} [config.sweepEachSubaddress] - sweep each subaddress individually if true (default false)
   * @return {Promise<ZephyrTxWallet[]>} the created transactions
   */
  async sweepUnlocked(config: Partial<ZephyrTxConfig>): Promise<ZephyrTxWallet[]> {
    throw new ZephyrError("Not supported");
  }
  
  /**
   * <p>Sweep all unmixable dust outputs back to the wallet to make them easier to spend and mix.</p>
   * 
   * <p>NOTE: Dust only exists pre RCT, so this method will throw "no dust to sweep" on new wallets.</p>
   * 
   * @param {boolean} [relay] - specifies if the resulting transaction should be relayed (default false)
   * @return {Promise<ZephyrTxWallet[]>} the created transactions
   */
  async sweepDust(relay?: boolean): Promise<ZephyrTxWallet[]> {
    throw new ZephyrError("Not supported");
  }
  
  /**
   * Relay a previously created transaction.
   * 
   * @param {(ZephyrTxWallet | string)} txOrMetadata - transaction or its metadata to relay
   * @return {Promise<string>} the hash of the relayed tx
   */
  async relayTx(txOrMetadata: ZephyrTxWallet | string): Promise<string> {
    return (await this.relayTxs([txOrMetadata]))[0];
  }
  
  /**
   * Relay previously created transactions.
   * 
   * @param {(ZephyrTxWallet[] | string[])} txsOrMetadatas - transactions or their metadata to relay
   * @return {Promise<string[]>} the hashes of the relayed txs
   */
  async relayTxs(txsOrMetadatas: (ZephyrTxWallet | string)[]): Promise<string[]> {
    throw new ZephyrError("Not supported");
  }
  
  /**
   * Describe a tx set from unsigned tx hex.
   * 
   * @param {string} unsignedTxHex - unsigned tx hex
   * @return {Promise<ZephyrTxSet>} the tx set containing structured transactions
   */
  async describeUnsignedTxSet(unsignedTxHex: string): Promise<ZephyrTxSet> {
    return this.describeTxSet(new ZephyrTxSet().setUnsignedTxHex(unsignedTxHex));
  }
  
  /**
   * Describe a tx set from multisig tx hex.
   * 
   * @param {string} multisigTxHex - multisig tx hex
   * @return {Promise<ZephyrTxSet>} the tx set containing structured transactions
   */
  async describeMultisigTxSet(multisigTxHex: string): Promise<ZephyrTxSet> {
    return this.describeTxSet(new ZephyrTxSet().setMultisigTxHex(multisigTxHex));
  }
  
  /**
   * Describe a tx set containing unsigned or multisig tx hex to a new tx set containing structured transactions.
   * 
   * @param {ZephyrTxSet} txSet - a tx set containing unsigned or multisig tx hex
   * @return {Promise<ZephyrTxSet>} txSet - the tx set containing structured transactions
   */
  async describeTxSet(txSet: ZephyrTxSet): Promise<ZephyrTxSet> {
    throw new ZephyrError("Not supported");
  }
  
  /**
   * Sign unsigned transactions from a view-only wallet.
   * 
   * @param {string} unsignedTxHex - unsigned transaction hex from when the transactions were created
   * @return {Promise<ZephyrTxSet>} the signed transaction set
   */
  async signTxs(unsignedTxHex: string): Promise<ZephyrTxSet> {
    throw new ZephyrError("Not supported");
  }
  
  /**
   * Submit signed transactions from a view-only wallet.
   * 
   * @param {string} signedTxHex - signed transaction hex from signTxs()
   * @return {Promise<string[]>} the resulting transaction hashes
   */
  async submitTxs(signedTxHex: string): Promise<string[]> {
    throw new ZephyrError("Not supported");
  }
  
  /**
   * Sign a message.
   * 
   * @param {string} message - the message to sign
   * @param {ZephyrMessageSignatureType} [signatureType] - sign with spend key or view key (default spend key)
   * @param {number} [accountIdx] - the account index of the message signature (default 0)
   * @param {number} [subaddressIdx] - the subaddress index of the message signature (default 0)
   * @return {Promise<string>} the signature
   */
  async signMessage(message: string, signatureType = ZephyrMessageSignatureType.SIGN_WITH_SPEND_KEY, accountIdx = 0, subaddressIdx = 0): Promise<string> {
    throw new ZephyrError("Not supported");
  }
  
  /**
   * Verify a signature on a message.
   * 
   * @param {string} message - signed message
   * @param {string} address - signing address
   * @param {string} signature - signature
   * @return {Promise<ZephyrMessageSignatureResult>} true if the signature is good, false otherwise
   */
  async verifyMessage(message: string, address: string, signature: string): Promise<ZephyrMessageSignatureResult> {
    throw new ZephyrError("Not supported");
  }
  
  /**
   * Get a transaction's secret key from its hash.
   * 
   * @param {string} txHash - transaction's hash
   * @return {Promise<string>} - transaction's secret key
   */
  async getTxKey(txHash: string): Promise<string> {
    throw new ZephyrError("Not supported");
  }
  
  /**
   * Check a transaction in the blockchain with its secret key.
   * 
   * @param {string} txHash - transaction to check
   * @param {string} txKey - transaction's secret key
   * @param {string} address - destination public address of the transaction
   * @return {romise<ZephyrCheckTx>} the result of the check
   */
  async checkTxKey(txHash: string, txKey: string, address: string): Promise<ZephyrCheckTx> {
    throw new ZephyrError("Not supported");
  }
  
  /**
   * Get a transaction signature to prove it.
   * 
   * @param {string} txHash - transaction to prove
   * @param {string} address - destination public address of the transaction
   * @param {string} [message] - message to include with the signature to further authenticate the proof (optional)
   * @return {Promise<string>} the transaction signature
   */
  async getTxProof(txHash: string, address: string, message?: string): Promise<string> {
    throw new ZephyrError("Not supported");
  }
  
  /**
   * Prove a transaction by checking its signature.
   * 
   * @param {string} txHash - transaction to prove
   * @param {string} address - destination public address of the transaction
   * @param {string | undefined} message - message included with the signature to further authenticate the proof
   * @param {string} signature  - transaction signature to confirm
   * @return {Promise<ZephyrCheckTx>} the result of the check
   */
  async checkTxProof(txHash: string, address: string, message: string | undefined, signature: string): Promise<ZephyrCheckTx> {
    throw new ZephyrError("Not supported");
  }
  
  /**
   * Generate a signature to prove a spend. Unlike proving a transaction, it does not require the destination public address.
   * 
   * @param {string} txHash - transaction to prove
   * @param {string} [message] - message to include with the signature to further authenticate the proof (optional)
   * @return {Promise<string>} the transaction signature
   */
  async getSpendProof(txHash: string, message?: string): Promise<string> {
    throw new ZephyrError("Not supported");
  }
  
  /**
   * Prove a spend using a signature. Unlike proving a transaction, it does not require the destination public address.
   * 
   * @param {string} txHash - transaction to prove
   * @param {string | undefined} message - message included with the signature to further authenticate the proof (optional)
   * @param {string} signature - transaction signature to confirm
   * @return {Promise<boolean>} true if the signature is good, false otherwise
   */
  async checkSpendProof(txHash: string, message: string | undefined, signature: string): Promise<boolean> {
    throw new ZephyrError("Not supported");
  }
  
  /**
   * Generate a signature to prove the entire balance of the wallet.
   * 
   * @param {string} [message] - message included with the signature to further authenticate the proof (optional)
   * @return {Promise<string>} the reserve proof signature
   */
  async getReserveProofWallet(message?: string): Promise<string> {
    throw new ZephyrError("Not supported");
  }
  
  /**
   * Generate a signature to prove an available amount in an account.
   * 
   * @param {number} accountIdx - account to prove ownership of the amount
   * @param {bigint} amount - minimum amount to prove as available in the account
   * @param {string} [message] - message to include with the signature to further authenticate the proof (optional)
   * @return {Promise<string>} the reserve proof signature
   */
  async getReserveProofAccount(accountIdx: number, amount: bigint, message?: string): Promise<string> {
    throw new ZephyrError("Not supported");
  }

  /**
   * Proves a wallet has a disposable reserve using a signature.
   * 
   * @param {string} address - public wallet address
   * @param {string | undefined} message - message included with the signature to further authenticate the proof (optional)
   * @param {string} signature - reserve proof signature to check
   * @return {Promise<ZephyrCheckReserve>} the result of checking the signature proof
   */
  async checkReserveProof(address: string, message: string | undefined, signature: string): Promise<ZephyrCheckReserve> {
    throw new ZephyrError("Not supported");
  }
  
  /**
   * Get a transaction note.
   * 
   * @param {string} txHash - transaction to get the note of
   * @return {Promise<string>} the tx note
   */
  async getTxNote(txHash: string): Promise<string> {
    return (await this.getTxNotes([txHash]))[0];
  }
  
  /**
   * Get notes for multiple transactions.
   * 
   * @param {string[]} txHashes - hashes of the transactions to get notes for
   * @return {Promise<string[]>} notes for the transactions
   */
  async getTxNotes(txHashes: string[]): Promise<string[]> {
    throw new ZephyrError("Not supported");
  }
  
  /**
   * Set a note for a specific transaction.
   * 
   * @param {string} txHash - hash of the transaction to set a note for
   * @param {string} note - the transaction note
   * @return {Promise<void>}
   */
  async setTxNote(txHash: string, note: string): Promise<void> {
    await this.setTxNotes([txHash], [note]);
  }
  
  /**
   * Set notes for multiple transactions.
   * 
   * @param {string[]} txHashes - transactions to set notes for
   * @param {string[]} notes - notes to set for the transactions
   * @return {Promise<void>}
   */
  async setTxNotes(txHashes: string[], notes: string[]): Promise<void> {
    throw new ZephyrError("Not supported");
  }
  
  /**
   * Get address book entries.
   * 
   * @param {number[]} [entryIndices] - indices of the entries to get
   * @return {Promise<ZephyrAddressBookEntry[]>} the address book entries
   */
  async getAddressBookEntries(entryIndices?: number[]): Promise<ZephyrAddressBookEntry[]> {
    throw new ZephyrError("Not supported");
  }
  
  /**
   * Add an address book entry.
   * 
   * @param {string} address - entry address
   * @param {string} [description] - entry description (optional)
   * @return {Promise<number>} the index of the added entry
   */
  async addAddressBookEntry(address: string, description?: string): Promise<number> {
    throw new ZephyrError("Not supported");
  }
  
  /**
   * Edit an address book entry.
   * 
   * @param {number} index - index of the address book entry to edit
   * @param {boolean} setAddress - specifies if the address should be updated
   * @param {string | undefined} address - updated address
   * @param {boolean} setDescription - specifies if the description should be updated
   * @param {string | undefined} description - updated description
   * @return {Promise<void>}
   */
  async editAddressBookEntry(index: number, setAddress: boolean, address: string | undefined, setDescription: boolean, description: string | undefined): Promise<void> {
    throw new ZephyrError("Not supported");
  }
  
  /**
   * Delete an address book entry.
   * 
   * @param {number} entryIdx - index of the entry to delete
   * @return {Promise<void>}
   */
  async deleteAddressBookEntry(entryIdx: number): Promise<void> {
    throw new ZephyrError("Not supported");
  }
  
  /**
   * Tag accounts.
   * 
   * @param {string} tag - tag to apply to the specified accounts
   * @param {number[]} accountIndices - indices of the accounts to tag
   * @return {Promise<void>}
   */
  async tagAccounts(tag: string, accountIndices: number[]): Promise<void> {
    throw new ZephyrError("Not supported");
  }

  /**
   * Untag accounts.
   * 
   * @param {number[]} accountIndices - indices of the accounts to untag
   * @return {Promise<void>}
   */
  async untagAccounts(accountIndices: number[]): Promise<void> {
    throw new ZephyrError("Not supported");
  }
  
  /**
   * Return all account tags.
   * 
   * @return {Promise<ZephyrAccountTag[]>} the wallet's account tags
   */
  async getAccountTags(): Promise<ZephyrAccountTag[]> {
    throw new ZephyrError("Not supported");
  }

  /**
   * Sets a human-readable description for a tag.
   * 
   * @param {string} tag - tag to set a description for
   * @param {string} label - label to set for the tag
   * @return {Promise<void>}
   */
  async setAccountTagLabel(tag: string, label: string): Promise<void> {
    throw new ZephyrError("Not supported");
  }
  
  /**
   * Creates a payment URI from a send configuration.
   * 
   * @param {ZephyrTxConfig} config - specifies configuration for a potential tx
   * @return {Promise<string>} the payment uri
   */
  async getPaymentUri(config: ZephyrTxConfig): Promise<string> {
    throw new ZephyrError("Not supported");
  }
  
  /**
   * Parses a payment URI to a tx config.
   * 
   * @param {string} uri - payment uri to parse
   * @return {Promise<ZephyrTxConfig>} the send configuration parsed from the uri
   */
  async parsePaymentUri(uri: string): Promise<ZephyrTxConfig> {
    throw new ZephyrError("Not supported");
  }
  
  /**
   * Get an attribute.
   * 
   * @param {string} key - attribute to get the value of
   * @return {Promise<string>} the attribute's value
   */
  async getAttribute(key: string): Promise<string> {
    throw new ZephyrError("Not supported");
  }
  
  /**
   * Set an arbitrary attribute.
   * 
   * @param {string} key - attribute key
   * @param {string} val - attribute value
   * @return {Promise<void>}
   */
  async setAttribute(key: string, val: string): Promise<void> {
    throw new ZephyrError("Not supported");
  }
  
  /**
   * Start mining.
   * 
   * @param {number} [numThreads] - number of threads created for mining (optional)
   * @param {boolean} [backgroundMining] - specifies if mining should occur in the background (optional)
   * @param {boolean} [ignoreBattery] - specifies if the battery should be ignored for mining (optional)
   * @return {Promise<void>}
   */
  async startMining(numThreads: number, backgroundMining?: boolean, ignoreBattery?: boolean): Promise<void> {
    throw new ZephyrError("Not supported");
  }
  
  /**
   * Stop mining.
   * 
   * @return {Promise<void>}
   */
  async stopMining(): Promise<void> {
    throw new ZephyrError("Not supported");
  }
  
  /**
   * Indicates if importing multisig data is needed for returning a correct balance.
   * 
   * @return {Promise<boolean>} true if importing multisig data is needed for returning a correct balance, false otherwise
   */
  async isMultisigImportNeeded(): Promise<boolean> {
    throw new ZephyrError("Not supported");
  }
  
  /**
   * Indicates if this wallet is a multisig wallet.
   * 
   * @return {Promise<boolean>} true if this is a multisig wallet, false otherwise
   */
  async isMultisig(): Promise<boolean> {
    return (await this.getMultisigInfo()).getIsMultisig();
  }
  
  /**
   * Get multisig info about this wallet.
   * 
   * @return {Promise<ZephyrMultisigInfo>} multisig info about this wallet
   */
  async getMultisigInfo(): Promise<ZephyrMultisigInfo> {
    throw new ZephyrError("Not supported");
  }
  
  /**
   * Get multisig info as hex to share with participants to begin creating a
   * multisig wallet.
   * 
   * @return {Promise<string>} this wallet's multisig hex to share with participants
   */
  async prepareMultisig(): Promise<string> {
    throw new ZephyrError("Not supported");
  }
  
  /**
   * Make this wallet multisig by importing multisig hex from participants.
   * 
   * @param {string[]} multisigHexes - multisig hex from each participant
   * @param {number} threshold - number of signatures needed to sign transfers
   * @param {string} password - wallet password
   * @return {Promise<string>} this wallet's multisig hex to share with participants
   */
  async makeMultisig(multisigHexes: string[], threshold: number, password: string): Promise<string> {
    throw new ZephyrError("Not supported");
  }
  
  /**
   * Exchange multisig hex with participants in a M/N multisig wallet.
   * 
   * This process must be repeated with participants exactly N-M times.
   * 
   * @param {string[]} multisigHexes are multisig hex from each participant
   * @param {string} password - wallet's password // TODO monero-project: redundant? wallet is created with password
   * @return {Promise<ZephyrMultisigInitResult>} the result which has the multisig's address xor this wallet's multisig hex to share with participants iff not done
   */
  async exchangeMultisigKeys(multisigHexes: string[], password: string): Promise<ZephyrMultisigInitResult> {
    throw new ZephyrError("Not supported");
  }
  
  /**
   * Export this wallet's multisig info as hex for other participants.
   * 
   * @return {Promise<string>} this wallet's multisig info as hex for other participants
   */
  async exportMultisigHex(): Promise<string> {
    throw new ZephyrError("Not supported");
  }
  
  /**
   * Import multisig info as hex from other participants.
   * 
   * @param {string[]} multisigHexes - multisig hex from each participant
   * @param {boolean} [refreshAfterImport] - specifies if the wallet should be refreshed after importing multisig hex (default true)
   * @return {Promise<number>} the number of outputs signed with the given multisig hex
   */
  async importMultisigHex(multisigHexes: string[], refreshAfterImport?: boolean): Promise<number> {
    throw new ZephyrError("Not supported");
  }
  
  /**
   * Sign multisig transactions from a multisig wallet.
   * 
   * @param {string} multisigTxHex - unsigned multisig transactions as hex
   * @return {ZephyrMultisigSignResult} the result of signing the multisig transactions
   */
  async signMultisigTxHex(multisigTxHex: string): Promise<ZephyrMultisigSignResult> {
    throw new ZephyrError("Not supported");
  }
  
  /**
   * Submit signed multisig transactions from a multisig wallet.
   * 
   * @param {string} signedMultisigTxHex - signed multisig hex returned from signMultisigTxHex()
   * @return {Promise<string[]>} the resulting transaction hashes
   */
  async submitMultisigTxHex(signedMultisigTxHex: string): Promise<string[]> {
    throw new ZephyrError("Not supported");
  }
  
  /**
   * Change the wallet password.
   * 
   * @param {string} oldPassword - the wallet's old password
   * @param {string} newPassword - the wallet's new password
   * @return {Promise<void>}
   */
  async changePassword(oldPassword: string, newPassword: string): Promise<void> {
    throw new ZephyrError("Not supported");
  }
  
  /**
   * Save the wallet at its current path.
   * 
   * @return {Promise<void>}
   */
  async save(): Promise<void> {
    throw new ZephyrError("Not supported");
  }
  
  /**
   * Optionally save then close the wallet.
   *
   * @param {boolean} [save] - specifies if the wallet should be saved before being closed (default false)
   * @return {Promise<void>}
   */
  async close(save = false): Promise<void> {
    if (this.connectionManager) this.connectionManager.removeListener(this.connectionManagerListener);
    this.connectionManager = undefined;
    this.connectionManagerListener = undefined;
    this.listeners.splice(0, this.listeners.length);
    this._isClosed = true;
  }
  
  /**
   * Indicates if this wallet is closed or not.
   * 
   * @return {Promise<boolean>} true if the wallet is closed, false otherwise
   */
  async isClosed(): Promise<boolean> {
    return this._isClosed;
  }
  
  // -------------------------------- PRIVATE ---------------------------------

  /**
   * @private
   */
  async announceSyncProgress(height: number, startHeight: number, endHeight: number, percentDone: number, message: string): Promise<void> {
    const generation = this.listenerGeneration;
    for (let listener of this.listeners.slice()) {
      if (this._isClosed || generation !== this.listenerGeneration) return;
      if (!this.listeners.includes(listener)) continue;
      try {
        await listener.onSyncProgress(height, startHeight, endHeight, percentDone, message);
      } catch (err) {
        console.error("Error calling listener on sync progress", err);
      }
    }
  }

  /**
   * @private
   */
  async announceNewBlock(height: number): Promise<void> {
    const generation = this.listenerGeneration;
    for (let listener of this.listeners.slice()) {
      if (this._isClosed || generation !== this.listenerGeneration) return;
      if (!this.listeners.includes(listener)) continue;
      try {
        await listener.onNewBlock(height);
      } catch (err) {
        console.error("Error calling listener on new block", err);
      }
    }
  }

  /**
   * @private
   */
  async announceBalancesChanged(newBalance: bigint, newUnlockedBalance: bigint): Promise<void> {
    const generation = this.listenerGeneration;
    for (let listener of this.listeners.slice()) {
      if (this._isClosed || generation !== this.listenerGeneration) return;
      if (!this.listeners.includes(listener)) continue;
      try {
        await listener.onBalancesChanged(newBalance, newUnlockedBalance);
      } catch (err) {
        console.error("Error calling listener on balances changed", err);
      }
    }
  }

  /**
   * @private
   */
  async announceOutputReceived(output: ZephyrOutputWallet): Promise<void> {
    const generation = this.listenerGeneration;
    for (let listener of this.listeners.slice()) {
      if (this._isClosed || generation !== this.listenerGeneration) return;
      if (!this.listeners.includes(listener)) continue;
      try {
        await listener.onOutputReceived(output);
      } catch (err) {
        console.error("Error calling listener on output received", err);
      }
    }
  }

  /**
   * @private
   */
  async announceOutputSpent(output: ZephyrOutputWallet): Promise<void> {
    const generation = this.listenerGeneration;
    for (let listener of this.listeners.slice()) {
      if (this._isClosed || generation !== this.listenerGeneration) return;
      if (!this.listeners.includes(listener)) continue;
      try {
        await listener.onOutputSpent(output);
      } catch (err) {
        console.error("Error calling listener on output spent", err);
      }
    }
  }
  
  protected static normalizeTxQuery(query): ZephyrTxQuery {
    if (query instanceof ZephyrTxQuery) query = query.copy();
    else if (Array.isArray(query)) query = new ZephyrTxQuery().setHashes(query);
    else {
      query = Object.assign({}, query);
      query = new ZephyrTxQuery(query);
    }
    if (query.getBlock() === undefined) query.setBlock(new ZephyrBlock().setTxs([query]));
    if (query.getInputQuery()) query.getInputQuery().setTxQuery(query);
    if (query.getOutputQuery()) query.getOutputQuery().setTxQuery(query);
    return query;
  }
  
  protected static normalizeTransferQuery(query): ZephyrTransferQuery {
    query = new ZephyrTransferQuery(query);
    if (query.getTxQuery() !== undefined) {
      let txQuery = query.getTxQuery().copy();
      query = txQuery.getTransferQuery();
    }
    if (query.getTxQuery() === undefined) query.setTxQuery(new ZephyrTxQuery());
    query.getTxQuery().setTransferQuery(query);
    if (query.getTxQuery().getBlock() === undefined) query.getTxQuery().setBlock(new ZephyrBlock().setTxs([query.getTxQuery()]));
    return query;
  }
  
  protected static normalizeOutputQuery(query): ZephyrOutputQuery {
    query = new ZephyrOutputQuery(query);
    if (query.getTxQuery() !== undefined) {
      let txQuery = query.getTxQuery().copy();
      query = txQuery.getOutputQuery();
    }
    if (query.getTxQuery() === undefined) query.setTxQuery(new ZephyrTxQuery());
    query.getTxQuery().setOutputQuery(query);
    if (query.getTxQuery().getBlock() === undefined) query.getTxQuery().setBlock(new ZephyrBlock().setTxs([query.getTxQuery()]));
    return query;
  }
  
  protected static normalizeCreateTxsConfig(config): ZephyrTxConfig {
    if (config === undefined || !(config instanceof Object)) throw new ZephyrError("Must provide ZephyrTxConfig or equivalent JS object");
    config = new ZephyrTxConfig(config);
    assert(config.getDestinations() && config.getDestinations().length > 0, "Must provide destinations");
    assert.equal(config.getSweepEachSubaddress(), undefined);
    assert.equal(config.getBelowAmount(), undefined);
    return config;
  }
  
  protected static normalizeSweepOutputConfig(config): ZephyrTxConfig {
    if (config === undefined || !(config instanceof Object)) throw new ZephyrError("Must provide ZephyrTxConfig or equivalent JS object");
    config = new ZephyrTxConfig(config);
    assert.equal(config.getSweepEachSubaddress(), undefined);
    assert.equal(config.getBelowAmount(), undefined);
    assert.equal(config.getCanSplit(), undefined, "Cannot split transactions when sweeping an output");
    if (!config.getDestinations() || config.getDestinations().length !== 1 || !config.getDestinations()[0].getAddress()) throw new ZephyrError("Must provide exactly one destination address to sweep output to");
    if (config.getSubtractFeeFrom() && config.getSubtractFeeFrom().length > 0) throw new ZephyrError("Sweep transactions do not support subtracting fees from destinations");
    return config;  
  }
  
  protected static normalizeSweepUnlockedConfig(config): ZephyrTxConfig {
    if (config === undefined || !(config instanceof Object)) throw new ZephyrError("Must provide ZephyrTxConfig or equivalent JS object");
    config = new ZephyrTxConfig(config);
    if (config.getDestinations() === undefined || config.getDestinations().length != 1) throw new ZephyrError("Must provide exactly one destination to sweep to");
    if (config.getDestinations()[0].getAddress() === undefined) throw new ZephyrError("Must provide destination address to sweep to");
    if (config.getDestinations()[0].getAmount() !== undefined) throw new ZephyrError("Cannot provide amount in sweep config");
    if (config.getKeyImage() !== undefined) throw new ZephyrError("Key image defined; use sweepOutput() to sweep an output by its key image");
    if (config.getSubaddressIndices() !== undefined && config.getSubaddressIndices().length === 0) config.setSubaddressIndices(undefined);
    if (config.getAccountIndex() === undefined && config.getSubaddressIndices() !== undefined) throw new ZephyrError("Must provide account index if subaddress indices are provided");
    if (config.getSubtractFeeFrom() && config.getSubtractFeeFrom().length > 0) throw new ZephyrError("Sweep transactions do not support subtracting fees from destinations");
    return config;
  }
}
