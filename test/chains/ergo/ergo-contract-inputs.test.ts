/**
 * Chain-layer behaviours for connectors that spend contract boxes:
 * 1. a fixed-input transaction goes through the locked path, so two wallets cannot race
 *    for the same contract box in this process, and a rejected submit caused by an
 *    already-spent fixed input is a distinct, retryable error with the node's text;
 * 2. the change outputs themselves must sit at the change address (and the signer check
 *    reads them), not only the `changeErgoTree` field;
 * 3. what the tracker records comes from the posted JSON, the same source the post-signing
 *    check reads;
 * 4. outputs of a pending transaction the node has forgotten are not offered: for a chain
 *    of transactions, and for one with a fixed contract input;
 * 5. poll reports FAILED for a transaction whose fixed input was an unconfirmed box that
 *    will never exist.
 * Real fleet-sdk and real ergo-lib-wasm; the node is a stand-in.
 */
import { SInt } from '@fleet-sdk/core';

import { Ergo, ErgoInputSpentError } from '../../../src/chains/ergo/ergo';
import { ErgoNodeError } from '../../../src/chains/ergo/ergo.node-client';
import { ErgoPendingTracker } from '../../../src/chains/ergo/ergo.pending';
import { ErgoSigner, WasmErgoSigner } from '../../../src/chains/ergo/ergo.signer';
import {
  assertTransactionBalanced,
  BuiltErgoTransaction,
  buildUnsignedTransaction,
  ErgoBuildError,
  ErgoTransactionAssertionError,
} from '../../../src/chains/ergo/ergo.tx-builder';
import { addressFromPublicKey } from '../../../src/chains/ergo/ergo.utils';
import { TransactionStatusCode } from '../../../src/schemas/chain-schema';

import {
  fakeNode,
  FakeResponse,
  FEE_TREE,
  GENERATOR_PK,
  HEADERS,
  infoBody,
  makeBox,
  MNEMONIC_A,
  MNEMONIC_B,
  nodeBoxJson,
  notFound,
  p2pk,
  testConfig,
  TIP,
} from './ergo-test-helpers';

const ERG = 1000000000n;
const signerA = WasmErgoSigner.fromMnemonic(MNEMONIC_A);
const signerB = WasmErgoSigner.fromMnemonic(MNEMONIC_B);
const TREE_A = p2pk(signerA.publicKeys[0]);
const TREE_B = p2pk(signerB.publicKeys[0]);
const ADDR_A = addressFromPublicKey(signerA.publicKeys[0], 0);
const ADDR_B = addressFromPublicKey(signerB.publicKeys[0], 0);
const OTHER_TREE = p2pk(GENERATOR_PK);
/** sigmaProp(HEIGHT > 0): a contract box anyone can spend, like a pool. */
const OPEN_TREE = `1001${SInt(0).toHex()}d191a37300`;

const errorOf = <T>(p: Promise<T>) =>
  p.then(
    () => null,
    (e) => e,
  );

function setup(opts: {
  wallets: Record<string, ReturnType<typeof makeBox>[]>;
  submit: (body: string) => FakeResponse;
  other?: (method: string, path: string) => FakeResponse | undefined;
}) {
  const posted: string[] = [];
  const node = fakeNode((method, path, body) => {
    if (method === 'GET' && path === '/info') return { body: infoBody() };
    if (method === 'GET' && path === '/blocks/lastHeaders/10') return { body: HEADERS };
    if (method === 'POST' && path.startsWith('/blockchain/box/unspent/byAddress')) {
      const offset = new URLSearchParams(path.split('?')[1]).get('offset');
      return { body: offset === '0' ? (opts.wallets[body!] ?? []).map((b) => nodeBoxJson(b)) : [] };
    }
    if (method === 'POST' && path === '/transactions') {
      posted.push(body!);
      return opts.submit(body!);
    }
    return opts.other?.(method, path);
  });
  const ergo = new Ergo('mainnet', { config: testConfig(), fetch: node.fetch });
  return { ergo, posted, node };
}

const accept = (body: string): FakeResponse => ({ body: JSON.stringify(JSON.parse(body).id) });

