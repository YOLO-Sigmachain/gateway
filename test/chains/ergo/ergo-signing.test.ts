/**
 * Build with the real fleet-sdk, sign with the real ergo-lib-wasm-nodejs 0.28.0, against
 * in-test boxes and mainnet headers saved as a fixture. No network.
 */
import { SByte, SColl, SInt, SLong } from '@fleet-sdk/core';
import { Transaction } from 'ergo-lib-wasm-nodejs';

import { assertSignedMatches, Ergo } from '../../../src/chains/ergo/ergo';
import { parseNodeJson, stringifyWithBigInt } from '../../../src/chains/ergo/ergo.json';
import { ErgoSigner, SignedErgoTransaction, WasmErgoSigner } from '../../../src/chains/ergo/ergo.signer';
import { buildTransfer } from '../../../src/chains/ergo/ergo.transfer';
import { buildUnsignedTransaction, ErgoTransactionAssertionError } from '../../../src/chains/ergo/ergo.tx-builder';

import {
  ABOVE_2_53,
  fakeNode,
  FEE_TREE,
  HEADERS,
  MAX_LONG,
  makeBox,
  MNEMONIC_A,
  p2pk,
  testConfig,
  TIP,
  tokenId,
} from './ergo-test-helpers';

const signer = WasmErgoSigner.fromMnemonic(MNEMONIC_A);
const ME = p2pk(signer.publicKeys[0]);
const OTHER = p2pk('02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5');
const ERG = 1000000000n;
const FEE = 1100000n;
const PER_BYTE = 360n;
const T = tokenId(0x42);

const walletBoxes = [
  makeBox({ ergoTree: ME, value: 3n * ERG, creationHeight: TIP - 20, assets: [{ tokenId: T, amount: MAX_LONG }] }),
  makeBox({ ergoTree: ME, value: 2n * ERG, creationHeight: TIP - 5 }),
];

describe('sign a transfer with the real wasm signer', () => {
  const built = buildTransfer({
    height: TIP,
    minValuePerByte: PER_BYTE,
    fee: FEE,
    feeErgoTree: FEE_TREE,
    fromErgoTree: ME,
    toErgoTree: OTHER,
    nanoErgs: 1500000000n,
    tokens: [{ tokenId: T, amount: ABOVE_2_53 }],
    walletBoxes,
  });
  let signed: SignedErgoTransaction;

  beforeAll(async () => {
    signed = await signer.signTransaction(built.unsigned, built.unsigned.inputs, built.unsigned.dataInputs, {
      headers: HEADERS,
    });
  });

  it('spends exactly the selected boxes, each with a proof', () => {
    expect(signed.parsed.inputs.map((i) => i.boxId)).toEqual(built.inputBoxes.map((b) => b.boxId));
    for (const input of signed.parsed.inputs) {
      expect(input.spendingProof.proofBytes.length).toBeGreaterThan(0);
    }
  });

  it('creates the built outputs with exact amounts, including 2^53+1 and 2^63-1 token amounts', () => {
    const outputs = signed.parsed.outputs as Array<{
      value: bigint | number;
      ergoTree: string;
      assets: Array<{ tokenId: string; amount: bigint | number }>;
    }>;
    expect(outputs.length).toBe(built.unsigned.outputs.length);
    expect(outputs[0].ergoTree).toBe(OTHER);
    expect(BigInt(outputs[0].value)).toBe(1500000000n);
    expect(BigInt(outputs[0].assets[0].amount)).toBe(ABOVE_2_53);
    const change = outputs[built.changeOutputIndexes[0]];
    expect(BigInt(change.assets[0].amount)).toBe(MAX_LONG - ABOVE_2_53);
    const fee = outputs[outputs.length - 1];
    expect(fee.ergoTree).toBe(FEE_TREE);
    expect(BigInt(fee.value)).toBe(FEE);
    expect(fee.assets).toEqual([]);
    const ergIn = walletBoxes
      .filter((b) => built.inputBoxes.some((i) => i.boxId === b.boxId))
      .reduce((s, b) => s + b.value, 0n);
    expect(outputs.reduce((s, o) => s + BigInt(o.value), 0n)).toBe(ergIn);
  });

  it('the JSON parses back as the same transaction in ergo-lib', () => {
    const again = Transaction.from_json(signed.json);
    expect(again.id().to_str()).toBe(signed.id);
    expect(parseNodeJson<{ id: string }>(signed.json).id).toBe(signed.id);
  });

  it('matches what the conservation check passed', () => {
    expect(() => assertSignedMatches(built, signed)).not.toThrow();
  });

  it('a signer that changes an output in the JSON it submits is caught', () => {
    const tampered = rewriteJson(signed, (tx) => {
      tx.outputs[0].value = BigInt(tx.outputs[0].value) - 1n;
    });
    expect(() => assertSignedMatches(built, { ...signed, json: tampered })).toThrow(ErgoTransactionAssertionError);
  });

  it('checks the JSON that is submitted, not the parsed copy beside it', () => {
    // the parsed copy is untouched; only the submitted bytes say 1 nanoERG
    const tampered = rewriteJson(signed, (tx) => {
      tx.outputs[0].value = 1;
    });
    expect(tampered).not.toBe(signed.json);
    expect(() => assertSignedMatches(built, { ...signed, json: tampered })).toThrow('output 0 value');
  });

  it('an input with no context extension matches one whose extension is left out or {}', () => {
    const missing = rewriteJson(signed, (tx) => {
      delete tx.inputs[0].spendingProof.extension;
    });
    expect(() => assertSignedMatches(built, { ...signed, json: missing })).not.toThrow();
  });
});

