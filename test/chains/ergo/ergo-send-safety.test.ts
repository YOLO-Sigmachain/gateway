/**
 * What happens around the POST: a lost answer, a dropped transaction, two sends at once, a
 * change address that is not the signer's, a node that answers with another id. Built with
 * real fleet, signed with real wasm, submitted to a node stand-in.
 */
import { Ergo, ErgoNotSubmittedError, ErgoSubmitOutcomeUnknownError } from '../../../src/chains/ergo/ergo';
import { FetchLike } from '../../../src/chains/ergo/ergo.node-client';
import { ErgoSigner, WasmErgoSigner } from '../../../src/chains/ergo/ergo.signer';
import { ErgoBuildError, ErgoTransactionAssertionError } from '../../../src/chains/ergo/ergo.tx-builder';
import { addressFromPublicKey } from '../../../src/chains/ergo/ergo.utils';
import { TransactionStatusCode } from '../../../src/schemas/chain-schema';

import {
  fakeNode,
  FakeResponse,
  GENERATOR_ADDRESSES,
  HEADERS,
  infoBody,
  makeBox,
  MNEMONIC_A,
  nodeBoxJson,
  notFound,
  p2pk,
  testConfig,
  TIP,
} from './ergo-test-helpers';

const signer = WasmErgoSigner.fromMnemonic(MNEMONIC_A);
const ME_TREE = p2pk(signer.publicKeys[0]);
const ME = addressFromPublicKey(signer.publicKeys[0], 0);
const OTHER = GENERATOR_ADDRESSES[0];
const ERG = 1000000000n;

const big = makeBox({ ergoTree: ME_TREE, value: 5n * ERG, creationHeight: TIP - 30 });
const small = makeBox({ ergoTree: ME_TREE, value: 3n * ERG, creationHeight: TIP - 30 });

const inputsOf = (json: string): string[] => JSON.parse(json).inputs.map((i: { boxId: string }) => i.boxId);
const acceptWithId = (body: string): FakeResponse => ({ body: JSON.stringify(JSON.parse(body).id) });

function setup(opts: {
  listing: () => ReturnType<typeof nodeBoxJson>[];
  submit: (body: string) => FakeResponse;
  other?: (path: string) => FakeResponse | undefined;
  now?: () => number;
}) {
  const posted: string[] = [];
  const node = fakeNode((method, path, body) => {
    if (method === 'GET' && path === '/info') return { body: infoBody() };
    if (method === 'POST' && path.startsWith('/blockchain/box/unspent/byAddress')) return { body: opts.listing() };
    if (method === 'GET' && path === '/blocks/lastHeaders/10') return { body: HEADERS };
    if (method === 'POST' && path === '/transactions') {
      posted.push(body!);
      return opts.submit(body!);
    }
    return opts.other ? opts.other(path) : undefined;
  });
  const ergo = new Ergo('mainnet', { config: testConfig(), fetch: node.fetch, now: opts.now });
  jest.spyOn(ergo, 'getWallet').mockResolvedValue({ address: ME, ergoTree: ME_TREE, signer });
  return { ergo, posted, node };
}

const errorOf = <T>(p: Promise<T>) =>
  p.then(
    () => null,
    (e) => e,
  );

describe('two sends at once from one wallet', () => {
  it('spend disjoint boxes', async () => {
    const { ergo, posted } = setup({ listing: () => [nodeBoxJson(big), nodeBoxJson(small)], submit: acceptWithId });
    const [a, b] = await Promise.all([ergo.transfer(ME, OTHER, ERG), ergo.transfer(ME, OTHER, 2n * ERG)]);
    expect(a).not.toBe(b);
    expect(posted.length).toBe(2);
    const first = new Set(inputsOf(posted[0]));
    expect(inputsOf(posted[1]).some((id) => first.has(id))).toBe(false);
    expect(ergo.pending.get(a)!.inputBoxIds).toEqual([big.boxId]);
    expect(ergo.pending.get(b)!.inputBoxIds).toEqual([small.boxId]);
  });

  it('a failed send does not block the next one', async () => {
    let n = 0;
    const { ergo } = setup({
      listing: () => [nodeBoxJson(big), nodeBoxJson(small)],
      submit: (body) =>
        n++ === 0 ? { status: 400, body: { error: 400, reason: 'bad.request', detail: 'nope' } } : acceptWithId(body),
    });
    const [first, second] = await Promise.allSettled([ergo.transfer(ME, OTHER, ERG), ergo.transfer(ME, OTHER, ERG)]);
    expect(first.status).toBe('rejected');
    expect(second.status).toBe('fulfilled');
  });
});

