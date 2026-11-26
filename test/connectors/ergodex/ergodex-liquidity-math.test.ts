/**
 * Deposit and redeem math for Spectrum-style pools, against numbers worked out by hand,
 * then the same rules checked on many generated pools: the deposit never takes more than
 * offered, the contract rule holds for it and fails one LP unit more or one unit less in;
 * the redeem holds and fails one unit more out of either side. Also the venue's successor
 * and its contract rule for a deposit and a redeem.
 */
import { Eip12BoxCandidate } from '../../../src/chains/ergo/ergo.types';
import { ratioWithin } from '../../../src/connectors/ergodex/ergodex';
import {
  depositAllowed,
  depositFor,
  lpSupply,
  redeemAllowed,
  redeemFor,
} from '../../../src/connectors/ergodex/venues/spectrum/spectrum.math';
import { SpectrumVenue } from '../../../src/connectors/ergodex/venues/spectrum/spectrum.venue';
import { PoolLiquidityChange, VenuePool } from '../../../src/connectors/ergodex/venues/venue';

import { dexConfig, ERG, n2tPool, t2tPool, TIP } from './ergodex-test-helpers';

const LOCKED = 9223372036854775807n;

describe('deposit: hand-computed', () => {
  // [x0, y0, supply, offerX, offerY, x, y, lp]
  const cases: Array<[bigint, bigint, bigint, bigint | null, bigint | null, bigint, bigint, bigint]> = [
    // in ratio: 100*500/1000 = 50 and 300*500/3000 = 50; 50*1000/500 = 100, 50*3000/500 = 300
    [1000n, 3000n, 500n, 100n, 300n, 100n, 300n, 50n],
    // base limits (50 against 166); the wallet keeps 700 of the quote
    [1000n, 3000n, 500n, 100n, 1000n, 100n, 300n, 50n],
    // 50.5 and 50.17 both round down to 50; the extra unit of each stays in the wallet
    [1000n, 3000n, 500n, 101n, 301n, 100n, 300n, 50n],
    // 1*500/1000 = 0.5: no LP token
    [1000n, 3000n, 500n, 1n, 3n, 0n, 0n, 0n],
    // the smallest deposit: 1 LP for ceil(1000/500) = 2 and ceil(3000/500) = 6
    [1000n, 3000n, 500n, 2n, 6n, 2n, 6n, 1n],
    // 5*13/7 = 9.29 and 9*13/11 = 10.6: lp 9; ceil(63/13) = 5, ceil(99/13) = 8 (one under the offer)
    [7n, 11n, 13n, 5n, 9n, 5n, 8n, 9n],
    // supply above the reserves: 3*1000/10 = 300, 5*1000/20 = 250: lp 250; ceil(2.5) = 3, 5
    [10n, 20n, 1000n, 3n, 5n, 3n, 5n, 250n],
    // no limit on the quote side
    [1000n, 3000n, 500n, 100n, null, 100n, 300n, 50n],
    // no limit on the base side: 7*13/11 = 8.27: lp 8; ceil(56/13) = 5, ceil(88/13) = 7
    [7n, 11n, 13n, null, 7n, 5n, 7n, 8n],
  ];

  it.each(cases)('x0 %p y0 %p S %p, offer %p and %p: takes %p and %p for %p LP', (x0, y0, s, ox, oy, x, y, lp) => {
    expect(depositFor(x0, y0, s, ox, oy)).toEqual({ x, y, lp });
    if (lp > 0n) {
      expect(depositAllowed(x0, y0, s, x, y, lp)).toBe(true);
      expect(depositAllowed(x0, y0, s, x, y, lp + 1n)).toBe(false);
      expect(depositAllowed(x0, y0, s, x - 1n, y, lp)).toBe(false);
      expect(depositAllowed(x0, y0, s, x, y - 1n, lp)).toBe(false);
    }
  });

  it('a deposit on one side only is not a deposit', () => {
    expect(depositAllowed(1000n, 3000n, 500n, 100n, 0n, 1n)).toBe(false);
  });

  it('the LP supply is the constant minus what the pool holds', () => {
    // the ERG/RSN fixture: 9223372036854775807 - 9223370866119426648
    expect(lpSupply(LOCKED, 9223370866119426648n)).toBe(1170735349159n);
  });
});

