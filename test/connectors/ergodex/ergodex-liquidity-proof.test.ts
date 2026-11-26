/**
 * The proof that our deposit and redeem match the deployed pool contracts: for each pool
 * box captured from mainnet (three ERG/token pools and one token/token pool), build the
 * deposit and the redeem this code plans with the real builder (fleet-sdk), and have the
 * real ergo-lib-wasm 0.28.0 reduce and sign them with a throw-away test key. The pool
 * script reduces to true for ours (the pool input signs with an empty proof) and to false
 * for one LP unit more out or one unit less of either side in (deposit), and for one unit
 * more of either side out or one LP unit less in (redeem). A deposit is proved with each
 * side as the one that limits it. Nothing is sent: there is no node here.
 *
 * Also here: our own bigint contract rule agrees with the script on every case, and the
 * pre-signing check refuses a built transaction that is not its plan.
 */
import { buildUnsignedTransaction, changeDelta, ErgoOutputSpec } from '../../../src/chains/ergo/ergo.tx-builder';
import { ErgoBox } from '../../../src/chains/ergo/ergo.types';
import { verifyLiquidityTransaction } from '../../../src/connectors/ergodex/amm-routes/liquidity';
import { Ergodex, FreshLiquidityPool, LiquidityPlan, TokenRef } from '../../../src/connectors/ergodex/ergodex';
import { FEE_TREE, GENERATOR_PK } from '../../chains/ergo/ergo-test-helpers';

import {
  ERG,
  HEADERS,
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
  T2T_POOL,
  TIP,
  walletBox,
  WT_ADA,
  WT_ERG,
} from './ergodex-test-helpers';

const dex: Ergodex = makeDex(newNodeState());
const LOG = process.env.ERGODEX_PROOF_LOG === '1';
const ERG_REF: TokenRef = { tokenId: null, symbol: 'ERG', decimals: 9 };
const tok = (id: string, symbol: string, decimals: number): TokenRef => ({ tokenId: id, symbol, decimals });

function fresh(box: ErgoBox, base: TokenRef, quote: TokenRef): FreshLiquidityPool {
  const venue = dex.venueForTree(box.ergoTree)!;
  const pool = venue.parsePool(box)!;
  const { lpTokenId, supply } = venue.liquidity!(pool)!;
  return { pool, venue, source: 'confirmed', base, quote, lpToken: tok(lpTokenId, 'LP', 0), supply };
}

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

const sign = (built: ReturnType<typeof build>) =>
  signer.signTransaction(built.unsigned, built.unsigned.inputs, built.unsigned.dataInputs, { headers: HEADERS });

/** The successor with `delta` added to the side at token index `i` (or the value). */
function moved(spec: ErgoOutputSpec, index: number | 'value', delta: bigint): ErgoOutputSpec {
  const copy: ErgoOutputSpec = { ...spec, assets: spec.assets!.map((a) => ({ ...a })) };
  if (index === 'value') copy.value = spec.value + delta;
  else copy.assets![index].amount += delta;
  return copy;
}

interface Case {
  name: string;
  box: ErgoBox;
  base: TokenRef;
  quote: TokenRef;
  /** An amount of base the deposit is limited by, and an amount of quote it is limited by. */
  baseOffer: bigint;
  quoteOffer: bigint;
}

const CASES: Case[] = [
  { name: 'ERG/RSN', box: RSN_POOL, base: ERG_REF, quote: tok(RSN, 'RSN', 3), baseOffer: ERG, quoteOffer: 10000n },
  {
    name: 'ERG/SigUSD',
    box: SIGUSD_POOL,
    base: ERG_REF,
    quote: tok(SIGUSD, 'SigUSD', 2),
    baseOffer: ERG,
    quoteOffer: 100n,
  },
  {
    name: 'ERG/rsBTC',
    box: RSBTC_POOL,
    base: ERG_REF,
    quote: tok(RSBTC, 'rsBTC', 8),
    baseOffer: ERG,
    quoteOffer: 3000n,
  },
  {
    name: 'WT_ERG/WT_ADA',
    box: T2T_POOL,
    base: tok(WT_ERG, 'WT_ERG', 9),
    quote: tok(WT_ADA, 'WT_ADA', 8),
    baseOffer: ERG,
    quoteOffer: 10n ** 8n,
  },
];

