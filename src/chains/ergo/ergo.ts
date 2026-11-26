/**
 * The Ergo chain: one instance per network, everything network-specific from that
 * network's config or from its node.
 *
 * Venue connectors call the transaction service here (buildTransaction, signTransaction,
 * submitTransaction, sendTransaction); box selection, pending-box tracking, change, the
 * conservation check, signing, submit and poll are all in this layer.
 */
import * as fs from 'fs';
import * as path from 'path';

import { rootPath } from '../../paths';
import { TransactionStatusCode } from '../../schemas/chain-schema';
import { httpErrors } from '../../services/error-handler';
import { logger } from '../../services/logger';
import { WalletTokenBalance } from '../wallet-balances';

import { configuredAddressPrefixes, ErgoNetworkConfig, getErgoNetworkConfig, networks } from './ergo.config';
import { bigintsToStrings, parseNodeJson, toAmount } from './ergo.json';
import { ErgoNodeClient, ErgoNodeError, FetchLike, normalizeNodeBox, NodeTransaction } from './ergo.node-client';
import { ErgoPendingTracker, PendingTransaction } from './ergo.pending';
import { ErgoPendingFile } from './ergo.pending-file';
import { ErgoSigner, SignedErgoTransaction } from './ergo.signer';
import { buildTransfer } from './ergo.transfer';
import {
  assertTransactionBalanced,
  BuiltErgoTransaction,
  buildUnsignedTransaction,
  ErgoBuildError,
  ErgoBuildParams,
  ErgoTransactionAssertionError,
} from './ergo.tx-builder';
import { ErgoBox, ErgoTokenAmount, ErgoTokenInfo } from './ergo.types';
import {
  assertErgoId,
  decodeErgoAddress,
  decodeErgoAddressForPrefix,
  isErgoId,
  NATIVE_COIN_ID,
  toDecimalNumber,
} from './ergo.utils';
import { ErgoWalletAccount, loadErgoWallet } from './ergo.wallet';

/** A build request as connectors send it; height, fee and the node's parameters are filled in here. */
export type ErgoTransactionRequest = Omit<
  ErgoBuildParams,
  'height' | 'minValuePerByte' | 'fee' | 'feeErgoTree' | 'changeErgoTree' | 'excludeBoxIds'
> & {
  /** Change and, when walletBoxes is omitted, the boxes to select from. */
  changeAddress: string;
  fee?: bigint;
};

export interface ErgoPollResult {
  currentBlock: number;
  signature: string;
  txBlock: number | null;
  txStatus: TransactionStatusCode;
  fee: number | null;
  error: string | null;
  txData: Record<string, unknown> | null;
}

export class AmbiguousTokenError extends Error {
  constructor(symbol: string, ids: string[]) {
    super(`Token symbol ${symbol} names ${ids.length} tokens (${ids.join(', ')}); ask for it by token id`);
    this.name = 'AmbiguousTokenError';
  }
}

/**
 * The node may or may not have taken the transaction: the connection failed after it may
 * have been made (a reset, a timeout), the node answered 5xx, or it answered 200 without an
 * id. A connection never made is ErgoNotSubmittedError instead. The transaction stays
 * tracked (its inputs are not selected again); poll `txId` before doing the action again.
 */
export class ErgoSubmitOutcomeUnknownError extends ErgoNodeError {
  readonly txId: string;

  constructor(txId: string, cause: unknown) {
    const nodeError = cause instanceof ErgoNodeError ? cause : undefined;
    const causeText = cause instanceof Error ? cause.message : String(cause);
    super(
      nodeError?.status ?? 0,
      `Submit outcome unknown for ${txId}; poll it before retrying`,
      nodeError?.reason,
      nodeError?.detail ?? causeText,
    );
    this.name = 'ErgoSubmitOutcomeUnknownError';
    this.txId = txId;
  }
}

/**
 * The submit never reached the node: the connection to it was refused, or its name did
 * not resolve. No byte of the transaction was sent, so it cannot confirm from this submit;
 * it is no longer tracked. Retry once the node is reachable.
 */
export class ErgoNotSubmittedError extends ErgoNodeError {
  readonly txId: string;

  constructor(txId: string, cause: ErgoNodeError) {
    super(
      0,
      `Transaction ${txId} was not submitted: the node could not be reached (${cause.message}); ` +
        'nothing was sent, so it cannot confirm. Retry once the node is reachable',
      cause.reason,
      cause.detail,
      { cause },
    );
    this.name = 'ErgoNotSubmittedError';
    this.txId = txId;
  }
}

/** Transport error codes raised before a connection exists: nothing can have been sent. */
const CONNECT_PHASE_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN']);

/**
 * Whether a failed request provably failed before any connection was made: the error, or
 * the error its cause chain ends in, carries one of CONNECT_PHASE_CODES; for an error that
 * groups several (an AggregateError, one per address tried), every one of them does. An
 * error with any other code (a reset, a timeout) is not: part of the request may have
 * been sent.
 */
export function failedBeforeConnecting(error: unknown, depth = 0): boolean {
  if (depth > 10 || error === null || typeof error !== 'object') return false;
  const e = error as { code?: unknown; cause?: unknown; errors?: unknown };
  if (Array.isArray(e.errors) && e.errors.length > 0) {
    return e.errors.every((inner) => failedBeforeConnecting(inner, depth + 1));
  }
  if (e.code !== undefined) return typeof e.code === 'string' && CONNECT_PHASE_CODES.has(e.code);
  return e.cause !== undefined && failedBeforeConnecting(e.cause, depth + 1);
}

/** The node's own words for a rejection. */
function nodeText(error: ErgoNodeError): string {
  return error.detail ?? error.reason ?? error.message;
}

/**
 * A fixed input of the transaction (a contract box such as a pool) is already spent: by
 * one of our own pending transactions, or, on the node's evidence, by someone else. The
 * transaction cannot confirm. Retryable: read the box's successor and build again.
 * `nodeText` is the node's own rejection text when the node rejected the submit.
 */