describe('redeem: hand-computed', () => {
  // [x0, y0, supply, lp, x, y]
  const cases: Array<[bigint, bigint, bigint, bigint, bigint, bigint]> = [
    [1000n, 3000n, 500n, 50n, 100n, 300n], // 50*1000/500, 50*3000/500
    [1000n, 3000n, 500n, 1n, 2n, 6n],
    [7n, 11n, 13n, 5n, 2n, 4n], // 35/13 = 2.7, 55/13 = 4.2
    [7n, 11n, 13n, 1n, 0n, 0n], // 7/13 and 11/13 both round to nothing
    [10n, 20n, 1000n, 250n, 2n, 5n], // 2500/1000 = 2.5, 5000/1000
    [1000n, 3000n, 500n, 500n, 1000n, 3000n], // the whole supply takes the whole pool
  ];

  it.each(cases)('x0 %p y0 %p S %p, %p LP back: takes %p and %p', (x0, y0, s, lp, x, y) => {
    expect(redeemFor(x0, y0, s, lp)).toEqual({ x, y, lp });
    expect(redeemAllowed(x0, y0, s, x, y, lp)).toBe(true);
    expect(redeemAllowed(x0, y0, s, x + 1n, y, lp)).toBe(false);
    expect(redeemAllowed(x0, y0, s, x, y + 1n, lp)).toBe(false);
  });

  it('one LP unit less for the same amounts fails on the side whose floor drops', () => {
    // 4 LP: 28/13 = 2 still covers x = 2, but 44/13 = 3 no longer covers y = 4
    expect(redeemAllowed(7n, 11n, 13n, 2n, 4n, 4n)).toBe(false);
  });

  it('more LP than the supply is refused', () => {
    expect(() => redeemFor(1000n, 3000n, 500n, 501n)).toThrow('more than the LP supply');
  });
});

/** A small generator with a fixed seed, so a failure can be replayed. */
function rng(seed: number) {
  let s = seed >>> 0;
  const next = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s;
  };
  return (max: bigint): bigint => {
    let v = 0n;
    for (let i = 0; i < 4; i++) v = (v << 32n) | BigInt(next());
    return (v % max) + 1n;
  };
}

describe('deposit and redeem rules on generated pools', () => {
  const rand = rng(20261126);
  const pools = Array.from({ length: 400 }, () => {
    const x0 = rand(10n ** BigInt(Number(rand(16n)) + 2));
    const y0 = rand(10n ** BigInt(Number(rand(16n)) + 2));
    const s = rand(10n ** BigInt(Number(rand(16n)) + 2));
    return { x0, y0, s, ox: rand(x0 * 2n), oy: rand(y0 * 2n), lp: rand(s) };
  });

  it('the deposit never takes more than offered, holds, and fails one LP more or one unit less', () => {
    for (const { x0, y0, s, ox, oy } of pools) {
      const d = depositFor(x0, y0, s, ox, oy);
      expect(d.x <= ox && d.y <= oy).toBe(true);
      if (d.lp === 0n) {
        expect((ox * s) / x0 === 0n || (oy * s) / y0 === 0n).toBe(true);
        continue;
      }
      expect(depositAllowed(x0, y0, s, d.x, d.y, d.lp)).toBe(true);
      expect(depositAllowed(x0, y0, s, ox, oy, d.lp + 1n)).toBe(false); // the whole offer buys no more
      expect(depositAllowed(x0, y0, s, d.x - 1n, d.y, d.lp)).toBe(false);
      expect(depositAllowed(x0, y0, s, d.x, d.y - 1n, d.lp)).toBe(false);
    }
  });

  it('the redeem holds and fails one unit more of either side', () => {
    for (const { x0, y0, s, lp } of pools) {
      const r = redeemFor(x0, y0, s, lp);
      expect(redeemAllowed(x0, y0, s, r.x, r.y, lp)).toBe(true);
      expect(redeemAllowed(x0, y0, s, r.x + 1n, r.y, lp)).toBe(false);
      expect(redeemAllowed(x0, y0, s, r.x, r.y + 1n, lp)).toBe(false);
    }
  });
});

