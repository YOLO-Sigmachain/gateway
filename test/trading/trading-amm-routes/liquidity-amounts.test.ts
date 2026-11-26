/**
 * The shared AMM add and remove routes: a PENDING answer's `pendingData` reaches the
 * caller as exact decimal strings, and `data` stays absent; a remove names exactly one of
 * `percentageToRemove` and `lpTokenAmount`; a connector other than ergodex refuses
 * `lpTokenAmount` and otherwise gets `percentageToRemove` as before. The connectors are
 * stubbed: only the routes are under test.
 */
jest.mock('../../../src/trading/learn-pool', () => ({ learnPool: jest.fn().mockResolvedValue(undefined) }));

const mockErgodexAdd = jest.fn();
const mockErgodexRemove = jest.fn();
jest.mock('../../../src/connectors/ergodex/amm-routes/liquidity', () => ({
  addLiquidity: (...args: any[]) => mockErgodexAdd(...args),
  removeLiquidity: (...args: any[]) => mockErgodexRemove(...args),
}));
const mockRaydiumRemove = jest.fn();
jest.mock('../../../src/connectors/raydium/amm-routes/removeLiquidity', () => ({
  removeLiquidity: (...args: any[]) => mockRaydiumRemove(...args),
}));
const mockUniswapRemove = jest.fn();
jest.mock('../../../src/connectors/uniswap/amm-routes/removeLiquidity', () => ({
  removeLiquidity: (...args: any[]) => mockUniswapRemove(...args),
}));

import { addLiquidityRoute } from '../../../src/trading/trading-amm-routes/add';
import { removeLiquidityRoute } from '../../../src/trading/trading-amm-routes/remove';
import { fastifyWithTypeProvider } from '../../utils/testUtils';

const ERGO_POOL = 'aa'.repeat(32);
const ERGO_WALLET = 'an-ergo-wallet';
const SOLANA_POOL = '58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2';
const SOLANA_WALLET = '82SggYRE2Vo4jN4a2pk3aQ4SET4ctafZJGbowmCqyHx5';

/** Amounts with more significant digits than a JSON number keeps. */
const BIG = '12345678901234567.123456789';
const LP_BIG = '9223372036854775806';