describe('1. fixed inputs: one locked path, and a distinct error for an input spent first', () => {
  const pool = makeBox({ ergoTree: OPEN_TREE, value: 10n * ERG, creationHeight: TIP - 3 });
  const boxA = makeBox({ ergoTree: TREE_A, value: 5n * ERG, creationHeight: TIP - 30 });
  const boxB = makeBox({ ergoTree: TREE_B, value: 5n * ERG, creationHeight: TIP - 30 });
  // the "successor": the contract box carried on with its value
  const request = (address: string) => ({
    changeAddress: address,
    inputs: [{ box: pool }],
    outputs: [{ ergoTree: OPEN_TREE, value: 10n * ERG + ERG }],
  });

  it('two wallets sending against the same fixed input at once: one POST, the other gets ErgoInputSpentError', async () => {
    const { ergo, posted } = setup({ wallets: { [ADDR_A]: [boxA], [ADDR_B]: [boxB] }, submit: accept });
    const [a, b] = await Promise.all([
      errorOf(ergo.sendTransaction(request(ADDR_A), signerA)).then((e) => e),
      errorOf(ergo.sendTransaction(request(ADDR_B), signerB)).then((e) => e),
    ]);
    // exactly one of the two built and posted; the second saw the box spent by our pending tx
    expect(posted.length).toBe(1);
    const errors = [a, b].filter((e) => e !== null);
    expect(errors.length).toBe(1);
    expect(errors[0]).toBeInstanceOf(ErgoInputSpentError);
    expect(errors[0].retryable).toBe(true);
    expect(errors[0].boxIds).toEqual([pool.boxId]);
    expect(errors[0].message).toContain('already spent by one of our pending transactions');
  });

  it('a built fixed-input transaction cannot be submitted outside the locked path', async () => {
    const { ergo, posted } = setup({ wallets: { [ADDR_A]: [boxA] }, submit: accept });
    const built = await ergo.buildTransaction(request(ADDR_A));
    expect(built.fixedInputCount).toBe(1);
    const signed = await ergo.signTransaction(built, signerA);
    const error = await errorOf(ergo.submitTransaction(signed, built));
    expect(error).toBeInstanceOf(ErgoBuildError);
    expect(error.message).toContain('sendTransaction');
    expect(posted.length).toBe(0);
    expect(ergo.pending.isSpent(pool.boxId)).toBe(false);
  });

  it('a 400 while the node shows the fixed input spent in its mempool: ErgoInputSpentError with the node text', async () => {
    const detail = 'Malformed transaction: Every input of the transaction should be in UTXO';
    const { ergo, posted } = setup({
      wallets: { [ADDR_A]: [boxA] },
      submit: () => ({ status: 400, body: { error: 400, reason: 'bad.request', detail } }),
      other: (method, path) =>
        method === 'GET' && path === `/transactions/unconfirmed/inputs/byBoxId/${pool.boxId}`
          ? { body: nodeBoxJson(pool) }
          : undefined,
    });
    const error = await errorOf(ergo.sendTransaction(request(ADDR_A), signerA));
    expect(posted.length).toBe(1);
    expect(error).toBeInstanceOf(ErgoInputSpentError);
    expect(error.boxIds).toEqual([pool.boxId]);
    expect(error.nodeText).toBe(detail);
    expect(error.message).toContain(detail);
    // the rejected transaction no longer hides the wallet box or the pool
    expect(ergo.pending.isSpent(pool.boxId)).toBe(false);
    expect(ergo.pending.isSpent(boxA.boxId)).toBe(false);
  });

  const noEvidence = (detail: string) =>
    setup({
      wallets: { [ADDR_A]: [boxA] },
      submit: () => ({ status: 400, body: { error: 400, reason: 'bad.request', detail } }),
      other: (method, path) =>
        method === 'GET' &&
        (path.startsWith('/transactions/unconfirmed/inputs/') || path.startsWith('/blockchain/box/byId/'))
          ? notFound()
          : undefined,
    });

  it('a 400 that says an input is missing, with no index evidence yet: the node error, not the fixed input', async () => {
    // "an input is missing" alone may be a wallet input; it is not read as the contract box spent
    for (const detail of [
      'Double spending attempt',
      'Malformed transaction: Every input of the transaction should be in UTXO. Input 1 not found',
    ]) {
      const { ergo, posted } = noEvidence(detail);
      const error = await errorOf(ergo.sendTransaction(request(ADDR_A), signerA));
      expect(posted.length).toBe(1);
      expect(error).not.toBeInstanceOf(ErgoInputSpentError);
      expect(error).toBeInstanceOf(ErgoNodeError);
      expect(error.status).toBe(400);
      expect(error.detail).toBe(detail);
      expect(ergo.pending.isSpent(pool.boxId)).toBe(false);
    }
  });

  it('a 400 that names the fixed input as missing, with no index evidence yet: ErgoInputSpentError', async () => {
    const detail = `Double spending attempt: input ${pool.boxId} is already spent`;
    const { ergo } = noEvidence(detail);
    const error = await errorOf(ergo.sendTransaction(request(ADDR_A), signerA));
    expect(error).toBeInstanceOf(ErgoInputSpentError);
    expect(error.boxIds).toEqual([pool.boxId]);
    expect(error.nodeText).toBe(detail);
  });

  it('a 400 for another reason stays the node error it was', async () => {
    const detail = 'Scripts of all transaction inputs should pass verification';
    const { ergo } = setup({
      wallets: { [ADDR_A]: [boxA] },
      submit: () => ({ status: 400, body: { error: 400, reason: 'bad.request', detail } }),
      other: (method, path) =>
        method === 'GET' &&
        (path.startsWith('/transactions/unconfirmed/inputs/') || path.startsWith('/blockchain/box/byId/'))
          ? notFound()
          : undefined,
    });
    const error = await errorOf(ergo.sendTransaction(request(ADDR_A), signerA));
    expect(error).not.toBeInstanceOf(ErgoInputSpentError);
    expect(error).toBeInstanceOf(ErgoNodeError);
    expect(error.detail).toBe(detail);
  });

  it('verify runs on the built transaction inside the lock, before signing', async () => {
    const { ergo, posted } = setup({ wallets: { [ADDR_A]: [boxA] }, submit: accept });
    const spy: ErgoSigner = { publicKeys: signerA.publicKeys, signTransaction: jest.fn() };
    const error = await errorOf(
      ergo.sendTransaction(request(ADDR_A), spy, {
        verify: (built) => {
          expect(built.inputBoxes[0].boxId).toBe(pool.boxId);
          throw new Error('connector check failed');
        },
      }),
    );
    expect(error.message).toBe('connector check failed');
    expect(spy.signTransaction).not.toHaveBeenCalled();
    expect(posted.length).toBe(0);
  });
});

