/**
 * Venue matching, pool parsing, successor rules, guards, pool choice, quote fields and
 * token identity for connector `ergodex`, against a node stand-in.
 */
import { getPoolInfo } from '../../../src/connectors/ergodex/amm-routes/poolInfo';
import { quoteSwap } from '../../../src/connectors/ergodex/amm-routes/quoteSwap';
import { Ergodex, NATIVE_TOKEN_ID } from '../../../src/connectors/ergodex/ergodex';
import { ErgodexConfig } from '../../../src/connectors/ergodex/ergodex.config';
import { ConfigManagerV2 } from '../../../src/services/config-manager-v2';

import {
  dexConfig,
  ERG,
  makeBox,
  makeDex,
  N2T_TREE,
  n2tPool,
  newNodeState,
  NodeState,
  R4,
  RSN,
  RSN_POOL,
  T2T_POOL,
  T2T_TREE,
  t2tPool,
  tokenId,
  TOKENS,
  TIP,
  WT_ADA,
  WT_ERG,
} from './ergodex-test-helpers';

const TKN = tokenId(0xc1);
const TOKEN_LIST = [...TOKENS, { address: TKN, symbol: 'TKN', name: 'TKN', decimals: 3 }];

const statusOf = <T>(p: Promise<T>) =>
  p.then(
    () => null,
    (e) => e as Error & { statusCode?: number },
  );

function withPool(state: NodeState, box: ReturnType<typeof n2tPool>) {
  state.pools.set(box.assets[0].tokenId, [box]);
  return box;
}

afterEach(() => jest.restoreAllMocks());

describe('venue matching by exact tree', () => {
  it('finds the venue for the live trees and for nothing else', () => {
    const dex = makeDex(newNodeState());
    expect(dex.venueForTree(N2T_TREE)?.name).toBe('spectrum');
    expect(dex.venueForTree(T2T_TREE)?.name).toBe('spectrum');
    // one byte different (a constant changed) is not the pool contract
    const altered = N2T_TREE.slice(0, -2) + (N2T_TREE.endsWith('00') ? '01' : '00');
    expect(dex.venueForTree(altered)).toBeUndefined();
  });

  it('refuses a box with the right tokens at a tree no venue owns', async () => {
    const state = newNodeState();
    const impostor = n2tPool({
      x: 1000n * ERG,
      y: 5000000n,
      fee: 997,
      token: TKN,
      tree: '0008cd' + '02'.padEnd(66, '1'),
    });
    state.pools.set(impostor.assets[0].tokenId, [impostor]);
    const dex = makeDex(state);
    const err = await statusOf(dex.getFreshPool(impostor.assets[0].tokenId));
    expect(err?.statusCode).toBe(400);
    expect(err?.message).toContain('tree no configured ergodex venue owns');
  });

  it('skips boxes at a pool tree that are not pools', async () => {
    const state = newNodeState();
    const good = n2tPool({ x: 1000n * ERG, y: 5000000n, fee: 997, token: TKN });
    const nftLpOnly = makeBox({
      ergoTree: N2T_TREE,
      value: 3300000000n,
      assets: [
        { tokenId: tokenId(0xd1), amount: 1n },
        { tokenId: tokenId(0xd2), amount: 9223372036280318543n },
      ],
      registers: { R4: '04940f' },
    });
    const noTokens = makeBox({ ergoTree: N2T_TREE, value: 2000000n });
    const oneToken = makeBox({ ergoTree: N2T_TREE, value: 1000000n, assets: [{ tokenId: RSN, amount: 968120n }] });
    const noR4 = makeBox({
      ergoTree: N2T_TREE,
      value: 50n * ERG,
      assets: [
        { tokenId: tokenId(0xd3), amount: 1n },
        { tokenId: tokenId(0xd4), amount: 5n },
        { tokenId: tokenId(0xd5), amount: 5n },
      ],
    });
    const longR4 = makeBox({
      ergoTree: T2T_TREE,
      value: 4000000n,
      assets: [
        { tokenId: tokenId(0xd6), amount: 1n },
        { tokenId: tokenId(0xd7), amount: 5n },
        { tokenId: tokenId(0xd8), amount: 5n },
        { tokenId: tokenId(0xd9), amount: 5n },
      ],
      registers: { R4: '05bc0f' }, // a Long: the live tree reads Int
    });
    state.byTree.set(N2T_TREE, [good, nftLpOnly, noTokens, oneToken, noR4]);
    state.byTree.set(T2T_TREE, [longR4, T2T_POOL]);
    const dex = makeDex(state);
    const found = await dex.discoverPools();
    expect(found.map((f) => f.pool.poolId).sort()).toEqual([good.assets[0].tokenId, T2T_POOL.assets[0].tokenId].sort());
  });

  it('reads pages of 100 or fewer from the node', async () => {
    const state = newNodeState();
    const many = Array.from({ length: 150 }, (_, i) =>
      n2tPool({ x: 1000n * ERG, y: 5000000n, fee: 997, nft: (i + 1).toString(16).padStart(64, '7') }),
    );
    state.byTree.set(N2T_TREE, many);
    const dex = makeDex(state);
    expect((await dex.discoverPools()).length).toBe(150);
    const pages = state.calls.filter((c) => c.path.startsWith('/blockchain/box/unspent/byErgoTree'));
    expect(pages.every((c) => /limit=(\d+)/.exec(c.path)![1] === '100')).toBe(true);
  });
});