/** The signer's JSON, parsed bigint-safe, changed, and written back as node JSON. */
function rewriteJson(signed: SignedErgoTransaction, change: (tx: any) => void): string {
  const tx = parseNodeJson<any>(signed.json);
  change(tx);
  return stringifyWithBigInt(tx);
}

describe('context variables, data inputs and registers survive signing', () => {
  const fixed = makeBox({ ergoTree: ME, value: 4n * ERG, creationHeight: TIP - 2 });
  const oracle = makeBox({
    ergoTree: OTHER,
    value: ERG,
    creationHeight: TIP - 100,
    registers: { R4: SLong(1234567890123n).toHex() },
  });
  const registers = {
    R4: SInt(997).toHex(),
    R5: SColl(SLong, [9985n, 15n, 15n]).toHex(),
    R6: SColl(SByte, [0xde, 0xad]).toHex(),
  };
  const built = buildUnsignedTransaction({
    height: TIP,
    minValuePerByte: PER_BYTE,
    fee: FEE,
    feeErgoTree: FEE_TREE,
    changeErgoTree: ME,
    inputs: [{ box: fixed, extension: { 0: SByte(0).toHex(), 1: SInt(1).toHex() } }],
    walletBoxes: [walletBoxes[1]],
    dataInputs: [oracle],
    outputs: [{ ergoTree: OTHER, value: ERG, additionalRegisters: registers }],
  });
  let signed: SignedErgoTransaction;

  beforeAll(async () => {
    signed = await signer.signTransaction(built.unsigned, built.unsigned.inputs, built.unsigned.dataInputs, {
      headers: HEADERS,
    });
  });

  it('keeps input 0 and its context extension in the spending proof', () => {
    expect(signed.parsed.inputs[0].boxId).toBe(fixed.boxId);
    expect(signed.parsed.inputs[0].spendingProof.extension).toEqual({ '0': SByte(0).toHex(), '1': SInt(1).toHex() });
  });

  it('keeps the data input', () => {
    expect(signed.parsed.dataInputs.map((d) => d.boxId)).toEqual([oracle.boxId]);
  });

  it('keeps the registers byte for byte', () => {
    expect((signed.parsed.outputs[0] as { additionalRegisters: unknown }).additionalRegisters).toEqual(registers);
    expect(() => assertSignedMatches(built, signed)).not.toThrow();
  });

  it('refuses a signed transaction whose context extension differs from the checked one', () => {
    const changed = rewriteJson(signed, (tx) => {
      tx.inputs[0].spendingProof.extension = { '0': SByte(1).toHex(), '1': SInt(1).toHex() };
    });
    expect(() => assertSignedMatches(built, { ...signed, json: changed })).toThrow('input 0 context variable 0');
    const added = rewriteJson(signed, (tx) => {
      tx.inputs[0].spendingProof.extension = { ...tx.inputs[0].spendingProof.extension, '7': '0400' };
    });
    expect(() => assertSignedMatches(built, { ...signed, json: added })).toThrow('input 0 context variable 7');
    const dropped = rewriteJson(signed, (tx) => {
      tx.inputs[0].spendingProof.extension = {};
    });
    expect(() => assertSignedMatches(built, { ...signed, json: dropped })).toThrow(ErgoTransactionAssertionError);
  });
});

