/**
 * Amount semantics (SELL and BUY, base ERG and base token) and the constant-product math,
 * against hand-computed numbers.
 *
 * Pool for the table: X = 1,000 ERG (1,000,000,000,000 nanoERG), Y = 5,000.000 TKN
 * (5,000,000 raw, 3 decimals). Gateway `amount` is in base units: SELL is an exact input of
 * base, BUY an exact output of base. Hand computation, fee f over 1000:
 *   out(in) = floor(rOut * in * f / (rIn * 1000 + in * f))
 *   in(out) = ceil(out * rIn * 1000 / (f * (rOut - out)))
 * f = 997:
 *   SELL 10 ERG (base ERG):  5e6*1e10*997 / (1e15 + 1e10*997) = 49357.9..  -> 49,357 raw = 49.357 TKN
 *   SELL 50 TKN (base TKN):  1e12*5e4*997 / (5e9 + 5e4*997)   = 9871580343.6.. -> 9.871580343 ERG
 *   BUY 10 ERG  (base ERG):  1e10*5e6*1000 / (997*(1e12-1e10)) = 50657.4.. -> 50,658 raw = 50.658 TKN in
 *   BUY 50 TKN  (base TKN):  5e4*1e12*1000 / (997*(5e6-5e4))   = 10131404313.4.. -> 10.131404314 ERG in
 * f = 990:
 *   SELL 10 ERG: 49,014 raw = 49.014 TKN; SELL 50 TKN: 9.802950787 ERG;
 *   BUY 10 ERG: 51,016 raw = 51.016 TKN in; BUY 50 TKN: 10.203040507 ERG in.
 */
import { quoteResponse } from '../../../src/connectors/ergodex/amm-routes/quoteSwap';
import { Ergodex, TokenRef } from '../../../src/connectors/ergodex/ergodex';
import {
  decodeSInt,
  inputForOutput,
  outputForInput,
  swapAllowed,
} from '../../../src/connectors/ergodex/venues/spectrum/spectrum.math';

import { ERG, makeDex, n2tPool, newNodeState, R4, tokenId } from './ergodex-test-helpers';

const TKN = tokenId(0xc1);
const ERG_REF: TokenRef = { tokenId: null, symbol: 'ERG', decimals: 9 };
const TKN_REF: TokenRef = { tokenId: TKN, symbol: 'TKN', decimals: 3 };

interface Row {
  fee: number;
  side: 'BUY' | 'SELL';
  base: 'ERG' | 'TKN';
  amount: bigint;
  /** Whole units as the exact decimal string the response carries. */
  amountIn: string;
  amountOut: string;
  tokenIn: string;
  tokenOut: string;
  rawIn: bigint;
  rawOut: bigint;
}

const ZERO = '0'.repeat(64);
const TABLE: Row[] = [
  // fee 997
  {
    fee: 997,
    side: 'SELL',
    base: 'ERG',
    amount: 10n * ERG,
    rawIn: 10n * ERG,
    rawOut: 49357n,
    amountIn: '10',
    amountOut: '49.357',
    tokenIn: ZERO,
    tokenOut: TKN,
  },
  {
    fee: 997,
    side: 'SELL',
    base: 'TKN',
    amount: 50000n,
    rawIn: 50000n,
    rawOut: 9871580343n,
    amountIn: '50',
    amountOut: '9.871580343',
    tokenIn: TKN,
    tokenOut: ZERO,
  },
  {
    fee: 997,
    side: 'BUY',
    base: 'ERG',
    amount: 10n * ERG,
    rawIn: 50658n,
    rawOut: 10n * ERG,
    amountIn: '50.658',
    amountOut: '10',
    tokenIn: TKN,
    tokenOut: ZERO,
  },
  {
    fee: 997,
    side: 'BUY',
    base: 'TKN',
    amount: 50000n,
    rawIn: 10131404314n,
    rawOut: 50000n,
    amountIn: '10.131404314',
    amountOut: '50',
    tokenIn: ZERO,
    tokenOut: TKN,
  },
  // fee 990
  {
    fee: 990,
    side: 'SELL',
    base: 'ERG',
    amount: 10n * ERG,
    rawIn: 10n * ERG,
    rawOut: 49014n,
    amountIn: '10',
    amountOut: '49.014',
    tokenIn: ZERO,
    tokenOut: TKN,
  },
  {
    fee: 990,
    side: 'SELL',
    base: 'TKN',
    amount: 50000n,
    rawIn: 50000n,
    rawOut: 9802950787n,
    amountIn: '50',
    amountOut: '9.802950787',
    tokenIn: TKN,
    tokenOut: ZERO,
  },
  {
    fee: 990,
    side: 'BUY',
    base: 'ERG',
    amount: 10n * ERG,
    rawIn: 51016n,
    rawOut: 10n * ERG,
    amountIn: '51.016',
    amountOut: '10',
    tokenIn: TKN,
    tokenOut: ZERO,
  },
  {
    fee: 990,
    side: 'BUY',
    base: 'TKN',
    amount: 50000n,
    rawIn: 10203040507n,
    rawOut: 50000n,
    amountIn: '10.203040507',
    amountOut: '50',
    tokenIn: ZERO,
    tokenOut: TKN,
  },
];

