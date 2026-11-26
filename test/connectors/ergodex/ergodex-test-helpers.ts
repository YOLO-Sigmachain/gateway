/**
 * Fixtures for the ergodex tests. Pool boxes in `fixtures/` were read from the local
 * mainnet node with read-only GETs on 2026-11-25 (`/blockchain/box/unspent/byTokenId/<pool
 * NFT>`), as were the headers. Synthetic pools are built with real fleet-sdk at the same
 * live trees, so their box ids are true hashes. Keys are BIP-39 test vectors only.
 */
import * as fs from 'fs';
import * as path from 'path';

import { SInt } from '@fleet-sdk/core';

import { Ergo } from '../../../src/chains/ergo/ergo';
import { ErgoNetworkConfig } from '../../../src/chains/ergo/ergo.config';
import { parseNodeJson } from '../../../src/chains/ergo/ergo.json';
import { FetchLike, normalizeNodeBox } from '../../../src/chains/ergo/ergo.node-client';
import { WasmErgoSigner } from '../../../src/chains/ergo/ergo.signer';
import { ErgoBox, ErgoTokenInfo, NodeHeaderJson } from '../../../src/chains/ergo/ergo.types';
import { addressFromPublicKey } from '../../../src/chains/ergo/ergo.utils';
import { Ergodex } from '../../../src/connectors/ergodex/ergodex';
import { ErgodexNetworkConfig, ErgodexRootConfig } from '../../../src/connectors/ergodex/ergodex.config';
import {
  checkTestConfig,
  makeBox,
  MNEMONIC_A,
  nodeBoxJson,
  p2pk,
  testConfig,
  tokenId,
  withoutSubmitMode,
} from '../../chains/ergo/ergo-test-helpers';

export { checkTestConfig, makeBox, nodeBoxJson, p2pk, tokenId, MNEMONIC_A, testConfig, withoutSubmitMode };

const FIXTURES = path.join(__dirname, 'fixtures');

export const fixtureText = (name: string): string => fs.readFileSync(path.join(FIXTURES, name), 'utf8');

/** The single pool box in a fixture file, normalized (amounts as exact bigints). */
export function fixturePool(name: string): ErgoBox {
  const list = parseNodeJson<Array<Record<string, unknown>>>(fixtureText(name));
  if (list.length !== 1) throw new Error(`fixture ${name} must hold one box`);
  return normalizeNodeBox(list[0]);
}

export const RSN_POOL = fixturePool('pool-n2t-erg-rsn.json');
export const SIGUSD_POOL = fixturePool('pool-n2t-erg-sigusd.json');
export const RSBTC_POOL = fixturePool('pool-n2t-erg-rsbtc.json');
export const T2T_POOL = fixturePool('pool-t2t-wterg-wtada.json');

/** The live trees, taken from the captured boxes. */
export const N2T_TREE = RSN_POOL.ergoTree;
export const T2T_TREE = T2T_POOL.ergoTree;

export const HEADERS: NodeHeaderJson[] = JSON.parse(fixtureText('mainnet-last-headers.json'));
export const TIP = Math.max(...HEADERS.map((h) => h.height));

export const RSN = '8b08cdd5449a9592a9e79711d7d79249d7a03c535d17efaee83e216e80a44c4b';
export const SIGUSD = '03faf2cb329f2e90d6d23b58d91bbb6c046aa143261cc21f52fbe2824bfcbf04';
export const RSBTC = '7a51950e5f548549ec1aa63ffdc38279505b11e7e803d01bcf8347e0123c88b0';
export const WT_ERG = 'ef802b475c06189fdbf844153cdc1d449a5ba87cce13d11bb47b5a539f27f12b';
export const WT_ADA = '30974274078845f263b4f21787e33cc99e9ec19a17ad85a5bc6da2cca91c5a2e';

export const TOKENS: ErgoTokenInfo[] = [
  { address: RSN, symbol: 'RSN', name: 'RSN', decimals: 3 },
  { address: SIGUSD, symbol: 'SigUSD', name: 'SigUSD', decimals: 2 },
  { address: RSBTC, symbol: 'rsBTC', name: 'rsBTC', decimals: 8 },
  { address: WT_ERG, symbol: 'WT_ERG', name: 'WT_ERG', decimals: 9 },
  { address: WT_ADA, symbol: 'WT_ADA', name: 'WT_ADA', decimals: 8 },
];

export const signer = WasmErgoSigner.fromMnemonic(MNEMONIC_A);
export const ME_TREE = p2pk(signer.publicKeys[0]);
export const ME = addressFromPublicKey(signer.publicKeys[0], 0);
export const ERG = 1000000000n;

export const R4 = (fee: number): string => SInt(fee).toHex();

