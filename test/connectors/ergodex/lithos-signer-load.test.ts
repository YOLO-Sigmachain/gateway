/**
 * The second signing library (the alpha build that reads ErgoTree version 3) is loaded
 * only when a transaction spends a box at a version-3 tree. A Spectrum swap, and a
 * transfer, sign on 0.28.0 without loading it; the first LithosDex swap loads it once.
 */
import { Ergo, ergoTreeVersion, spendsTreeVersion3 } from '../../../src/chains/ergo/ergo';
import { WasmErgoSigner } from '../../../src/chains/ergo/ergo.signer';
import { buildUnsignedTransaction } from '../../../src/chains/ergo/ergo.tx-builder';
import { Ergodex, TokenRef } from '../../../src/connectors/ergodex/ergodex';
import { FEE_TREE, testConfig } from '../../chains/ergo/ergo-test-helpers';

import { ERG, ME_TREE, newNodeState, RSN, RSN_POOL, signer, walletBox } from './ergodex-test-helpers';
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

  it('a version-3 counterpart holding other keys is refused', async () => {
    const other = WasmErgoSigner.fromSecretKeyBytes(Uint8Array.from({ length: 32 }, (_, i) => (i === 31 ? 7 : 0)));
    const mixed = {
      publicKeys: signer.publicKeys,
      signTransaction: signer.signTransaction.bind(signer),
      forTreeVersion3: () => other.forTreeVersion3(),
    };
    await expect(ergo.signTransaction(swapBuilt(dex, LIT_POOL, LIT_REF), mixed)).rejects.toThrow(/other keys/);
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
