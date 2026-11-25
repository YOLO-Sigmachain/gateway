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
import { logger } from '../../services/logger';
import { WalletTokenBalance } from '../wallet-balances';

import { configuredAddressPrefixes, ErgoNetworkConfig, getErgoNetworkConfig, networks } from './ergo.config';
import { bigintsToStrings, toAmount } from './ergo.json';
import { ErgoNodeClient, ErgoNodeError, FetchLike, normalizeNodeBox, NodeTransaction } from './ergo.node-client';
import { ErgoPendingTracker } from './ergo.pending';
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
import { assertErgoId, decodeErgoAddress, decodeErgoAddressForPrefix, isErgoId, toDecimalNumber } from './ergo.utils';
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

export class Ergo {
  private static _instances: Record<string, Ergo> = {};

  readonly chain = 'ergo';
  readonly network: string;
  readonly config: ErgoNetworkConfig;
  readonly node: ErgoNodeClient;
  readonly pending: ErgoPendingTracker;
  private readonly tokenInfoCache = new Map<string, ErgoTokenInfo | null>();

  constructor(network: string, options: { config?: ErgoNetworkConfig; fetch?: FetchLike; now?: () => number } = {}) {
    this.network = network;
    this.config = options.config ?? getErgoNetworkConfig(network);
    this.node = new ErgoNodeClient(this.config.nodeURL, {
      timeoutMs: this.config.nodeTimeoutMs,
      pageSize: this.config.boxPageSize,
      fetch: options.fetch,
    });
    const timeoutMs = this.config.pendingTxTimeoutBlocks * this.config.blockTimeSeconds * 1000;
    this.pending = new ErgoPendingTracker(timeoutMs, options.now);
  }