describe('SELL/BUY x base ERG/token, hand-computed', () => {
  const dex: Ergodex = makeDex(newNodeState());

  it.each(TABLE)('fee $fee: $side $amount raw of base $base', (row) => {
    const box = n2tPool({ x: 1000n * ERG, y: 5000000n, fee: row.fee, token: TKN });
    const venue = dex.venueForTree(box.ergoTree)!;
    const pool = venue.parsePool(box)!;
    const [base, quote] = row.base === 'ERG' ? [ERG_REF, TKN_REF] : [TKN_REF, ERG_REF];
    const plan = dex.plan({ pool, venue, source: 'confirmed' }, base, quote, row.side, row.amount);
    expect(plan.swap.amountIn).toBe(row.rawIn);
    expect(plan.swap.amountOut).toBe(row.rawOut);
    const q = quoteResponse(plan, 1);
    expect(q.tokenIn).toBe(row.tokenIn);
    expect(q.tokenOut).toBe(row.tokenOut);
    expect(q.amountIn).toBe(row.amountIn);
    expect(q.amountOut).toBe(row.amountOut);
    // SELL pays exactly the base amount; BUY receives exactly the base amount
    if (row.side === 'SELL') expect(plan.swap.amountIn).toBe(row.amount);
    else expect(plan.swap.amountOut).toBe(row.amount);
    // the pool's side that is ERG is the box value: a SELL of ERG or BUY of TKN raises it
    const ergIntoPool = (row.side === 'SELL') === (row.base === 'ERG');
    expect(plan.successor.value).toBe(
      ergIntoPool ? 1000n * ERG + plan.swap.amountIn : 1000n * ERG - plan.swap.amountOut,
    );
  });
});

