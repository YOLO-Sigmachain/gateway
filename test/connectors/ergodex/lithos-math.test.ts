/**
 * LithosDex swap math as table tests with numbers worked out by hand (the small pool) or
 * with plain integer arithmetic outside this code (the captured pools), for both pool
 * kinds, both directions, exact input and exact output. Gateway amounts are base units:
 * SELL is an exact input of base, BUY an exact output of base.
 */
import { ErgoTokenAmount } from '../../../src/chains/ergo/ergo.types';
import { Ergodex, TokenRef } from '../../../src/connectors/ergodex/ergodex';
import {
  decodeBigInt,
  decodeCollLong,
  decodeLong,
  encodeBigInt,
  encodeCollLong,
  encodeLong,
  quoteExactIn,
  quoteExactOut,
  sideFee,
} from '../../../src/connectors/ergodex/venues/lithos/lithos.math';
import { LithosPool } from '../../../src/connectors/ergodex/venues/lithos/lithos.venue';

import { newNodeState, RSN } from './ergodex-test-helpers';
import { LIT, LIT_POOL, LIT_RSN_POOL, makeLithosDex } from './lithos-test-helpers';

const D = 10000n;

describe('side fee rounding by pool kind', () => {
  const fees = { denom: D, dex: 9970n, side: 100n };
  it.each([
    // gross, n2t floor(100*A/1e4), t2t ceil(100*A/1e4)
    [1000n, 10n, 10n],
    [1001n, 10n, 11n],
    [1099n, 10n, 11n],
    [99n, 0n, 1n],
    [0n, 0n, 0n],
  ])('gross %s: ERG/token %s, token/token %s', (gross, n2t, t2t) => {
    expect(sideFee('n2t', gross, fees)).toBe(n2t);
    expect(sideFee('t2t', gross, fees)).toBe(t2t);
  });

  it('a zero side fee charges nothing on either kind', () => {
    expect(sideFee('t2t', 12345n, { ...fees, side: 0n })).toBe(0n);
    expect(sideFee('n2t', 12345n, { ...fees, side: 0n })).toBe(0n);
  });
});

describe('a small pool worked by hand: reserves in 1,000,000 and out 2,000,000, dex 9970, side fee 100', () => {
  const fees = { denom: D, dex: 9970n, side: 100n };
  // n2t: f = floor(10.01) = 10, traded 991; out = floor(2e6*991*9970 / (1e6*1e4 + 991*9970))
  //      = floor(19,760,540,000,000 / 10,009,880,270) = 1974
  // t2t: f = ceil(10.01) = 11, traded 990; out = floor(19,740,600,000,000 / 10,009,870,300) = 1972
  it('exact input of 1001', () => {
    expect(quoteExactIn('n2t', 1000000n, 2000000n, 1001n, fees)).toEqual({
      gross: 1001n,
      sideFee: 10n,
      traded: 991n,
      out: 1974n,
    });
    expect(quoteExactIn('t2t', 1000000n, 2000000n, 1001n, fees)).toEqual({
      gross: 1001n,
      sideFee: 11n,
      traded: 990n,
      out: 1972n,
    });
  });

  // traded needed for 1974 out: ceil(1974*1e6*1e4 / (9970*(2e6-1974))) = ceil(19,740,000,000,000 /
  // 19,920,319,220) = 991 (990.94...). n2t: A = floor(990*1e4/9900) + 1 = 1001.
  // For 1972 out: ceil(19,720,000,000,000 / 19,920,339,160) = 990; t2t: A = ceil(990*1e4/9900) = 1000.
  it('exact output: the smallest input, and one unit less does not suffice', () => {
    expect(quoteExactOut('n2t', 1000000n, 2000000n, 1974n, fees)!.gross).toBe(1001n);
    expect(quoteExactIn('n2t', 1000000n, 2000000n, 1000n, fees).out).toBeLessThan(1974n);
    expect(quoteExactOut('t2t', 1000000n, 2000000n, 1972n, fees)!.gross).toBe(1000n);
    expect(quoteExactIn('t2t', 1000000n, 2000000n, 999n, fees).out).toBeLessThan(1972n);
  });

  it('exact output of the whole reserve or more is impossible', () => {
    expect(quoteExactOut('n2t', 1000000n, 2000000n, 2000000n, fees)).toBeNull();
    expect(quoteExactOut('t2t', 1000000n, 2000000n, 2000001n, fees)).toBeNull();
  });

  it('an input that the side fee eats entirely gives nothing', () => {
    expect(quoteExactIn('t2t', 1000000n, 2000000n, 1n, fees).out).toBe(0n);
  });

  it('exact output inverts exact input over a range of sizes, both kinds', () => {
    for (const kind of ['n2t', 't2t'] as const) {
      for (let out = 1n; out < 4000n; out += 37n) {
        const q = quoteExactOut(kind, 1000000n, 2000000n, out, fees)!;
        expect(quoteExactIn(kind, 1000000n, 2000000n, q.gross, fees).out).toBeGreaterThanOrEqual(out);
        expect(quoteExactIn(kind, 1000000n, 2000000n, q.gross - 1n, fees).out).toBeLessThan(out);
      }
    }
  });
});

