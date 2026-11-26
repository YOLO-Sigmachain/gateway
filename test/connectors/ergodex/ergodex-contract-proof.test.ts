/**
 * The proof that our formula matches the deployed pool contracts: for each pool box
 * captured from mainnet, build a direct swap in both directions with the real builder
 * (fleet-sdk) and have the real ergo-lib-wasm 0.28.0 reduce and sign it. The pool script
 * reduces to true for our swap (signing succeeds, with an empty proof for the pool input)
 * and to false for the same swap asking one unit more (signing refuses it). Exact output
 * is proved in every direction, including the native coin out. Also here: the script's
 * Long overflow rule, and the pre-signing check refusing a built transaction that does
 * not match its plan.
 */
import { buildUnsignedTransaction, changeDelta, ErgoOutputSpec } from '../../../src/chains/ergo/ergo.tx-builder';
import { ErgoBox } from '../../../src/chains/ergo/ergo.types';
import { verifySwapTransaction } from '../../../src/connectors/ergodex/amm-routes/executeSwap';
import { Ergodex, TokenRef } from '../../../src/connectors/ergodex/ergodex';
import { swapAllowed } from '../../../src/connectors/ergodex/venues/spectrum/spectrum.math';
import { FEE_TREE, GENERATOR_PK } from '../../chains/ergo/ergo-test-helpers';

import {
  ERG,
  HEADERS,
  makeBox,
  makeDex,
  ME_TREE,
  newNodeState,
  RSBTC,
  RSBTC_POOL,
  RSN,
  RSN_POOL,
  signer,
  SIGUSD,
  SIGUSD_POOL,
  R4,
  T2T_POOL,
  T2T_TREE,
  TIP,
  tokenId,
  walletBox,
  WT_ADA,
  WT_ERG,
} from './ergodex-test-helpers';

const dex: Ergodex = makeDex(newNodeState());
const ERG_REF: TokenRef = { tokenId: null, symbol: 'ERG', decimals: 9 };
const tok = (id: string, symbol: string, decimals: number): TokenRef => ({ tokenId: id, symbol, decimals });
const LOG = process.env.ERGODEX_PROOF_LOG === '1';

function build(pool: ErgoBox, successor: ErgoOutputSpec, wallet: ErgoBox) {
  return buildUnsignedTransaction({
    height: TIP,
    minValuePerByte: 360n,
    fee: 1100000n,
    feeErgoTree: FEE_TREE,
    changeErgoTree: ME_TREE,
    inputs: [{ box: pool }],
    walletBoxes: [wallet],
    outputs: [successor],
  });
}

async function sign(built: ReturnType<typeof build>) {
  return signer.signTransaction(built.unsigned, built.unsigned.inputs, built.unsigned.dataInputs, { headers: HEADERS });
}

/** The same successor with the pool paying `delta` more of the side at token index `i` (or value for -1). */
function payMore(spec: ErgoOutputSpec, index: number | 'value', delta: bigint): ErgoOutputSpec {
  const copy: ErgoOutputSpec = { ...spec, assets: spec.assets!.map((a) => ({ ...a })) };
  if (index === 'value') copy.value = spec.value - delta;
  else copy.assets![index].amount -= delta;
  return copy;
}

interface Case {
  name: string;
  box: ErgoBox;
  base: TokenRef;
  quote: TokenRef;
  amount: bigint;
  wallet: ErgoBox;
}

const rsn = tok(RSN, 'RSN', 3);
const sigusd = tok(SIGUSD, 'SigUSD', 2);
const rsbtc = tok(RSBTC, 'rsBTC', 8);
const wterg = tok(WT_ERG, 'WT_ERG', 9);
const wtada = tok(WT_ADA, 'WT_ADA', 8);

const CASES: Case[] = [
  { name: 'ERG/RSN, ERG in', box: RSN_POOL, base: ERG_REF, quote: rsn, amount: ERG, wallet: walletBox(5n * ERG) },
  {
    name: 'ERG/RSN, RSN in',
    box: RSN_POOL,
    base: rsn,
    quote: ERG_REF,
    amount: 100000n,
    wallet: walletBox(ERG / 10n, [{ tokenId: RSN, amount: 100000n }]),
  },
  {
    name: 'ERG/SigUSD, ERG in',
    box: SIGUSD_POOL,
    base: ERG_REF,
    quote: sigusd,
    amount: ERG,
    wallet: walletBox(5n * ERG),
  },
  {
    name: 'ERG/SigUSD, SigUSD in',
    box: SIGUSD_POOL,
    base: sigusd,
    quote: ERG_REF,
    amount: 1000n,
    wallet: walletBox(ERG / 10n, [{ tokenId: SIGUSD, amount: 1000n }]),
  },
  { name: 'ERG/rsBTC, ERG in', box: RSBTC_POOL, base: ERG_REF, quote: rsbtc, amount: ERG, wallet: walletBox(5n * ERG) },
  {
    name: 'ERG/rsBTC, rsBTC in',
    box: RSBTC_POOL,
    base: rsbtc,
    quote: ERG_REF,
    amount: 10000n,
    wallet: walletBox(ERG / 10n, [{ tokenId: RSBTC, amount: 10000n }]),
  },
  {
    name: 'WT_ERG/WT_ADA, WT_ERG in',
    box: T2T_POOL,
    base: wterg,
    quote: wtada,
    amount: ERG,
    wallet: walletBox(ERG / 10n, [{ tokenId: WT_ERG, amount: ERG }]),
  },
  {
    name: 'WT_ERG/WT_ADA, WT_ADA in',
    box: T2T_POOL,
    base: wtada,
    quote: wterg,
    amount: 100000000n,
    wallet: walletBox(ERG / 10n, [{ tokenId: WT_ADA, amount: 100000000n }]),
  },
];