describe('the shared AMM add and remove routes', () => {
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

  beforeEach(() => jest.clearAllMocks());

  const ergoRemove = (over: Record<string, unknown>) =>
    app.inject({
      method: 'POST',
      url: '/remove',
      payload: {
        connector: 'ergodex',
        chainNetwork: 'ergo-mainnet',
        walletAddress: ERGO_WALLET,
        poolAddress: ERGO_POOL,
        ...over,
      },
    });
  const otherRemove = (connector: string, over: Record<string, unknown>) =>
    app.inject({
      method: 'POST',
      url: '/remove',
      payload: {
        connector,
        chainNetwork: 'solana-mainnet-beta',
        walletAddress: SOLANA_WALLET,
        poolAddress: SOLANA_POOL,
        ...over,
      },
    });

  describe('pendingData on a PENDING answer', () => {
    it('add: every field reaches the caller as the exact decimal string, and there is no data', async () => {
      const pendingData = {
        fee: '0.0011',
        poolAddress: ERGO_POOL,
        baseTokenAmountAdded: BIG,
        quoteTokenAmountAdded: '0.00000001',
        lpTokenAmountAdded: LP_BIG,
      };
      mockErgodexAdd.mockResolvedValue({ signature: 'sig', status: 0, pendingData });
      const res = await app.inject({
        method: 'POST',
        url: '/add',
        payload: {
          connector: 'ergodex',
          chainNetwork: 'ergo-mainnet',
          walletAddress: ERGO_WALLET,
          poolAddress: ERGO_POOL,
          baseTokenAmount: 1,
          quoteTokenAmount: 1,
        },
      });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain(`"baseTokenAmountAdded":"${BIG}"`);
      expect(res.body).toContain(`"lpTokenAmountAdded":"${LP_BIG}"`);
      expect(JSON.parse(res.body)).toEqual({ signature: 'sig', status: 0, pendingData });
    });

    it('remove: every field reaches the caller as the exact decimal string, and there is no data', async () => {
      const pendingData = {
        fee: '0.0011',
        poolAddress: ERGO_POOL,
        baseTokenAmountRemoved: BIG,
        quoteTokenAmountRemoved: '0.00000001',
        lpTokenAmountRemoved: LP_BIG,
      };
      mockErgodexRemove.mockResolvedValue({ signature: 'sig', status: 0, pendingData });
      const res = await ergoRemove({ lpTokenAmount: 5 });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain(`"baseTokenAmountRemoved":"${BIG}"`);
      expect(res.body).toContain(`"lpTokenAmountRemoved":"${LP_BIG}"`);
      expect(JSON.parse(res.body)).toEqual({ signature: 'sig', status: 0, pendingData });
    });
  });

  describe('remove: how much', () => {
    it('ergodex gets lpTokenAmount, or percentageToRemove, as sent', async () => {
      mockErgodexRemove.mockResolvedValue({ signature: 'sig', status: 0 });
      expect((await ergoRemove({ lpTokenAmount: 1234567 })).statusCode).toBe(200);
      expect((await ergoRemove({ percentageToRemove: 50 })).statusCode).toBe(200);
      expect(mockErgodexRemove.mock.calls.map((c) => c[3])).toEqual([
        { percentageToRemove: undefined, lpTokenAmount: 1234567 },
        { percentageToRemove: 50, lpTokenAmount: undefined },
      ]);
    });

    it('both percentageToRemove and lpTokenAmount is a 400, the connector not called', async () => {
      const both = { percentageToRemove: 50, lpTokenAmount: 1 };
      for (const res of [await ergoRemove(both), await otherRemove('raydium', both)]) {
        expect(res.statusCode).toBe(400);
        expect(JSON.parse(res.body).message).toBe('Send exactly one of percentageToRemove and lpTokenAmount');
      }
      expect(mockErgodexRemove).not.toHaveBeenCalled();
      expect(mockRaydiumRemove).not.toHaveBeenCalled();
    });

    it('neither field: a 400 for ergodex, which must be told what to remove', async () => {
      const res = await ergoRemove({});
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).message).toBe('Send exactly one of percentageToRemove and lpTokenAmount');
      expect(mockErgodexRemove).not.toHaveBeenCalled();
    });

    it('neither field: another connector removes 100%, as before', async () => {
      mockRaydiumRemove.mockResolvedValue({ signature: 'sig', status: 1 });
      const res = await otherRemove('raydium', { slippagePct: 1 });
      expect(res.statusCode).toBe(200);
      expect(mockRaydiumRemove).toHaveBeenCalledWith('mainnet-beta', SOLANA_WALLET, SOLANA_POOL, 100, 1);
    });

    const EVM = {
      chainNetwork: 'ethereum-mainnet',
      walletAddress: '0x' + '11'.repeat(20),
      poolAddress: '0x' + '22'.repeat(20),
    };

    it.each([
      ['raydium', mockRaydiumRemove, {}],
      ['uniswap', mockUniswapRemove, EVM],
    ])('%s refuses lpTokenAmount with a 400 and is not called', async (connector, mock, where) => {
      const res = await otherRemove(connector, { lpTokenAmount: 5, ...where });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).message).toBe(
        `lpTokenAmount is not supported by ${connector}; send percentageToRemove`,
      );
      expect(mock).not.toHaveBeenCalled();
    });

    it('another connector still gets percentageToRemove, as before', async () => {
      mockRaydiumRemove.mockResolvedValue({ signature: 'sig', status: 1 });
      const res = await otherRemove('raydium', { percentageToRemove: 50, slippagePct: 1 });
      expect(res.statusCode).toBe(200);
      expect(mockRaydiumRemove).toHaveBeenCalledWith('mainnet-beta', SOLANA_WALLET, SOLANA_POOL, 50, 1);
    });
  });
});