describe('the successor box', () => {
  const dex = makeDex(newNodeState());
  const venue = dex.venueForTree(N2T_TREE)!;

  it('ERG/token: same tree, tokens, R4 bytes and LP amount; value moves by the input', () => {
    const pool = venue.parsePool(RSN_POOL)!;
    const out = venue.amountOut(pool, 'x', ERG);
    const s = venue.successor(pool, { input: 'x', amountIn: ERG, amountOut: out });
    expect(s.ergoTree).toBe(RSN_POOL.ergoTree);
    expect(s.additionalRegisters).toEqual(RSN_POOL.additionalRegisters);
    expect(s.additionalRegisters!.R4).toBe('04bc0f');
    expect(s.assets!.map((a) => a.tokenId)).toEqual(RSN_POOL.assets.map((a) => a.tokenId));
    expect(s.assets![0].amount).toBe(1n);
    expect(s.assets![1].amount).toBe(RSN_POOL.assets[1].amount);
    expect(s.assets![1].amount > 2n ** 62n).toBe(true);
    expect(s.value).toBe(RSN_POOL.value + ERG);
    expect(s.assets![2].amount).toBe(RSN_POOL.assets[2].amount - out);
  });

  it('ERG/token: a successor at or below the storage floor is refused', () => {
    const box = n2tPool({ x: 10_000_100n, y: 5_000_000n, fee: 997, token: TKN });
    const pool = venue.parsePool(box)!;
    // take 100 nanoERG out, leaving exactly the floor: the contract wants strictly more
    const need = venue.amountInFor(pool, 'y', 100n)!;
    expect(() => venue.successor(pool, { input: 'y', amountIn: need, amountOut: 100n })).toThrow(/storage floor/);
    const need99 = venue.amountInFor(pool, 'y', 99n)!;
    expect(venue.successor(pool, { input: 'y', amountIn: need99, amountOut: 99n }).value).toBe(10_000_001n);
  });

  it('token/token: value unchanged, four tokens in order, R4 copied', () => {
    const pool = venue.parsePool(T2T_POOL)!;
    expect(pool.kind).toBe('t2t');
    expect(pool.x.tokenId).toBe(WT_ERG);
    expect(pool.y.tokenId).toBe(WT_ADA);
    const out = venue.amountOut(pool, 'y', 10n ** 8n);
    const s = venue.successor(pool, { input: 'y', amountIn: 10n ** 8n, amountOut: out });
    expect(s.value).toBe(T2T_POOL.value);
    expect(s.assets!.map((a) => a.tokenId)).toEqual(T2T_POOL.assets.map((a) => a.tokenId));
    expect(s.assets![1].amount).toBe(T2T_POOL.assets[1].amount);
    expect(s.assets![2].amount).toBe(T2T_POOL.assets[2].amount - out);
    expect(s.assets![3].amount).toBe(T2T_POOL.assets[3].amount + 10n ** 8n);
    expect(s.additionalRegisters).toEqual({ R4: '04c80f' });
  });

  it('the contract rule refuses an LP change, a fee change and a lower token/token value', () => {
    const pool = venue.parsePool(T2T_POOL)!;
    const out = venue.amountOut(pool, 'y', 10n ** 8n);
    const s = venue.successor(pool, { input: 'y', amountIn: 10n ** 8n, amountOut: out });
    const eip = (over: Partial<{ value: bigint; lp: bigint; r4: string }>) => ({
      value: String(over.value ?? s.value),
      ergoTree: s.ergoTree,
      creationHeight: TIP,
      assets: s.assets!.map((a, i) => ({
        tokenId: a.tokenId,
        amount: String(i === 1 && over.lp ? over.lp : a.amount),
      })),
      additionalRegisters: { R4: over.r4 ?? s.additionalRegisters!.R4! },
    });
    expect(venue.contractAccepts(pool, eip({}))).toBe(true);
    expect(venue.contractAccepts(pool, eip({ lp: T2T_POOL.assets[1].amount - 1n }))).toBe(false);
    expect(venue.contractAccepts(pool, eip({ r4: R4(997) }))).toBe(false);
    expect(venue.contractAccepts(pool, eip({ value: T2T_POOL.value - 1n }))).toBe(false);
  });
});

