/**
 * The /pools helpers (add a pool, look one up) for an ergodex pool: pool facts come from
 * the ergodex connector, and token symbols from the Ergo network's own token list, never
 * from another chain.
 */
import { Ergo } from '../../../src/chains/ergo/ergo';
import { FetchLike } from '../../../src/chains/ergo/ergo.node-client';
import { Ethereum } from '../../../src/chains/ethereum/ethereum';
import { getPositionsOwned } from '../../../src/connectors/ergodex/amm-routes/positions';
import { Ergodex, NATIVE_TOKEN_ID } from '../../../src/connectors/ergodex/ergodex';
import { fetchPoolInfo, resolveTokenSymbols } from '../../../src/pools/pool-info-helpers';
import { testConfig } from '../../chains/ergo/ergo-test-helpers';

import {
  dexConfig,
  makeBox,
  makeDex,
  ME,
  newNodeState,
  ROOT,
  RSN,
  RSN_POOL,
  stateNode,
  TOKENS,
  walletBox,
} from './ergodex-test-helpers';

const NFT = RSN_POOL.assets[0].tokenId;

describe('/pools helpers for an ergodex pool', () => {
  let ethereum: jest.SpyInstance;

  beforeEach(() => {
    const state = newNodeState();
    state.pools.set(NFT, [RSN_POOL]);
    const dex = makeDex(state);
    jest.spyOn(Ergodex, 'getInstance').mockResolvedValue(dex);
    jest.spyOn(Ergo, 'getInstance').mockResolvedValue(dex.ergo);
    ethereum = jest.spyOn(Ethereum, 'getInstance').mockImplementation(() => {
      throw new Error('the Ethereum chain must not be asked about an Ergo pool');
    });
  });

  afterEach(() => jest.restoreAllMocks());

  it('reads the pool from the connector: tokens by id, fee from the pool', async () => {
    await expect(fetchPoolInfo('ergodex', 'amm', 'mainnet', NFT)).resolves.toEqual({
      baseTokenAddress: NATIVE_TOKEN_ID,
      quoteTokenAddress: RSN,
      feePct: 1,
    });
  });

  it('a pool NFT with no pool is "not found" (null), not an error', async () => {
    await expect(fetchPoolInfo('ergodex', 'amm', 'mainnet', 'ab'.repeat(32))).resolves.toBeNull();
  });

  it('symbols come from the Ergo token list; the native coin by its all-zero id', async () => {
    await expect(resolveTokenSymbols('ergodex', 'mainnet', NATIVE_TOKEN_ID, RSN)).resolves.toEqual({
      baseSymbol: 'ERG',
      quoteSymbol: 'RSN',
    });
    expect(ethereum).not.toHaveBeenCalled();
  });

  it('resolves a 2-tx chained mempool pool successor even when /unconfirmed/inputs/byBoxId returns 404', async () => {
    const state = newNodeState();
    const tx1 = '11'.repeat(32);
    const tx2 = '22'.repeat(32);
    const p1 = makeBox({
      ...RSN_POOL,
      value: RSN_POOL.value + 1_000_000_000n,
      registers: RSN_POOL.additionalRegisters,
      transactionId: tx1,
      inclusionHeight: null,
    });
    const p2 = makeBox({
      ...RSN_POOL,
      value: RSN_POOL.value + 2_000_000_000n,
      registers: RSN_POOL.additionalRegisters,
      transactionId: tx2,
      inclusionHeight: null,
    });
    state.pools.set(NFT, [RSN_POOL]);
    state.mempool.set(NFT, [p1, p2]);
    // Mirror Ergo Reference Node: /unconfirmed/inputs/byBoxId does not list unconfirmed box p1,
    // so mempoolSpent stays empty; only the unconfirmed transactions show tx2 spending p1.
    const unconfirmedTxs = new Map<string, Record<string, unknown>>([
      [tx1, { id: tx1, inputs: [{ boxId: RSN_POOL.boxId }], dataInputs: [], outputs: [] }],
      [tx2, { id: tx2, inputs: [{ boxId: p1.boxId }], dataInputs: [], outputs: [] }],
    ]);
    const baseFetch = stateNode(state);
    const customFetch: FetchLike = async (input, init) => {
      const m = new URL(input).pathname.match(/^\/transactions\/unconfirmed\/byTransactionId\/([0-9a-f]{64})$/);
      if (m && unconfirmedTxs.has(m[1])) {
        const text = JSON.stringify(unconfirmedTxs.get(m[1]));
        return { ok: true, status: 200, text: async () => text };
      }
      return baseFetch(input, init);
    };
    const ergo = new Ergo('mainnet', { config: testConfig(), fetch: customFetch });
    jest.spyOn(ergo, 'getTokenList').mockResolvedValue(TOKENS);
    const dex = new Ergodex('mainnet', ergo, dexConfig(), ROOT);
    const fresh = await dex.getFreshPool(NFT);
    expect(fresh.source).toBe('mempool');
    expect(fresh.pool.box.boxId).toBe(p2.boxId);
  });

  it('positions-owned skips a pool whose LP token declares out-of-range on-chain decimals instead of throwing 500', async () => {
    const state = newNodeState();
    const evilNft = 'e1'.repeat(32);
    const evilLp = 'e2'.repeat(32);
    const evilPool = makeBox({
      ergoTree: RSN_POOL.ergoTree,
      value: 10_000_000n,
      assets: [
        { tokenId: evilNft, amount: 1n },
        { tokenId: evilLp, amount: 6n },
        { tokenId: RSN, amount: 10n },
      ],
      registers: RSN_POOL.additionalRegisters,
    });
    state.pools.set(evilNft, [evilPool]);
    state.byTree.set(RSN_POOL.ergoTree, [evilPool]);
    state.emission.set(evilNft, 1n);
    state.emission.set(evilLp, 10n);
    state.wallet = [walletBox(5_000_000_000n, [{ tokenId: evilLp, amount: 1n }])];
    const baseFetch = stateNode(state);
    const customFetch: FetchLike = async (input, init) => {
      if (new URL(input).pathname === `/blockchain/token/byId/${evilLp}`) {
        const text = JSON.stringify({
          id: evilLp,
          boxId: evilLp,
          emissionAmount: 10,
          name: 'EVIL_LP',
          description: '',
          decimals: 2147483647,
        });
        return { ok: true, status: 200, text: async () => text };
      }
      return baseFetch(input, init);
    };
    const ergo = new Ergo('mainnet', { config: testConfig(), fetch: customFetch });
    jest.spyOn(ergo, 'getTokenList').mockResolvedValue(TOKENS);
    const dex = new Ergodex('mainnet', ergo, dexConfig(), ROOT);
    jest.spyOn(Ergodex, 'getInstance').mockResolvedValue(dex);

    const positions = await getPositionsOwned('mainnet', ME);
    expect(positions).toEqual([]);
  });
});