describe('the Spectrum venue for a deposit and a redeem', () => {
  const venue = new SpectrumVenue(dexConfig().spectrum);
  const candidate = (spec: ReturnType<typeof venue.liquiditySuccessor>): Eip12BoxCandidate => ({
    value: spec.value.toString(),
    ergoTree: spec.ergoTree,
    creationHeight: TIP,
    assets: spec.assets!.map((a) => ({ tokenId: a.tokenId, amount: a.amount.toString() })),
    additionalRegisters: spec.additionalRegisters!,
  });
  const shift = (spec: ReturnType<typeof venue.liquiditySuccessor>, index: number | 'value', by: bigint) => {
    const c = candidate(spec);
    if (index === 'value') c.value = (BigInt(c.value) + by).toString();
    else c.assets![index].amount = (BigInt(c.assets![index].amount) + by).toString();
    return c;
  };

  const n2t = venue.parsePool(n2tPool({ x: 1000n * ERG, y: 5000000n, fee: 997, lp: LOCKED - 2000000n }))!;
  const t2t = venue.parsePool(t2tPool({ x: 10n ** 12n, y: 3n * 10n ** 12n, fee: 997 }))!;

  it('reads the LP token and supply', () => {
    expect(venue.liquidity(n2t)).toEqual({ lpTokenId: n2t.box.assets[1].tokenId, supply: 2000000n });
    expect(venue.liquidity(t2t)!.supply).toBe(LOCKED - 9223370000000000000n);
  });

  it('without the LP constant in config, no liquidity and no LP change accepted', () => {
    const bare = new SpectrumVenue({ ...dexConfig().spectrum, lockedLiquidity: undefined });
    expect(bare.liquidityRefusal()).toContain('spectrum.lockedLiquidity');
    const pool = bare.parsePool(n2t.box)!;
    expect(bare.liquidity(pool)).toBeNull();
    const spec = venue.liquiditySuccessor(n2t, venue.depositFor(n2t, ERG, 10000n));
    expect(venue.contractAccepts(n2t, candidate(spec))).toBe(true);
    expect(bare.contractAccepts(pool, candidate(spec))).toBe(false);
  });

  it.each([
    ['ERG/token', n2t],
    ['token/token', t2t],
  ] as Array<[string, VenuePool]>)('%s deposit: layout, rule, and one unit either way', (_name, pool) => {
    const change = venue.depositFor(pool, pool.x.reserve / 1000n, pool.y.reserve);
    expect(change.lp).toBeGreaterThan(0n);
    const spec = venue.liquiditySuccessor(pool, change);
    expect(spec.ergoTree).toBe(pool.box.ergoTree);
    expect(spec.additionalRegisters).toEqual(pool.box.additionalRegisters);
    expect(spec.assets!.map((a) => a.tokenId)).toEqual(pool.box.assets.map((a) => a.tokenId));
    expect(spec.assets![0].amount).toBe(1n);
    expect(spec.assets![1].amount).toBe(pool.box.assets[1].amount - change.lp);
    const xIndex = pool.kind === 'n2t' ? 'value' : 2;
    const yIndex = pool.kind === 'n2t' ? 2 : 3;
    if (pool.kind === 't2t') expect(spec.value).toBe(pool.box.value);
    expect(venue.contractAccepts(pool, candidate(spec))).toBe(true);
    expect(venue.contractAccepts(pool, shift(spec, 1, -1n))).toBe(false); // one LP more out
    expect(venue.contractAccepts(pool, shift(spec, xIndex, -1n))).toBe(false); // one x less in
    expect(venue.contractAccepts(pool, shift(spec, yIndex, -1n))).toBe(false); // one y less in
  });

  it.each([
    ['ERG/token', n2t],
    ['token/token', t2t],
  ] as Array<[string, VenuePool]>)('%s redeem: layout, rule, and one unit either way', (_name, pool) => {
    const supply = venue.liquidity(pool)!.supply;
    const change = venue.redeemFor(pool, supply / 7n);
    const spec = venue.liquiditySuccessor(pool, change);
    expect(spec.assets![1].amount).toBe(pool.box.assets[1].amount + change.lp);
    const xIndex = pool.kind === 'n2t' ? 'value' : 2;
    const yIndex = pool.kind === 'n2t' ? 2 : 3;
    expect(venue.contractAccepts(pool, candidate(spec))).toBe(true);
    expect(venue.contractAccepts(pool, shift(spec, xIndex, -1n))).toBe(false); // one x more out
    expect(venue.contractAccepts(pool, shift(spec, yIndex, -1n))).toBe(false); // one y more out
    expect(venue.contractAccepts(pool, shift(spec, 1, -1n))).toBe(false); // one LP less in
  });

  it('an ERG/token redeem that would take the pool to its storage floor is refused', () => {
    const small = venue.parsePool(n2tPool({ x: 20000000n, y: 1000n, fee: 997, lp: LOCKED - 1000n }))!;
    const change: PoolLiquidityChange = venue.redeemFor(small, 600n); // 12,000,000 out leaves 8,000,000
    expect(change.x).toBe(12000000n);
    expect(() => venue.liquiditySuccessor(small, change)).toThrow('storage floor');
  });

  it('a redeem of the whole supply empties the pool and is refused', () => {
    const change = venue.redeemFor(t2t, venue.liquidity(t2t)!.supply);
    expect(() => venue.liquiditySuccessor(t2t, change)).toThrow('empty one side');
  });
});

describe('the pool price bound', () => {
  const venue = new SpectrumVenue(dexConfig().spectrum);
  const pool = (x: bigint, y: bigint) => venue.parsePool(n2tPool({ x, y, fee: 997 }))!;
  const ONE_PCT = 10n ** 8n;

  it('holds within the slippage either way and fails just outside it', () => {
    const ref = pool(1000n * ERG, 1000000n);
    expect(ratioWithin(ref, pool(1000n * ERG, 1010000n), ONE_PCT)).toBe(true); // +1% exactly
    expect(ratioWithin(ref, pool(1000n * ERG, 1010001n), ONE_PCT)).toBe(false);
    expect(ratioWithin(ref, pool(1000n * ERG, 990000n), ONE_PCT)).toBe(true); // -1% exactly
    expect(ratioWithin(ref, pool(1000n * ERG, 989999n), ONE_PCT)).toBe(false);
    // the same price on a deeper pool
    expect(ratioWithin(ref, pool(2000n * ERG, 2000000n), 0n)).toBe(true);
  });
});