  public static async getInstance(network: string): Promise<Ergo> {
    if (!networks.includes(network)) {
      throw new Error(`Unknown Ergo network: ${network}. Available: ${networks.join(', ')}`);
    }
    if (!Ergo._instances[network]) {
      Ergo._instances[network] = new Ergo(network);
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
    return raw
      .filter((t) => isErgoId(t?.address) && Number.isInteger(t?.decimals) && typeof t?.symbol === 'string')
      .map((t) => ({
        address: String(t.address).toLowerCase(),
        symbol: String(t.symbol),
        name: typeof t.name === 'string' ? t.name : String(t.symbol),
        decimals: Number(t.decimals),
      }));
  }

  /** A token by id: the token list first, then the node's index. Null if neither knows it. */
  async getTokenById(tokenId: string): Promise<ErgoTokenInfo | null> {
    const id = assertErgoId(tokenId, 'token id');
    const listed = (await this.getTokenList()).find((t) => t.address === id);
    if (listed) return listed;
    if (this.tokenInfoCache.has(id)) return this.tokenInfoCache.get(id)!;
    const fromNode = await this.node.getToken(id);
    const info =
      fromNode && fromNode.decimals !== null
        ? { address: id, symbol: fromNode.name ?? id, name: fromNode.name ?? id, decimals: fromNode.decimals }
        : null;
    this.tokenInfoCache.set(id, info);
    return info;
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
      const symbolCount = new Map<string, number>();
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
      if (name.toLowerCase() === native.toLowerCase()) {
        result.push({ key: name, symbol: native, address: null, balance: nativeBalance });
        continue;
      }
      const token = await this.getToken(name); // throws on an ambiguous symbol
      if (!token) {
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
    // A fixed input our own pending transaction already spends could only double-spend.
    for (const spec of request.inputs ?? []) {
      if (this.pending.isSpent(spec.box.boxId)) {
        throw new ErgoBuildError(`Input ${spec.box.boxId} is already spent by one of our pending transactions`);
      }
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
    const headers = await this.node.getLastHeaders(10);
    const signed = await signer.signTransaction(built.unsigned, built.unsigned.inputs, built.unsigned.dataInputs, {
      headers,
    });
    assertSignedMatches(built, signed);
    return signed;
  }

  /** Submit through the node. Records the transaction so its boxes are not selected again. */
  async submitTransaction(signed: SignedErgoTransaction, built: BuiltErgoTransaction): Promise<string> {
    const txId = await this.node.submitTransaction(signed.json);
    if (txId !== signed.id) {
      logger.warn(`Ergo node returned id ${txId} for transaction ${signed.id}`);
    }
    const outputs = signed.parsed.outputs.map((o, index) =>
      normalizeNodeBox({ ...o, transactionId: signed.id, index } as Record<string, unknown>),
    );
    this.pending.record(
      signed.id,
      built.inputBoxes.map((b) => b.boxId),
      outputs,
    );
    logger.info(`Submitted Ergo transaction ${signed.id} on ${this.network}`);
    return signed.id;
  }

  async sendTransaction(
    request: ErgoTransactionRequest,
    signer: ErgoSigner,
  ): Promise<{ txId: string; built: BuiltErgoTransaction }> {
    const built = await this.buildTransaction(request);
    const signed = await this.signTransaction(built, signer);
    return { txId: await this.submitTransaction(signed, built), built };
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
    const wallet = await this.getWallet(fromAddress);
    const built = await this.buildTransfer(fromAddress, toAddress, nanoErgs, tokens);
    const signed = await this.signTransaction(built, wallet.signer);
    return this.submitTransaction(signed, built);
  }

  // -------------------------------------------------------------------------------------
  // Poll

  async pollTransaction(txId: string): Promise<ErgoPollResult> {
    const id = assertErgoId(txId, 'transaction id');
    const { fullHeight } = await this.node.getInfo();
    const base = { currentBlock: fullHeight, signature: txId, fee: null, error: null };

    const confirmed = await this.node.getTransaction(id);
    if (confirmed) {
      const inclusionHeight = typeof confirmed.inclusionHeight === 'number' ? confirmed.inclusionHeight : null;
      const confirmations =
        typeof confirmed.numConfirmations === 'number'
          ? confirmed.numConfirmations
          : inclusionHeight !== null
            ? fullHeight - inclusionHeight + 1
            : 0;
      const done = confirmations >= this.config.confirmations;
      if (done) this.pending.release(id);
      return {
        ...base,
        txBlock: inclusionHeight,
        txStatus: done ? TransactionStatusCode.CONFIRMED : TransactionStatusCode.PENDING,
        fee: this.feeOf(confirmed),
        txData: summarize(confirmed, confirmations),
      };
    }

    const unconfirmed = await this.node.getUnconfirmedTransaction(id);
    if (unconfirmed) {
      return {
        ...base,
        txBlock: null,
        txStatus: TransactionStatusCode.PENDING,
        fee: this.feeOf(unconfirmed),
        txData: summarize(unconfirmed, 0),
      };
    }

    // Neither indexed nor in the mempool. Failed only on evidence: one of its inputs spent
    // by a different transaction, which we can check for transactions we submitted.
    const tracked = this.pending.get(id);
    if (tracked) {
      for (const boxId of tracked.inputBoxIds) {
        const box = await this.node.getBox(boxId);
        if (box?.spentTransactionId && box.spentTransactionId !== id) {
          this.pending.release(id);
          return {
            ...base,
            txBlock: null,
            txStatus: TransactionStatusCode.FAILED,
            error: `Input ${boxId} was spent by transaction ${box.spentTransactionId}; this transaction can no longer confirm`,
            txData: null,
          };
        }
      }
    }

    // The indexer can lag the chain; a transaction in a block it has not indexed yet looks
    // unknown, so do not call it not-found until the index has caught up.
    const indexed = await this.node.getIndexedHeight();
    if (indexed.indexedHeight < fullHeight) {
      return {
        ...base,
        txBlock: null,
        txStatus: TransactionStatusCode.PENDING,
        txData: { note: `node index at ${indexed.indexedHeight}, chain at ${fullHeight}; status not yet known` },
      };
    }
    return { ...base, txBlock: null, txStatus: TransactionStatusCode.NOT_FOUND, txData: null };
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

/** The signed transaction spends, reads and creates exactly what was checked. */
export function assertSignedMatches(built: BuiltErgoTransaction, signed: SignedErgoTransaction): void {
  const fail = (message: string): never => {
    throw new ErgoTransactionAssertionError(`signed transaction differs from the checked one: ${message}`);
  };
  const tx = signed.parsed;
  if (tx.id !== signed.id) fail('id');
  const ins = built.unsigned.inputs.map((i) => i.boxId);
  if (tx.inputs.length !== ins.length || tx.inputs.some((input, i) => input.boxId !== ins[i])) fail('inputs');
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