describe('a submit whose answer is lost', () => {
  it('200 without an id: the transaction stays tracked, the error carries its id, a retry does not pay twice', async () => {
    let accepted = false;
    const { ergo, posted } = setup({
      // the node still lists `big` (not indexed yet, or the retry reaches another node)
      listing: () => [nodeBoxJson(big), nodeBoxJson(small)],
      submit: (body) => {
        if (!accepted) {
          accepted = true;
          return { body: '' }; // the node took it; the answer was cut off
        }
        return acceptWithId(body);
      },
    });
    const error = await errorOf(ergo.transfer(ME, OTHER, ERG));
    expect(error).toBeInstanceOf(ErgoSubmitOutcomeUnknownError);
    const firstId = JSON.parse(posted[0]).id;
    expect(error.txId).toBe(firstId);
    expect(error.message).toBe(`Submit outcome unknown for ${firstId}; poll it before retrying`);
    expect(ergo.pending.isSpent(big.boxId)).toBe(true);
    expect(ergo.pending.get(firstId)!.json).toBe(posted[0]);

    await ergo.transfer(ME, OTHER, ERG);
    expect(inputsOf(posted[0])).toEqual([big.boxId]);
    expect(inputsOf(posted[1])).not.toContain(big.boxId);
  });

  it('a fetch timeout on submit: status 0, tracked, id on the error', async () => {
    const node = fakeNode((method, path) => {
      if (method === 'GET' && path === '/info') return { body: infoBody() };
      if (method === 'POST' && path.startsWith('/blockchain/box/unspent/byAddress'))
        return { body: [nodeBoxJson(big), nodeBoxJson(small)] };
      if (method === 'GET' && path === '/blocks/lastHeaders/10') return { body: HEADERS };
      return undefined;
    });
    let postedBody = '';
    const fetch: FetchLike = async (input, init) => {
      if (init?.method === 'POST' && input.endsWith('/transactions')) {
        postedBody = String(init.body);
        throw new Error('The operation was aborted due to timeout');
      }
      return node.fetch(input, init);
    };
    const ergo = new Ergo('mainnet', { config: testConfig(), fetch });
    jest.spyOn(ergo, 'getWallet').mockResolvedValue({ address: ME, ergoTree: ME_TREE, signer });
    const error = await errorOf(ergo.transfer(ME, OTHER, ERG));
    expect(error).toBeInstanceOf(ErgoSubmitOutcomeUnknownError);
    expect(error.status).toBe(0);
    expect(error.txId).toBe(JSON.parse(postedBody).id);
    expect(ergo.pending.isSpent(big.boxId)).toBe(true);
  });

  /** A send whose POST fails in transport with `thrown`; everything else answered. */
  function failingTransport(thrown: () => unknown) {
    const node = fakeNode((method, path) => {
      if (method === 'GET' && path === '/info') return { body: infoBody() };
      if (method === 'POST' && path.startsWith('/blockchain/box/unspent/byAddress'))
        return { body: [nodeBoxJson(big), nodeBoxJson(small)] };
      if (method === 'GET' && path === '/blocks/lastHeaders/10') return { body: HEADERS };
      return undefined;
    });
    const fetch: FetchLike = async (input, init) => {
      if (init?.method === 'POST' && input.endsWith('/transactions')) throw thrown();
      return node.fetch(input, init);
    };
    const ergo = new Ergo('mainnet', { config: testConfig(), fetch });
    jest.spyOn(ergo, 'getWallet').mockResolvedValue({ address: ME, ergoTree: ME_TREE, signer });
    return ergo;
  }
  const coded = (code: string) => Object.assign(new Error(`connect ${code} 127.0.0.1:9053`), { code });
  const fetchFailed = (cause: unknown) => new TypeError('fetch failed', { cause });

  it.each([
    ['the connection is refused', () => fetchFailed(coded('ECONNREFUSED'))],
    [
      'every address tried refuses it',
      () => fetchFailed(new AggregateError([coded('ECONNREFUSED'), coded('ECONNREFUSED')])),
    ],
    ["the node's name does not resolve", () => fetchFailed(coded('ENOTFOUND'))],
    ['name resolution fails for now', () => fetchFailed(coded('EAI_AGAIN'))],
  ])('%s at the first submit: not submitted, released, and not an unknown outcome', async (_name, thrown) => {
    const ergo = failingTransport(thrown);
    const error = await errorOf(ergo.transfer(ME, OTHER, ERG));
    expect(error).toBeInstanceOf(ErgoNotSubmittedError);
    expect(error).not.toBeInstanceOf(ErgoSubmitOutcomeUnknownError);
    expect(error.message).toContain('was not submitted');
    expect(ergo.pending.isSpent(big.boxId)).toBe(false);
    expect(ergo.pending.get(error.txId)).toBeUndefined();
  });

  it.each([
    ['a reset after connecting', () => fetchFailed(coded('ECONNRESET'))],
    [
      'one address refuses and another times out',
      () => fetchFailed(new AggregateError([coded('ECONNREFUSED'), coded('ETIMEDOUT')])),
    ],
    ['a timeout', () => Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })],
    ['an error with no code', () => fetchFailed(new Error('other side closed'))],
  ])('%s at the first submit: still an unknown outcome, kept', async (_name, thrown) => {
    const ergo = failingTransport(thrown);
    const error = await errorOf(ergo.transfer(ME, OTHER, ERG));
    expect(error).toBeInstanceOf(ErgoSubmitOutcomeUnknownError);
    expect(ergo.pending.isSpent(big.boxId)).toBe(true);
  });

  it('a 5xx is an unknown outcome too; a 4xx is a definite rejection and releases', async () => {
    let status = 503;
    const { ergo } = setup({
      listing: () => [nodeBoxJson(big)],
      submit: () => ({ status, body: { error: status, reason: 'x', detail: 'y' } }),
    });
    const unknown = await errorOf(ergo.transfer(ME, OTHER, ERG));
    expect(unknown).toBeInstanceOf(ErgoSubmitOutcomeUnknownError);
    expect(unknown.status).toBe(503);
    expect(ergo.pending.isSpent(big.boxId)).toBe(true);
    ergo.pending.release(unknown.txId);

    status = 400;
    const rejected = await errorOf(ergo.transfer(ME, OTHER, ERG));
    expect(rejected).not.toBeInstanceOf(ErgoSubmitOutcomeUnknownError);
    expect(rejected.status).toBe(400);
    expect(ergo.pending.isSpent(big.boxId)).toBe(false);
  });
});

