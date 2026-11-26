/**
 * The proof that our LithosDex math and successor match the deployed pool contracts: for
 * each pool box captured from mainnet (ERG:LIT, an ERG/token pool; LIT:RSN, a token/token
 * pool), in both directions, exact input and exact output, build the direct swap with the
 * real builder and have the real signing library for version-3 trees (the alpha
 * ergo-lib-wasm build) evaluate it. No network.
 *
 * The verdict is read two ways, because that library's reduce does not fail on a script
 * that evaluates to false: the reduced proposition of the pool input (true or false), and
 * signing (which refuses a false script). Our swap is true; the same input taking one unit
 * more out than the curve allows is false; one unit less in is false exactly when our
 * math says that input buys less than the output (always, on an exact output); a
 * successor register one unit off is false.
 */
import {
  ErgoBoxes,
  ErgoStateContext,
  BlockHeaders,
  Parameters,
  PreHeader,
  ReducedTransaction,
  UnsignedTransaction,
} from 'ergo-lib-wasm-nodejs-alpha';

import {
  buildUnsignedTransaction,
  BuiltErgoTransaction,
  ErgoOutputSpec,
} from '../../../src/chains/ergo/ergo.tx-builder';
import { ErgoBox, ErgoTokenAmount } from '../../../src/chains/ergo/ergo.types';
import { verifySwapTransaction } from '../../../src/connectors/ergodex/amm-routes/executeSwap';
import { Ergodex, TokenRef } from '../../../src/connectors/ergodex/ergodex';
import {
  accumulatorAdvance,
  encodeBigInt,
  encodeCollLong,
  quoteExactIn,
  sideFee,
} from '../../../src/connectors/ergodex/venues/lithos/lithos.math';
import { LithosPool } from '../../../src/connectors/ergodex/venues/lithos/lithos.venue';
import { Venue } from '../../../src/connectors/ergodex/venues/venue';
import { FEE_TREE } from '../../chains/ergo/ergo-test-helpers';

import { ME_TREE, newNodeState, RSN, signer, walletBox } from './ergodex-test-helpers';
import { L_HEADERS, L_TIP, LIT, LIT_POOL, LIT_RSN_POOL, lithosConfig, makeLithosDex } from './lithos-test-helpers';

const LOG = process.env.ERGODEX_PROOF_LOG === '1';
const dex: Ergodex = makeLithosDex(newNodeState());
const cfg = lithosConfig();
const ERG: TokenRef = { tokenId: null, symbol: 'ERG', decimals: 9 };
const LIT_REF: TokenRef = { tokenId: LIT, symbol: 'LIT', decimals: 9 };
const RSN_REF: TokenRef = { tokenId: RSN, symbol: 'RSN', decimals: 3 };

/** The successor written out from the contract's rules, with a hook to put one value off. */
function rawSuccessor(
  pool: LithosPool,
  input: 'x' | 'y',
  gross: bigint,
  out: bigint,
  tweak: { pendingIn?: bigint; accIn?: bigint } = {},
): ErgoOutputSpec {
  const s = pool.lithos;
  const o = input === 'x' ? 'y' : 'x';
  const f = sideFee(s.kind, gross, { denom: s.denom, dex: s.dexFee, side: s.sideFee[input] });
  const held = { ...s.held };
  held[input] += gross;
  held[o] -= out;
  const pending = { ...s.pending };
  pending[input] += f + (tweak.pendingIn ?? 0n);
  const acc = { ...s.acc };
  acc[input] += accumulatorAdvance(f, cfg.accumulatorScale, s.supply) + (tweak.accIn ?? 0n);
  const box = pool.box;
  const assets: ErgoTokenAmount[] =
    s.kind === 'n2t'
      ? [box.assets[0], { tokenId: box.assets[1].tokenId, amount: held.y }, box.assets[2]]
      : [
          box.assets[0],
          { tokenId: box.assets[1].tokenId, amount: held.x },
          { tokenId: box.assets[2].tokenId, amount: held.y },
          box.assets[3],
        ];
  return {
    ergoTree: box.ergoTree,
    value: s.kind === 'n2t' ? held.x : box.value,
    assets: assets.map((a) => ({ ...a })),
    additionalRegisters: {
      R4: box.additionalRegisters.R4,
      R5: box.additionalRegisters.R5,
      R6: encodeCollLong([pending.x, pending.y]),
      R7: encodeBigInt(acc.x),
      R8: encodeBigInt(acc.y),
    },
  };
}

