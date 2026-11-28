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

import yaml from 'js-yaml';

import { rootPath } from '../../paths';
import { TransactionStatusCode } from '../../schemas/chain-schema';
import { ConfigManagerV2 } from '../../services/config-manager-v2';
import { httpErrors } from '../../services/error-handler';
import { logger } from '../../services/logger';
import { WalletTokenBalance } from '../wallet-balances';

import {
  configuredAddressPrefixes,
  errorKind,
  ErgoNetworkConfig,
  ErgoSubmitMode,
  findSubmitModeLookalike,
  getErgoNetworkConfig,
  networks,
  parseSubmitMode,
} from './ergo.config';
import { bigintsToStrings, parseNodeJson, toAmount } from './ergo.json';
import {
  ErgoNodeClient,
  ErgoNodeError,
  ErgoSubmitRefusedError,
  FetchLike,
  normalizeNodeBox,
  NodeTransaction,
} from './ergo.node-client';
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
  fetchUsesEnvProxy,
  formatUnits,
  isErgoId,
  isLoopbackUrl,
  NATIVE_COIN_ID,
  sanitizeNodeText,
  symbolForMessage,
  toDecimalNumber,
  tokenForMessage,
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

  /** `keepIds`: ids that stay readable in the node's text (see sanitizeNodeText); the id is always kept. */
  constructor(txId: string, cause: unknown, keepIds: string[] = []) {
    const nodeError = cause instanceof ErgoNodeError ? cause : undefined;
    const causeText = cause instanceof Error ? cause.message : String(cause);
    const keep = [txId, ...keepIds];
    super(
      nodeError?.status ?? 0,
      `Submit outcome unknown for ${txId}; poll it before retrying`,
      nodeError?.reason === undefined ? undefined : sanitizeNodeText(nodeError.reason, keep),
      sanitizeNodeText(nodeError?.detail ?? causeText, keep),
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

/** The node's words for a rejection, made safe for a message or a log line (see sanitizeNodeText). */
function safeNodeText(error: ErgoNodeError, keepIds: Iterable<string>): string {
  return sanitizeNodeText(nodeText(error), keepIds);
}

/** The same node error with its texts made safe for a message or a log line. */
function sanitizedNodeError(error: ErgoNodeError, keepIds: string[]): ErgoNodeError {
  const safe = (text?: string) => (text === undefined ? undefined : sanitizeNodeText(text, keepIds));
  return new ErgoNodeError(error.status, safe(error.message)!, safe(error.reason), safe(error.detail), {
    cause: error.cause,
  });
}

/** An error's message, made safe for a log line (see sanitizeNodeText). */
function safeErrorText(error: unknown, keepIds: Iterable<string>): string {
  return sanitizeNodeText(error instanceof Error ? error.message : String(error), keepIds);
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
  /** The node's texts are kept only as sanitizeNodeText leaves them; `keepIds` stay readable. */
  constructor(cause: ErgoNodeError, keepIds: string[] = []) {
    const safe = sanitizedNodeError(cause, keepIds);
    super(safe.status, safe.message, safe.reason, safe.detail);
    this.name = 'ErgoTransactionRejectedError';
  }
}

/**
 * submitMode is `check`: the node's check endpoint found the signed transaction valid, and
 * nothing was sent. It is not a submitted transaction: nothing is tracked, and nothing can
 * confirm from it. `moves`, when set, says what the transaction would move if it were sent.
 */
export class ErgoCheckOnlyError extends Error {
  readonly txId: string;
  readonly moves?: string;

  constructor(txId: string, moves?: string) {
    super(
      `Check only: the node accepted transaction ${txId} as valid; nothing was sent` +
        (moves ? `. If it were sent, it would move ${moves}` : ''),
    );
    this.name = 'ErgoCheckOnlyError';
    this.txId = txId;
    this.moves = moves;
  }

  /** The same answer, saying what the transaction would move. */
  withMoves(moves: string): ErgoCheckOnlyError {
    return new ErgoCheckOnlyError(this.txId, moves);
  }
}

/**
 * submitMode is `check` and the node's check refused the signed transaction (it answered
 * 400). Nothing was sent. Answered like a refusal at a first submit, with the node's text.
 */
export class ErgoCheckRejectedError extends ErgoTransactionRejectedError {
  constructor(cause: ErgoNodeError, keepIds: string[] = []) {
    super(cause, keepIds);
    this.name = 'ErgoCheckRejectedError';
    this.message = `Check only, nothing was sent: ${sanitizeNodeText(cause.message, keepIds)}`;
  }
}

/**
 * submitMode is `check` and the node's check gave no verdict: the connection failed, it
 * timed out, the node answered something other than 400 or an id, or an id other than the
 * transaction's. Nothing was submitted, so this is not an unknown submit outcome and there
 * is nothing to poll.
 */
export class ErgoCheckIncompleteError extends Error {
  readonly txId: string;

  /** `keepIds`: ids that stay readable in the node's text (see sanitizeNodeText); the id is always kept. */
  constructor(txId: string, cause: unknown, keepIds: string[] = []) {
    const causeText = sanitizeNodeText(cause instanceof Error ? cause.message : String(cause), [txId, ...keepIds]);
    super(
      `Check only: the check of transaction ${txId} could not be completed (${causeText}); nothing was sent. ` +
        'Retry once the node answers',
    );
    this.name = 'ErgoCheckIncompleteError';
    this.txId = txId;
  }
}

/**
 * The network's submitMode is not set: nothing is signed, sent or checked until it is set to
 * `send` or `check` in the network's config file and Gateway is restarted. Raised before
 * any box is selected and before the wallet's key is loaded. Answered as a 503.
 */
export class ErgoSubmitModeNotSetError extends Error {
  constructor(network: string) {
    super(
      `ergo-${network}.submitMode is not set. Add "submitMode: send" to send transactions, or "submitMode: check" ` +
        "to have the node only check them, to the network's config file, then restart Gateway. Nothing was signed " +
        'or sent.',
    );
    this.name = 'ErgoSubmitModeNotSetError';
  }
}

/**
 * The submit mode differs between the running instance, the config held in memory and the
 * config file (or one of them cannot be read, or is neither `send` nor `check`, or a key
 * that looks like submitMode is in the config). Nothing was recorded or sent, and once seen
 * the network refuses every later submit and re-post until Gateway restarts. Answered as a
 * 503.
 */
export class ErgoSubmitModeMismatchError extends Error {
  constructor(network: string, cause: { running: string; inMemory: string; inFile: string } | { keyProblem: string }) {
    const what =
      'keyProblem' in cause
        ? `The submit mode for ergo-${network} is in doubt: ${cause.keyProblem}. The mode changed while Gateway ` +
          'was running; correct the config, then restart Gateway'
        : `The submit mode differs between the running Gateway and its config for ergo-${network}: ` +
          `running ${cause.running}, config in memory ${cause.inMemory}, config file ${cause.inFile}. ` +
          'The mode changed while Gateway was running; restart Gateway to use the mode in its config';
    super(`${what}. Nothing was sent, and nothing is sent from this network until Gateway is restarted`);
    this.name = 'ErgoSubmitModeMismatchError';
  }
}

/** The submit mode as one of its three states: `send`, `check`, or not set. */
type SubmitModeState = ErgoSubmitMode | 'not set';

/**
 * A submitMode value as read: the state it names, or why it names none. Absent is not set.
 * A value that is neither `send` nor `check` is described by its type only: its text is
 * never repeated, since a person may have pasted anything there.
 */
function readSubmitModeValue(value: unknown): { mode?: SubmitModeState; text: string } {
  if (value === undefined) return { mode: 'not set', text: 'not set' };
  if (value === 'send' || value === 'check') return { mode: value, text: value };
  const type =
    value === null
      ? 'null'
      : Array.isArray(value)
        ? 'a list'
        : value instanceof Date
          ? 'a date'
          : typeof value === 'object'
            ? 'a mapping'
            : `a ${typeof value}`;
  return { text: `a value that is neither send nor check (${type})` };
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
  /**
   * `send`: signed transactions are submitted. `check`: only checked by the node; nothing is
   * sent. Undefined (not set): nothing is signed, sent or checked.
   */
  readonly submitMode: ErgoSubmitMode | undefined;
  /**
   * Whether this instance's config was read from the config manager (no `options.config`
   * given), as every instance getInstance makes is. Only then is there a config in memory
   * and a config file to compare the mode with at each submit decision.
   */
  private readonly configFromManager: boolean;
  /** The first doubt about the submit mode this instance saw; once set, nothing is submitted until a restart. */
  private latchedMismatch?: ErgoSubmitModeMismatchError;
  private readonly tokenInfoCache = new Map<string, ErgoTokenInfo>();
  /** A token's total emission never changes once it is minted. */
  private readonly tokenEmissionCache = new Map<string, bigint>();
  /** One build-sign-submit at a time per wallet tree, so two sends never select the same boxes. */
  private readonly sendLocks = new Map<string, Promise<unknown>>();

  constructor(network: string, options: { config?: ErgoNetworkConfig; fetch?: FetchLike; now?: () => number } = {}) {
    this.network = network;
    this.configFromManager = options.config === undefined;
    this.config = options.config ?? getErgoNetworkConfig(network);
    this.submitMode = parseSubmitMode(this.config.submitMode, `ergo-${network}.submitMode`);
    if (
      this.submitMode === 'check' &&
      this.config.checkAllowsRemoteNode !== true &&
      !isLoopbackUrl(this.config.nodeURL)
    ) {
      let host = 'that cannot be read';
      try {
        host = new URL(this.config.nodeURL).hostname;
      } catch {
        // the host stays unnamed
      }
      throw new Error(
        `ergo-${network}.submitMode is check and nodeURL names the host ${host}, which is not this machine. In ` +
          'check mode the node receives every signed transaction in full, and whoever runs or can watch that node ' +
          'could broadcast it. Point nodeURL at a node on this machine (localhost, 127.0.0.0/8 or ::1), or set ' +
          `ergo-${network}.checkAllowsRemoteNode: true to accept that; this network does not start until then`,
      );
    }
    if (this.submitMode === 'check' && fetchUsesEnvProxy(process.env, process.execArgv)) {
      throw new Error(
        `ergo-${network}.submitMode is check and Node is set to send fetch requests through a proxy from the ` +
          'environment (NODE_USE_ENV_PROXY or --use-env-proxy, with HTTP_PROXY or HTTPS_PROXY set). In check mode ' +
          'every signed transaction is posted in full to the node, and the proxy would receive it and could ' +
          'broadcast it. Start Gateway without the environment proxy; this network does not start until then',
      );
    }
    if (this.submitMode === 'check') {
      logger.warn(
        `ergo-${network}.submitMode is check: signed transactions are only checked by the node, never sent; ` +
          'no swap or transfer from this network is carried out',
      );
    } else if (this.submitMode === 'send') {
      logger.info(`ergo-${network}.submitMode is send: signed transactions are sent to the node`);
    } else {
      logger.warn(
        `ergo-${network}.submitMode is not set: no swap or transfer is carried out until it is set; nothing is ` +
          'signed, sent or checked. Add "submitMode: send" or "submitMode: check" to the network\'s config file, ' +
          'then restart Gateway',
      );
    }
    this.node = new ErgoNodeClient(this.config.nodeURL, {
      timeoutMs: this.config.nodeTimeoutMs,
      pageSize: this.config.boxPageSize,
      fetch: options.fetch,
      canSubmit: () => this.submitModeCheck().mode === 'send',
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

  /** This instance's submit mode as one of the three states. */
  private get submitModeState(): SubmitModeState {
    return this.submitMode ?? 'not set';
  }

  /**
   * The submit mode in force, read at each submit decision. Three values are compared: the
   * mode this instance was built with, the mode in the config manager's namespace held in
   * memory (a /config/update changes it), and the mode in that namespace's config file on
   * disk, read now (a hand edit changes it). Each is `send`, `check` or not set (no key);
   * not set is a state of its own. All three agreeing gives that state; any disagreement, a
   * value that cannot be read, one that is neither `send` nor `check`, or a key that looks
   * like submitMode in the network's file or memory or in the chain's memory or file (see
   * findSubmitModeLookalike) gives `mismatch`, and then nothing may be recorded or posted.
   * A mismatch is kept: from then on every answer is that mismatch until Gateway restarts,
   * even if the three values agree again (an update through the API rewrites the whole
   * file from memory, which can erase a hand edit and make them agree on the old mode).
   * An instance built from an explicit config (`options.config`) has no namespace or file
   * behind it: only its own mode exists, and that is the answer.
   */
  private submitModeCheck(): { mode?: SubmitModeState; mismatch?: ErgoSubmitModeMismatchError } {
    if (this.latchedMismatch) return { mismatch: this.latchedMismatch };
    if (!this.configFromManager) return { mode: this.submitModeState };
    const mismatch = this.findSubmitModeMismatch();
    if (!mismatch) return { mode: this.submitModeState };
    this.latchedMismatch = mismatch;
    return { mismatch };
  }

  /** The doubt about the submit mode found now (see submitModeCheck), or undefined when there is none. */
  private findSubmitModeMismatch(): ErgoSubmitModeMismatchError | undefined {
    const namespaceId = `ergo-${this.network}`;
    let inMemory: { mode?: SubmitModeState; text: string };
    let inFile: { mode?: SubmitModeState; text: string };
    try {
      const namespace = ConfigManagerV2.getInstance().getNamespace(namespaceId);
      if (!namespace) {
        inMemory = { text: `unreadable (no ${namespaceId} namespace)` };
        inFile = { text: 'not read' };
      } else {
        inMemory = readSubmitModeValue(namespace.get('submitMode'));
        let body: unknown;
        let readFailure: string | undefined;
        try {
          body = yaml.load(fs.readFileSync(namespace.configurationPath, 'utf8'));
        } catch (error) {
          // the error's code or class only: a parser's message quotes lines of the file
          readFailure = errorKind(error);
        }
        if (readFailure !== undefined) {
          inFile = { text: `unreadable (${readFailure})` };
        } else if (!body || typeof body !== 'object' || Array.isArray(body)) {
          inFile = { text: 'unreadable (not a mapping)' };
        } else {
          const keyProblem = findSubmitModeLookalike(namespaceId, body);
          if (keyProblem) return new ErgoSubmitModeMismatchError(this.network, { keyProblem });
          inFile = readSubmitModeValue((body as Record<string, unknown>).submitMode);
        }
      }
    } catch (error) {
      inMemory = { text: `unreadable (${errorKind(error)})` };
      inFile = { text: 'not read' };
    }
    const running = this.submitModeState;
    if (inMemory.mode === running && inFile.mode === running) return undefined;
    return new ErgoSubmitModeMismatchError(this.network, { running, inMemory: inMemory.text, inFile: inFile.text });
  }

  /**
   * The submit mode in force (see submitModeCheck). Throws ErgoSubmitModeMismatchError when
   * it is in doubt, and ErgoSubmitModeNotSetError when it is not set.
   */
  private submitModeInForce(): ErgoSubmitMode {
    const { mode, mismatch } = this.submitModeCheck();
    if (mismatch || mode === undefined) throw mismatch;
    if (mode === 'not set') throw new ErgoSubmitModeNotSetError(this.network);
    return mode;
  }

  /**
   * Refuse, before any box is selected and before a wallet's key is loaded, a swap or a
   * transfer this network cannot carry out: its submitMode is not set
   * (ErgoSubmitModeNotSetError), or it has already seen its submit mode in doubt
   * (ErgoSubmitModeMismatchError; see submitModeCheck). Callers that load a key run this
   * first.
   */
  assertSubmitModeSet(): void {
    if (this.latchedMismatch) throw this.latchedMismatch;
    if (this.submitMode === undefined) throw new ErgoSubmitModeNotSetError(this.network);
  }

  get nativeTokenSymbol(): string {
    return this.config.nativeCurrencySymbol;
  }

  /**
   * Confirmations a different transaction that spent one of our inputs needs before ours is
   * reported failed; `confirmations` when the network config does not set it.
   */
  private get failedAfterConfirmations(): number {
    return this.config.failedAfterConfirmations ?? this.config.confirmations;
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
    // The second signer is an unreleased alpha build of the signing library
    // (ergo-lib-wasm-nodejs 0.29.0-alpha-2f840d3). It is used only for a transaction with an
    // input or data input whose ErgoTree is version 3, which 0.28.0 cannot read; every other
    // transaction (transfers, Spectrum swaps) signs on 0.28.0 as before.
    let chosen = signer;
    if (spendsTreeVersion3(built)) {
      if (!signer.forTreeVersion3) {
        throw new ErgoTransactionAssertionError('an input is at ErgoTree version 3 and this signer cannot sign it');
      }
      chosen = await signer.forTreeVersion3();
      if (chosen.publicKeys.join(',') !== signer.publicKeys.join(',')) {
        throw new ErgoTransactionAssertionError('the version-3 signer holds other keys');
      }
    }
    const signed = await chosen.signTransaction(built.unsigned, built.unsigned.inputs, built.unsigned.dataInputs, {
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
   * A definite answer is given only once its release is written to the pending file: if
   * that write fails, the entry stays tracked (a restart would read it back and post it
   * again) and the answer is ErgoSubmitOutcomeUnknownError, so the caller polls.
   *
   * With submitMode `check`, nothing is recorded or submitted: the transaction is posted to
   * the node's check endpoint only, and the answer is always an error (see checkSigned).
   * The mode is read again here, before anything is recorded or posted (see
   * submitModeCheck): when it is in doubt, nothing is recorded or posted and the answer is
   * ErgoSubmitModeMismatchError. With submitMode not set, nothing is checked or submitted
   * and the answer is ErgoSubmitModeNotSetError, given at the start, before anything else.
   *
   * A transaction with fixed inputs (a contract box such as a pool) must go through
   * sendTransaction, which holds a lock on each fixed input as well as on the wallet, so
   * two wallets cannot race each other for the same box inside this process.
   */
  async submitTransaction(signed: SignedErgoTransaction, built: BuiltErgoTransaction): Promise<string> {
    this.assertSubmitModeSet();
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
    // the ids that stay readable in the node's text
    const ownIds = [signed.id, ...inputBoxIds];
    // the mode in force: throws, before anything is recorded or posted, when it is in doubt
    // or not set
    const mode = this.submitModeInForce();
    // check mode: checked by the node and never recorded, so the signed transaction is kept
    // nowhere and no later post can send it
    if (mode === 'check') return this.checkSigned(signed, ownIds);
    const walletErgoTree = built.changeErgoTree.toLowerCase();
    this.pending.record(signed.id, inputBoxIds, outputs, signed.json, fixedInputs, { walletErgoTree });
    let txId: string;
    try {
      txId = await this.postToSubmit(signed.json);
    } catch (error) {
      if (error instanceof ErgoSubmitRefusedError) {
        // the node client refused to post (the mode changed in the moment since it was
        // read above): nothing was sent
        this.releaseBeforeDefiniteAnswer(signed.id, error);
        throw this.submitModeCheck().mismatch ?? error;
      }
      if (error instanceof ErgoNodeError && error.status >= 400 && error.status < 500) {
        this.releaseBeforeDefiniteAnswer(signed.id, error);
        const fixed = built.inputBoxes.slice(0, built.fixedInputCount).map((b) => b.boxId);
        const gone = fixed.length > 0 ? await this.spentFixedInputs(fixed, error) : [];
        if (gone.length > 0) {
          throw new ErgoInputSpentError(
            `The node rejected the transaction: fixed input ${gone.join(', ')} is already spent`,
            gone,
            safeNodeText(error, ownIds),
          );
        }
        throw new ErgoTransactionRejectedError(error, ownIds);
      }
      if (error instanceof ErgoNodeError && error.status === 0 && failedBeforeConnecting(error)) {
        // no byte reached the node: nothing from this submit can confirm
        this.releaseBeforeDefiniteAnswer(signed.id, error);
        throw new ErgoNotSubmittedError(signed.id, error);
      }
      throw new ErgoSubmitOutcomeUnknownError(signed.id, error, inputBoxIds);
    }
    if (txId !== signed.id) {
      // The node's id is the one that will confirm. The outputs' box ids derive from our id,
      // so they are not offered as spendable; the inputs stay hidden under the node's id.
      // Submitted already, so a file write failure here is logged, never thrown.
      logger.error(`Ergo node returned id ${txId} for transaction ${signed.id}; tracking the node's id`);
      this.pending.record(txId, inputBoxIds, [], signed.json, fixedInputs, { mustPersist: false, walletErgoTree });
      this.pending.release(signed.id);
    }
    logger.info(`Submitted Ergo transaction ${txId} on ${this.network}`);
    return txId;
  }

  /**
   * check mode: post the signed transaction to the node's check endpoint, never to its
   * submit endpoint. Always throws: ErgoCheckOnlyError when the node found it valid,
   * ErgoCheckRejectedError when the node answered 400 (its verdict that the transaction is
   * invalid), ErgoCheckIncompleteError for anything else (no connection, a timeout, a 5xx,
   * another status, no id, another id), and also, without posting anything, when the node's
   * /info cannot be read or says it keeps no UTXO state. Nothing is recorded in any case.
   * The node's text is made safe (sanitizeNodeText) before it is logged or answered.
   */
  private async checkSigned(signed: SignedErgoTransaction, ownIds: string[]): Promise<never> {
    const incompleteBecause = (cause: unknown): ErgoCheckIncompleteError => {
      const incomplete = new ErgoCheckIncompleteError(signed.id, cause, ownIds);
      logger.info(`Ergo ${this.network}: ${incomplete.message}`);
      return incomplete;
    };
    // Only a node that keeps the UTXO set runs the scripts; any other checks the syntax
    // only, and its "valid" would mean little.
    let stateType: unknown;
    try {
      stateType = (await this.node.getInfo()).stateType;
    } catch (error) {
      throw incompleteBecause(error);
    }
    if (stateType !== 'utxo') {
      const shown = JSON.stringify(stateType ?? null).slice(0, 40);
      throw incompleteBecause(
        `this node keeps no UTXO state, its stateType is ${shown}, so it cannot validate scripts`,
      );
    }
    let id: string;
    try {
      id = await this.node.checkTransaction(signed.json);
    } catch (error) {
      if (error instanceof ErgoNodeError && error.status === 400) {
        logger.info(
          `Ergo ${this.network}: check only: the node refused transaction ${signed.id}; nothing was sent: ` +
            safeNodeText(error, ownIds),
        );
        throw new ErgoCheckRejectedError(error, ownIds);
      }
      throw incompleteBecause(error);
    }
    if (id !== signed.id) {
      const incomplete = new ErgoCheckIncompleteError(signed.id, `the node answered with id ${id}`, ownIds);
      logger.info(`Ergo ${this.network}: ${incomplete.message}`);
      throw incomplete;
    }
    logger.info(`Ergo ${this.network}: check only: the node accepted transaction ${id} as valid; nothing was sent`);
    throw new ErgoCheckOnlyError(id);
  }

  /**
   * The one path to the node's submit endpoint. Never reached in check mode (every caller
   * branches before it); refused here as well, so no path can send in that mode.
   */
  private async postToSubmit(json: string): Promise<string> {
    if (this.submitMode !== 'send') {
      throw new Error(`ergo-${this.network}.submitMode is ${this.submitModeState}: nothing is sent to the node`);
    }
    return this.node.submitTransaction(json);
  }

  /**
   * Release a transaction about to be answered as not taken. If the release cannot be
   * written to the pending file, the entry stays tracked and the answer becomes an unknown
   * outcome: a restart would read the entry back and post it again, so "not taken" would
   * not hold.
   */
  private releaseBeforeDefiniteAnswer(txId: string, cause: unknown): void {
    try {
      this.pending.release(txId, { mustPersist: true });
    } catch (writeError) {
      logger.error(
        `Ergo ${this.network}: transaction ${txId} is kept and answered as an unknown outcome: ` +
          `${writeError instanceof Error ? writeError.message : String(writeError)}`,
      );
      throw new ErgoSubmitOutcomeUnknownError(txId, cause);
    }
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
    this.assertSubmitModeSet();
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

  /**
   * A token as a check answer names it (see tokenForMessage): its symbol from the token
   * list or the node, and the start of its id. A lookup that fails leaves the id alone.
   */
  private async tokenNameForMessage(tokenId: string): Promise<string> {
    let symbol = tokenId;
    try {
      symbol = (await this.getTokenById(tokenId))?.symbol ?? tokenId;
    } catch {
      // named by its id only
    }
    return tokenForMessage(symbol, tokenId.toLowerCase());
  }

  /** Send ERG and tokens from a stored wallet. Internal: upstream has no transfer route. */
  async transfer(
    fromAddress: string,
    toAddress: string,
    nanoErgs: bigint,
    tokens: ErgoTokenAmount[] = [],
  ): Promise<string> {
    this.assertSubmitModeSet();
    return this.withLock(`tree:${this.addressToErgoTree(fromAddress)}`, async () => {
      const wallet = await this.getWallet(fromAddress);
      try {
        const built = await this.buildTransfer(fromAddress, toAddress, nanoErgs, tokens);
        const signed = await this.signTransaction(built, wallet.signer);
        try {
          return await this.submitSigned(signed, built);
        } catch (error) {
          if (error instanceof ErgoCheckOnlyError) {
            const symbol = symbolForMessage(this.config.nativeCurrencySymbol, null);
            const names = await Promise.all(tokens.map((t) => this.tokenNameForMessage(t.tokenId)));
            const tokenText = tokens.map((t, i) => `, ${t.amount} of ${names[i]} (in its smallest unit)`).join('');
            throw error.withMoves(
              `${formatUnits(nanoErgs, this.config.nativeDecimals)} ${symbol}${tokenText} to ${toAddress}, ` +
                `miner fee ${formatUnits(built.fee, this.config.nativeDecimals)} ${symbol}`,
            );
          }
          throw error;
        }
      } finally {
        // the key is loaded for this one send; wipe it once the send has settled
        wallet.signer.dispose?.();
      }
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
      if (done) this.pending.releaseConfirmed(id);
      else this.pending.markRefused(id, false);
      return {
        ...base,
        txBlock: inclusionHeight,
        txStatus: done ? TransactionStatusCode.CONFIRMED : TransactionStatusCode.PENDING,
        fee: this.feeOf(confirmed),
        txData: summarize(confirmed, confirmations),
      };
    }

    const tracked = this.pending.get(id);

    // The indexer can lag the chain; a transaction in a block it has not indexed yet looks
    // unknown. Read the index height before any input box, so box reads are at least as
    // fresh as the height the decision below is made on.
    const indexed = await this.node.getIndexedHeight();
    const chainHeight = Math.max(fullHeight, typeof indexed.fullHeight === 'number' ? indexed.fullHeight : fullHeight);
    const indexBehind = indexed.indexedHeight < chainHeight;

    // Neither indexed nor in the mempool. Failed only on proof: one of its inputs spent by a
    // different transaction that has the network's failedAfterConfirmations, which we can
    // check for transactions we submitted.
    const inputs = tracked ? await this.readTrackedInputs(tracked) : undefined;
    if (inputs?.spentElsewhere) {
      const { boxId, by } = inputs.spentElsewhere;
      const depth = await this.confirmationsOfTransaction(by, fullHeight);
      if (depth >= this.failedAfterConfirmations) {
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
            `input ${boxId} is spent by transaction ${by}, which has ${depth} of the ${this.failedAfterConfirmations} ` +
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

    // Released earlier because it can never confirm. Asked only after the mempool, the index
    // and the index-lag check: a transaction the chain shows confirmed is confirmed, and one
    // in a block the index has not reached yet is not known, whatever this says.
    const failed = tracked ? undefined : this.pending.failedReason(id);
    if (failed) {
      return { ...base, txBlock: null, txStatus: TransactionStatusCode.FAILED, error: failed.reason, txData: null };
    }

    // Ours, every input still unspent on an index that has caught up, and the node holds
    // it nowhere: it was dropped. Post it once more rather than forget it, since releasing
    // would let a rebuild execute twice if the dropped one resurfaces.
    if (tracked && inputs!.allUnspent) {
      const { mode, mismatch } = this.submitModeCheck();
      if (mismatch) {
        // the mode is in doubt: kept, its inputs hidden, not posted
        logger.warn(`Ergo ${this.network}: transaction ${id} is not posted again: ${mismatch.message}`);
        return {
          ...base,
          txBlock: null,
          txStatus: TransactionStatusCode.NOT_FOUND,
          txData: {
            note: `the node holds it nowhere and its inputs are unspent; it is kept, and not posted again: ${mismatch.message}`,
          },
        };
      }
      if (mode !== 'send') {
        // a transaction sent before the mode was check or not set: kept, its inputs hidden, not posted
        return {
          ...base,
          txBlock: null,
          txStatus: TransactionStatusCode.NOT_FOUND,
          txData: {
            note:
              'the node holds it nowhere and its inputs are unspent; it is kept, and not posted again while ' +
              `submitMode is ${mode}`,
          },
        };
      }
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
      // in check mode or with the mode not set no parent is posted again either, nor while the mode is in doubt
      const { mode, mismatch } = this.submitModeCheck();
      if (mismatch) {
        logger.warn(`Ergo ${this.network}: the transactions ${id} waits for are not posted again: ${mismatch.message}`);
      }
      await this.settleWaitingAncestors(id, parents, fullHeight, mode === 'send');
      const cascaded = this.pending.failedReason(id);
      if (cascaded) {
        return { ...base, txBlock: null, txStatus: TransactionStatusCode.FAILED, error: cascaded.reason, txData: null };
      }
      const stillPending = parents.filter((p) => this.pending.get(p) !== undefined);
      return {
        ...base,
        txBlock: null,
        txStatus: TransactionStatusCode.PENDING,
        txData: {
          note:
            stillPending.length > 0
              ? `waits for transaction ${stillPending.join(', ')}, which creates its inputs and is still pending`
              : `ancestor transaction ${parents.join(', ')} settled; re-poll to track this transaction`,
        },
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
    const ownIds = [tx.txId, ...tx.inputBoxIds];
    try {
      await this.postToSubmit(tx.json);
    } catch (error) {
      if (error instanceof ErgoNodeError && error.status >= 400 && error.status < 500) {
        this.pending.markRefused(tx.txId, true);
        logger.warn(
          `Ergo ${this.network}: transaction ${tx.txId} was refused when posted again, and is kept: ` +
            safeNodeText(error, ownIds),
        );
        return error;
      }
      // the node's text goes on to a log line or an answer: made safe first
      throw error instanceof ErgoNodeError ? sanitizedNodeError(error, ownIds) : error;
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
    const said = safeNodeText(refusal, [tx.txId, ...tx.inputBoxIds]);
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
   * Walk tracked ancestors of a waiting child transaction: confirm/release settled ones,
   * fail-cascade any ancestor whose input was spent by a competing transaction at
   * `failedAfterConfirmations` (regardless of submitMode), recurse up multi-hop chains, and
   * rebroadcast dropped root ancestors when `allowRebroadcast` is true.
   */
  private async settleWaitingAncestors(
    childId: string,
    roots: string[],
    fullHeight: number,
    allowRebroadcast: boolean,
  ): Promise<void> {
    const queue = [...roots];
    const visited = new Set<string>([childId]);
    while (queue.length > 0) {
      const ancestorId = queue.shift()!;
      if (visited.has(ancestorId)) continue;
      visited.add(ancestorId);
      const ancestorTx = this.pending.get(ancestorId);
      if (!ancestorTx) continue;
      try {
        if (await this.node.getUnconfirmedTransaction(ancestorId)) {
          this.pending.markRefused(ancestorId, false);
          continue;
        }
        const confirmed = await this.node.getTransaction(ancestorId);
        if (confirmed) {
          if (confirmationsOf(confirmed, fullHeight) >= this.config.confirmations) {
            this.pending.releaseConfirmed(ancestorId);
          } else {
            this.pending.markRefused(ancestorId, false);
          }
          continue;
        }
        const aInputs = await this.readTrackedInputs(ancestorTx);
        if (aInputs.spentElsewhere) {
          const { boxId, by } = aInputs.spentElsewhere;
          if ((await this.confirmationsOfTransaction(by, fullHeight)) >= this.failedAfterConfirmations) {
            const reason = `Input ${boxId} was spent by transaction ${by}; this transaction can no longer confirm`;
            this.pending.releaseFailed(ancestorId, reason);
            if (this.pending.failedReason(childId)) return;
          }
          continue;
        }
        if (aInputs.waitingOn.length > 0 && aInputs.unknown.length === 0) {
          for (const grandParent of aInputs.waitingOn) {
            if (!visited.has(grandParent)) queue.push(grandParent);
          }
          continue;
        }
        if (aInputs.allUnspent && allowRebroadcast) {
          await this.postAgain(ancestorTx);
        }
      } catch (error) {
        logger.warn(
          `Ergo ${this.network}: could not check transaction ${ancestorId}, which ${childId} waits for: ` +
            safeErrorText(error, [ancestorId, ...ancestorTx.inputBoxIds]),
        );
      }
    }
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
   * A spend by the id in the entry's own signed JSON is a spend by this transaction too:
   * when the node answered the submit with another id, the entry is tracked under the
   * node's id, while the transaction posted (the one that confirms) carries ours.
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
    const self = new Set([tracked.txId]);
    const postedId = signedJsonId(tracked.json);
    if (postedId !== undefined) self.add(postedId);
    for (const boxId of tracked.inputBoxIds) {
      const box = await this.node.getBox(boxId);
      if (box?.spentTransactionId && !self.has(box.spentTransactionId)) {
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
   * - an input spent by a different transaction that has the network's failedAfterConfirmations:
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
            safeErrorText(error, [tx.txId, ...tx.inputBoxIds]),
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
      if (confirmationsOf(confirmed, fullHeight) >= this.config.confirmations) this.pending.releaseConfirmed(id);
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
      if ((await this.confirmationsOfTransaction(by, fullHeight)) < this.failedAfterConfirmations) return;
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
    // dropped by the node while it can still confirm: post it again (a refusal keeps it). A
    // refusal is checked against the mempool as poll does: the node may hold it after all
    // (posted by a poll at the same moment, or relayed back by a peer), and then it is not
    // marked refused.
    if (inputs.allUnspent) {
      const { mode, mismatch } = this.submitModeCheck();
      if (mismatch) {
        logger.warn(
          `Ergo ${this.network}: pending transaction ${id} is held nowhere by the node and its inputs are unspent; ` +
            `it is kept, and not posted again: ${mismatch.message}`,
        );
        return;
      }
      if (mode !== 'send') {
        logger.warn(
          `Ergo ${this.network}: pending transaction ${id} is held nowhere by the node and its inputs are unspent; ` +
            `it is kept, and not posted again while submitMode is ${mode}`,
        );
        return;
      }
      const refusal = await this.postAgain(tx);
      if (refusal) await this.refusedAnswer(tx, refusal);
    }
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

/** The transaction id carried in a tracked entry's signed JSON, or undefined when it cannot be read. */
function signedJsonId(json: string): string | undefined {
  try {
    const id = parseNodeJson<{ id?: unknown }>(json)?.id;
    return typeof id === 'string' ? id : undefined;
  } catch {
    return undefined;
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

/** The version an ErgoTree's header byte states (its low three bits). */
export function ergoTreeVersion(ergoTree: string): number {
  return parseInt(ergoTree.slice(0, 2), 16) & 0x07;
}

/**
 * Whether a transaction spends or reads a box at an ErgoTree of version 3. A version above
 * 3 is refused: no signer here is known to read it.
 */
export function spendsTreeVersion3(built: BuiltErgoTransaction): boolean {
  const versions = [...built.inputBoxes, ...built.dataInputBoxes].map((b) => ergoTreeVersion(b.ergoTree));
  if (versions.some((v) => v > 3))
    throw new ErgoTransactionAssertionError('an input is at an ErgoTree version above 3');
  return versions.includes(3);
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