describe('2. change outputs are checked where they are, not by the changeErgoTree field', () => {
  const funding = makeBox({ ergoTree: TREE_A, value: 5n * ERG, creationHeight: TIP - 30 });
  const fresh = (): BuiltErgoTransaction =>
    buildUnsignedTransaction({
      height: TIP,
      minValuePerByte: 360n,
      fee: 1100000n,
      feeErgoTree: FEE_TREE,
      changeErgoTree: TREE_A,
      walletBoxes: [funding],
      outputs: [{ ergoTree: OTHER_TREE, value: ERG }],
    });

  it('a change output moved to another tree is refused, though ERG and tokens still balance', () => {
    const built = fresh();
    const i = built.changeOutputIndexes[0];
    built.unsigned.outputs[i].ergoTree = OTHER_TREE;
    expect(() => assertTransactionBalanced(built)).toThrow(ErgoTransactionAssertionError);
    expect(() => assertTransactionBalanced(built)).toThrow('is not at the change address');
  });

  it('change indexes that do not name the boxes before the fee box are refused', () => {
    const built = fresh();
    built.changeOutputIndexes = [0];
    expect(() => assertTransactionBalanced(built)).toThrow('right before the fee box');
  });

  it('an input counted as selected must be at the change tree: the check reads the input itself', () => {
    const contractBox = makeBox({ ergoTree: OTHER_TREE, value: 2n * ERG, creationHeight: TIP - 30 });
    const built = buildUnsignedTransaction({
      height: TIP,
      minValuePerByte: 360n,
      fee: 1100000n,
      feeErgoTree: FEE_TREE,
      changeErgoTree: TREE_A,
      inputs: [{ box: contractBox }],
      walletBoxes: [funding],
      outputs: [{ ergoTree: OTHER_TREE, value: ERG }],
    });
    expect(() => assertTransactionBalanced(built)).not.toThrow();
    built.fixedInputCount = 0;
    expect(() => assertTransactionBalanced(built)).toThrow('selected input 0 is not at the change address');
  });

  it('signTransaction refuses before the signer runs when a change output is not the signer’s', async () => {
    const { ergo } = setup({ wallets: {}, submit: accept });
    const built = fresh();
    built.unsigned.outputs[built.changeOutputIndexes[0]].ergoTree = OTHER_TREE;
    const spy: ErgoSigner = { publicKeys: signerA.publicKeys, signTransaction: jest.fn() };
    const error = await errorOf(ergo.signTransaction(built, spy));
    expect(error).toBeInstanceOf(ErgoTransactionAssertionError);
    expect(spy.signTransaction).not.toHaveBeenCalled();
  });
});