describe('the signing context is the upcoming block, as the node checks it', () => {
  // sigmaProp(HEIGHT <op> c), a constant-segregated v0 tree
  const heightTree = (op: string, c: number) => `1001${SInt(c).toHex()}d1${op}a37300`;
  const OP = { LE: '90', GT: '91', GE: '92', EQ: '93' };

  async function trySign(tree: string): Promise<{ ok: boolean; err?: string }> {
    const box = makeBox({ ergoTree: tree, value: 2n * ERG, creationHeight: TIP - 10 });
    const built = buildUnsignedTransaction({
      height: TIP,
      minValuePerByte: PER_BYTE,
      fee: FEE,
      feeErgoTree: FEE_TREE,
      changeErgoTree: ME,
      inputs: [{ box }],
      walletBoxes: [],
      outputs: [{ ergoTree: ME, value: ERG }],
    });
    try {
      await signer.signTransaction(built.unsigned, built.unsigned.inputs, built.unsigned.dataInputs, {
        headers: HEADERS,
      });
      return { ok: true };
    } catch (e) {
      return { ok: false, err: (e as Error).message };
    }
  }

  it('HEIGHT is tip + 1: a timelock opening next block signs, a deadline at the tip does not', async () => {
    expect((await trySign(heightTree(OP.EQ, TIP + 1))).ok).toBe(true);
    expect((await trySign(heightTree(OP.GT, TIP))).ok).toBe(true);
    expect((await trySign(heightTree(OP.GE, TIP + 1))).ok).toBe(true);
    expect((await trySign(heightTree(OP.EQ, TIP))).ok).toBe(false);
    const deadline = await trySign(heightTree(OP.LE, TIP));
    expect(deadline.ok).toBe(false);
    expect(deadline.err).toContain('Signing failed');
  });
});

describe('Ergo.signTransaction runs the check before the signer', () => {
  const node = fakeNode((method, urlPath) =>
    method === 'GET' && urlPath === '/blocks/lastHeaders/10' ? { body: HEADERS } : undefined,
  );
  const ergo = new Ergo('mainnet', { config: testConfig(), fetch: node.fetch });
  const built = buildTransfer({
    height: TIP,
    minValuePerByte: PER_BYTE,
    fee: FEE,
    feeErgoTree: FEE_TREE,
    fromErgoTree: ME,
    toErgoTree: OTHER,
    nanoErgs: ERG,
    walletBoxes,
  });

  it('signs a balanced transaction', async () => {
    const result = await ergo.signTransaction(built, signer);
    expect(result.parsed.inputs.length).toBe(built.inputBoxes.length);
  });

  it('refuses an unbalanced one without calling the signer', async () => {
    const bad = { ...built, unsigned: JSON.parse(JSON.stringify(built.unsigned)) };
    const change = bad.unsigned.outputs[bad.changeOutputIndexes[0]];
    change.value = (BigInt(change.value) - 1n).toString();
    const spy: ErgoSigner = { publicKeys: [], signTransaction: jest.fn() };
    await expect(ergo.signTransaction(bad, spy)).rejects.toThrow(ErgoTransactionAssertionError);
    expect(spy.signTransaction).not.toHaveBeenCalled();
  });

  it("refuses a transaction whose change goes to a tree that is not the signer's, without calling it", async () => {
    const elsewhere = buildTransfer({
      height: TIP,
      minValuePerByte: PER_BYTE,
      fee: FEE,
      feeErgoTree: FEE_TREE,
      fromErgoTree: OTHER,
      toErgoTree: ME,
      nanoErgs: ERG,
      walletBoxes: [makeBox({ ergoTree: OTHER, value: 3n * ERG, creationHeight: TIP - 5 })],
    });
    const spy: ErgoSigner = { publicKeys: signer.publicKeys, signTransaction: jest.fn() };
    await expect(ergo.signTransaction(elsewhere, spy)).rejects.toThrow("not the signer's address");
    expect(spy.signTransaction).not.toHaveBeenCalled();
  });

  it('refuses headers that are not one contiguous chain', async () => {
    const broken = [...HEADERS];
    broken[3] = { ...broken[3], parentId: '00'.repeat(32) };
    await expect(
      signer.signTransaction(built.unsigned, built.unsigned.inputs, [], { headers: broken }),
    ).rejects.toThrow('contiguous');
  });
});