describe('guards from config', () => {
  it('refuses a named pool above the fee ceiling (a 99.9% pool)', async () => {
    const state = newNodeState();
    const box = withPool(state, n2tPool({ x: 1000n * ERG, y: 5000000n, fee: 1, token: TKN }));
    const dex = makeDex(state, dexConfig({ maxPoolFeePct: '3' }), undefined, TOKEN_LIST);
    const err = await statusOf(dex.freshPlan(box.assets[0].tokenId, await dex.resolveToken('ERG'), 'SELL', ERG));
    expect(err?.statusCode).toBe(400);
    expect(err?.message).toContain('99.9%');
  });

  it('refuses a pool below the minimum size', async () => {
    const state = newNodeState();
    const box = withPool(state, n2tPool({ x: 50n * ERG, y: 5000000n, fee: 997, token: TKN }));
    const dex = makeDex(state, dexConfig({ minPoolNativeReserve: 100n * ERG }), undefined, TOKEN_LIST);
    const err = await statusOf(dex.freshPlan(box.assets[0].tokenId, await dex.resolveToken('ERG'), 'SELL', ERG));
    expect(err?.message).toContain('minPoolNativeReserve');
  });

  it('refuses a pool off the allowlist', async () => {
    const state = newNodeState();
    const box = withPool(state, n2tPool({ x: 1000n * ERG, y: 5000000n, fee: 997, token: TKN }));
    const dex = makeDex(state, dexConfig({ poolAllowlist: ['ab'.repeat(32)] }), undefined, TOKEN_LIST);
    const err = await statusOf(dex.freshPlan(box.assets[0].tokenId, await dex.resolveToken('ERG'), 'SELL', ERG));
    expect(err?.message).toContain('not on the allowlist');
  });
});

describe('choosing a pool for a pair (T-13)', () => {
  const nft = (n: number) => n.toString(16).padStart(64, 'e');
  const pools = [
    n2tPool({ x: 1000n * ERG, y: 5000000n, fee: 990, token: TKN, nft: nft(1) }), // deep, 1%
    n2tPool({ x: 400n * ERG, y: 2000000n, fee: 997, token: TKN, nft: nft(2) }), // shallower, 0.3%
    n2tPool({ x: 20_000_000n, y: 1n, fee: 997, token: TKN, nft: nft(3) }), // dust
    n2tPool({ x: 5000n * ERG, y: 25000000n, fee: 1, token: TKN, nft: nft(4) }), // 99.9% fee
    n2tPool({ x: 1000n * ERG, y: 5000000n, fee: 997, token: RSN, nft: nft(5) }), // another pair
  ];

  function setup(over = {}) {
    const state = newNodeState();
    state.byTree.set(N2T_TREE, pools);
    for (const p of pools) state.pools.set(p.assets[0].tokenId, [p]);
    return makeDex(state, dexConfig(over), undefined, TOKEN_LIST);
  }

  it('SELL: the most out for the size, skipping the dust pool and the 99.9% pool', async () => {
    const dex = setup();
    // 1 ERG: deep 990 gives floor(5e6*1e9*990/(1e15+9.9e11)) = 4945; shallow 997 gives
    // floor(2e6*1e9*997/(4e14+9.97e11)) = 4972; the 99.9% pool would give 4 and is refused
    expect(await dex.bestPool('ERG', 'TKN', 'SELL', 1)).toBe(nft(2));
    // 100 ERG: deep gives 450,409, shallow 399,039: the deep pool wins at size
    expect(await dex.bestPool('ERG', 'TKN', 'SELL', 100)).toBe(nft(1));
  });

  it('BUY: the least in, and a size only one pool can pay picks that pool', async () => {
    const dex = setup();
    expect(await dex.bestPool('TKN', 'ERG', 'BUY', 5)).toBe(nft(2));
    expect(await dex.bestPool('TKN', 'ERG', 'BUY', 2500)).toBe(nft(1)); // more than the shallow pool holds
  });

  it('only allowlisted pools are considered', async () => {
    const dex = setup({ poolAllowlist: [nft(1)] });
    expect(await dex.bestPool('ERG', 'TKN', 'SELL', 1)).toBe(nft(1));
  });

  it('a size no allowed pool can do is a 404, not a throw from a dust pool', async () => {
    const dex = setup();
    const err = await statusOf(dex.bestPool('TKN', 'ERG', 'BUY', 1000000));
    expect(err?.statusCode).toBe(404);
  });
});