function build(venue: Venue, pool: LithosPool, successor: ErgoOutputSpec, wallet: ErgoBox): BuiltErgoTransaction {
  return buildUnsignedTransaction({
    height: L_TIP,
    minValuePerByte: 360n,
    fee: 1100000n,
    feeErgoTree: FEE_TREE,
    changeErgoTree: ME_TREE,
    inputs: [{ box: pool.box, extension: venue.swapInputExtension!(pool) }],
    walletBoxes: [wallet],
    outputs: [successor],
  });
}

/** The pool input's proposition after reduction: 'true', 'false', or what the library printed. */
function reducedPoolProposition(built: BuiltErgoTransaction): string {
  const ordered = [...L_HEADERS].sort((a, b) => b.height - a.height);
  const headers = BlockHeaders.from_json(ordered);
  const ctx = new ErgoStateContext(
    PreHeader.from_block_header(headers.get(0)),
    headers,
    Parameters.default_parameters(),
  );
  const tx = UnsignedTransaction.from_json(JSON.stringify(built.unsigned));
  const boxes = ErgoBoxes.from_boxes_json(built.unsigned.inputs);
  const reduced = ReducedTransaction.from_unsigned_tx(tx, boxes, ErgoBoxes.empty(), ctx);
  const json = JSON.parse(reduced.to_json());
  for (const o of [reduced, boxes, tx, ctx]) o.free();
  const inputs = json.inputs ?? json.reducedInputs;
  const prop = inputs[0].sigmaProp ?? inputs[0].sigma_prop;
  // TrivialProp: d3 is true, d2 is false
  if (prop === 'd3') return 'true';
  if (prop === 'd2') return 'false';
  return JSON.stringify(prop);
}

async function signs(built: BuiltErgoTransaction): Promise<boolean> {
  const v3 = await signer.forTreeVersion3!();
  try {
    const signed = await v3.signTransaction(built.unsigned, built.unsigned.inputs, built.unsigned.dataInputs, {
      headers: L_HEADERS,
    });
    // the pool input needs no signature, and carries the swap operation byte
    expect(signed.parsed.inputs[0].spendingProof.proofBytes).toBe('');
    expect(signed.parsed.inputs[0].spendingProof.extension).toEqual({ '0': '0200' });
    return true;
  } catch (error) {
    expect((error as Error).message).toMatch(/false/i);
    return false;
  }
}

/** Both verdicts, which must agree. */
async function verdict(built: BuiltErgoTransaction): Promise<boolean> {
  const reduced = reducedPoolProposition(built);
  const signed = await signs(built);
  expect(reduced).toBe(String(signed));
  return signed;
}

interface Case {
  name: string;
  box: ErgoBox;
  side: 'BUY' | 'SELL';
  base: TokenRef;
  quote: TokenRef;
  amount: bigint;
}

const CASES: Case[] = [
  {
    name: 'ERG:LIT, SELL 1 ERG (ERG in, exact input)',
    box: LIT_POOL,
    side: 'SELL',
    base: ERG,
    quote: LIT_REF,
    amount: 10n ** 9n,
  },
  {
    name: 'ERG:LIT, SELL 1000 LIT (LIT in, exact input)',
    box: LIT_POOL,
    side: 'SELL',
    base: LIT_REF,
    quote: ERG,
    amount: 10n ** 12n,
  },
  {
    name: 'ERG:LIT, BUY 1 ERG (LIT in, exact output)',
    box: LIT_POOL,
    side: 'BUY',
    base: ERG,
    quote: LIT_REF,
    amount: 10n ** 9n,
  },
  {
    name: 'ERG:LIT, BUY 1000 LIT (ERG in, exact output)',
    box: LIT_POOL,
    side: 'BUY',
    base: LIT_REF,
    quote: ERG,
    amount: 10n ** 12n,
  },
  {
    name: 'LIT:RSN, SELL 100 LIT (LIT in, exact input)',
    box: LIT_RSN_POOL,
    side: 'SELL',
    base: LIT_REF,
    quote: RSN_REF,
    amount: 10n ** 11n,
  },
  {
    name: 'LIT:RSN, SELL 1 RSN (RSN in, exact input)',
    box: LIT_RSN_POOL,
    side: 'SELL',
    base: RSN_REF,
    quote: LIT_REF,
    amount: 1000n,
  },
  {
    name: 'LIT:RSN, BUY 1 RSN (LIT in, exact output)',
    box: LIT_RSN_POOL,
    side: 'BUY',
    base: RSN_REF,
    quote: LIT_REF,
    amount: 1000n,
  },
  {
    name: 'LIT:RSN, BUY 100 LIT (RSN in, exact output)',
    box: LIT_RSN_POOL,
    side: 'BUY',
    base: LIT_REF,
    quote: RSN_REF,
    amount: 10n ** 11n,
  },
];

