/**
 * The second signing library (the alpha build that reads ErgoTree version 3) is loaded
 * only when a transaction spends a box at a version-3 tree. A Spectrum swap, and a
 * transfer, sign on 0.28.0 without loading it; the first LithosDex swap loads it once.
 */
import { Ergo, ergoTreeVersion, spendsTreeVersion3 } from '../../../src/chains/ergo/ergo';
import { ErgoSigningError, WasmErgoSigner } from '../../../src/chains/ergo/ergo.signer';
import { buildUnsignedTransaction } from '../../../src/chains/ergo/ergo.tx-builder';
import { Ergodex, TokenRef } from '../../../src/connectors/ergodex/ergodex';
import { FEE_TREE, testConfig } from '../../chains/ergo/ergo-test-helpers';

import { ERG, ME_TREE, MNEMONIC_A, newNodeState, RSN, RSN_POOL, signer, walletBox } from './ergodex-test-helpers';
import { L_TIP, LIT, LIT_POOL, LIT_VAULT, lithosNode, makeLithosDex, putPools } from './lithos-test-helpers';

let mockAlphaLoads = 0;
jest.mock('ergo-lib-wasm-nodejs-alpha', () => {
  mockAlphaLoads += 1;
  return jest.requireActual('ergo-lib-wasm-nodejs-alpha');
});

const ERG_REF: TokenRef = { tokenId: null, symbol: 'ERG', decimals: 9 };
const LIT_REF: TokenRef = { tokenId: LIT, symbol: 'LIT', decimals: 9 };
const RSN_REF: TokenRef = { tokenId: RSN, symbol: 'RSN', decimals: 3 };

function swapBuilt(dex: Ergodex, box: typeof RSN_POOL, quote: TokenRef) {
  const venue = dex.venueForTree(box.ergoTree)!;
  const pool = venue.parsePool(box)!;
  const plan = dex.plan({ pool, venue, source: 'confirmed' }, ERG_REF, quote, 'SELL', ERG);
  return buildUnsignedTransaction({
    height: L_TIP,
    minValuePerByte: 360n,
    fee: 1100000n,
    feeErgoTree: FEE_TREE,
    changeErgoTree: ME_TREE,
    inputs: [{ box, extension: venue.swapInputExtension?.(pool) }],
    walletBoxes: [walletBox(5n * ERG)],
    outputs: [plan.successor],
  });
}

