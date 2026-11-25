/**
 * The proof that our formula matches the deployed pool contracts: for each pool box
 * captured from mainnet, build a direct swap in both directions with the real builder
 * (fleet-sdk) and have the real ergo-lib-wasm 0.28.0 reduce and sign it. The pool script
 * reduces to true for our swap (signing succeeds, with an empty proof for the pool input)
 * and to false for the same swap asking one unit more (signing refuses it).
 */
import { buildUnsignedTransaction, ErgoOutputSpec } from '../../../src/chains/ergo/ergo.tx-builder';
import { ErgoBox } from '../../../src/chains/ergo/ergo.types';
import { Ergodex, TokenRef } from '../../../src/connectors/ergodex/ergodex';
import { FEE_TREE } from '../../chains/ergo/ergo-test-helpers';

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

  it.each(CASES.filter((_, i) => i % 2 === 0))(
    '$name, exact output: the minimal input passes, one unit less fails',
    async (c) => {
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
    },
  );
});
