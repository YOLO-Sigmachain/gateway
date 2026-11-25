/**
 * The shared transaction builder, with the real fleet-sdk. Boxes are made in the test with
 * true box ids. Nothing is mocked.
 */
import { SInt, SLong, SColl, SByte } from '@fleet-sdk/core';

import { ErgoPendingTracker } from '../../../src/chains/ergo/ergo.pending';
import { buildTransfer } from '../../../src/chains/ergo/ergo.transfer';
import {
  assertTransactionBalanced,
  BuiltErgoTransaction,
  buildUnsignedTransaction,
  ErgoBuildError,
  ErgoBuildParams,
  ErgoTransactionAssertionError,
  InsufficientErgoFundsError,
  MAX_TOKENS_PER_CHANGE_BOX,
  minBoxValue,
} from '../../../src/chains/ergo/ergo.tx-builder';
import { ErgoBox } from '../../../src/chains/ergo/ergo.types';

import { ABOVE_2_53, FEE_TREE, GENERATOR_PK, makeBox, MAX_LONG, p2pk, tokenId } from './ergo-test-helpers';

const ME = p2pk(GENERATOR_PK);
const OTHER = p2pk('02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5'); // key of secret 2
const POOL_TREE = '10010400d801d601b2a5730000ea02d193c27201c2a7'; // stand-in contract tree, any bytes do
const HEIGHT = 1924432;
const PER_BYTE = 360n;
const FEE = 1100000n;
const ERG = 1000000000n;

const base = (overrides: Partial<ErgoBuildParams>): ErgoBuildParams => ({
  height: HEIGHT,
  minValuePerByte: PER_BYTE,
  fee: FEE,
  feeErgoTree: FEE_TREE,
  changeErgoTree: ME,
  outputs: [],
  ...overrides,
});

const sumValues = (built: BuiltErgoTransaction) => built.unsigned.outputs.reduce((s, o) => s + BigInt(o.value), 0n);
const tokenTotal = (boxes: Array<{ assets: Array<{ tokenId: string; amount: string | bigint }> }>, id: string) =>
  boxes.reduce((s, b) => s + b.assets.filter((a) => a.tokenId === id).reduce((t, a) => t + BigInt(a.amount), 0n), 0n);

function clone(built: BuiltErgoTransaction): BuiltErgoTransaction {
  return { ...built, unsigned: JSON.parse(JSON.stringify(built.unsigned)) };
}