/** Index of a side in the successor: the value for the native coin, else its token index. */
const indexOf = (plan: FreshLiquidityPool, side: 'x' | 'y'): number | 'value' =>
  plan.pool[side].tokenId === null
    ? 'value'
    : plan.pool.box.assets.findIndex((a) => a.tokenId === plan.pool[side].tokenId);

/** A wallet box holding what a plan needs from the wallet, and some ERG for the fee and change. */
function walletFor(plan: LiquidityPlan): ErgoBox {
  const { change, pool } = plan;
  const tokens: Array<{ tokenId: string; amount: bigint }> = [];
  let value = ERG / 10n;
  if (change.action === 'deposit') {
    if (pool.x.tokenId === null) value += change.x;
    else tokens.push({ tokenId: pool.x.tokenId, amount: change.x });
    tokens.push({ tokenId: pool.y.tokenId!, amount: change.y });
  } else {
    tokens.push({ tokenId: plan.lpToken.tokenId!, amount: change.lp });
  }
  return walletBox(value, tokens);
}

const results: string[] = [];

afterAll(() => {
  if (LOG) console.log(results.join('\n'));
});

describe('deposit: the pool script, real wasm, on boxes captured from mainnet', () => {
  const deposits = CASES.flatMap((c) => [
    { ...c, limit: 'base' as const, offer: [c.baseOffer, c.baseOffer * 10n ** 12n] as const },
    { ...c, limit: 'quote' as const, offer: [c.quoteOffer * 10n ** 12n, c.quoteOffer] as const },
  ]);

  it.each(deposits)(
    '$name, limited by $limit: ours true; one LP more, one base less, one quote less: false',
    async (c) => {
      const f = fresh(c.box, c.base, c.quote);
      const plan = dex.planDeposit(f, c.offer[0], c.offer[1]);
      const { x, y, lp } = plan.change;
      expect(x <= c.offer[0] && y <= c.offer[1]).toBe(true);
      // the limiting side is (nearly) used up, the other only in the pool's ratio
      if (c.limit === 'base') expect(c.offer[0] - x < f.pool.x.reserve / f.supply + 1n).toBe(true);
      else expect(c.offer[1] - y < f.pool.y.reserve / f.supply + 1n).toBe(true);
      const wallet = walletFor(plan);

      const built = build(c.box, plan.successor, wallet);
      const signed = await sign(built);
      expect(signed.parsed.inputs[0].spendingProof.proofBytes).toBe('');
      expect(() => verifyLiquidityTransaction(plan, built)).not.toThrow();
      expect(plan.venue.contractAccepts(plan.pool, built.unsigned.outputs[0])).toBe(true);

      const variants: Array<[string, ErgoOutputSpec]> = [
        ['one LP more out', moved(plan.successor, 1, -1n)],
        ['one base less in', moved(plan.successor, indexOf(plan, 'x'), -1n)],
        ['one quote less in', moved(plan.successor, indexOf(plan, 'y'), -1n)],
      ];
      const outcome: string[] = ['ours TRUE'];
      for (const [what, spec] of variants) {
        // the wallet keeps a unit more of what it did not pay, or of the LP it was paid
        const tx = build(c.box, spec, wallet);
        await expect(sign(tx)).rejects.toThrow(/false/i);
        expect(plan.venue.contractAccepts(plan.pool, tx.unsigned.outputs[0])).toBe(false);
        outcome.push(`${what} FALSE`);
      }
      results.push(
        `[proof] deposit ${c.name} (${c.limit} limits) box ${c.box.boxId.slice(0, 12)} S ${f.supply}: ` +
          `${x} + ${y} for ${lp} LP: ${outcome.join(', ')}`,
      );
    },
  );

  it.each(CASES)('$name: a deposit on one side only with LP out is false', async (c) => {
    const f = fresh(c.box, c.base, c.quote);
    const plan = dex.planDeposit(f, c.baseOffer, c.baseOffer * 10n ** 12n);
    // the same LP out for the base side only: the redeem rule applies, and refuses it
    const oneSided = moved(plan.successor, indexOf(plan, 'y'), -plan.change.y);
    const tx = build(c.box, oneSided, walletFor(plan));
    await expect(sign(tx)).rejects.toThrow(/false/i);
    expect(plan.venue.contractAccepts(plan.pool, tx.unsigned.outputs[0])).toBe(false);
  });
});