describe('a transaction the node dropped', () => {
  const dropped = (
    submit: (body: string) => FakeResponse,
    now?: () => number,
    mempool: (p: string) => FakeResponse | undefined = () => undefined,
  ) =>
    setup({
      listing: () => [nodeBoxJson(big)], // the node lists the input as unspent again
      submit,
      now,
      other: (p) => {
        const held = mempool(p);
        if (held) return held;
        if (p.startsWith('/blockchain/transaction/byId/') || p.startsWith('/transactions/unconfirmed/'))
          return notFound();
        if (p === '/blockchain/indexedHeight') return { body: { indexedHeight: TIP, fullHeight: TIP } };
        if (p === `/blockchain/box/byId/${big.boxId}`) return { body: nodeBoxJson(big) }; // unspent
        return undefined;
      },
    });

  it('poll posts it again, byte for byte, and reports it pending', async () => {
    const { ergo, posted } = dropped(acceptWithId);
    const txId = await ergo.transfer(ME, OTHER, ERG);
    const r = await ergo.pollTransaction(txId);
    expect(r.txStatus).toBe(TransactionStatusCode.PENDING);
    expect(r.txData).toEqual({ note: 'rebroadcast: the node had dropped it' });
    expect(posted.length).toBe(2);
    expect(posted[1]).toBe(posted[0]);
    expect(ergo.pending.isSpent(big.boxId)).toBe(true);
  });

  /** Accepted at the first submit, refused with `detail` on every post after it. */
  const refusedAfterFirst = (detail: string) => {
    let n = 0;
    return (body: string): FakeResponse =>
      n++ === 0 ? acceptWithId(body) : { status: 400, body: { error: 400, reason: 'bad.request', detail } };
  };

  it('refused when posted again: NOT_FOUND with the node text in the note, kept, and its outputs not offered', async () => {
    const { ergo } = dropped(refusedAfterFirst('input box not found'));
    const txId = await ergo.transfer(ME, OTHER, ERG);
    const r = await ergo.pollTransaction(txId);
    expect(r.txStatus).toBe(TransactionStatusCode.NOT_FOUND);
    expect(r.error).toBeNull();
    expect(r.txData).toEqual({ note: expect.stringContaining('input box not found') });
    expect(ergo.pending.get(txId)!.refused).toBe(true);
    // its input stays hidden, and its change is not offered while it is refused
    expect(await ergo.getSpendableBoxes(ME)).toEqual([]);
  });

  // The node answers 4xx for transactions that are still valid and may confirm from
  // another node's mempool; none of these is proof that it can no longer confirm.
  it.each([
    ['a competing spend in the mempool', 'Double spending attempt', 'spent', TransactionStatusCode.PENDING],
    [
      'one it already holds',
      'Pool can not accept transaction, it is already in the mempool',
      'held',
      TransactionStatusCode.PENDING,
    ],
    [
      'a full mempool',
      'Transaction pays less than any other in the pool being full',
      'none',
      TransactionStatusCode.NOT_FOUND,
    ],
    ['a fee below its own minimum', 'Min fee not met', 'none', TransactionStatusCode.NOT_FOUND],
  ])('refused when posted again for %s: never FAILED, and kept', async (_name, detail, mempool, status) => {
    let txId = '';
    let posts = 0;
    const submit = refusedAfterFirst(detail);
    const { ergo } = dropped(
      (body) => {
        posts += 1;
        return submit(body);
      },
      undefined,
      (p) => {
        if (mempool === 'spent' && p === `/transactions/unconfirmed/inputs/byBoxId/${big.boxId}`)
          return { body: { boxId: big.boxId } };
        // held: the node shows it in the mempool once it has been posted again
        if (mempool === 'held' && posts > 1 && p === `/transactions/unconfirmed/byTransactionId/${txId}`)
          return { body: { id: txId, inputs: [{ boxId: big.boxId }], outputs: [] } };
        return undefined;
      },
    );
    txId = await ergo.transfer(ME, OTHER, ERG);
    const r = await ergo.pollTransaction(txId);
    expect(r.txStatus).not.toBe(TransactionStatusCode.FAILED);
    expect(r.txStatus).toBe(status);
    expect(r.error).toBeNull();
    expect(r.txData).toEqual({ note: expect.stringContaining(detail) });
    expect(ergo.pending.get(txId)).toBeDefined();
    expect(ergo.pending.isSpent(big.boxId)).toBe(true);
  });

  it('after a block time, no phantom change is offered and balances do not count it', async () => {
    let now = 1_000_000;
    const { ergo } = dropped(acceptWithId, () => now);
    const txId = await ergo.transfer(ME, OTHER, ERG);
    now += 120_000;
    const spendable = await ergo.getSpendableBoxes(ME);
    expect(spendable.some((b) => b.transactionId === txId)).toBe(false);
    expect(spendable.map((b) => b.boxId)).not.toContain(big.boxId);
  });
});