describe('box selection and change', () => {
  const T1 = tokenId(1);
  const T2 = tokenId(2);
  const wallet: ErgoBox[] = [
    makeBox({ ergoTree: ME, value: 2n * ERG }),
    makeBox({ ergoTree: ME, value: 5n * ERG, assets: [{ tokenId: T1, amount: 1000n }] }),
    makeBox({ ergoTree: ME, value: 1000000n, assets: [{ tokenId: T2, amount: MAX_LONG }] }),
  ];

  it('covers outputs and fee; change meets the minimum and carries every unspent token', () => {
    const built = buildUnsignedTransaction(
      base({
        walletBoxes: wallet,
        outputs: [{ ergoTree: OTHER, value: 3n * ERG, assets: [{ tokenId: T1, amount: 400n }] }],
      }),
    );
    const outs = built.unsigned.outputs;
    // outputs: [recipient, change..., fee]
    expect(outs[0].ergoTree).toBe(OTHER);
    expect(outs[outs.length - 1].ergoTree).toBe(FEE_TREE);
    const change = built.changeOutputIndexes.map((i) => outs[i]);
    expect(change.length).toBe(1);
    expect(tokenTotal(change, T1)).toBe(600n);
    const ins = built.inputBoxes;
    expect(sumValues(built)).toBe(ins.reduce((s, b) => s + b.value, 0n));
    for (const c of change) {
      const min = minBoxValue(
        {
          ergoTree: c.ergoTree,
          value: BigInt(c.value),
          assets: c.assets.map((a) => ({ tokenId: a.tokenId, amount: BigInt(a.amount) })),
          additionalRegisters: {},
          creationHeight: c.creationHeight,
        },
        PER_BYTE,
      );
      expect(BigInt(c.value)).toBeGreaterThanOrEqual(min);
    }
  });

  it('a token held only in a selected box is carried to change at 2^63-1 exactly', () => {
    // 2 + 5 ERG fall 0.0001 ERG short of 6.999 ERG plus fee, so the small box holding T2 is taken
    const built = buildUnsignedTransaction(
      base({ walletBoxes: wallet, outputs: [{ ergoTree: OTHER, value: 6999000000n }] }),
    );
    const change = built.changeOutputIndexes.map((i) => built.unsigned.outputs[i]);
    expect(tokenTotal(built.inputBoxes, T2)).toBe(MAX_LONG);
    expect(tokenTotal(change, T2)).toBe(MAX_LONG);
  });

  it('adds inputs until change reaches the minimum box value, instead of leaving dust', () => {
    const boxes = [makeBox({ ergoTree: ME, value: ERG + FEE + 1000n }), makeBox({ ergoTree: ME, value: ERG })];
    const built = buildUnsignedTransaction(base({ walletBoxes: boxes, outputs: [{ ergoTree: OTHER, value: ERG }] }));
    expect(built.inputBoxes.length).toBe(2);
    const change = built.unsigned.outputs[built.changeOutputIndexes[0]];
    expect(BigInt(change.value)).toBe(ERG + 1000n);
  });

  it('refuses when change would be below the minimum and no box is left', () => {
    const boxes = [makeBox({ ergoTree: ME, value: ERG + FEE + 1000n })];
    expect(() =>
      buildUnsignedTransaction(base({ walletBoxes: boxes, outputs: [{ ergoTree: OTHER, value: ERG }] })),
    ).toThrow(InsufficientErgoFundsError);
  });

  it('spends exactly with no change box when nothing is left over', () => {
    const boxes = [makeBox({ ergoTree: ME, value: ERG + FEE })];
    const built = buildUnsignedTransaction(base({ walletBoxes: boxes, outputs: [{ ergoTree: OTHER, value: ERG }] }));
    expect(built.changeOutputIndexes).toEqual([]);
    expect(built.unsigned.outputs.length).toBe(2);
  });

  it('refuses when a token is short, naming it', () => {
    expect(() =>
      buildUnsignedTransaction(
        base({
          walletBoxes: wallet,
          outputs: [{ ergoTree: OTHER, value: ERG, assets: [{ tokenId: T1, amount: 1001n }] }],
        }),
      ),
    ).toThrow(`token ${T1}`);
  });

  it('splits more than one box worth of change tokens into several change boxes', () => {
    const n = MAX_TOKENS_PER_CHANGE_BOX + 3;
    const many = Array.from({ length: n }, (_, i) => ({ tokenId: tokenId(i + 10), amount: BigInt(i + 1) }));
    const boxes = [makeBox({ ergoTree: ME, value: 10n * ERG, assets: many })];
    const built = buildUnsignedTransaction(base({ walletBoxes: boxes, outputs: [{ ergoTree: OTHER, value: ERG }] }));
    expect(built.changeOutputIndexes.length).toBe(2);
    const change = built.changeOutputIndexes.map((i) => built.unsigned.outputs[i]);
    for (const t of many) expect(tokenTotal(change, t.tokenId)).toBe(t.amount);
  });

  it('prefers confirmed boxes and uses unconfirmed ones only when needed', () => {
    const confirmed = makeBox({ ergoTree: ME, value: 3n * ERG });
    const unconfirmed = makeBox({ ergoTree: ME, value: 9n * ERG, inclusionHeight: null });
    const built = buildUnsignedTransaction(
      base({ walletBoxes: [unconfirmed, confirmed], outputs: [{ ergoTree: OTHER, value: ERG }] }),
    );
    expect(built.inputBoxes.map((b) => b.boxId)).toEqual([confirmed.boxId]);
  });

  it('refuses a wallet box whose id does not match its content', () => {
    const box = makeBox({ ergoTree: ME, value: 3n * ERG });
    const tampered = { ...box, value: box.value + 1n };
    expect(() =>
      buildUnsignedTransaction(base({ walletBoxes: [tampered], outputs: [{ ergoTree: OTHER, value: ERG }] })),
    ).toThrow('box id does not match');
  });
});