/** A synthetic ERG/token pool at the live tree. */
export function n2tPool(p: {
  x: bigint;
  y: bigint;
  fee: number;
  token?: string;
  nft?: string;
  lp?: bigint;
  creationHeight?: number;
  tree?: string;
}): ErgoBox {
  return makeBox({
    ergoTree: p.tree ?? N2T_TREE,
    value: p.x,
    creationHeight: p.creationHeight ?? TIP - 5,
    assets: [
      { tokenId: p.nft ?? tokenId(0xa1), amount: 1n },
      { tokenId: tokenId(0xb1), amount: p.lp ?? 9223372036854000000n },
      { tokenId: p.token ?? tokenId(0xc1), amount: p.y },
    ],
    registers: { R4: R4(p.fee) },
  });
}

/** A synthetic token/token pool at the live tree. */
export function t2tPool(p: {
  x: bigint;
  y: bigint;
  fee: number;
  tokenX?: string;
  tokenY?: string;
  nft?: string;
}): ErgoBox {
  return makeBox({
    ergoTree: T2T_TREE,
    value: 4000000n,
    creationHeight: TIP - 5,
    assets: [
      { tokenId: p.nft ?? tokenId(0xa2), amount: 1n },
      { tokenId: tokenId(0xb2), amount: 9223370000000000000n },
      { tokenId: p.tokenX ?? tokenId(0xc2), amount: p.x },
      { tokenId: p.tokenY ?? tokenId(0xc3), amount: p.y },
    ],
    registers: { R4: R4(p.fee) },
  });
}

export function dexConfig(
  over: Partial<ErgodexNetworkConfig> = {},
  spectrum: Partial<ErgodexNetworkConfig['spectrum']> = {},
): ErgodexNetworkConfig {
  return {
    useMempoolSuccessor: true,
    maxPoolFeePct: '3',
    minPoolNativeReserve: 0n,
    minPoolTokenReserve: 1n,
    poolAllowlist: [],
    maxDiscoveredBoxes: 1000,
    ...over,
    spectrum: {
      n2tPoolTrees: [N2T_TREE],
      t2tPoolTrees: [T2T_TREE],
      feeDenominator: 1000n,
      n2tMinSuccessorValue: 10000000n,
      lockedLiquidity: 9223372036854775807n,
      ...spectrum,
    },
  };
}

export const ROOT: ErgodexRootConfig = { slippagePct: 1, maxRebuilds: 2, rebuildWaitMs: 0 };

export interface NodeState {
  /** Confirmed unspent pool boxes, by pool NFT (what byTokenId returns). */
  pools: Map<string, ErgoBox[]>;
  /** Mempool outputs holding a pool NFT. */
  mempool: Map<string, ErgoBox[]>;
  /** Box ids a mempool transaction spends. */
  mempoolSpent: Set<string>;
  /** Boxes at each tree (what byErgoTree returns). */
  byTree: Map<string, ErgoBox[]>;
  wallet: ErgoBox[];
  /** Index view of a box (for `getBox`). */
  boxes: Map<string, Record<string, unknown>>;
  /** 'throw': the connection breaks mid-request; 'refused': the connection is never made. */
  submit: (body: string) => { status?: number; body: unknown } | 'throw' | 'refused';
  posted: string[];
  /**
   * The node's check endpoint (POST /transactions/check): 'timeout' stands for a request
   * aborted by its timeout.
   */
  check: (body: string) => { status?: number; body: unknown } | 'throw' | 'refused' | 'timeout';
  /** Bodies posted to the check endpoint. */
  checked: string[];
  calls: Array<{ method: string; path: string }>;
  /**
   * Total emission by token id, for `/blockchain/token/byId`. A pool NFT not listed here
   * answers 1 when some pool box in this state holds it; any other token is unknown.
   */
  emission: Map<string, bigint>;
  /** The node's state type in /info; unset: utxo. */
  stateType?: string;
  /** On-chain token names by token id, for `/blockchain/token/byId`; unset: an empty name. */
  tokenNames?: Map<string, string>;
}

export function newNodeState(): NodeState {
  return {
    pools: new Map(),
    mempool: new Map(),
    mempoolSpent: new Set(),
    byTree: new Map(),
    wallet: [],
    boxes: new Map(),
    submit: (body) => ({ body: JSON.stringify(JSON.parse(body).id) }),
    posted: [],
    check: (body) => ({ body: JSON.stringify(JSON.parse(body).id) }),
    checked: [],
    calls: [],
    emission: new Map(),
  };
}

/** Whether a pool box anywhere in the state holds this token as its NFT (slot 0). */
function isPoolNft(state: NodeState, id: string): boolean {
  const boxes = [...state.pools.values(), ...state.mempool.values(), ...state.byTree.values()].flat();
  return boxes.some((b) => b.assets[0]?.tokenId === id);
}

const notFound = { status: 404, body: { error: 404, reason: 'not-found', detail: null } };