describe('3. one source: the tracker records what is posted', () => {
  it('pending outputs come from the signed JSON even if the parsed copy differs', async () => {
    const funding = makeBox({ ergoTree: TREE_A, value: 5n * ERG, creationHeight: TIP - 30 });
    const { ergo, posted } = setup({ wallets: { [ADDR_A]: [funding] }, submit: accept });
    const lying: ErgoSigner = {
      publicKeys: signerA.publicKeys,
      signTransaction: async (...args) => {
        const signed = await signerA.signTransaction(...args);
        // a signer whose parsed copy disagrees with the JSON it returns
        const parsed = JSON.parse(JSON.stringify(signed.parsed, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
        parsed.outputs[1].value = '1';
        return { ...signed, parsed };
      },
    };
    const { txId } = await ergo.sendTransaction(
      { changeAddress: ADDR_A, outputs: [{ ergoTree: OTHER_TREE, value: ERG }] },
      lying,
    );
    const json = JSON.parse(posted[0]);
    const tracked = ergo.pending.get(txId)!;
    expect(tracked.outputs.map((o) => o.value)).toEqual(json.outputs.map((o: { value: number }) => BigInt(o.value)));
    expect(tracked.outputs[1].value).not.toBe(1n);
  });
});

describe('4. chained transactions the node has forgotten offer no outputs', () => {
  it('the second transaction’s outputs are not offered once the first is not', () => {
    let now = 0;
    const tracker = new ErgoPendingTracker(30 * 60_000, () => now, 120_000);
    const funding = makeBox({ ergoTree: TREE_A, value: 5n * ERG });
    const tx1 = 'e1'.repeat(32);
    const tx2 = 'e2'.repeat(32);
    const change1 = makeBox({ ergoTree: TREE_A, value: 3n * ERG, transactionId: tx1, inclusionHeight: null });
    const change2 = makeBox({ ergoTree: TREE_A, value: 2n * ERG, transactionId: tx2, inclusionHeight: null });
    tracker.record(tx1, [funding.boxId], [change1], '{}');
    tracker.record(tx2, [change1.boxId], [change2], '{}');
    // just recorded: the second's change is offered (the first's is spent by the second)
    expect(tracker.available([funding], TREE_A).map((b) => b.boxId)).toEqual([change2.boxId]);
    now = 120_000;
    // the node lists the funding box as unspent: it has neither transaction
    expect(tracker.available([funding], TREE_A)).toEqual([]);
    // the node has both (funding spent, change1 spent in its mempool, change2 listed or not)
    expect(tracker.available([], TREE_A).map((b) => b.boxId)).toEqual([change2.boxId]);
    // the node has the first but forgot the second: change1 listed, change2 not offered
    expect(tracker.available([change1], TREE_A)).toEqual([]);
  });

  it('a forgotten transaction with a fixed contract input offers no phantom change', () => {
    let now = 0;
    const tracker = new ErgoPendingTracker(30 * 60_000, () => now, 120_000);
    const pool = makeBox({ ergoTree: OPEN_TREE, value: 10n * ERG });
    const funding = makeBox({ ergoTree: TREE_A, value: 5n * ERG });
    const tx1 = 'f1'.repeat(32);
    const change1 = makeBox({ ergoTree: TREE_A, value: 3n * ERG, transactionId: tx1, index: 1, inclusionHeight: null });
    tracker.record(tx1, [pool.boxId, funding.boxId], [change1], '{}', [
      { boxId: pool.boxId, transactionId: pool.transactionId },
    ]);
    // just recorded: offered, funding hidden
    expect(tracker.available([funding], TREE_A).map((b) => b.boxId)).toEqual([change1.boxId]);
    now = 120_000;
    // the node lists the funding box as unspent: it never got the transaction, or lost it.
    // The contract box is never in the wallet listing, so its absence there proves nothing.
    expect(tracker.available([funding], TREE_A).map((b) => b.boxId)).toEqual([]);
    // the node shows the funding box spent: the change is offered
    expect(tracker.available([], TREE_A).map((b) => b.boxId)).toEqual([change1.boxId]);
  });

  it('a sent transaction records its fixed inputs and the transactions that created them', async () => {
    const pool = makeBox({ ergoTree: OPEN_TREE, value: 10n * ERG, creationHeight: TIP - 3 });
    const funding = makeBox({ ergoTree: TREE_A, value: 5n * ERG, creationHeight: TIP - 30 });
    const { ergo } = setup({ wallets: { [ADDR_A]: [funding] }, submit: accept });
    const { txId } = await ergo.sendTransaction(
      { changeAddress: ADDR_A, inputs: [{ box: pool }], outputs: [{ ergoTree: OPEN_TREE, value: 11n * ERG }] },
      signerA,
    );
    expect(ergo.pending.get(txId)!.fixedInputs).toEqual([{ boxId: pool.boxId, transactionId: pool.transactionId }]);
  });
});

describe('5. a fixed input built on an unconfirmed box whose creator is gone', () => {
  // the contract box is an output of someone else's unconfirmed transaction
  const pool = makeBox({ ergoTree: OPEN_TREE, value: 10n * ERG, creationHeight: TIP, inclusionHeight: null });
  const funding = makeBox({ ergoTree: TREE_A, value: 5n * ERG, creationHeight: TIP - 30 });

  async function sentThenPolled(opts: { parentInMempool?: boolean; indexedHeight?: number }) {
    const { ergo, node } = setup({
      wallets: { [ADDR_A]: [funding] },
      submit: accept,
      other: (method, path) => {
        if (method !== 'GET') return undefined;
        if (path === '/blockchain/indexedHeight') {
          return { body: { indexedHeight: opts.indexedHeight ?? TIP, fullHeight: TIP } };
        }
        if (path === `/transactions/unconfirmed/byTransactionId/${pool.transactionId}`) {
          return opts.parentInMempool ? { body: { id: pool.transactionId, inputs: [], outputs: [] } } : notFound();
        }
        if (path === `/blockchain/box/byId/${funding.boxId}`) return { body: nodeBoxJson(funding) }; // unspent
        if (
          path.startsWith('/transactions/unconfirmed/') ||
          path.startsWith('/blockchain/transaction/byId/') ||
          path.startsWith('/blockchain/box/byId/')
        ) {
          return notFound(); // our transaction is gone, and the pool box was never indexed
        }
        return undefined;
      },
    });
    const { txId } = await ergo.sendTransaction(
      { changeAddress: ADDR_A, inputs: [{ box: pool }], outputs: [{ ergoTree: OPEN_TREE, value: 11n * ERG }] },
      signerA,
    );
    return { ergo, node, txId, result: await ergo.pollTransaction(txId) };
  }

  it('creator neither confirmed nor in the mempool: FAILED, and the wallet box is spendable again', async () => {
    const { ergo, txId, result } = await sentThenPolled({});
    expect(result.txStatus).toBe(TransactionStatusCode.FAILED);
    expect(result.error).toContain(`fixed input ${pool.boxId} no longer exists`);
    expect(ergo.pending.get(txId)).toBeUndefined();
    expect((await ergo.getSpendableBoxes(ADDR_A)).map((b) => b.boxId)).toEqual([funding.boxId]);
  });

  it('creator still in the mempool: not FAILED, still tracked', async () => {
    const { ergo, txId, result } = await sentThenPolled({ parentInMempool: true });
    expect(result.txStatus).not.toBe(TransactionStatusCode.FAILED);
    expect(ergo.pending.get(txId)).toBeDefined();
  });

  it('the index is behind: PENDING, still tracked', async () => {
    const { ergo, txId, result } = await sentThenPolled({ indexedHeight: TIP - 1 });
    expect(result.txStatus).toBe(TransactionStatusCode.PENDING);
    expect(ergo.pending.get(txId)).toBeDefined();
  });
});
