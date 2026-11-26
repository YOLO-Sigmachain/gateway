/**
 * Ergo node REST client. Node-only: heights, headers, boxes, transactions, tokens and
 * submission all come from one node, which must run the extra indexer for the
 * /blockchain routes.
 *
 * Every response is parsed bigint-safe. A failed request raises `ErgoNodeError`
 * carrying the node's own reason and detail, never a swallowed or generic code.
 */
import { parseNodeJson, toAmount } from './ergo.json';
import { ErgoBox, ErgoRegisters, NodeHeaderJson, REGISTER_IDS } from './ergo.types';
import { assertErgoId } from './ergo.utils';

export class ErgoNodeError extends Error {
  /** HTTP status, or 0 when the node could not be reached. */
  readonly status: number;
  /** The node's `reason` field, when it sent one. */
  readonly reason?: string;
  /** The node's `detail` field: for a rejected transaction, why it was rejected. */
  readonly detail?: string;

  /** `options.cause`: for status 0, the transport error as the fetch threw it. */
  constructor(status: number, message: string, reason?: string, detail?: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ErgoNodeError';
    this.status = status;
    this.reason = reason;
    this.detail = detail;
  }
}

export interface NodeInfo {
  fullHeight: number;
  headersHeight?: number;
  bestFullHeaderId?: string;
  network?: string;
  appVersion?: string;
  isExplorer?: boolean;
  parameters?: {
    minValuePerByte?: number;
    storageFeeFactor?: number;
    maxBlockCost?: number;
    height?: number;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface NodeTokenInfo {
  id: string;
  name: string | null;
  decimals: number | null;
  emissionAmount?: bigint;
}

/** A transaction as the indexer or the mempool returns it, amounts not normalized. */
export interface NodeTransaction {
  id: string;
  inputs: Array<{ boxId: string; [key: string]: unknown }>;
  dataInputs?: Array<{ boxId: string }>;
  outputs: Array<Record<string, unknown>>;
  inclusionHeight?: number;
  numConfirmations?: number;
  [key: string]: unknown;
}

export interface UnspentQuery {
  includeUnconfirmed: boolean;
  excludeMempoolSpent: boolean;
}

export type FetchLike = (
  input: string,
  init?: Record<string, unknown>,
) => Promise<{
  ok: boolean;
  status: number;
  text: () => Promise<string>;
}>;

const MAX_PAGES = 1000;

/** Normalize one box from node JSON: amounts to bigint, registers as hex, fields checked. */
export function normalizeNodeBox(raw: Record<string, unknown>): ErgoBox {
  const boxId = assertErgoId(raw.boxId, 'boxId');
  const transactionId = assertErgoId(raw.transactionId, 'transactionId');
  const ergoTree = raw.ergoTree;
  if (typeof ergoTree !== 'string' || !/^([0-9a-fA-F]{2})+$/.test(ergoTree)) {
    throw new Error(`Box ${boxId}: invalid ergoTree`);
  }
  const index = Number(raw.index);
  const creationHeight = Number(raw.creationHeight);
  if (!Number.isInteger(index) || index < 0 || !Number.isInteger(creationHeight) || creationHeight < 0) {
    throw new Error(`Box ${boxId}: invalid index or creationHeight`);
  }
  const assets = ((raw.assets as Array<Record<string, unknown>>) || []).map((asset) => ({
    tokenId: assertErgoId(asset.tokenId, `Box ${boxId} tokenId`),
    amount: toAmount(asset.amount, `Box ${boxId} token amount`),
  }));
  const registers: ErgoRegisters = {};
  const rawRegisters = (raw.additionalRegisters as Record<string, unknown>) || {};
  for (const id of REGISTER_IDS) {
    const reg = rawRegisters[id];
    if (reg === undefined || reg === null) continue;
    // The node writes registers as hex; some APIs wrap them as { serializedValue }.
    const hexValue = typeof reg === 'string' ? reg : (reg as { serializedValue?: unknown }).serializedValue;
    if (typeof hexValue !== 'string' || !/^([0-9a-fA-F]{2})+$/.test(hexValue)) {
      throw new Error(`Box ${boxId}: register ${id} is not hex`);
    }
    registers[id] = hexValue;
  }
  const inclusion = raw.inclusionHeight;
  return {
    boxId,
    transactionId,
    index,
    value: toAmount(raw.value, `Box ${boxId} value`),
    ergoTree: ergoTree.toLowerCase(),
    creationHeight,
    assets,
    additionalRegisters: registers,
    inclusionHeight: typeof inclusion === 'number' && inclusion > 0 ? inclusion : undefined,
  };
}

export class ErgoNodeClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly pageSize: number;
  private readonly fetchImpl: FetchLike;

  constructor(baseUrl: string, options: { timeoutMs: number; pageSize: number; fetch?: FetchLike }) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs;
    this.pageSize = options.pageSize;
    this.fetchImpl = options.fetch ?? ((input, init) => (globalThis.fetch as unknown as FetchLike)(input, init));
  }