export class ErgoInputSpentError extends Error {
  readonly boxIds: string[];
  readonly nodeText?: string;
  readonly retryable = true;

  constructor(message: string, boxIds: string[], nodeText?: string) {
    super(nodeText ? `${message}. Node said: ${nodeText}` : message);
    this.name = 'ErgoInputSpentError';
    this.boxIds = boxIds;
    this.nodeText = nodeText;
  }
}

/**
 * The node answered the submit with a 4xx: it refused the transaction, which therefore was
 * not taken from this submit. Not a fixed input spent first (that is ErgoInputSpentError).
 * Carries the node's own reason and detail.
 */
export class ErgoTransactionRejectedError extends ErgoNodeError {
  constructor(cause: ErgoNodeError) {
    super(cause.status, cause.message, cause.reason, cause.detail);
    this.name = 'ErgoTransactionRejectedError';
  }
}

/** Node rejection text that means an input is not (or no longer) in the UTXO set. */
const INPUT_GONE_TEXT = /double.?spend|utxo|missing input|input.{0,40}(not found|spent)|already spent/i;

/** What a connector may check on the built transaction, inside the lock, before it is signed. */
export interface ErgoSendOptions {
  verify?: (built: BuiltErgoTransaction) => void | Promise<void>;
}

export class Ergo {
  private static _instances: Record<string, Ergo> = {};

  readonly chain = 'ergo';
  readonly network: string;
  readonly config: ErgoNetworkConfig;
  readonly node: ErgoNodeClient;
  readonly pending: ErgoPendingTracker;
  private readonly tokenInfoCache = new Map<string, ErgoTokenInfo>();
  /** A token's total emission never changes once it is minted. */
  private readonly tokenEmissionCache = new Map<string, bigint>();
  /** One build-sign-submit at a time per wallet tree, so two sends never select the same boxes. */
  private readonly sendLocks = new Map<string, Promise<unknown>>();

  constructor(network: string, options: { config?: ErgoNetworkConfig; fetch?: FetchLike; now?: () => number } = {}) {
    this.network = network;
    this.config = options.config ?? getErgoNetworkConfig(network);
    this.node = new ErgoNodeClient(this.config.nodeURL, {
      timeoutMs: this.config.nodeTimeoutMs,
      pageSize: this.config.boxPageSize,
      fetch: options.fetch,
    });
    const timeoutMs = this.config.pendingTxTimeoutBlocks * this.config.blockTimeSeconds * 1000;
    const stateFile = this.config.pendingStateFile;
    this.pending = new ErgoPendingTracker(timeoutMs, options.now, {
      recentMs: this.config.blockTimeSeconds * 1000,
      file: stateFile ? new ErgoPendingFile(path.resolve(rootPath(), stateFile), network) : undefined,
    });
  }

  public static async getInstance(network: string): Promise<Ergo> {
    if (!networks.includes(network)) {
      throw new Error(`Unknown Ergo network: ${network}. Available: ${networks.join(', ')}`);
    }
    if (!Ergo._instances[network]) {
      const ergo = new Ergo(network);
      if (!ergo.config.pendingStateFile) {
        logger.warn(`ergo-${network}.pendingStateFile is not set: pending transactions are kept in memory only`);
      }
      Ergo._instances[network] = ergo;
    }
    return Ergo._instances[network];
  }

  /** For tests: drop cached instances. */
  public static clearInstances(): void {
    Ergo._instances = {};
  }

  get nativeTokenSymbol(): string {
    return this.config.nativeCurrencySymbol;
  }

  // -------------------------------------------------------------------------------------
  // Addresses

  /** An address valid on some configured Ergo network (for wallet files, which span networks). */
  public static validateAddress(address: string): string {
    const decoded = decodeErgoAddress(address);
    const prefixes = configuredAddressPrefixes();
    if (!prefixes.includes(decoded.prefix)) {
      throw new Error(
        `Invalid Ergo address: ${address} has prefix ${decoded.prefix}, which no configured Ergo network uses`,
      );
    }
    return address;
  }

  /** The address's tree, requiring this network's prefix. */
  public addressToErgoTree(address: string): string {
    return decodeErgoAddressForPrefix(address, this.config.addressPrefix).ergoTree;
  }

  // -------------------------------------------------------------------------------------
  // Chain state

  async getCurrentBlockNumber(): Promise<number> {
    return (await this.node.getInfo()).fullHeight;
  }

  /** Height and minimum value per byte, both from the node in one read. */
  async getBuildState(): Promise<{ height: number; minValuePerByte: bigint }> {
    const info = await this.node.getInfo();
    const perByte = info.parameters?.minValuePerByte;
    if (perByte === undefined) {
      throw new ErgoNodeError(200, 'Ergo node /info has no parameters.minValuePerByte');
    }
    return { height: info.fullHeight, minValuePerByte: toAmount(perByte, 'minValuePerByte') };
  }

  // -------------------------------------------------------------------------------------
  // Tokens. Identity is the token id; a symbol is only a name and may collide.