describe('pool contract proof with real wasm, on boxes captured from mainnet', () => {
  it.each(CASES)('$name: our swap reduces to true, one unit more to false', async (c) => {
    const venue = dex.venueForTree(c.box.ergoTree)!;
    expect(venue).toBeDefined();
    const pool = venue.parsePool(c.box)!;
    expect(pool).not.toBeNull();
    const plan = dex.plan({ pool, venue, source: 'confirmed' }, c.base, c.quote, 'SELL', c.amount);

    const built = build(c.box, plan.successor, c.wallet);
    expect(built.unsigned.inputs[0].boxId).toBe(c.box.boxId);
    const signed = await sign(built);
    // the pool input needs no proof: its script reduced to true
    expect(signed.parsed.inputs[0].spendingProof.proofBytes).toBe('');
    expect(signed.parsed.inputs[1].spendingProof.proofBytes.length).toBeGreaterThan(0);

    // one unit more out of the pool: on the token side, or (ERG out) in the box value
    const outSide = plan.swap.input === 'x' ? 'y' : 'x';
    const outIndex =
      pool[outSide].tokenId === null ? 'value' : pool.box.assets.findIndex((a) => a.tokenId === pool[outSide].tokenId);
    const greedy = build(c.box, payMore(plan.successor, outIndex as number | 'value', 1n), c.wallet);
    await expect(sign(greedy)).rejects.toThrow(/false/i);
    // and our own contract check agrees on both
    expect(venue.contractAccepts(pool, built.unsigned.outputs[0])).toBe(true);
    expect(venue.contractAccepts(pool, greedy.unsigned.outputs[0])).toBe(false);

    if (LOG) {
      console.log(
        `[proof] ${c.name}: pool box ${c.box.boxId} fee ${pool.feeNum}/${pool.feeDenom}; ` +
          `in ${plan.swap.amountIn} (${plan.tokenIn.symbol} raw) out ${plan.swap.amountOut} (${plan.tokenOut.symbol} raw); ` +
          `signed ${signed.id}; +1 refused`,
      );
    }
  });

  it.each(CASES)('$name, exact output: the minimal input passes, one unit less fails', async (c) => {
    const venue = dex.venueForTree(c.box.ergoTree)!;
    const pool = venue.parsePool(c.box)!;
    // BUY the quote side's worth: ask for exactly the output a SELL of `amount` gives
    const sell = dex.plan({ pool, venue, source: 'confirmed' }, c.base, c.quote, 'SELL', c.amount);
    const buy = dex.plan({ pool, venue, source: 'confirmed' }, c.quote, c.base, 'BUY', sell.swap.amountOut);
    expect(buy.swap.amountIn <= c.amount).toBe(true);
    const wallet = c.wallet;
    const signed = await sign(build(c.box, buy.successor, wallet));
    expect(signed.parsed.inputs[0].spendingProof.proofBytes).toBe('');
    // pay one unit less into the pool
    const inSide = buy.swap.input;
    const inIndex =
      pool[inSide].tokenId === null ? 'value' : pool.box.assets.findIndex((a) => a.tokenId === pool[inSide].tokenId);
    const short = build(c.box, payMore(buy.successor, inIndex as number | 'value', 1n), wallet);
    await expect(sign(short)).rejects.toThrow(/false/i);
    if (LOG)
      console.log(
        `[proof] ${c.name} BUY ${buy.swap.amountOut}: min input ${buy.swap.amountIn} signs; ${buy.swap.amountIn - 1n} refused`,
      );
  });
});

