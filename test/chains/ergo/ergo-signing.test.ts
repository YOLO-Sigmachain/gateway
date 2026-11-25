/**
 * Build with the real fleet-sdk, sign with the real ergo-lib-wasm-nodejs 0.28.0, against
 * in-test boxes and mainnet headers saved as a fixture. No network.
 */
import { SByte, SColl, SInt, SLong } from '@fleet-sdk/core';
import { Transaction } from 'ergo-lib-wasm-nodejs';

import { assertSignedMatches, Ergo } from '../../../src/chains/ergo/ergo';
import { parseNodeJson } from '../../../src/chains/ergo/ergo.json';
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

  it('a signer that changes an output is caught', () => {
    const tampered = JSON.parse(JSON.stringify(signed.parsed, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
    tampered.outputs[0].value = String(BigInt(tampered.outputs[0].value) - 1n);
    expect(() => assertSignedMatches(built, { ...signed, parsed: tampered })).toThrow(ErgoTransactionAssertionError);
  });
});

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

  it('refuses headers that are not one contiguous chain', async () => {
    const broken = [...HEADERS];
    broken[3] = { ...broken[3], parentId: '00'.repeat(32) };
    await expect(
      signer.signTransaction(built.unsigned, built.unsigned.inputs, [], { headers: broken }),
    ).rejects.toThrow('contiguous');
  });
});