describe('register codecs, on the registers of captured pool boxes', () => {
  it('every register decodes and re-encodes to the node bytes', () => {
    for (const box of [LIT_POOL, LIT_RSN_POOL]) {
      const r = box.additionalRegisters;
      expect(encodeLong(decodeLong(r.R4)!)).toBe(r.R4);
      expect(encodeCollLong(decodeCollLong(r.R5)!)).toBe(r.R5);
      expect(encodeCollLong(decodeCollLong(r.R6)!)).toBe(r.R6);
      expect(encodeBigInt(decodeBigInt(r.R7)!)).toBe(r.R7);
      expect(encodeBigInt(decodeBigInt(r.R8)!)).toBe(r.R8);
    }
    expect(decodeBigInt(LIT_POOL.additionalRegisters.R7)).toBe(333646673224898018097541n);
    expect(decodeCollLong(LIT_POOL.additionalRegisters.R6)).toEqual([331502945n, 86397776395n]);
  });

  it('BigInt takes the shortest two complement form, with a sign byte where the top bit is set', () => {
    expect(encodeBigInt(0n)).toBe('060100');
    expect(encodeBigInt(127n)).toBe('06017f');
    expect(encodeBigInt(128n)).toBe('06020080');
    expect(encodeBigInt(-1n)).toBe('0601ff');
    expect(encodeBigInt(15000000000000000000n)).toBe('060900d02ab486cedc0000');
  });

  it('a register of another type, or with trailing bytes, does not decode', () => {
    expect(decodeLong('04bc0f')).toBeNull();
    expect(decodeCollLong('1103829c011e1e00')).toBeNull();
    expect(decodeBigInt('05e09a89d995fed3ffff01')).toBeNull();
  });
});

interface Row {
  name: string;
  side: 'BUY' | 'SELL';
  base: TokenRef;
  quote: TokenRef;
  amount: bigint;
  input: 'x' | 'y';
  amountIn: bigint;
  amountOut: bigint;
  /** Successor: value, the pool's two traded amounts, R6, R7, R8 */
  value: bigint;
  held: [bigint, bigint];
  pending: [bigint, bigint];
  acc: [bigint, bigint];
}

const ERG: TokenRef = { tokenId: null, symbol: 'ERG', decimals: 9 };
const LIT_REF: TokenRef = { tokenId: LIT, symbol: 'LIT', decimals: 9 };
const RSN_REF: TokenRef = { tokenId: RSN, symbol: 'RSN', decimals: 3 };

// ERG:LIT box ed5f84f8...: value 1,988,353,543,313, LIT 481,736,402,653,643, R5 [9985,15,15],
// R6 [331,502,945, 86,397,776,395], R7 333,646,673,224,898,018,097,541,
// R8 51,057,671,520,323,530,514,820,940, supply 96,788,471,011,663. Side fees round down.
const accX = 333646673224898018097541n;
const accY = 51057671520323530514820940n;
const N2T_ROWS: Row[] = [
  {
    name: 'SELL 1 ERG (exact input of ERG)',
    side: 'SELL',
    base: ERG,
    quote: LIT_REF,
    amount: 1000000000n,
    input: 'x',
    amountIn: 1000000000n,
    amountOut: 241428628025n,
    value: 1989353543313n,
    held: [1989353543313n, 481494974025618n],
    pending: [333002945n, 86397776395n],
    acc: [333662170938461643357895n, accY],
  },
  {
    name: 'SELL 1000 LIT (exact input of the token)',
    side: 'SELL',
    base: LIT_REF,
    quote: ERG,
    amount: 1000000000000n,
    input: 'y',
    amountIn: 1000000000000n,
    amountOut: 4106650239n,
    value: 1984246893074n,
    held: [1984246893074n, 482736402653643n],
    pending: [331502945n, 87897776395n],
    acc: [accX, 51073169233887155775175630n],
  },
  {
    name: 'BUY 1 ERG (exact output of ERG, paid in the token)',
    side: 'BUY',
    base: ERG,
    quote: LIT_REF,
    amount: 1000000000n,
    input: 'y',
    amountIn: 243126750851n,
    amountOut: 1000000000n,
    value: 1987353543313n,
    held: [1987353543313n, 481979529404494n],
    pending: [331502945n, 86762466521n],
    acc: [accX, 51061439429065017451631296n],
  },
  {
    name: 'BUY 1000 LIT (exact output of the token, paid in ERG)',
    side: 'BUY',
    base: LIT_REF,
    quote: ERG,
    amount: 1000000000000n,
    input: 'x',
    amountIn: 4148547867n,
    amountOut: 1000000000000n,
    value: 1992502091180n,
    held: [1992502091180n, 480736402653643n],
    pending: [337725766n, 86397776395n],
    acc: [333710966223175159501718n, accY],
  },
];