/** A node stand-in for the reads and the one write the connector makes. */
export function stateNode(state: NodeState): FetchLike {
  return async (input, init) => {
    const url = new URL(input);
    const method = String(init?.method ?? 'GET');
    const body = init?.body as string | undefined;
    const p = url.pathname;
    state.calls.push({ method, path: p + url.search });
    const send = (res: { status?: number; body: unknown }) => {
      const status = res.status ?? 200;
      const text =
        typeof res.body === 'string'
          ? res.body
          : JSON.stringify(res.body, (_k, v) => (typeof v === 'bigint' ? `__big__${v}` : v)).replace(
              /"__big__(-?\d+)"/g,
              '$1',
            );
      return { ok: status >= 200 && status < 300, status, text: async () => text };
    };
    const json = (boxes: ErgoBox[]) => send({ body: boxes.map((b) => nodeBoxJson(b)) });
    let m: RegExpMatchArray | null;
    if (method === 'GET' && p === '/info') {
      return send({
        body: {
          fullHeight: TIP,
          headersHeight: TIP,
          network: 'mainnet',
          stateType: state.stateType ?? 'utxo',
          parameters: { minValuePerByte: 360 },
        },
      });
    }
    if (method === 'GET' && p === '/blocks/lastHeaders/10') return send({ body: HEADERS });
    if (method === 'GET' && (m = p.match(/^\/blockchain\/box\/unspent\/byTokenId\/([0-9a-f]{64})$/))) {
      return json(state.pools.get(m[1]) ?? []);
    }
    if (method === 'GET' && (m = p.match(/^\/transactions\/unconfirmed\/outputs\/byTokenId\/([0-9a-f]{64})$/))) {
      return json(state.mempool.get(m[1]) ?? []);
    }
    if (method === 'GET' && (m = p.match(/^\/transactions\/unconfirmed\/inputs\/byBoxId\/([0-9a-f]{64})$/))) {
      return state.mempoolSpent.has(m[1]) ? send({ body: { boxId: m[1] } }) : send(notFound);
    }
    if (method === 'GET' && (m = p.match(/^\/blockchain\/box\/byId\/([0-9a-f]{64})$/))) {
      const box = state.boxes.get(m[1]);
      return box ? send({ body: box }) : send(notFound);
    }
    if (method === 'POST' && p === '/blockchain/box/unspent/byErgoTree') {
      const tree = JSON.parse(body!);
      const offset = Number(url.searchParams.get('offset'));
      const limit = Number(url.searchParams.get('limit'));
      return json((state.byTree.get(tree) ?? []).slice(offset, offset + limit));
    }
    if (method === 'POST' && p === '/blockchain/box/unspent/byAddress') {
      const offset = Number(url.searchParams.get('offset'));
      return json(offset === 0 ? state.wallet : []);
    }
    if (method === 'POST' && p === '/transactions') {
      state.posted.push(body!);
      const res = state.submit(body!);
      if (res === 'throw') throw new Error('socket hang up');
      if (res === 'refused') {
        const refused = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:9053'), { code: 'ECONNREFUSED' });
        throw new TypeError('fetch failed', { cause: refused });
      }
      return send(res);
    }
    if (method === 'POST' && p === '/transactions/check') {
      state.checked.push(body!);
      const res = state.check(body!);
      if (res === 'throw') throw new Error('socket hang up');
      if (res === 'timeout') {
        throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError', code: 23 });
      }
      if (res === 'refused') {
        const refused = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:9053'), { code: 'ECONNREFUSED' });
        throw new TypeError('fetch failed', { cause: refused });
      }
      return send(res);
    }
    if (method === 'GET' && (m = p.match(/^\/blockchain\/token\/byId\/([0-9a-f]{64})$/))) {
      const emission = state.emission.get(m[1]) ?? (isPoolNft(state, m[1]) ? 1n : undefined);
      if (emission === undefined) return send(notFound);
      return send({
        body: {
          id: m[1],
          boxId: m[1],
          emissionAmount: emission,
          name: state.tokenNames?.get(m[1]) ?? '',
          description: '',
          decimals: 0,
        },
      });
    }
    throw new Error(`unrouted node request ${method} ${p}${url.search}`);
  };
}

/** A connector on a stand-in node, with the token list fixed (no conf/ read). */
export function makeDex(
  state: NodeState,
  config: ErgodexNetworkConfig = dexConfig(),
  root: ErgodexRootConfig = ROOT,
  tokens: ErgoTokenInfo[] = TOKENS,
  chainConfig: ErgoNetworkConfig = testConfig(),
): Ergodex {
  const ergo = new Ergo('mainnet', { config: chainConfig, fetch: stateNode(state) });
  jest.spyOn(ergo, 'getTokenList').mockResolvedValue(tokens);
  // a fresh signer per load, as the chain layer gives one per request and wipes it after
  jest.spyOn(ergo, 'getWallet').mockImplementation(async () => ({
    address: ME,
    ergoTree: ME_TREE,
    signer: WasmErgoSigner.fromMnemonic(MNEMONIC_A),
  }));
  return new Ergodex('mainnet', ergo, config, root);
}

/** A wallet box of the test key with ERG and optional tokens. */
export function walletBox(value: bigint, assets: Array<{ tokenId: string; amount: bigint }> = []): ErgoBox {
  return makeBox({ ergoTree: ME_TREE, value, assets, creationHeight: TIP - 50 });
}