describe('pending boxes and chained spends (T-5)', () => {
  it('two builds in a row do not pick the same boxes', () => {
    const tracker = new ErgoPendingTracker(60_000);
    const boxes = [makeBox({ ergoTree: ME, value: 2n * ERG }), makeBox({ ergoTree: ME, value: 2n * ERG })];
    const first = buildUnsignedTransaction(
      base({
        walletBoxes: tracker.available(boxes, ME),
        outputs: [{ ergoTree: OTHER, value: ERG }],
        excludeBoxIds: tracker.spentBoxIds(),
      }),
    );
    tracker.record(
      'aa'.repeat(32),
      first.inputBoxes.map((b) => b.boxId),
      [],
    );
    // the node still lists both boxes: the first transaction is not indexed yet
    const second = buildUnsignedTransaction(
      base({
        walletBoxes: tracker.available(boxes, ME),
        outputs: [{ ergoTree: OTHER, value: ERG }],
        excludeBoxIds: tracker.spentBoxIds(),
      }),
    );
    const firstIds = new Set(first.inputBoxes.map((b) => b.boxId));
    expect(second.inputBoxes.some((b) => firstIds.has(b.boxId))).toBe(false);
  });

  it('spends the unconfirmed change of our own previous transaction', () => {
    const tracker = new ErgoPendingTracker(60_000);
    const funding = makeBox({ ergoTree: ME, value: 5n * ERG, assets: [{ tokenId: tokenId(7), amount: ABOVE_2_53 }] });
    const first = buildUnsignedTransaction(
      base({ walletBoxes: [funding], outputs: [{ ergoTree: OTHER, value: ERG }] }),
    );
    const firstTxId = 'bb'.repeat(32);
    // outputs of the first transaction, as boxes with their real ids
    const firstOutputs = first.unsigned.outputs.map((o, index) =>
      makeBox({
        ergoTree: o.ergoTree,
        value: BigInt(o.value),
        assets: o.assets.map((a) => ({ tokenId: a.tokenId, amount: BigInt(a.amount) })),
        creationHeight: o.creationHeight,
        transactionId: firstTxId,
        index,
        inclusionHeight: null,
      }),
    );
    tracker.record(
      firstTxId,
      first.inputBoxes.map((b) => b.boxId),
      firstOutputs,
    );

    // The node still shows the funding box as unspent and does not list the change yet.
    const available = tracker.available([funding], ME);
    expect(available.map((b) => b.boxId)).toEqual([firstOutputs[first.changeOutputIndexes[0]].boxId]);

    const second = buildUnsignedTransaction(
      base({
        walletBoxes: available,
        outputs: [{ ergoTree: OTHER, value: ERG }],
        excludeBoxIds: tracker.spentBoxIds(),
      }),
    );
    expect(second.inputBoxes[0].transactionId).toBe(firstTxId);
    const change = second.changeOutputIndexes.map((i) => second.unsigned.outputs[i]);
    expect(tokenTotal(change, tokenId(7))).toBe(ABOVE_2_53);
  });

  it('a released or timed-out transaction frees its boxes', () => {
    let now = 0;
    const tracker = new ErgoPendingTracker(1000, () => now);
    const box = makeBox({ ergoTree: ME, value: ERG });
    tracker.record('cc'.repeat(32), [box.boxId], []);
    expect(tracker.available([box], ME)).toEqual([]);
    now = 2000;
    expect(tracker.available([box], ME).map((b) => b.boxId)).toEqual([box.boxId]);
    tracker.record('dd'.repeat(32), [box.boxId], []);
    tracker.release('dd'.repeat(32));
    expect(tracker.isSpent(box.boxId)).toBe(false);
  });
});