// LIT:RSN box 4f13bdf9...: LIT 234,146,082,425,083, RSN 23,399,703, R5 [9970,100,100],
// R6 [55,020,366,559, 8,683], supply 37,787,089,203,173, value 6,300,000,000. Side fees round up.
const tAccX = 98778166542015353680593333n;
const tAccY = 9220696327710546103n;
const T2T_ROWS: Row[] = [
  {
    name: 'SELL 100 LIT (exact input of X)',
    side: 'SELL',
    base: LIT_REF,
    quote: RSN_REF,
    amount: 100000000000n,
    input: 'x',
    amountIn: 100000000000n,
    amountOut: 9858n,
    value: 6300000000n,
    held: [234246082425083n, 23389845n],
    pending: [56020366559n, 8683n],
    acc: [98804630607416719116290387n, tAccY],
  },
  {
    name: 'SELL 1 RSN (exact input of Y)',
    side: 'SELL',
    base: RSN_REF,
    quote: LIT_REF,
    amount: 1000n,
    input: 'y',
    amountIn: 1000n,
    amountOut: 9877515028n,
    value: 6300000000n,
    held: [234136204910055n, 23400703n],
    pending: [55020366559n, 8693n],
    acc: [tAccX, 9220960968364559757n],
  },
  {
    name: 'BUY 1 RSN (exact output of Y, paid in X)',
    side: 'BUY',
    base: RSN_REF,
    quote: LIT_REF,
    amount: 1000n,
    input: 'x',
    amountIn: 10139671519n,
    amountOut: 1000n,
    value: 6300000000n,
    held: [234156222096602n, 23398703n],
    pending: [55121763275n, 8683n],
    acc: [98780849911339061357688923n, tAccY],
  },
  {
    name: 'BUY 100 LIT (exact output of X, paid in Y)',
    side: 'BUY',
    base: LIT_REF,
    quote: RSN_REF,
    amount: 100000000000n,
    input: 'y',
    amountIn: 10129n,
    amountOut: 100000000000n,
    value: 6300000000n,
    held: [234046082425083n, 23409832n],
    pending: [55020366559n, 8785n],
    acc: [tAccX, 9223395662381485377n],
  },
];

describe.each([
  ['ERG/token pool ERG:LIT', LIT_POOL, N2T_ROWS],
  ['token/token pool LIT:RSN', LIT_RSN_POOL, T2T_ROWS],
])('%s, captured from mainnet: gateway amounts to pool amounts and the successor', (_n, box, rows) => {
  const dex: Ergodex = makeLithosDex(newNodeState());
  const venue = dex.venueForTree(box.ergoTree)!;
  const pool = venue.parsePool(box) as LithosPool;

  it.each(rows)('$name', (row) => {
    const plan = dex.plan({ pool, venue, source: 'confirmed' }, row.base, row.quote, row.side, row.amount);
    expect(plan.swap).toEqual({ input: row.input, amountIn: row.amountIn, amountOut: row.amountOut });
    const s = plan.successor;
    expect(s.value).toBe(row.value);
    const amounts = (s.assets as ErgoTokenAmount[]).map((a) => a.amount);
    if (pool.kind === 'n2t') {
      expect(s.value).toBe(row.held[0]);
      expect(amounts[1]).toBe(row.held[1]);
    } else {
      expect([amounts[1], amounts[2]]).toEqual(row.held);
    }
    expect(amounts[0]).toBe(1n);
    expect(amounts[amounts.length - 1]).toBe(box.assets[box.assets.length - 1].amount);
    const r = s.additionalRegisters!;
    expect(decodeCollLong(r.R6)).toEqual(row.pending);
    expect([decodeBigInt(r.R7), decodeBigInt(r.R8)]).toEqual(row.acc);
    // R4 and R5 byte for byte; the accumulator of the side not paid in byte for byte
    expect(r.R4).toBe(box.additionalRegisters.R4);
    expect(r.R5).toBe(box.additionalRegisters.R5);
    const untouched = row.input === 'x' ? 'R8' : 'R7';
    expect(r[untouched]).toBe(box.additionalRegisters[untouched]);
  });
});