  async getTokenList(): Promise<ErgoTokenInfo[]> {
    const confRoot = path.resolve(rootPath(), 'conf');
    const tokensRoot = path.join(confRoot, 'tokens');
    const file = path.resolve(confRoot, this.config.tokenListSource);
    if (!file.startsWith(tokensRoot + path.sep)) {
      throw new Error(`ergo-${this.network}.tokenListSource must name a file inside conf/tokens/`);
    }
    if (!fs.existsSync(file)) {
      return [];
    }
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(raw)) {
      throw new Error(`Token list ${this.config.tokenListSource} is not an array`);
    }
    // The list may name the native coin under NATIVE_COIN_ID, for clients that read decimals
    // from it. It is not a token: here the native coin comes from the network config only.
    return raw
      .filter((t) => isErgoId(t?.address) && Number.isInteger(t?.decimals) && typeof t?.symbol === 'string')
      .filter((t) => String(t.address).toLowerCase() !== NATIVE_COIN_ID)
      .map((t) => ({
        address: String(t.address).toLowerCase(),
        symbol: String(t.symbol),
        name: typeof t.name === 'string' ? t.name : String(t.symbol),
        decimals: Number(t.decimals),
      }));
  }

  /**
   * A token by id: the token list first, then the node's index. Null if neither knows it.
   * Only hits are cached: the index may learn a token later (a fresh mint, a lagging index).
   */
  async getTokenById(tokenId: string): Promise<ErgoTokenInfo | null> {
    const id = assertErgoId(tokenId, 'token id');
    const listed = (await this.getTokenList()).find((t) => t.address === id);
    if (listed) return listed;
    const cached = this.tokenInfoCache.get(id);
    if (cached) return cached;
    const fromNode = await this.node.getToken(id);
    const info =
      fromNode && fromNode.decimals !== null
        ? { address: id, symbol: fromNode.name ?? id, name: fromNode.name ?? id, decimals: fromNode.decimals }
        : null;
    if (info) this.tokenInfoCache.set(id, info);
    return info;
  }

  /**
   * A token's total emission (the amount minted), from the node's index; null if the node
   * does not know the token. A token is minted once, so a known answer is cached for good.
   */
  async getTokenEmission(tokenId: string): Promise<bigint | null> {
    const id = assertErgoId(tokenId, 'token id');
    const cached = this.tokenEmissionCache.get(id);
    if (cached !== undefined) return cached;
    const emission = (await this.node.getToken(id))?.emissionAmount;
    if (emission === undefined) return null;
    this.tokenEmissionCache.set(id, emission);
    return emission;
  }

  /**
   * A token by id or by symbol. A symbol shared by two listed tokens throws
   * AmbiguousTokenError rather than picking one.
   */
  async getToken(idOrSymbol: string): Promise<ErgoTokenInfo | null> {
    if (isErgoId(idOrSymbol)) return this.getTokenById(idOrSymbol);
    const matches = (await this.getTokenList()).filter((t) => t.symbol.toLowerCase() === idOrSymbol.toLowerCase());
    if (matches.length > 1)
      throw new AmbiguousTokenError(
        idOrSymbol,
        matches.map((t) => t.address),
      );
    return matches[0] ?? null;
  }

  // -------------------------------------------------------------------------------------
  // Boxes and balances

  /**
   * Boxes at an address that are ours to spend: the node's unspent set including mempool
   * outputs and excluding mempool spends, minus boxes our own pending transactions spend,
   * plus their unconfirmed outputs the node does not list yet.
   */
  async getSpendableBoxes(address: string): Promise<ErgoBox[]> {
    const tree = this.addressToErgoTree(address);
    await this.checkOverduePending();
    const fromNode = await this.node.getUnspentBoxesByAddress(address, {
      includeUnconfirmed: true,
      excludeMempoolSpent: true,
    });
    return this.pending.available(fromNode, tree);
  }

  async getBalances(address: string, tokens?: string[]): Promise<WalletTokenBalance[]> {
    this.addressToErgoTree(address); // refuse another network's address before any read
    const boxes = await this.getSpendableBoxes(address);
    let nanoErgs = 0n;
    const held = new Map<string, bigint>();
    for (const box of boxes) {
      nanoErgs += box.value;
      for (const a of box.assets) held.set(a.tokenId, (held.get(a.tokenId) ?? 0n) + a.amount);
    }
    const native = this.config.nativeCurrencySymbol;
    const nativeBalance = toDecimalNumber(nanoErgs, this.config.nativeDecimals);
    const list = await this.getTokenList();
    const requested = tokens && tokens.length > 0 ? tokens : undefined;
    const result: WalletTokenBalance[] = [];

    if (!requested) {
      result.push({ key: native, symbol: native, address: null, balance: nativeBalance });
      // the native symbol counts as taken: a listed token named like it is keyed by its id
      const symbolCount = new Map<string, number>([[native.toLowerCase(), 1]]);
      for (const t of list) symbolCount.set(t.symbol.toLowerCase(), (symbolCount.get(t.symbol.toLowerCase()) ?? 0) + 1);
      for (const t of list) {
        const amount = held.get(t.address) ?? 0n;
        if (amount === 0n) continue;
        // a symbol two listed tokens share is reported under each token's id instead
        const key = symbolCount.get(t.symbol.toLowerCase())! > 1 ? t.address : t.symbol;
        result.push({ key, symbol: t.symbol, address: t.address, balance: toDecimalNumber(amount, t.decimals) });
      }
      return result;
    }

    for (const name of requested) {
      if (name.toLowerCase() === native.toLowerCase() || name.toLowerCase() === NATIVE_COIN_ID) {
        result.push({ key: name, symbol: native, address: null, balance: nativeBalance });
        continue;
      }
      const token = await this.getToken(name); // throws on an ambiguous symbol
      if (!token) {
        // Without decimals the amount cannot be stated; a held token is never reported as 0.
        if (isErgoId(name) && (held.get(name.toLowerCase()) ?? 0n) > 0n) {
          throw httpErrors.serviceUnavailable(
            `Token ${name.toLowerCase()} is held but the node has no decimals for it yet; retry`,
          );
        }
        result.push({ key: name, symbol: null, address: null, balance: 0 });
        continue;
      }
      const amount = held.get(token.address) ?? 0n;
      result.push({
        key: isErgoId(name) ? name : token.symbol,
        // a token the list does not name is reported under its on-chain name, if it has one
        symbol: token.symbol === token.address ? null : token.symbol,
        address: token.address,
        balance: toDecimalNumber(amount, token.decimals),
      });
    }
    return result;
  }

  // -------------------------------------------------------------------------------------
  // Wallets

  async getWallet(address: string): Promise<ErgoWalletAccount> {
    return loadErgoWallet(address, this.config.addressPrefix);
  }

  // -------------------------------------------------------------------------------------
  // Transaction service

  /** Build with a fresh node height, the node's minimum box value and spendable boxes. */
  async buildTransaction(request: ErgoTransactionRequest): Promise<BuiltErgoTransaction> {
    const changeErgoTree = this.addressToErgoTree(request.changeAddress);
    await this.checkOverduePending();
    // A fixed input our own pending transaction already spends could only double-spend.
    for (const spec of request.inputs ?? []) {
      if (this.pending.isSpent(spec.box.boxId)) {
        throw new ErgoInputSpentError(`Input ${spec.box.boxId} is already spent by one of our pending transactions`, [
          spec.box.boxId,
        ]);
      }
    }
    // Nor can it read a box our own pending transaction spends: the node would reject it.
    for (const box of request.dataInputs ?? []) {
      if (this.pending.isSpent(box.boxId)) {
        throw new ErgoBuildError(
          `Data input ${box.boxId} is already spent by one of our pending transactions; read its successor`,
        );
      }
    }
    const { minerFee, maxMinerFee } = this.config;
    if (request.fee !== undefined && (request.fee < minerFee || request.fee > maxMinerFee)) {
      throw new ErgoBuildError(`fee ${request.fee} is outside the allowed range [${minerFee}, ${maxMinerFee}]`);
    }
    const { height, minValuePerByte } = await this.getBuildState();
    const walletBoxes = request.walletBoxes ?? (await this.getSpendableBoxes(request.changeAddress));
    return buildUnsignedTransaction({
      ...request,
      walletBoxes,
      height,
      minValuePerByte,
      fee: request.fee ?? this.config.minerFee,
      feeErgoTree: this.config.minerFeeErgoTree,
      changeErgoTree,
      excludeBoxIds: this.pending.spentBoxIds(),
    });
  }

  /**
   * Check, then sign. The conservation assertion runs here on the exact object handed to
   * the signer; a transaction that fails it is never signed. The signed result is then
   * compared with what was checked.
   */
  async signTransaction(built: BuiltErgoTransaction, signer: ErgoSigner): Promise<SignedErgoTransaction> {
    assertTransactionBalanced(built);
    if (built.fee > this.config.maxMinerFee) {
      throw new ErgoTransactionAssertionError(`fee ${built.fee} is above maxMinerFee ${this.config.maxMinerFee}`);
    }
    // The remainder of every selected box goes to change; it must come back to the signer.
    // The assertion above tied the change outputs to built.changeErgoTree; the outputs
    // themselves are checked here too, so the decision rests on what is created.
    const owned = new Set(signer.publicKeys.map((pk) => ('0008cd' + pk).toLowerCase()));
    const changeTrees = [
      built.changeErgoTree,
      ...built.changeOutputIndexes.map((i) => built.unsigned.outputs[i]?.ergoTree),
    ];
    if (changeTrees.some((tree) => typeof tree !== 'string' || !owned.has(tree.toLowerCase()))) {
      throw new ErgoTransactionAssertionError("change goes to a tree that is not the signer's address");
    }
    const headers = await this.node.getLastHeaders(10);
    const signed = await signer.signTransaction(built.unsigned, built.unsigned.inputs, built.unsigned.dataInputs, {
      headers,
    });
    assertSignedMatches(built, signed);
    return signed;
  }

  /**
   * Submit through the node. The transaction is recorded before the POST, so its boxes are
   * not selected again even when the node's answer is lost. A definite rejection (4xx)
   * releases it and rethrows; a connection that was never made (refused, or the node's
   * name did not resolve) releases it and throws ErgoNotSubmittedError; any other failure
   * keeps it tracked and throws ErgoSubmitOutcomeUnknownError carrying the transaction id.
   *
   * A transaction with fixed inputs (a contract box such as a pool) must go through
   * sendTransaction, which holds a lock on each fixed input as well as on the wallet, so
   * two wallets cannot race each other for the same box inside this process.
   */
  async submitTransaction(signed: SignedErgoTransaction, built: BuiltErgoTransaction): Promise<string> {
    if (built.fixedInputCount > 0) {
      throw new ErgoBuildError(
        'A transaction with fixed inputs must be sent with sendTransaction, which holds the wallet and input locks',
      );
    }
    return this.submitSigned(signed, built);
  }

  private async submitSigned(signed: SignedErgoTransaction, built: BuiltErgoTransaction): Promise<string> {
    const inputBoxIds = built.inputBoxes.map((b) => b.boxId);
    const fixedInputs = built.inputBoxes
      .slice(0, built.fixedInputCount)
      .map((b) => ({ boxId: b.boxId, transactionId: b.transactionId }));
    // One source for what is tracked: the JSON that is posted (and that assertSignedMatches
    // read), not the signer's parallel parsed object.
    const posted = parseNodeJson<SignedErgoTransaction['parsed']>(signed.json);
    if (posted.id !== signed.id) {
      throw new ErgoTransactionAssertionError('signed JSON carries a different transaction id');
    }
    const outputs = posted.outputs.map((o, index) =>
      normalizeNodeBox({ ...o, transactionId: posted.id, index } as Record<string, unknown>),
    );
    this.pending.record(signed.id, inputBoxIds, outputs, signed.json, fixedInputs);
    let txId: string;
    try {
      txId = await this.node.submitTransaction(signed.json);
    } catch (error) {
      if (error instanceof ErgoNodeError && error.status >= 400 && error.status < 500) {
        this.pending.release(signed.id);
        const fixed = built.inputBoxes.slice(0, built.fixedInputCount).map((b) => b.boxId);
        const gone = fixed.length > 0 ? await this.spentFixedInputs(fixed, error) : [];
        if (gone.length > 0) {
          throw new ErgoInputSpentError(
            `The node rejected the transaction: fixed input ${gone.join(', ')} is already spent`,
            gone,
            error.detail ?? error.reason ?? error.message,
          );
        }
        throw new ErgoTransactionRejectedError(error);
      }
      if (error instanceof ErgoNodeError && error.status === 0 && failedBeforeConnecting(error)) {
        // no byte reached the node: nothing from this submit can confirm
        this.pending.release(signed.id);
        throw new ErgoNotSubmittedError(signed.id, error);
      }
      throw new ErgoSubmitOutcomeUnknownError(signed.id, error);
    }
    if (txId !== signed.id) {
      // The node's id is the one that will confirm. The outputs' box ids derive from our id,
      // so they are not offered as spendable; the inputs stay hidden under the node's id.
      // Submitted already, so a file write failure here is logged, never thrown.
      logger.error(`Ergo node returned id ${txId} for transaction ${signed.id}; tracking the node's id`);
      this.pending.record(txId, inputBoxIds, [], signed.json, fixedInputs, { mustPersist: false });
      this.pending.release(signed.id);
    }
    logger.info(`Submitted Ergo transaction ${txId} on ${this.network}`);
    return txId;
  }

  /**
   * Which of a rejected transaction's fixed inputs are gone: spent by a mempool
   * transaction, or shown spent by the index. If no lookup could say so, only a fixed input
   * the node's text names by its box id, in a text that says an input is missing, counts:
   * "an input is missing" alone may mean a wallet input, and must not be read as the
   * contract box being spent. The lookups are best effort; a failed lookup is not
   * evidence either way.
   */
  private async spentFixedInputs(boxIds: string[], rejection: ErgoNodeError): Promise<string[]> {
    const gone: string[] = [];
    for (const boxId of boxIds) {
      try {
        if (await this.node.isSpentInMempool(boxId)) {
          gone.push(boxId);
          continue;
        }
        const box = await this.node.getBox(boxId);
        if (box?.spentTransactionId) gone.push(boxId);
      } catch {
        // no evidence from this lookup
      }
    }
    if (gone.length > 0) return gone;
    const text = `${rejection.reason ?? ''} ${rejection.detail ?? ''}`;
    if (!INPUT_GONE_TEXT.test(text)) return [];
    const lower = text.toLowerCase();
    return boxIds.filter((boxId) => lower.includes(boxId.toLowerCase()));
  }

  /**
   * Build, check, sign and submit under locks: one on the wallet (change) tree, so two
   * sends from one wallet never select the same boxes, and one on each fixed input, so two
   * wallets in this process never both build on the same contract box. Locks are taken in
   * one global order, so two sends cannot wait on each other. `verify` runs on the built
   * transaction after the conservation check would pass and before anything is signed.
   */
  async sendTransaction(
    request: ErgoTransactionRequest,
    signer: ErgoSigner,
    options: ErgoSendOptions = {},
  ): Promise<{ txId: string; built: BuiltErgoTransaction }> {
    const keys = [
      `tree:${this.addressToErgoTree(request.changeAddress)}`,
      ...(request.inputs ?? []).map((spec) => `box:${spec.box.boxId}`),
    ];
    return this.withLocks(keys, async () => {
      const built = await this.buildTransaction(request);
      if (options.verify) await options.verify(built);
      const signed = await this.signTransaction(built, signer);
      return { txId: await this.submitSigned(signed, built), built };
    });
  }

  /** Hold every lock in `keys`, taken in sorted order, while `fn` runs. */
  private async withLocks<T>(keys: string[], fn: () => Promise<T>): Promise<T> {
    const sorted = [...new Set(keys)].sort();
    const run = (i: number): Promise<T> => (i === sorted.length ? fn() : this.withLock(sorted[i], () => run(i + 1)));
    return run(0);
  }

  /** Run `fn` after every earlier call for the same key has settled. */
  private async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.sendLocks.get(key) ?? Promise.resolve();
    const run = previous.then(() => fn());
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    this.sendLocks.set(key, settled);
    try {
      return await run;
    } finally {
      if (this.sendLocks.get(key) === settled) this.sendLocks.delete(key);
    }
  }

  /** Build an ERG and token transfer without signing it. */
  async buildTransfer(
    fromAddress: string,
    toAddress: string,
    nanoErgs: bigint,
    tokens: ErgoTokenAmount[] = [],
  ): Promise<BuiltErgoTransaction> {
    const fromErgoTree = this.addressToErgoTree(fromAddress);
    const toErgoTree = this.addressToErgoTree(toAddress);
    const { height, minValuePerByte } = await this.getBuildState();
    return buildTransfer({
      height,
      minValuePerByte,
      fee: this.config.minerFee,
      feeErgoTree: this.config.minerFeeErgoTree,
      fromErgoTree,
      toErgoTree,
      nanoErgs,
      tokens,
      walletBoxes: await this.getSpendableBoxes(fromAddress),
      excludeBoxIds: this.pending.spentBoxIds(),
    });
  }

  /** Send ERG and tokens from a stored wallet. Internal: upstream has no transfer route. */
  async transfer(
    fromAddress: string,
    toAddress: string,
    nanoErgs: bigint,
    tokens: ErgoTokenAmount[] = [],
  ): Promise<string> {
    return this.withLock(`tree:${this.addressToErgoTree(fromAddress)}`, async () => {
      const wallet = await this.getWallet(fromAddress);
      const built = await this.buildTransfer(fromAddress, toAddress, nanoErgs, tokens);
      const signed = await this.signTransaction(built, wallet.signer);
      return this.submitSigned(signed, built);
    });
  }

  // -------------------------------------------------------------------------------------
  // Poll

  async pollTransaction(txId: string): Promise<ErgoPollResult> {
    const id = assertErgoId(txId, 'transaction id');
    const { fullHeight } = await this.node.getInfo();
    const base = { currentBlock: fullHeight, signature: txId, fee: null, error: null };

    // The mempool first, then the index: a transaction that leaves the mempool between the
    // two reads has moved into a block, which the index lookup or its lag check covers.
    const unconfirmed = await this.node.getUnconfirmedTransaction(id);
    if (unconfirmed) {
      this.pending.markRefused(id, false);
      return {
        ...base,
        txBlock: null,
        txStatus: TransactionStatusCode.PENDING,
        fee: this.feeOf(unconfirmed),
        txData: summarize(unconfirmed, 0),
      };
    }

    const confirmed = await this.node.getTransaction(id);
    if (confirmed) {
      const inclusionHeight = typeof confirmed.inclusionHeight === 'number' ? confirmed.inclusionHeight : null;
      const confirmations = confirmationsOf(confirmed, fullHeight);
      const done = confirmations >= this.config.confirmations;
      if (done) this.pending.release(id);
      else this.pending.markRefused(id, false);
      return {
        ...base,
        txBlock: inclusionHeight,
        txStatus: done ? TransactionStatusCode.CONFIRMED : TransactionStatusCode.PENDING,
        fee: this.feeOf(confirmed),
        txData: summarize(confirmed, confirmations),
      };
    }

    // Released earlier because it can never confirm. Asked only after the mempool and the
    // index: a transaction the chain shows confirmed is confirmed, whatever this says.
    const tracked = this.pending.get(id);
    const failed = tracked ? undefined : this.pending.failedReason(id);
    if (failed) {
      return { ...base, txBlock: null, txStatus: TransactionStatusCode.FAILED, error: failed.reason, txData: null };
    }

    // The indexer can lag the chain; a transaction in a block it has not indexed yet looks
    // unknown. Read the index height before any input box, so box reads are at least as
    // fresh as the height the decision below is made on.
    const indexed = await this.node.getIndexedHeight();
    const chainHeight = Math.max(fullHeight, typeof indexed.fullHeight === 'number' ? indexed.fullHeight : fullHeight);
    const indexBehind = indexed.indexedHeight < chainHeight;

    // Neither indexed nor in the mempool. Failed only on proof: one of its inputs spent by a
    // different transaction that has the network's confirmations, which we can check for
    // transactions we submitted.
    const inputs = tracked ? await this.readTrackedInputs(tracked) : undefined;
    if (inputs?.spentElsewhere) {
      const { boxId, by } = inputs.spentElsewhere;
      const depth = await this.confirmationsOfTransaction(by, fullHeight);
      if (depth >= this.config.confirmations) {
        const reason = `Input ${boxId} was spent by transaction ${by}; this transaction can no longer confirm`;
        this.pending.releaseFailed(id, reason);
        return { ...base, txBlock: null, txStatus: TransactionStatusCode.FAILED, error: reason, txData: null };
      }
      return {
        ...base,
        txBlock: null,
        txStatus: TransactionStatusCode.PENDING,
        txData: {
          note:
            `input ${boxId} is spent by transaction ${by}, which has ${depth} of the ${this.config.confirmations} ` +
            'confirmations that make it final; this transaction can no longer confirm once that one is final',
        },
      };
    }

    if (indexBehind) {
      return {
        ...base,
        txBlock: null,
        txStatus: TransactionStatusCode.PENDING,
        txData: { note: `node index at ${indexed.indexedHeight}, chain at ${chainHeight}; status not yet known` },
      };
    }

    // Ours, every input still unspent on an index that has caught up, and the node holds
    // it nowhere: it was dropped. Post it once more rather than forget it, since releasing
    // would let a rebuild execute twice if the dropped one resurfaces.
    if (tracked && inputs!.allUnspent) {
      const refusal = await this.postAgain(tracked);
      if (!refusal) {
        return {
          ...base,
          txBlock: null,
          txStatus: TransactionStatusCode.PENDING,
          txData: { note: 'rebroadcast: the node had dropped it' },
        };
      }
      return { ...base, txBlock: null, ...(await this.refusedAnswer(tracked, refusal)) };
    }

    // Ours, and every input the index does not know is an output of another transaction we
    // still track (a chained spend of our own unconfirmed change): it waits for that one.
    // Not posted again itself: a node that lacks the parent would reject it, and that
    // rejection would prove nothing about this transaction. A parent the node has dropped
    // is posted again here, so polling only this one still moves its parent.
    if (tracked && inputs!.waitingOn.length > 0 && inputs!.unknown.length === 0) {
      const parents = [...new Set(inputs!.waitingOn)];
      for (const parent of parents) {
        const parentTx = this.pending.get(parent);
        if (!parentTx) continue;
        try {
          await this.postAgainIfDropped(parentTx);
        } catch (error) {
          logger.warn(
            `Ergo ${this.network}: could not check transaction ${parent}, which ${id} waits for: ` +
              `${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      return {
        ...base,
        txBlock: null,
        txStatus: TransactionStatusCode.PENDING,
        txData: { note: `waits for transaction ${parents.join(', ')}, which creates its inputs and is still pending` },
      };
    }
    return { ...base, txBlock: null, txStatus: TransactionStatusCode.NOT_FOUND, txData: null };
  }

  /**
   * Post a tracked transaction the node no longer holds, as it was signed. Returns the
   * node's refusal (a 4xx), or undefined when the node took it. A refusal is not proof that
   * the transaction cannot confirm (the node also refuses a valid transaction: a competing
   * spend in its mempool, a full mempool, one it already holds, a fee below its own
   * minimum), so the entry is kept and marked refused, and its outputs are not offered
   * until a later post is taken. Any other failure throws, and the entry is kept as it is.
   */
  private async postAgain(tx: PendingTransaction): Promise<ErgoNodeError | undefined> {
    try {
      await this.node.submitTransaction(tx.json);
    } catch (error) {
      if (error instanceof ErgoNodeError && error.status >= 400 && error.status < 500) {
        this.pending.markRefused(tx.txId, true);
        logger.warn(
          `Ergo ${this.network}: transaction ${tx.txId} was refused when posted again, and is kept: ${nodeText(error)}`,
        );
        return error;
      }
      throw error;
    }
    this.pending.markRefused(tx.txId, false);
    logger.info(`Ergo ${this.network}: transaction ${tx.txId}, which the node had dropped, was posted again and taken`);
    return undefined;
  }

  /**
   * Poll's answer for a tracked transaction the node refused when it was posted again. It
   * is kept either way. PENDING when it is in the mempool after all, or when one of its
   * inputs is spent there by another transaction (whichever confirms first wins); otherwise
   * NOT_FOUND, with the node's words in the note.
   */
  private async refusedAnswer(
    tx: PendingTransaction,
    refusal: ErgoNodeError,
  ): Promise<Pick<ErgoPollResult, 'txStatus' | 'txData'>> {
    const said = nodeText(refusal);
    if (await this.node.getUnconfirmedTransaction(tx.txId)) {
      this.pending.markRefused(tx.txId, false);
      return {
        txStatus: TransactionStatusCode.PENDING,
        txData: { note: `the node refused it when posted again (${said}), but holds it in its mempool` },
      };
    }
    for (const boxId of tx.inputBoxIds) {
      if (await this.node.isSpentInMempool(boxId)) {
        return {
          txStatus: TransactionStatusCode.PENDING,
          txData: {
            note:
              `the node refused it when posted again (${said}): its input ${boxId} is spent by another ` +
              'transaction in the mempool; it may still confirm',
          },
        };
      }
    }
    return {
      txStatus: TransactionStatusCode.NOT_FOUND,
      txData: { note: `the node refused it when posted again: ${said}; it is kept and posted again later` },
    };
  }

  /**
   * Post a tracked transaction again if the node has dropped it: in no mempool, and every
   * input indexed and unspent. For a caller that has seen the index caught up. A refusal
   * keeps it, as in poll.
   */
  private async postAgainIfDropped(tx: PendingTransaction): Promise<void> {
    if (await this.node.getUnconfirmedTransaction(tx.txId)) {
      this.pending.markRefused(tx.txId, false);
      return;
    }
    const inputs = await this.readTrackedInputs(tx);
    if (inputs.allUnspent) await this.postAgain(tx);
  }

  /** Blocks holding a transaction, by the index; 0 when the index does not have it. */
  private async confirmationsOfTransaction(txId: string, fullHeight: number): Promise<number> {
    const tx = await this.node.getTransaction(txId);
    return tx ? confirmationsOf(tx, fullHeight) : 0;
  }

  /**
   * The index's view of a tracked transaction's inputs: the first one spent by a different
   * transaction (evidence it failed), or else which are not indexed, split into those a
   * transaction we track creates (`waitingOn` holds that transaction's id) and the rest.
   */
  private async readTrackedInputs(tracked: PendingTransaction): Promise<{
    spentElsewhere?: { boxId: string; by: string };
    unindexed: Set<string>;
    waitingOn: string[];
    unknown: string[];
    allUnspent: boolean;
  }> {
    const unindexed = new Set<string>();
    const waitingOn: string[] = [];
    const unknown: string[] = [];
    for (const boxId of tracked.inputBoxIds) {
      const box = await this.node.getBox(boxId);
      if (box?.spentTransactionId && box.spentTransactionId !== tracked.txId) {
        return {
          spentElsewhere: { boxId, by: box.spentTransactionId },
          unindexed,
          waitingOn,
          unknown,
          allUnspent: false,
        };
      }
      if (box?.spentTransactionId) {
        unknown.push(boxId); // spent by this very transaction, which the index does not list: no conclusion
        continue;
      }
      if (box) continue;
      unindexed.add(boxId);
      const parent = this.pending.producerOf(boxId);
      if (parent !== undefined && parent !== tracked.txId) waitingOn.push(parent);
      else unknown.push(boxId);
    }
    return { unindexed, waitingOn, unknown, allUnspent: waitingOn.length === 0 && unknown.length === 0 };
  }

  /**
   * Check overdue pending transactions against the node, so that an entry is settled even
   * when nobody polls it:
   * - confirmed: released;
   * - an input spent by a different transaction that has the network's confirmations:
   *   released as failed, with every tracked transaction that spends its outputs;
   *   below that depth it is kept;
   * - every input indexed and unspent, and the node holds it in no mempool: it was dropped,
   *   so it is posted again; a refusal keeps it, marked refused, for the next check;
   * - an input that neither the index nor the tracker knows (an unconfirmed box from
   *   someone else's transaction that has not confirmed by now): forgotten, so its other
   *   inputs are not hidden for ever.
   * An entry whose inputs are outputs of another tracked transaction is kept however old it
   * is. Best effort: a node error leaves the entry as it is.
   */
  private async checkOverduePending(): Promise<void> {
    for (const tx of this.pending.takeDueForCheck()) {
      if (!this.pending.get(tx.txId)) continue; // released with a failed parent earlier in this round
      try {
        await this.recheckPending(tx);
      } catch (error) {
        logger.warn(
          `Ergo ${this.network}: could not check pending transaction ${tx.txId}, kept: ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  private async recheckPending(tx: PendingTransaction): Promise<void> {
    const id = tx.txId;
    if (await this.node.getUnconfirmedTransaction(id)) {
      this.pending.markRefused(id, false);
      return;
    }
    const { fullHeight } = await this.node.getInfo();
    const confirmed = await this.node.getTransaction(id);
    if (confirmed) {
      if (confirmationsOf(confirmed, fullHeight) >= this.config.confirmations) this.pending.release(id);
      else this.pending.markRefused(id, false);
      return;
    }
    const indexed = await this.node.getIndexedHeight();
    const chainHeight = Math.max(fullHeight, typeof indexed.fullHeight === 'number' ? indexed.fullHeight : fullHeight);
    if (indexed.indexedHeight < chainHeight) return;
    const inputs = await this.readTrackedInputs(tx);
    if (inputs.spentElsewhere) {
      const { boxId, by } = inputs.spentElsewhere;
      // not final yet: the spender may still be undone, and this one confirm
      if ((await this.confirmationsOfTransaction(by, fullHeight)) < this.config.confirmations) return;
      const reason = `Input ${boxId} was spent by transaction ${by}; this transaction can no longer confirm`;
      const released = this.pending.releaseFailed(id, reason);
      const others = released.filter((r) => r !== id);
      logger.info(
        `Ergo ${this.network}: pending transaction ${id} failed: input ${boxId} was spent by transaction ${by}` +
          (others.length > 0 ? `; released with it, as they spend its outputs: ${others.join(', ')}` : ''),
      );
      return;
    }
    if (inputs.unknown.length > 0) {
      logger.warn(
        `Ergo ${this.network}: forgetting pending transaction ${id} after ${this.config.pendingTxTimeoutBlocks} ` +
          `blocks: input ${inputs.unknown.join(', ')} is known neither to the node's index nor as an output of a ` +
          'transaction this Gateway tracks',
      );
      this.pending.release(id);
      return;
    }
    // dropped by the node while it can still confirm: post it again (a refusal keeps it)
    if (inputs.allUnspent) await this.postAgain(tx);
  }

  private feeOf(tx: NodeTransaction): number | null {
    try {
      let fee = 0n;
      for (const output of tx.outputs ?? []) {
        if (String(output.ergoTree).toLowerCase() === this.config.minerFeeErgoTree)
          fee += toAmount(output.value, 'fee');
      }
      return toDecimalNumber(fee, this.config.nativeDecimals);
    } catch {
      return null;
    }
  }
}

/**
 * Blocks holding the transaction, counting its own block: the node's numConfirmations
 * counts the blocks after the inclusion block (0 at the tip); the config counts the
 * inclusion block too.
 */
function confirmationsOf(tx: NodeTransaction, fullHeight: number): number {
  const inclusionHeight = typeof tx.inclusionHeight === 'number' ? tx.inclusionHeight : null;
  if (typeof tx.numConfirmations === 'number') return tx.numConfirmations + 1;
  return inclusionHeight !== null ? fullHeight - inclusionHeight + 1 : 0;
}

function summarize(tx: NodeTransaction, confirmations: number): Record<string, unknown> {
  return bigintsToStrings({
    id: tx.id,
    inclusionHeight: tx.inclusionHeight ?? null,
    numConfirmations: confirmations,
    inputs: (tx.inputs ?? []).map((i) => i.boxId),
    dataInputs: (tx.dataInputs ?? []).map((d) => d.boxId),
    outputs: (tx.outputs ?? []).map((o) => o.boxId),
  }) as Record<string, unknown>;
}

/**
 * The signed transaction spends, reads and creates exactly what was checked. It reads the
 * JSON that is submitted, not a parallel representation, and compares each input's context
 * extension too: an extension picks the contract path the node runs.
 */
export function assertSignedMatches(built: BuiltErgoTransaction, signed: SignedErgoTransaction): void {
  const fail = (message: string): never => {
    throw new ErgoTransactionAssertionError(`signed transaction differs from the checked one: ${message}`);
  };
  const tx = parseNodeJson<SignedErgoTransaction['parsed']>(signed.json);
  if (tx.id !== signed.id) fail('id');
  const ins = built.unsigned.inputs.map((i) => i.boxId);
  if (tx.inputs.length !== ins.length || tx.inputs.some((input, i) => input.boxId !== ins[i])) fail('inputs');
  tx.inputs.forEach((input, i) => {
    const want: Record<string, string> = built.unsigned.inputs[i].extension ?? {};
    const got: Record<string, string> = input.spendingProof?.extension ?? {};
    for (const k of new Set([...Object.keys(want), ...Object.keys(got)])) {
      const g = got[k];
      const w = want[k];
      if (typeof g !== 'string' || typeof w !== 'string' || g.toLowerCase() !== w.toLowerCase())
        fail(`input ${i} context variable ${k}`);
    }
  });
  const datas = built.unsigned.dataInputs.map((d) => d.boxId);
  if ((tx.dataInputs ?? []).length !== datas.length || (tx.dataInputs ?? []).some((d, i) => d.boxId !== datas[i]))
    fail('data inputs');
  if (tx.outputs.length !== built.unsigned.outputs.length) fail('output count');
  tx.outputs.forEach((raw, i) => {
    const want = built.unsigned.outputs[i];
    const got = normalizeNodeBox({ ...raw, transactionId: tx.id, index: i } as Record<string, unknown>);
    if (got.value !== toAmount(want.value)) fail(`output ${i} value`);
    if (got.ergoTree !== want.ergoTree.toLowerCase()) fail(`output ${i} tree`);
    if (got.creationHeight !== want.creationHeight) fail(`output ${i} creation height`);
    const wantAssets = want.assets ?? [];
    if (
      got.assets.length !== wantAssets.length ||
      got.assets.some(
        (a, j) => a.tokenId !== wantAssets[j].tokenId.toLowerCase() || a.amount !== toAmount(wantAssets[j].amount),
      )
    ) {
      fail(`output ${i} tokens`);
    }
    const wantRegs = want.additionalRegisters ?? {};
    const keys = new Set([...Object.keys(got.additionalRegisters), ...Object.keys(wantRegs)]);
    for (const k of keys) {
      const g = (got.additionalRegisters as Record<string, string>)[k];
      const w = (wantRegs as Record<string, string>)[k];
      if (!g || !w || g.toLowerCase() !== w.toLowerCase()) fail(`output ${i} register ${k}`);
    }
  });
}