describe('quote fields (T-10, T-17) and the box used', () => {
  function setup(useMempoolSuccessor: boolean) {
    const state = newNodeState();
    const box = withPool(state, n2tPool({ x: 1000n * ERG, y: 5000000n, fee: 997, token: TKN }));
    const dex = makeDex(state, dexConfig({ useMempoolSuccessor }), undefined, TOKEN_LIST);
    jest.spyOn(Ergodex, 'getInstance').mockResolvedValue(dex);
    return { state, box, dex };
  }

  it('price is from the expected amounts, the slipped bound is apart, amounts in whole units', async () => {
    const { box } = setup(true);
    const q = await quoteSwap('mainnet', box.assets[0].tokenId, 'ERG', 'SELL', 10, 2);
    expect(q.amountIn).toBe(10);
    expect(q.amountOut).toBe(49.357);
    expect(q.price).toBe(4.9357);
    // 2% below 49,357 raw = floor(48,369.86) = 48,369
    expect(q.minAmountOut).toBe(48.369);
    expect(q.maxAmountIn).toBe(10);
    expect(q.slippagePct).toBe(2);
    expect(q.tokenIn).toBe(NATIVE_TOKEN_ID);
    expect(q.tokenOut).toBe(TKN);
    expect(q.priceImpactPct).toBeCloseTo((49357 / 5000000) * 100, 12);
    expect(q.poolAddress).toBe(box.assets[0].tokenId);
    expect(q.routePath).toBe(`spectrum:n2t pool ${box.assets[0].tokenId} box ${box.boxId} (confirmed)`);
    for (const v of [q.amountIn, q.amountOut, q.price, q.minAmountOut, q.maxAmountIn]) expect(v).toBeGreaterThan(0);
  });

  it('BUY: price is quote per base, maxAmountIn carries the slippage', async () => {
    const { box } = setup(true);
    const q = await quoteSwap('mainnet', box.assets[0].tokenId, 'TKN', 'BUY', 50, 1);
    expect(q.amountOut).toBe(50);
    expect(q.amountIn).toBe(10.131404314);
    expect(q.price).toBe(0.20262808628);
    expect(q.minAmountOut).toBe(50);
    // 1% above 10,131,404,314 = ceil(10,232,718,357.14) = 10,232,718,358
    expect(q.maxAmountIn).toBe(10.232718358);
  });

  it('builds on the mempool successor when configured, and says so; otherwise on the confirmed box', async () => {
    const { state, box, dex } = setup(true);
    const venue = dex.venueForTree(N2T_TREE)!;
    const pool = venue.parsePool(box)!;
    const succSpec = venue.successor(pool, { input: 'x', amountIn: ERG, amountOut: venue.amountOut(pool, 'x', ERG) });
    const successor = makeBox({
      ergoTree: succSpec.ergoTree,
      value: succSpec.value,
      assets: succSpec.assets,
      registers: succSpec.additionalRegisters,
      creationHeight: TIP,
      inclusionHeight: null,
    });
    state.mempool.set(box.assets[0].tokenId, [successor]);
    state.mempoolSpent.add(box.boxId);
    const q = await quoteSwap('mainnet', box.assets[0].tokenId, 'ERG', 'SELL', 10);
    expect(q.routePath).toContain(`box ${successor.boxId} (mempool)`);
    jest.restoreAllMocks();
    const second = setup(false);
    second.state.mempool.set(box.assets[0].tokenId, [successor]);
    const q2 = await quoteSwap('mainnet', second.box.assets[0].tokenId, 'ERG', 'SELL', 10);
    expect(q2.routePath).toContain(`box ${second.box.boxId} (confirmed)`);
  });

  it('a pool is addressed by pool NFT; a box id is not found', async () => {
    const { box } = setup(true);
    const err = await statusOf(quoteSwap('mainnet', box.boxId, 'ERG', 'SELL', 1));
    expect(err?.statusCode).toBe(404);
    expect(err?.message).toContain('never by box id');
  });

  it('pool info reports reserves, fee and marginal price in whole units', async () => {
    const { box } = setup(true);
    const info = await getPoolInfo('mainnet', box.assets[0].tokenId);
    expect(info).toEqual({
      address: box.assets[0].tokenId,
      baseTokenAddress: NATIVE_TOKEN_ID,
      quoteTokenAddress: TKN,
      feePct: 0.3,
      price: 5,
      baseTokenAmount: 1000,
      quoteTokenAmount: 5000,
    });
  });
});