describe('change goes back to the signer', () => {
  it('walletBoxes not at the change address: refused at build, nothing signed or posted', async () => {
    const { ergo, posted } = setup({ listing: () => [nodeBoxJson(big)], submit: acceptWithId });
    const error = await errorOf(
      ergo.sendTransaction(
        { changeAddress: OTHER, walletBoxes: [big], outputs: [{ ergoTree: ME_TREE, value: ERG }] },
        signer,
      ),
    );
    expect(error).toBeInstanceOf(ErgoBuildError);
    expect(posted.length).toBe(0);
  });

  it("change to another address with the signer's box as a fixed input: refused before the signer runs", async () => {
    const { ergo, posted } = setup({ listing: () => [], submit: acceptWithId });
    const spy: ErgoSigner = { publicKeys: signer.publicKeys, signTransaction: jest.fn() };
    const error = await errorOf(
      ergo.sendTransaction(
        { changeAddress: OTHER, inputs: [{ box: big }], walletBoxes: [], outputs: [{ ergoTree: ME_TREE, value: ERG }] },
        spy,
      ),
    );
    expect(error).toBeInstanceOf(ErgoTransactionAssertionError);
    expect(spy.signTransaction).not.toHaveBeenCalled();
    expect(posted.length).toBe(0);
  });
});

describe('the node answers with a different id', () => {
  it("tracks and returns the node's id", async () => {
    const nodeId = 'cd'.repeat(32);
    const { ergo, posted } = setup({
      listing: () => [nodeBoxJson(big)],
      submit: () => ({ body: JSON.stringify(nodeId) }),
    });
    const txId = await ergo.transfer(ME, OTHER, ERG);
    expect(txId).toBe(nodeId);
    expect(ergo.pending.get(nodeId)!.inputBoxIds).toEqual([big.boxId]);
    expect(ergo.pending.get(JSON.parse(posted[0]).id)).toBeUndefined();
    expect(ergo.pending.isSpent(big.boxId)).toBe(true);
  });
});