describe('caller-fixed structure for venue connectors', () => {
  const pool = makeBox({
    ergoTree: POOL_TREE,
    value: 100n * ERG,
    assets: [
      { tokenId: tokenId(0xa1), amount: 1n },
      { tokenId: tokenId(0xa2), amount: MAX_LONG - 5n },
    ],
    registers: { R4: SInt(997).toHex() },
  });
  const oracle = makeBox({ ergoTree: POOL_TREE, value: ERG, registers: { R4: SLong(123456789n).toHex() } });
  const wallet = [makeBox({ ergoTree: ME, value: 10n * ERG }), makeBox({ ergoTree: ME, value: 3n * ERG })];
  const registers = {
    R4: SInt(997).toHex(),
    R5: SColl(SLong, [9985n, 15n, 15n]).toHex(),
    R6: SColl(SByte, [1, 2, 3]).toHex(),
  };

  const built = buildUnsignedTransaction(
    base({
      inputs: [{ box: pool, extension: { 0: SByte(0).toHex(), 3: SInt(7).toHex() } }],
      walletBoxes: wallet,
      dataInputs: [oracle],
      outputs: [
        {
          ergoTree: POOL_TREE,
          value: 101n * ERG,
          assets: [
            { tokenId: tokenId(0xa1), amount: 1n },
            { tokenId: tokenId(0xa2), amount: MAX_LONG - 1000n },
          ],
          additionalRegisters: registers,
        },
        { ergoTree: OTHER, value: ERG, assets: [{ tokenId: tokenId(0xa2), amount: 995n }] },
      ],
    }),
  );

  it('keeps the fixed input at index 0 with its context variables', () => {
    expect(built.unsigned.inputs[0].boxId).toBe(pool.boxId);
    expect(built.unsigned.inputs[0].extension).toEqual({ '0': SByte(0).toHex(), '3': SInt(7).toHex() });
    for (const input of built.unsigned.inputs.slice(1)) expect(input.extension).toEqual({});
  });

  it('keeps data inputs, read and not spent', () => {
    expect(built.unsigned.dataInputs.map((d) => d.boxId)).toEqual([oracle.boxId]);
    expect(built.unsigned.inputs.map((i) => i.boxId)).not.toContain(oracle.boxId);
  });

  it('keeps the caller outputs first, in order, registers byte for byte', () => {
    expect(built.unsigned.outputs[0].ergoTree).toBe(POOL_TREE);
    expect(built.unsigned.outputs[0].additionalRegisters).toEqual(registers);
    expect(built.unsigned.outputs[1].ergoTree).toBe(OTHER);
    expect(built.unsigned.outputs[0].assets.map((a) => a.tokenId)).toEqual([tokenId(0xa1), tokenId(0xa2)]);
  });

  it('balances the pool token across the successor, the trader and change', () => {
    const all = built.unsigned.outputs;
    expect(tokenTotal(all, tokenId(0xa2))).toBe(MAX_LONG - 5n);
  });

  it('refuses a data input that is also spent', () => {
    expect(() =>
      buildUnsignedTransaction(
        base({
          inputs: [{ box: pool }],
          dataInputs: [pool],
          walletBoxes: wallet,
          outputs: [{ ergoTree: OTHER, value: ERG }],
        }),
      ),
    ).toThrow(ErgoBuildError);
  });

  it('refuses registers with a gap', () => {
    expect(() =>
      buildUnsignedTransaction(
        base({
          walletBoxes: wallet,
          outputs: [{ ergoTree: OTHER, value: ERG, additionalRegisters: { R5: SInt(1).toHex() } }],
        }),
      ),
    ).toThrow('no gap');
  });
});

