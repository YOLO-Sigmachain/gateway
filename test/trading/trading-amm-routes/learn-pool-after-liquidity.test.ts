/**
 * After a submitted add or remove, the shared AMM routes record the pool in Gateway's
 * pool list, except for ergodex, which never reads that list (its swaps do not record a
 * pool either). The connectors are stubbed: only the route's dispatch and recording are
 * under test.
 */
const mockLearnPool = jest.fn().mockResolvedValue(undefined);
jest.mock('../../../src/trading/learn-pool', () => ({ learnPool: (...args: any[]) => mockLearnPool(...args) }));

const submitted = { signature: 'sig', status: 0 };
const mockErgodexAdd = jest.fn().mockResolvedValue(submitted);
const mockErgodexRemove = jest.fn().mockResolvedValue(submitted);
jest.mock('../../../src/connectors/ergodex/amm-routes/liquidity', () => ({
  addLiquidity: (...args: any[]) => mockErgodexAdd(...args),
  removeLiquidity: (...args: any[]) => mockErgodexRemove(...args),
}));
const mockRaydiumAdd = jest.fn().mockResolvedValue(submitted);
jest.mock('../../../src/connectors/raydium/amm-routes/addLiquidity', () => ({
  addLiquidity: (...args: any[]) => mockRaydiumAdd(...args),
}));
const mockRaydiumRemove = jest.fn().mockResolvedValue(submitted);
jest.mock('../../../src/connectors/raydium/amm-routes/removeLiquidity', () => ({
  removeLiquidity: (...args: any[]) => mockRaydiumRemove(...args),
}));

import { addLiquidityRoute } from '../../../src/trading/trading-amm-routes/add';
import { removeLiquidityRoute } from '../../../src/trading/trading-amm-routes/remove';
import { fastifyWithTypeProvider } from '../../utils/testUtils';

const ERGO_POOL = 'aa'.repeat(32);
const ERGO_WALLET = 'an-ergo-wallet';
const SOLANA_POOL = '58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2';
const SOLANA_WALLET = '82SggYRE2Vo4jN4a2pk3aQ4SET4ctafZJGbowmCqyHx5';

describe('the shared add and remove routes record the pool, except for ergodex', () => {
  let app: ReturnType<typeof fastifyWithTypeProvider>;

  beforeAll(async () => {
    app = fastifyWithTypeProvider();
    await app.register(require('@fastify/sensible'));
    await app.register(addLiquidityRoute);
    await app.register(removeLiquidityRoute);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => mockLearnPool.mockClear());

  const add = (connector: string, chainNetwork: string, walletAddress: string, poolAddress: string) =>
    app.inject({
      method: 'POST',
      url: '/add',
      payload: { connector, chainNetwork, walletAddress, poolAddress, baseTokenAmount: 1, quoteTokenAmount: 1 },
    });
  const remove = (connector: string, chainNetwork: string, walletAddress: string, poolAddress: string) =>
    app.inject({
      method: 'POST',
      url: '/remove',
      payload: { connector, chainNetwork, walletAddress, poolAddress, percentageToRemove: 50 },
    });

  it('an ergodex add or remove does not write the pool list', async () => {
    expect((await add('ergodex', 'ergo-mainnet', ERGO_WALLET, ERGO_POOL)).statusCode).toBe(200);
    expect((await remove('ergodex', 'ergo-mainnet', ERGO_WALLET, ERGO_POOL)).statusCode).toBe(200);
    expect(mockErgodexAdd).toHaveBeenCalled();
    expect(mockErgodexRemove).toHaveBeenCalled();
    expect(mockLearnPool).not.toHaveBeenCalled();
  });

  it('another connector still records the pool after an add and after a remove', async () => {
    expect((await add('raydium', 'solana-mainnet-beta', SOLANA_WALLET, SOLANA_POOL)).statusCode).toBe(200);
    expect((await remove('raydium', 'solana-mainnet-beta', SOLANA_WALLET, SOLANA_POOL)).statusCode).toBe(200);
    expect(mockLearnPool).toHaveBeenCalledTimes(2);
    for (const call of mockLearnPool.mock.calls) {
      expect(call.slice(1)).toEqual(['amm', 'solana', 'mainnet-beta', 'raydium', 'solana-mainnet-beta', SOLANA_POOL]);
    }
  });
});