describe('the Long overflow rule on delta * feeNum, on the live token/token tree, real wasm', () => {
  const TX = tokenId(0xd1);
  const TY = tokenId(0xd2);
  const x0 = 10n ** 15n;
  const y0 = 10n ** 18n;
  const pool = makeBox({
    ergoTree: T2T_TREE,
    value: 4000000n,
    creationHeight: TIP - 5,
    assets: [
      { tokenId: tokenId(0xa7), amount: 1n },
      { tokenId: tokenId(0xb7), amount: 9223370000000000000n },
      { tokenId: TX, amount: x0 },
      { tokenId: TY, amount: y0 },
    ],
    registers: { R4: R4(997) },
  });
  const successor = (dx: bigint, out: bigint): ErgoOutputSpec => ({
    ergoTree: T2T_TREE,
    value: 4000000n,
    assets: [pool.assets[0], pool.assets[1], { tokenId: TX, amount: x0 + dx }, { tokenId: TY, amount: y0 - out }],
    additionalRegisters: { R4: R4(997) },
  });

  it.each([
    // 9,250,000,000,000,000 * 997 = 9,222,250,000,000,000,000 fits a Long
    ['fits a Long: accepted by the script and by our check', 9250000000000000n, true],
    // 9,300,000,000,000,000 * 997 = 9,272,100,000,000,000,000 does not
    ['overflows a Long: refused by the script and by our check', 9300000000000000n, false],
  ])('%s', async (_name, dx, fits) => {
    const venue = dex.venueForTree(T2T_TREE)!;
    const p = venue.parsePool(pool)!;
    const out = venue.amountOut(p, 'x', dx);
    expect(dx * 997n <= 2n ** 63n - 1n).toBe(fits);
    // the inequality alone, in unbounded integers, holds in both cases
    expect(swapAllowed(x0, y0, dx, out, 997n, 1000n)).toBe(true);
    const built = build(pool, successor(dx, out), walletBox(ERG, [{ tokenId: TX, amount: dx }]));
    expect(venue.contractAccepts(p, built.unsigned.outputs[0])).toBe(fits);
    if (fits) {
      expect((await sign(built)).parsed.inputs[0].spendingProof.proofBytes).toBe('');
    } else {
      await expect(sign(built)).rejects.toThrow(/overflow/i);
    }
  });
});

describe('the pre-signing check refuses a built transaction that is not its plan', () => {
  const venue = dex.venueForTree(RSN_POOL.ergoTree)!;
  const pool = venue.parsePool(RSN_POOL)!;
  const plan = dex.plan({ pool, venue, source: 'confirmed' }, ERG_REF, rsn, 'SELL', ERG);
  const wallet = walletBox(5n * ERG);

  it('the plan as built passes', () => {
    expect(() => verifySwapTransaction(plan, build(RSN_POOL, plan.successor, wallet))).not.toThrow();
  });

  it('another box at input 0', () => {
    const other = { ...plan, pool: { ...pool, box: SIGUSD_POOL } };
    expect(() => verifySwapTransaction(other, build(RSN_POOL, plan.successor, wallet))).toThrow(
      'the pool must be input 0',
    );
  });

  it('the successor at output 1', () => {
    const first: ErgoOutputSpec = { ergoTree: ME_TREE, value: ERG / 10n };
    const built = buildUnsignedTransaction({
      height: TIP,
      minValuePerByte: 360n,
      fee: 1100000n,
      feeErgoTree: FEE_TREE,
      changeErgoTree: ME_TREE,
      inputs: [{ box: RSN_POOL }],
      walletBoxes: [wallet],
      outputs: [first, plan.successor],
    });
    expect(() => verifySwapTransaction(plan, built)).toThrow('successor tree differs from the pool');
  });

  it('a successor that pays one unit more than planned', () => {
    const built = build(RSN_POOL, payMore(plan.successor, 2, 1n), wallet);
    expect(() => verifySwapTransaction(plan, built)).toThrow('successor token 2 amount differs from the plan');
  });

  it('a transaction that also pays part of the wallet elsewhere', () => {
    const elsewhere: ErgoOutputSpec = { ergoTree: '0008cd' + GENERATOR_PK, value: ERG / 10n };
    const built = buildUnsignedTransaction({
      height: TIP,
      minValuePerByte: 360n,
      fee: 1100000n,
      feeErgoTree: FEE_TREE,
      changeErgoTree: ME_TREE,
      inputs: [{ box: RSN_POOL }],
      walletBoxes: [wallet],
      outputs: [plan.successor, elsewhere],
    });
    expect(() => verifySwapTransaction(plan, built)).toThrow("the wallet's native balance change differs");
  });

  it('the wallet moves by exactly the swap and the fee', () => {
    const built = build(RSN_POOL, plan.successor, wallet);
    const delta = changeDelta(built);
    expect(delta.get(null)).toBe(-plan.swap.amountIn - built.fee);
    expect(delta.get(RSN)).toBe(plan.swap.amountOut);
    expect(delta.size).toBe(2);
  });

  it('a plan whose amounts differ from its own successor', () => {
    const lying = { ...plan, swap: { ...plan.swap, amountOut: plan.swap.amountOut - 1n } };
    expect(() => verifySwapTransaction(lying, build(RSN_POOL, plan.successor, wallet))).toThrow(
      'the pool does not pay the output',
    );
  });
});