describe('redeem: the pool script, real wasm, on boxes captured from mainnet', () => {
  it.each(CASES)('$name: ours true; one base more, one quote more, one LP less in: false', async (c) => {
    const f = fresh(c.box, c.base, c.quote);
    // the LP a deposit of the base offer would buy: a realistic holding
    const lp = dex.planDeposit(f, c.baseOffer, c.baseOffer * 10n ** 12n).change.lp;
    const plan = dex.planRedeem(f, lp);
    const { x, y } = plan.change;
    expect(x * f.supply <= lp * f.pool.x.reserve && (x + 1n) * f.supply > lp * f.pool.x.reserve).toBe(true);
    expect(y * f.supply <= lp * f.pool.y.reserve && (y + 1n) * f.supply > lp * f.pool.y.reserve).toBe(true);
    const wallet = walletFor(plan);

    const built = build(c.box, plan.successor, wallet);
    const signed = await sign(built);
    expect(signed.parsed.inputs[0].spendingProof.proofBytes).toBe('');
    expect(() => verifyLiquidityTransaction(plan, built)).not.toThrow();
    // the wallet gains exactly both sides, gives exactly the LP, and pays the fee
    const delta = changeDelta(built);
    expect(delta.get(plan.lpToken.tokenId)).toBe(-lp);
    expect(delta.get(c.quote.tokenId)).toBe(y);
    if (c.base.tokenId === null) expect(delta.get(null)).toBe(x - built.fee);
    else expect(delta.get(c.base.tokenId)).toBe(x);

    const variants: Array<[string, ErgoOutputSpec]> = [
      ['one base more out', moved(plan.successor, indexOf(plan, 'x'), -1n)],
      ['one quote more out', moved(plan.successor, indexOf(plan, 'y'), -1n)],
      ['one LP less in', moved(plan.successor, 1, -1n)],
    ];
    const outcome: string[] = ['ours TRUE'];
    for (const [what, spec] of variants) {
      const tx = build(c.box, spec, wallet);
      await expect(sign(tx)).rejects.toThrow(/false/i);
      expect(plan.venue.contractAccepts(plan.pool, tx.unsigned.outputs[0])).toBe(false);
      outcome.push(`${what} FALSE`);
    }
    results.push(
      `[proof] redeem ${c.name} box ${c.box.boxId.slice(0, 12)} S ${f.supply}: ${lp} LP for ${x} + ${y}: ` +
        outcome.join(', '),
    );
  });
});

describe('the pre-signing check refuses a built liquidity transaction that is not its plan', () => {
  const f = fresh(RSN_POOL, ERG_REF, tok(RSN, 'RSN', 3));
  const plan = dex.planDeposit(f, ERG, 10n ** 9n);
  const wallet = walletFor(plan);

  it('the plan as built passes', () => {
    expect(() => verifyLiquidityTransaction(plan, build(RSN_POOL, plan.successor, wallet))).not.toThrow();
  });

  it('a successor that pays one LP unit more than planned', () => {
    expect(() => verifyLiquidityTransaction(plan, build(RSN_POOL, moved(plan.successor, 1, -1n), wallet))).toThrow(
      'successor token 1 amount differs from the plan',
    );
  });

  it('a transaction that also pays part of the wallet elsewhere', () => {
    const elsewhere: ErgoOutputSpec = { ergoTree: '0008cd' + GENERATOR_PK, value: ERG / 100n };
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
    expect(() => verifyLiquidityTransaction(plan, built)).toThrow("the wallet's native balance change differs");
  });

  it('a plan whose amounts differ from its own successor', () => {
    const lying: LiquidityPlan = { ...plan, change: { ...plan.change, lp: plan.change.lp + 1n } };
    expect(() => verifyLiquidityTransaction(lying, build(RSN_POOL, plan.successor, wallet))).toThrow(
      'the pool LP reserve does not move by the plan',
    );
  });

  it('another box at input 0', () => {
    const other: LiquidityPlan = { ...plan, pool: { ...plan.pool, box: SIGUSD_POOL } };
    expect(() => verifyLiquidityTransaction(other, build(RSN_POOL, plan.successor, wallet))).toThrow(
      'the pool must be input 0',
    );
  });
});