describe('token identity is the token id (T-14)', () => {
  it('a symbol two listed tokens share is refused; each is reachable by id', async () => {
    const state = newNodeState();
    const twin = tokenId(0xf1);
    const list = [
      { address: RSN, symbol: 'RSN', name: 'RSN', decimals: 3 },
      { address: twin, symbol: 'RSN', name: 'fake RSN', decimals: 0 },
    ];
    const dex = makeDex(state, dexConfig(), undefined, list);
    const err = await statusOf(dex.resolveToken('RSN'));
    expect(err?.statusCode).toBe(400);
    expect(err?.message).toContain('ask for it by token id');
    expect((await dex.resolveToken(RSN)).decimals).toBe(3);
    expect((await dex.resolveToken(twin)).decimals).toBe(0);
  });

  it('the native symbol always means the native coin, even if a listed token is named like it', async () => {
    const dex = makeDex(newNodeState(), dexConfig(), undefined, [
      { address: tokenId(0xf2), symbol: 'ERG', name: 'not ERG', decimals: 9 },
    ]);
    expect((await dex.resolveToken('ERG')).tokenId).toBeNull();
    expect((await dex.resolveToken(NATIVE_TOKEN_ID)).tokenId).toBeNull();
  });

  it('a pool for another token with the same symbol does not trade this pair', async () => {
    const state = newNodeState();
    const fake = tokenId(0xf3);
    const box = withPool(state, n2tPool({ x: 1000n * ERG, y: 5000000n, fee: 997, token: fake }));
    const dex = makeDex(state, dexConfig(), undefined, [
      { address: RSN, symbol: 'RSN', name: 'RSN', decimals: 3 },
      { address: fake, symbol: 'RSN2', name: 'RSN', decimals: 3 },
    ]);
    const err = await statusOf(dex.freshPlan(box.assets[0].tokenId, await dex.resolveToken(RSN), 'SELL', 1000n));
    expect(err?.message).toContain('is not in pool');
  });
});

describe('a network with no pool trees', () => {
  it('loads, and every pool call answers that no pools are configured', async () => {
    const state = newNodeState();
    const dex = makeDex(state, dexConfig({}, { n2tPoolTrees: [], t2tPoolTrees: [] }));
    expect(dex.venues).toEqual([]);
    const calls: Array<Promise<unknown>> = [
      dex.discoverPools(),
      dex.fetchPoolBox(RSN_POOL.assets[0].tokenId),
      dex.bestPool('ERG', 'RSN', 'SELL', 1),
    ];
    for (const p of calls) {
      const err = await statusOf(p);
      expect(err?.statusCode).toBe(404);
      expect(err?.message).toContain('No pools are configured for ergodex on mainnet');
    }
    expect(state.calls.length).toBe(0);
  });

  it('a network missing from ergodex.networks reads as no trees, without throwing', () => {
    const values: Record<string, unknown> = {
      'ergodex.networks': {
        mainnet: { spectrum: { n2tPoolTrees: [N2T_TREE], t2tPoolTrees: [], feeDenominator: 1000 } },
      },
    };
    jest.spyOn(ConfigManagerV2, 'getInstance').mockReturnValue({ get: (k: string) => values[k] } as never);
    const later = ErgodexConfig.network('later-net');
    expect(later.spectrum.n2tPoolTrees).toEqual([]);
    expect(later.spectrum.t2tPoolTrees).toEqual([]);
    const main = ErgodexConfig.network('mainnet');
    expect(main.spectrum.n2tPoolTrees).toEqual([N2T_TREE]);
    expect(main.useMempoolSuccessor).toBe(true);
    expect(ErgodexConfig.root()).toEqual({ slippagePct: 1, maxRebuilds: 2 });
  });

  it('refuses trees configured without a fee denominator', () => {
    const values: Record<string, unknown> = {
      'ergodex.networks': { mainnet: { spectrum: { n2tPoolTrees: [N2T_TREE] } } },
    };
    jest.spyOn(ConfigManagerV2, 'getInstance').mockReturnValue({ get: (k: string) => values[k] } as never);
    expect(() => ErgodexConfig.network('mainnet')).toThrow(/feeDenominator/);
  });
});

it('uses t2tPool helper consistently', () => {
  const box = t2tPool({ x: 5n, y: 7n, fee: 990 });
  expect(makeDex(newNodeState()).venueForTree(box.ergoTree)!.parsePool(box)!.feeNum).toBe(990n);
});