  /**
   * One request. Returns the parsed body, or `null` for a 404 when `notFoundIsNull`.
   * Any other failure throws `ErgoNodeError` with the node's reason and detail.
   */
  async request<T>(
    method: 'GET' | 'POST',
    path: string,
    options: { body?: string; contentType?: string; notFoundIsNull?: boolean; plainTextOk?: boolean } = {},
  ): Promise<T | null> {
    const url = `${this.baseUrl}${path}`;
    let response: Awaited<ReturnType<FetchLike>>;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers: options.body !== undefined ? { 'Content-Type': options.contentType ?? 'application/json' } : {},
        body: options.body,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new ErgoNodeError(0, `Ergo node unreachable (${method} ${path}): ${message}`, undefined, undefined, {
        cause: error,
      });
    }

    const text = await response.text();
    if (response.status === 404 && options.notFoundIsNull) {
      return null;
    }
    if (!response.ok) {
      let reason: string | undefined;
      let detail: string | undefined;
      try {
        const body = parseNodeJson<{ reason?: unknown; detail?: unknown }>(text);
        reason = typeof body?.reason === 'string' ? body.reason : undefined;
        detail = typeof body?.detail === 'string' ? body.detail : undefined;
      } catch {
        detail = text.slice(0, 2000) || undefined;
      }
      const said = [reason, detail].filter(Boolean).join(': ') || `HTTP ${response.status}`;
      throw new ErgoNodeError(response.status, `Ergo node rejected ${method} ${path}: ${said}`, reason, detail);
    }
    if (text.trim() === '') {
      return null;
    }
    try {
      return parseNodeJson<T>(text);
    } catch (error) {
      if (options.plainTextOk) return text.trim() as unknown as T;
      throw new ErgoNodeError(response.status, `Ergo node sent unreadable JSON for ${method} ${path}`);
    }
  }

  async getInfo(): Promise<NodeInfo> {
    const info = await this.request<NodeInfo>('GET', '/info');
    if (!info || typeof info.fullHeight !== 'number') {
      throw new ErgoNodeError(200, 'Ergo node /info has no fullHeight (node not synced?)');
    }
    return info;
  }

  async getIndexedHeight(): Promise<{ indexedHeight: number; fullHeight: number }> {
    const body = await this.request<{ indexedHeight: number; fullHeight: number }>('GET', '/blockchain/indexedHeight');
    if (!body || typeof body.indexedHeight !== 'number') {
      throw new ErgoNodeError(200, 'Ergo node has no extra indexer (/blockchain/indexedHeight)');
    }
    return body;
  }

  /** The last `count` headers, oldest first as the node returns them. */
  async getLastHeaders(count: number): Promise<NodeHeaderJson[]> {
    const headers = await this.request<NodeHeaderJson[]>('GET', `/blocks/lastHeaders/${Math.trunc(count)}`);
    if (!Array.isArray(headers) || headers.length === 0) {
      throw new ErgoNodeError(200, 'Ergo node returned no headers');
    }
    return headers;
  }

  /**
   * Every unspent box at an address, paged. With `includeUnconfirmed` the node adds outputs
   * of mempool transactions; with `excludeMempoolSpent` it drops boxes a mempool
   * transaction spends.
   */
  async getUnspentBoxesByAddress(address: string, query: UnspentQuery): Promise<ErgoBox[]> {
    const boxes: ErgoBox[] = [];
    let lastBatchLength = 0;
    for (let page = 0; page < MAX_PAGES; page++) {
      const params = new URLSearchParams({
        offset: String(page * this.pageSize),
        limit: String(this.pageSize),
        sortDirection: 'asc',
        includeUnconfirmed: String(query.includeUnconfirmed),
        excludeMempoolSpent: String(query.excludeMempoolSpent),
      });
      const batch = await this.request<Array<Record<string, unknown>>>(
        'POST',
        `/blockchain/box/unspent/byAddress?${params.toString()}`,
        { body: address, contentType: 'text/plain', notFoundIsNull: true },
      );
      lastBatchLength = batch ? batch.length : 0;
      if (!batch || batch.length === 0) break;
      boxes.push(...batch.map(normalizeNodeBox));
      if (batch.length < this.pageSize) break;
    }
    // The last page was full: there are more boxes than the page limit lets us read.
    if (lastBatchLength >= this.pageSize) {
      throw new ErgoNodeError(
        200,
        `Address has more than ${MAX_PAGES * this.pageSize} unspent boxes; refusing to report a partial set`,
      );
    }
    // A box can appear twice if the set moved between pages.
    const seen = new Set<string>();
    return boxes.filter((box) => (seen.has(box.boxId) ? false : (seen.add(box.boxId), true)));
  }

  /**
   * Unspent boxes holding a token, one page (newest first). Without `includeUnconfirmed`
   * this is the confirmed UTXO set only.
   */
  async getUnspentBoxesByTokenId(
    tokenId: string,
    query: UnspentQuery & { limit: number; offset?: number },
  ): Promise<ErgoBox[]> {
    const params = new URLSearchParams({
      offset: String(query.offset ?? 0),
      limit: String(Math.min(query.limit, this.pageSize)),
      sortDirection: 'desc',
      includeUnconfirmed: String(query.includeUnconfirmed),
      excludeMempoolSpent: String(query.excludeMempoolSpent),
    });
    const batch = await this.request<Array<Record<string, unknown>>>(
      'GET',
      `/blockchain/box/unspent/byTokenId/${assertErgoId(tokenId, 'token id')}?${params.toString()}`,
      { notFoundIsNull: true },
    );
    return (batch ?? []).map(normalizeNodeBox);
  }

  /**
   * Every confirmed unspent box at an exact ErgoTree, paged at the client's page size.
   * The node answers with a list (or, on some versions, `{ items, total }`). Refuses a
   * partial set: more than `maxBoxes` boxes throws.
   */
  async getUnspentBoxesByErgoTree(ergoTree: string, maxBoxes: number): Promise<ErgoBox[]> {
    const { boxes, complete } = await this.readUnspentBoxesByErgoTree(ergoTree, maxBoxes);
    if (!complete) {
      throw new ErgoNodeError(200, `More than ${maxBoxes} unspent boxes at this ErgoTree; refusing a partial set`);
    }
    return boxes;
  }

  /**
   * The same read, for a caller that can use a partial set: at most about `maxBoxes`
   * boxes (oldest first), and `complete` false when the tree holds more than were read.
   */
  async readUnspentBoxesByErgoTree(
    ergoTree: string,
    maxBoxes: number,
  ): Promise<{ boxes: ErgoBox[]; complete: boolean }> {
    if (!/^([0-9a-fA-F]{2})+$/.test(ergoTree)) throw new Error('ergoTree must be hex');
    const boxes: ErgoBox[] = [];
    const unique = () => {
      const seen = new Set<string>();
      return boxes.filter((box) => (seen.has(box.boxId) ? false : (seen.add(box.boxId), true)));
    };
    for (let offset = 0; offset < maxBoxes; offset += this.pageSize) {
      const params = new URLSearchParams({
        offset: String(offset),
        limit: String(this.pageSize),
        sortDirection: 'asc',
        includeUnconfirmed: 'false',
        excludeMempoolSpent: 'false',
      });
      const body = await this.request<Array<Record<string, unknown>> | { items?: Array<Record<string, unknown>> }>(
        'POST',
        `/blockchain/box/unspent/byErgoTree?${params.toString()}`,
        { body: JSON.stringify(ergoTree.toLowerCase()), contentType: 'application/json', notFoundIsNull: true },
      );
      const batch = Array.isArray(body) ? body : (body?.items ?? []);
      boxes.push(...batch.map(normalizeNodeBox));
      if (batch.length < this.pageSize) return { boxes: unique(), complete: true };
    }
    return { boxes: unique(), complete: false };
  }

  /** Outputs of mempool transactions that hold a token (boxes not yet confirmed). */
  async getUnconfirmedOutputsByTokenId(tokenId: string): Promise<ErgoBox[]> {
    const batch = await this.request<Array<Record<string, unknown>>>(
      'GET',
      `/transactions/unconfirmed/outputs/byTokenId/${assertErgoId(tokenId, 'token id')}`,
      { notFoundIsNull: true },
    );
    return (batch ?? []).map(normalizeNodeBox);
  }

  /** Whether a mempool transaction spends this box. */
  async isSpentInMempool(boxId: string): Promise<boolean> {
    const raw = await this.request<Record<string, unknown>>(
      'GET',
      `/transactions/unconfirmed/inputs/byBoxId/${assertErgoId(boxId, 'boxId')}`,
      { notFoundIsNull: true },
    );
    return raw !== null;
  }

  async getBox(boxId: string): Promise<(ErgoBox & { spentTransactionId?: string | null }) | null> {
    const raw = await this.request<Record<string, unknown>>(
      'GET',
      `/blockchain/box/byId/${assertErgoId(boxId, 'boxId')}`,
      {
        notFoundIsNull: true,
      },
    );
    if (!raw) return null;
    const spent = raw.spentTransactionId;
    return { ...normalizeNodeBox(raw), spentTransactionId: typeof spent === 'string' ? spent : null };
  }

  /** A confirmed transaction from the indexer, or null if the indexer has none. */
  async getTransaction(txId: string): Promise<NodeTransaction | null> {
    return this.request<NodeTransaction>(
      'GET',
      `/blockchain/transaction/byId/${assertErgoId(txId, 'transaction id')}`,
      {
        notFoundIsNull: true,
      },
    );
  }

  /** A transaction in the node's mempool, or null if it is not there. */
  async getUnconfirmedTransaction(txId: string): Promise<NodeTransaction | null> {
    return this.request<NodeTransaction>(
      'GET',
      `/transactions/unconfirmed/byTransactionId/${assertErgoId(txId, 'transaction id')}`,
      { notFoundIsNull: true },
    );
  }

  async getToken(tokenId: string): Promise<NodeTokenInfo | null> {
    const raw = await this.request<Record<string, unknown>>(
      'GET',
      `/blockchain/token/byId/${assertErgoId(tokenId, 'token id')}`,
      {
        notFoundIsNull: true,
      },
    );
    if (!raw) return null;
    return {
      id: String(raw.id),
      name: typeof raw.name === 'string' ? raw.name : null,
      decimals: typeof raw.decimals === 'number' ? raw.decimals : null,
      emissionAmount: raw.emissionAmount !== undefined ? toAmount(raw.emissionAmount, 'emissionAmount') : undefined,
    };
  }

  /**
   * Submit a signed transaction. `json` is sent byte for byte as the signer wrote it.
   * Returns the id the node accepted. A rejection throws with the node's reason.
   */
  async submitTransaction(json: string): Promise<string> {
    // The node answers with the id as a JSON string; a bare id is accepted too.
    const id = await this.request<string>('POST', '/transactions', {
      body: json,
      contentType: 'application/json',
      plainTextOk: true,
    });
    if (typeof id !== 'string' || !/^[0-9a-fA-F]{64}$/.test(id)) {
      throw new ErgoNodeError(200, `Ergo node accepted the transaction but returned no id: ${String(id)}`);
    }
    return id;
  }
}