describe('LithosDex pool contract proof with the real version-3 signing library, on boxes captured from mainnet', () => {
  it.each(CASES)('$name', async (c) => {
    const venue = dex.venueForTree(c.box.ergoTree)!;
    const pool = venue.parsePool(c.box) as LithosPool;
    const plan = dex.plan({ pool, venue, source: 'confirmed' }, c.base, c.quote, c.side, c.amount);
    const { input, amountIn, amountOut } = plan.swap;
    const paid = plan.tokenIn.tokenId;
    const wallet = walletBox(
      paid === null ? amountIn + 10n ** 8n : 10n ** 8n,
      paid === null ? [] : [{ tokenId: paid, amount: amountIn }],
    );
    const s = pool.lithos;
    const fees = { denom: s.denom, dex: s.dexFee, side: s.sideFee[input] };
    const o = input === 'x' ? 'y' : 'x';

    // the plan's successor is the one written out from the contract text
    expect(plan.successor).toEqual(rawSuccessor(pool, input, amountIn, amountOut));

    const ours = build(venue, pool, plan.successor, wallet);
    expect(ours.unsigned.inputs[0].boxId).toBe(c.box.boxId);
    expect(ours.unsigned.inputs[0].extension).toEqual({ '0': '0200' });
    expect(ours.unsigned.dataInputs).toEqual([]);
    expect(() => verifySwapTransaction(plan, ours)).not.toThrow();
    const results: Record<string, boolean> = { ours: await verdict(ours) };
    expect(results.ours).toBe(true);
    expect(venue.contractAccepts(pool, ours.unsigned.outputs[0], ours.inputBoxes)).toBe(true);

    // One unit more out than the input allows: false. On an exact input that is our output
    // plus one; on an exact output the least input can allow a little more than was asked.
    const maxOut = quoteExactIn(s.kind, pool[input].reserve, pool[o].reserve, amountIn, fees).out;
    if (c.side === 'SELL') expect(maxOut).toBe(amountOut);
    const greedy = build(venue, pool, rawSuccessor(pool, input, amountIn, maxOut + 1n), wallet);
    results.oneMoreThanAllowed = await verdict(greedy);
    expect(results.oneMoreThanAllowed).toBe(false);
    expect(venue.contractAccepts(pool, greedy.unsigned.outputs[0])).toBe(false);
    if (c.side === 'BUY') {
      const atMost = build(venue, pool, rawSuccessor(pool, input, amountIn, maxOut), wallet);
      results.mostAllowed = await verdict(atMost);
      expect(results.mostAllowed).toBe(true);
      const moreOut = build(venue, pool, rawSuccessor(pool, input, amountIn, amountOut + 1n), wallet);
      results.oneMoreOut = await verdict(moreOut);
      expect(results.oneMoreOut).toBe(maxOut >= amountOut + 1n);
    }

    // one unit less in, with its own side fee and accumulator written exactly
    const lessIn = build(venue, pool, rawSuccessor(pool, input, amountIn - 1n, amountOut), wallet);
    const lessInBuys = quoteExactIn(s.kind, pool[input].reserve, pool[o].reserve, amountIn - 1n, fees).out >= amountOut;
    results.oneLessIn = await verdict(lessIn);
    expect(results.oneLessIn).toBe(lessInBuys);
    expect(venue.contractAccepts(pool, lessIn.unsigned.outputs[0])).toBe(lessInBuys);
    if (c.side === 'BUY') expect(lessInBuys).toBe(false); // exact output: our input is the least that buys it

    // a successor register one unit off
    for (const [name, tweak] of [
      ['pendingPlusOne', { pendingIn: 1n }],
      ['pendingMinusOne', { pendingIn: -1n }],
      ['accumulatorPlusOne', { accIn: 1n }],
      ['accumulatorMinusOne', { accIn: -1n }],
    ] as const) {
      const off = build(venue, pool, rawSuccessor(pool, input, amountIn, amountOut, tweak), wallet);
      results[name] = await verdict(off);
      expect(results[name]).toBe(false);
      expect(venue.contractAccepts(pool, off.unsigned.outputs[0])).toBe(false);
    }
    if (LOG) {
      // eslint-disable-next-line no-console
      console.log(`${c.name}: in ${amountIn} out ${amountOut} ${JSON.stringify(results)}`);
    }
  });
});