describe('fee box and creation heights', () => {
  it('the fee box is last, holds exactly the fee and no token, even when every input holds tokens', () => {
    const boxes = [makeBox({ ergoTree: ME, value: 3n * ERG, assets: [{ tokenId: tokenId(5), amount: 10n }] })];
    const built = buildUnsignedTransaction(base({ walletBoxes: boxes, outputs: [{ ergoTree: OTHER, value: ERG }] }));
    const fee = built.unsigned.outputs[built.unsigned.outputs.length - 1];
    expect(fee.ergoTree).toBe(FEE_TREE);
    expect(BigInt(fee.value)).toBe(FEE);
    expect(fee.assets).toEqual([]);
    expect(fee.additionalRegisters).toEqual({});
    expect(built.unsigned.outputs.filter((o) => o.ergoTree === FEE_TREE).length).toBe(1);
  });

  it('refuses a caller output to the fee contract', () => {
    const boxes = [makeBox({ ergoTree: ME, value: 3n * ERG, assets: [{ tokenId: tokenId(5), amount: 10n }] })];
    expect(() =>
      buildUnsignedTransaction(
        base({
          walletBoxes: boxes,
          outputs: [{ ergoTree: FEE_TREE, value: ERG, assets: [{ tokenId: tokenId(5), amount: 1n }] }],
        }),
      ),
    ).toThrow('fee box is added by the builder');
  });

  it('outputs take the build height, or the highest input height if that is later', () => {
    const old = makeBox({ ergoTree: ME, value: 3n * ERG, creationHeight: 10 });
    const built = buildUnsignedTransaction(base({ walletBoxes: [old], outputs: [{ ergoTree: OTHER, value: ERG }] }));
    expect(built.unsigned.outputs.every((o) => o.creationHeight === HEIGHT)).toBe(true);

    // a mempool box created for the next block (seen on mainnet)
    const ahead = makeBox({ ergoTree: ME, value: 3n * ERG, creationHeight: HEIGHT + 1, inclusionHeight: null });
    const built2 = buildUnsignedTransaction(base({ walletBoxes: [ahead], outputs: [{ ergoTree: OTHER, value: ERG }] }));
    expect(built2.unsigned.outputs.every((o) => o.creationHeight === HEIGHT + 1)).toBe(true);
  });

  it('keeps a caller creation height at or above the input height and refuses one below', () => {
    const box = makeBox({ ergoTree: ME, value: 3n * ERG, creationHeight: HEIGHT - 3 });
    const built = buildUnsignedTransaction(
      base({ walletBoxes: [box], outputs: [{ ergoTree: OTHER, value: ERG, creationHeight: HEIGHT - 2 }] }),
    );
    expect(built.unsigned.outputs[0].creationHeight).toBe(HEIGHT - 2);
    expect(() =>
      buildUnsignedTransaction(
        base({ walletBoxes: [box], outputs: [{ ergoTree: OTHER, value: ERG, creationHeight: HEIGHT - 4 }] }),
      ),
    ).toThrow('below the highest input creation height');
  });
});