describe('constant-product math edges', () => {
  const big = 2n ** 53n + 1n;

  it('zero and one unit in', () => {
    expect(outputForInput(1000n * ERG, 5000000n, 0n, 997n, 1000n)).toBe(0n);
    // one nanoERG into a deep pool buys nothing
    expect(outputForInput(1000n * ERG, 5000000n, 1n, 997n, 1000n)).toBe(0n);
    // one unit of token into the same pool buys floor(1e12*997/(5e9+997)) = 199,399 nanoERG
    expect(outputForInput(5000000n, 1000n * ERG, 1n, 997n, 1000n)).toBe(199399n);
    expect(swapAllowed(5000000n, 1000n * ERG, 1n, 199399n, 997n, 1000n)).toBe(true);
    expect(swapAllowed(5000000n, 1000n * ERG, 1n, 199400n, 997n, 1000n)).toBe(false);
  });

  it('reserves above 2^53 stay exact', () => {
    const rIn = 14269592596374645n; // BBC/0 reserve in a live t2t pool
    const rOut = 211674724104337n;
    const dIn = big;
    const out = outputForInput(rIn, rOut, dIn, 980n, 1000n);
    // hand: floor(211674724104337 * 9007199254740993 * 980 / (14269592596374645*1000 + 9007199254740993*980))
    expect(out).toBe(80897647991807n);
    expect(swapAllowed(rIn, rOut, dIn, out, 980n, 1000n)).toBe(true);
    expect(swapAllowed(rIn, rOut, dIn, out + 1n, 980n, 1000n)).toBe(false);
  });

  it('a 99.9%-fee pool (R4 = 1) pays a thousandth of the curve', () => {
    const out = outputForInput(1000n * ERG, 5000000n, 10n * ERG, 1n, 1000n);
    // hand: floor(5e6*1e10*1 / (1e15 + 1e10)) = 49
    expect(out).toBe(49n);
    const need = inputForOutput(1000n * ERG, 5000000n, 49n, 1n, 1000n)!;
    expect(swapAllowed(1000n * ERG, 5000000n, need, 49n, 1n, 1000n)).toBe(true);
    expect(swapAllowed(1000n * ERG, 5000000n, need - 1n, 49n, 1n, 1000n)).toBe(false);
  });

  it('exact output: the input passes at n and fails at n - 1', () => {
    const cases: Array<[bigint, bigint, bigint, bigint]> = [
      [1000n * ERG, 5000000n, 50000n, 997n],
      [5000000n, 1000n * ERG, 10n * ERG, 990n],
      [240511405855382n, 5756253026n, 1n, 990n],
      [5756253026n, 240511405855382n, 123456789n, 990n],
      [3507705255757425n, 14269592596374645n, big, 996n],
      [7n, 11n, 3n, 999n],
    ];
    for (const [rIn, rOut, out, f] of cases) {
      const n = inputForOutput(rIn, rOut, out, f, 1000n)!;
      expect(swapAllowed(rIn, rOut, n, out, f, 1000n)).toBe(true);
      expect(swapAllowed(rIn, rOut, n - 1n, out, f, 1000n)).toBe(false);
      // and the exact-input formula gives at least `out` for `n`
      expect(outputForInput(rIn, rOut, n, f, 1000n) >= out).toBe(true);
    }
  });

  it('an output the pool cannot pay has no input', () => {
    expect(inputForOutput(1000n, 5000n, 5000n, 997n, 1000n)).toBeNull();
    expect(inputForOutput(1000n, 5000n, 6000n, 997n, 1000n)).toBeNull();
  });

  it('a quote that rounds to zero is refused, not priced', () => {
    const dex = makeDex(newNodeState());
    const box = n2tPool({ x: 1000n * ERG, y: 5000000n, fee: 997, token: TKN });
    const venue = dex.venueForTree(box.ergoTree)!;
    const pool = venue.parsePool(box)!;
    expect(() => dex.plan({ pool, venue, source: 'confirmed' }, ERG_REF, TKN_REF, 'SELL', 1n)).toThrow(
      /rounds to zero/,
    );
  });

  it('LP amounts near 2^63 are carried exactly into the successor', () => {
    const dex = makeDex(newNodeState());
    const lp = 9223370866119426648n;
    const box = n2tPool({ x: 1000n * ERG, y: 5000000n, fee: 997, token: TKN, lp });
    const venue = dex.venueForTree(box.ergoTree)!;
    const pool = venue.parsePool(box)!;
    const plan = dex.plan({ pool, venue, source: 'confirmed' }, ERG_REF, TKN_REF, 'SELL', ERG);
    expect(plan.successor.assets![1]).toEqual({ tokenId: box.assets[1].tokenId, amount: lp });
  });

  it('R4 decodes as the live trees read it (Int), and nothing else', () => {
    expect(decodeSInt('04bc0f')).toBe(990);
    expect(decodeSInt('04c60f')).toBe(995);
    expect(decodeSInt('04c80f')).toBe(996);
    expect(decodeSInt('04ca0f')).toBe(997);
    expect(decodeSInt('0402')).toBe(1);
    expect(decodeSInt(R4(999))).toBe(999);
    expect(decodeSInt('05bc0f')).toBeNull(); // a Long
    expect(decodeSInt('04bc0f00')).toBeNull(); // trailing bytes
    expect(decodeSInt('04bc')).toBeNull(); // unterminated
    expect(decodeSInt(undefined)).toBeNull();
  });
});
