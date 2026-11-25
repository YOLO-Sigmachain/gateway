/**
 * The /pools helpers (add a pool, look one up) for an ergodex pool: pool facts come from
 * the ergodex connector, and token symbols from the Ergo network's own token list, never
 * from another chain.
 */
import { Ergo } from '../../../src/chains/ergo/ergo';
import { Ethereum } from '../../../src/chains/ethereum/ethereum';
import { Ergodex, NATIVE_TOKEN_ID } from '../../../src/connectors/ergodex/ergodex';
import { fetchPoolInfo, resolveTokenSymbols } from '../../../src/pools/pool-info-helpers';

import { makeDex, newNodeState, RSN, RSN_POOL } from './ergodex-test-helpers';

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
});