describe('conservation assertion before signing', () => {
  const T = tokenId(9);
  const boxes = [makeBox({ ergoTree: ME, value: 5n * ERG, assets: [{ tokenId: T, amount: MAX_LONG }] })];
  const good = buildUnsignedTransaction(
    base({
      walletBoxes: boxes,
      outputs: [{ ergoTree: OTHER, value: ERG, assets: [{ tokenId: T, amount: ABOVE_2_53 }] }],
    }),
  );
  const changeIndex = good.changeOutputIndexes[0];

  it('passes a balanced transaction', () => {
    expect(() => assertTransactionBalanced(good)).not.toThrow();
  });

  it('refuses a change box short by one token unit (the D7 burn)', () => {
    const bad = clone(good);
    const asset = bad.unsigned.outputs[changeIndex].assets[0];
    asset.amount = (BigInt(asset.amount) - 1n).toString();
    expect(() => assertTransactionBalanced(bad)).toThrow(ErgoTransactionAssertionError);
    expect(() => assertTransactionBalanced(bad)).toThrow(`token ${T}`);
  });

  it('refuses ERG that does not balance', () => {
    const bad = clone(good);
    bad.unsigned.outputs[changeIndex].value = (BigInt(bad.unsigned.outputs[changeIndex].value) - 1n).toString();
    expect(() => assertTransactionBalanced(bad)).toThrow('ERG in');
  });

  it('refuses a fee box that holds tokens (T-16)', () => {
    const bad = clone(good);
    const feeBox = bad.unsigned.outputs[bad.unsigned.outputs.length - 1];
    const moved = bad.unsigned.outputs[changeIndex].assets[0];
    feeBox.assets = [{ tokenId: moved.tokenId, amount: '1' }];
    moved.amount = (BigInt(moved.amount) - 1n).toString();
    expect(() => assertTransactionBalanced(bad)).toThrow('fee box holds tokens');
  });

  it('refuses a fee box that is not the declared fee', () => {
    const bad = clone(good);
    const feeBox = bad.unsigned.outputs[bad.unsigned.outputs.length - 1];
    feeBox.value = (BigInt(feeBox.value) + 1000n).toString();
    bad.unsigned.outputs[changeIndex].value = (BigInt(bad.unsigned.outputs[changeIndex].value) - 1000n).toString();
    expect(() => assertTransactionBalanced(bad)).toThrow('fee box holds');
  });

  it('refuses an input that is not the box read from the node', () => {
    const bad = clone(good);
    bad.unsigned.inputs[0].value = (BigInt(bad.unsigned.inputs[0].value) + 1n).toString();
    expect(() => assertTransactionBalanced(bad)).toThrow('input 0');
  });

  it('refuses an undeclared burn, and passes a declared one', () => {
    const burnt = buildUnsignedTransaction(
      base({ walletBoxes: boxes, outputs: [{ ergoTree: OTHER, value: ERG }], burn: [{ tokenId: T, amount: 5n }] }),
    );
    expect(() => assertTransactionBalanced(burnt)).not.toThrow();
    expect(tokenTotal(burnt.unsigned.outputs, T)).toBe(MAX_LONG - 5n);
    const undeclared = { ...burnt, burn: [] };
    expect(() => assertTransactionBalanced(undeclared)).toThrow(`token ${T}`);
  });

  it('passes a declared mint of the first input id and refuses an undeclared one', () => {
    const first = makeBox({ ergoTree: ME, value: 5n * ERG });
    const minted = buildUnsignedTransaction(
      base({
        inputs: [{ box: first }],
        outputs: [{ ergoTree: OTHER, value: ERG, assets: [{ tokenId: first.boxId, amount: 1000n }] }],
        mint: { tokenId: first.boxId, amount: 1000n },
      }),
    );
    expect(() => assertTransactionBalanced(minted)).not.toThrow();
    expect(() => assertTransactionBalanced({ ...minted, mint: undefined })).toThrow(`token ${first.boxId}`);
    expect(() =>
      buildUnsignedTransaction(
        base({
          walletBoxes: [first],
          outputs: [{ ergoTree: OTHER, value: ERG, assets: [{ tokenId: tokenId(0x77), amount: 1n }] }],
          mint: { tokenId: tokenId(0x77), amount: 1n },
        }),
      ),
    ).toThrow("first input's box id");
  });

  it('refuses an output below the minimum box value', () => {
    const tiny = [makeBox({ ergoTree: ME, value: 5n * ERG })];
    expect(() =>
      buildUnsignedTransaction(base({ walletBoxes: tiny, outputs: [{ ergoTree: OTHER, value: 1000n }] })),
    ).toThrow('below the minimum box value');
  });
});

describe('plain transfer', () => {
  it('sends ERG and tokens; a token-only transfer carries the minimum box value', () => {
    const T = tokenId(4);
    const boxes = [makeBox({ ergoTree: ME, value: 2n * ERG, assets: [{ tokenId: T, amount: 50n }] })];
    const built = buildTransfer({
      height: HEIGHT,
      minValuePerByte: PER_BYTE,
      fee: FEE,
      feeErgoTree: FEE_TREE,
      fromErgoTree: ME,
      toErgoTree: OTHER,
      tokens: [{ tokenId: T, amount: 20n }],
      walletBoxes: boxes,
    });
    const out = built.unsigned.outputs[0];
    expect(out.ergoTree).toBe(OTHER);
    expect(out.assets).toEqual([{ tokenId: T, amount: '20' }]);
    expect(BigInt(out.value)).toBe(
      minBoxValue(
        {
          ergoTree: OTHER,
          value: BigInt(out.value),
          assets: [{ tokenId: T, amount: 20n }],
          additionalRegisters: {},
          creationHeight: HEIGHT,
        },
        PER_BYTE,
      ),
    );
    expect(
      tokenTotal(
        built.changeOutputIndexes.map((i) => built.unsigned.outputs[i]),
        T,
      ),
    ).toBe(30n);
  });

  it('refuses a transfer of nothing', () => {
    expect(() =>
      buildTransfer({
        height: HEIGHT,
        minValuePerByte: PER_BYTE,
        fee: FEE,
        feeErgoTree: FEE_TREE,
        fromErgoTree: ME,
        toErgoTree: OTHER,
        walletBoxes: [],
      }),
    ).toThrow('ERG or tokens');
  });
});