describe('loading the version-3 signing library', () => {
  const state = newNodeState();
  putPools(state, [[LIT_POOL, LIT_VAULT]]);
  const dex = makeLithosDex(state);
  const ergo = new Ergo('mainnet', { config: testConfig(), fetch: lithosNode(state) });

  it('tree versions are read from the header byte', () => {
    expect(ergoTreeVersion(RSN_POOL.ergoTree)).toBe(1);
    expect(ergoTreeVersion(ME_TREE)).toBe(0);
    expect(ergoTreeVersion(LIT_POOL.ergoTree)).toBe(3);
  });

  it('a Spectrum swap and a plain transfer sign on 0.28.0 without loading it', async () => {
    const spectrum = swapBuilt(dex, RSN_POOL, RSN_REF);
    expect(spendsTreeVersion3(spectrum)).toBe(false);
    await ergo.signTransaction(spectrum, signer);
    const transfer = buildUnsignedTransaction({
      height: L_TIP,
      minValuePerByte: 360n,
      fee: 1100000n,
      feeErgoTree: FEE_TREE,
      changeErgoTree: ME_TREE,
      walletBoxes: [walletBox(5n * ERG)],
      outputs: [{ ergoTree: ME_TREE, value: ERG }],
    });
    await ergo.signTransaction(transfer, signer);
    // a signer loaded for one send and wiped after it does not load the library either
    const loaded = WasmErgoSigner.fromMnemonic(MNEMONIC_A);
    await ergo.signTransaction(swapBuilt(dex, RSN_POOL, RSN_REF), loaded);
    loaded.dispose();
    expect(mockAlphaLoads).toBe(0);
  });

  it('a LithosDex swap loads it once, and signs on it', async () => {
    const lithos = swapBuilt(dex, LIT_POOL, LIT_REF);
    expect(spendsTreeVersion3(lithos)).toBe(true);
    const before = mockAlphaLoads;
    const signed = await ergo.signTransaction(lithos, signer);
    expect(signed.parsed.inputs[0].spendingProof.extension).toEqual({ '0': '0200' });
    await ergo.signTransaction(swapBuilt(dex, LIT_POOL, LIT_REF), signer);
    expect(before).toBe(0);
    expect(mockAlphaLoads).toBe(1);
  });

  it('0.28.0 alone cannot sign it, and a signer with no version-3 counterpart is refused before signing', async () => {
    const lithos = swapBuilt(dex, LIT_POOL, LIT_REF);
    await expect(
      signer.signTransaction(lithos.unsigned, lithos.unsigned.inputs, lithos.unsigned.dataInputs, {
        headers: (await ergo.node.getLastHeaders(10)) as never,
      }),
    ).rejects.toThrow(/Signing failed/);
    const bare = { publicKeys: signer.publicKeys, signTransaction: signer.signTransaction.bind(signer) };
    await expect(ergo.signTransaction(lithos, bare)).rejects.toThrow(/version 3 and this signer cannot sign it/);
  });

  it('the version-3 signer reports the key it derives, and refuses to be built under another key', async () => {
    const { AlphaErgoSigner } = await import('../../../src/chains/ergo/ergo.signer-alpha');
    const seven = Uint8Array.from({ length: 32 }, (_, i) => (i === 31 ? 7 : 0));
    const sevenKey = WasmErgoSigner.fromSecretKeyBytes(seven).publicKeys[0];
    expect(sevenKey).not.toBe(signer.publicKeys[0]);
    const refused = (() => {
      try {
        AlphaErgoSigner.fromSecretKeyBytes(seven, signer.publicKeys[0]);
        return null;
      } catch (error) {
        return error as Error;
      }
    })();
    expect(refused).toBeInstanceOf(ErgoSigningError);
    expect(refused!.message).toMatch(/derives another public key/);
    // neither key is in the message
    expect(refused!.message).not.toContain(signer.publicKeys[0]);
    expect(refused!.message).not.toContain(sevenKey);
    // built with its own key, or with none, it reports the key it derived
    expect(AlphaErgoSigner.fromSecretKeyBytes(seven, sevenKey).publicKeys).toEqual([sevenKey]);
    expect(AlphaErgoSigner.fromSecretKeyBytes(seven).publicKeys).toEqual([sevenKey]);
    expect((await signer.forTreeVersion3()).publicKeys).toEqual(signer.publicKeys);
  });

  it('the copy of the key is zeroed once the version-3 signer is built, and a later call returns that signer', async () => {
    const alpha = await import('../../../src/chains/ergo/ergo.signer-alpha');
    const build = jest.spyOn(alpha.AlphaErgoSigner, 'fromSecretKeyBytes');
    try {
      const loaded = WasmErgoSigner.fromMnemonic(MNEMONIC_A);
      const v3 = await loaded.forTreeVersion3();
      const copy = build.mock.calls[0][0];
      expect(copy.length).toBe(32);
      expect(copy.every((b) => b === 0)).toBe(true);
      expect(await loaded.forTreeVersion3()).toBe(v3);
      expect(build).toHaveBeenCalledTimes(1);
      // and it still signs
      const signed = await ergo.signTransaction(swapBuilt(dex, LIT_POOL, LIT_REF), loaded);
      expect(signed.parsed.inputs[0].spendingProof.extension).toEqual({ '0': '0200' });
      loaded.dispose();
    } finally {
      build.mockRestore();
    }
  });

  it('a failed build keeps the copy so a later call can try again; dispose zeroes it and signing then throws', async () => {
    const alpha = await import('../../../src/chains/ergo/ergo.signer-alpha');
    const build = jest.spyOn(alpha.AlphaErgoSigner, 'fromSecretKeyBytes').mockImplementationOnce(() => {
      throw new Error('stand-in build failure');
    });
    try {
      const loaded = WasmErgoSigner.fromMnemonic(MNEMONIC_A);
      await expect(loaded.forTreeVersion3()).rejects.toThrow(/stand-in build failure/);
      const copy = build.mock.calls[0][0];
      expect(copy.some((b) => b !== 0)).toBe(true);
      // the retry builds from the kept copy
      expect((await loaded.forTreeVersion3()).publicKeys).toEqual(signer.publicKeys);
      expect(copy.every((b) => b === 0)).toBe(true);

      const other = WasmErgoSigner.fromMnemonic(MNEMONIC_A);
      build.mockImplementationOnce(() => {
        throw new Error('stand-in build failure');
      });
      await expect(other.forTreeVersion3()).rejects.toThrow(/stand-in build failure/);
      const otherCopy = build.mock.calls[2][0];
      expect(otherCopy.some((b) => b !== 0)).toBe(true);
      other.dispose();
      expect(otherCopy.every((b) => b === 0)).toBe(true);
      const built = swapBuilt(dex, RSN_POOL, RSN_REF);
      await expect(ergo.signTransaction(built, other)).rejects.toThrow(/disposed/);
      await expect(other.forTreeVersion3()).rejects.toThrow(/disposed/);
      other.dispose(); // twice is harmless

      // dispose also wipes a version-3 signer already built
      const v3 = await loaded.forTreeVersion3();
      loaded.dispose();
      await new Promise((resolve) => setImmediate(resolve));
      await expect(ergo.signTransaction(swapBuilt(dex, LIT_POOL, LIT_REF), loaded)).rejects.toThrow(/disposed/);
      const lithos = swapBuilt(dex, LIT_POOL, LIT_REF);
      await expect(
        v3.signTransaction(lithos.unsigned, lithos.unsigned.inputs, lithos.unsigned.dataInputs, {
          headers: (await ergo.node.getLastHeaders(10)) as never,
        }),
      ).rejects.toThrow(/disposed/);
    } finally {
      build.mockRestore();
    }
  });

  it('an input above version 3 is refused', () => {
    const built = swapBuilt(dex, RSN_POOL, RSN_REF);
    const v4 = {
      ...built,
      inputBoxes: [{ ...built.inputBoxes[0], ergoTree: '1c' + built.inputBoxes[0].ergoTree.slice(2) }],
    };
    expect(() => spendsTreeVersion3(v4)).toThrow(/above 3/);
  });
});
