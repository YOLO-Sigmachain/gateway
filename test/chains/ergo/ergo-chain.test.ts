/**
 * The Ergo chain class against a node stand-in: poll states, the node's rejection text,
 * mempool-aware boxes, balances and token identity, and a transfer end to end (built with
 * real fleet, signed with real wasm, submitted to the stand-in).
 */
import { AmbiguousTokenError, Ergo } from '../../../src/chains/ergo/ergo';
import { ErgoNodeError } from '../../../src/chains/ergo/ergo.node-client';
import { WasmErgoSigner } from '../../../src/chains/ergo/ergo.signer';
import { addressFromPublicKey, encodeErgoAddress } from '../../../src/chains/ergo/ergo.utils';
import { TransactionStatusCode } from '../../../src/schemas/chain-schema';

import {
  ABOVE_2_53,
  FakeResponse,
  fakeNode,
  FEE_TREE,
  GENERATOR_ADDRESSES,
  HEADERS,
  infoBody,
  MAX_LONG,
  makeBox,
  MNEMONIC_A,
  nodeBoxJson,
  notFound,
  p2pk,
  testConfig,
  TIP,
  tokenId,
} from './ergo-test-helpers';

const signer = WasmErgoSigner.fromMnemonic(MNEMONIC_A);
const ME_TREE = p2pk(signer.publicKeys[0]);
const ME = addressFromPublicKey(signer.publicKeys[0], 0);
const OTHER = GENERATOR_ADDRESSES[0];
const TX = 'ab'.repeat(32);
const ERG = 1000000000n;
const SIGUSD = '03faf2cb329f2e90d6d23b58d91bbb6c046aa143261cc21f52fbe2824bfcbf04';

type Route = (method: string, path: string, body?: string) => FakeResponse | undefined;

function chain(route: Route, overrides = {}) {
  const node = fakeNode((method, path, body) => {
    if (method === 'GET' && path === '/info') return { body: infoBody() };
    return route(method, path, body);
  });
  return { ergo: new Ergo('mainnet', { config: testConfig(overrides), fetch: node.fetch }), calls: node.calls };
}

describe('poll', () => {
  const tx = {
    id: TX,
    inputs: [{ boxId: 'cd'.repeat(32) }],
    dataInputs: [],
    outputs: [{ boxId: 'ef'.repeat(32), ergoTree: FEE_TREE, value: 1100000 }],
  };

  it('confirmed: indexed with enough confirmations', async () => {
    const { ergo } = chain((_m, p) =>
      p === `/blockchain/transaction/byId/${TX}`
        ? { body: { ...tx, inclusionHeight: TIP - 2, numConfirmations: 3 } }
        : undefined,
    );
    const r = await ergo.pollTransaction(TX);
    expect(r.txStatus).toBe(TransactionStatusCode.CONFIRMED);
    expect(r.txBlock).toBe(TIP - 2);
    expect(r.fee).toBe(0.0011);
    expect(r.currentBlock).toBe(TIP);
  });

  it('pending: indexed but fewer confirmations than the network config asks for', async () => {
    const { ergo } = chain(
      (_m, p) =>
        p === `/blockchain/transaction/byId/${TX}`
          ? { body: { ...tx, inclusionHeight: TIP, numConfirmations: 1 } }
          : undefined,
      { confirmations: 3 },
    );
    const r = await ergo.pollTransaction(TX);
    expect(r.txStatus).toBe(TransactionStatusCode.PENDING);
    expect(r.txBlock).toBe(TIP);
  });

  it('pending: in the mempool (not failed, D5)', async () => {
    const { ergo } = chain((_m, p) => {
      if (p === `/blockchain/transaction/byId/${TX}`) return notFound();
      if (p === `/transactions/unconfirmed/byTransactionId/${TX}`) return { body: tx };
      return undefined;
    });
    const r = await ergo.pollTransaction(TX);
    expect(r.txStatus).toBe(TransactionStatusCode.PENDING);
    expect(r.txBlock).toBeNull();
    expect(r.error).toBeNull();
  });

  it('not found: unknown to the node, with the index caught up', async () => {
    const { ergo } = chain((_m, p) => {
      if (p.startsWith('/blockchain/transaction/byId/') || p.startsWith('/transactions/unconfirmed/'))
        return notFound();
      if (p === '/blockchain/indexedHeight') return { body: { indexedHeight: TIP, fullHeight: TIP } };
      return undefined;
    });
    const r = await ergo.pollTransaction(TX);
    expect(r.txStatus).toBe(TransactionStatusCode.NOT_FOUND);
  });

  it('pending, not "not found", while the index lags the chain', async () => {
    const { ergo } = chain((_m, p) => {
      if (p.startsWith('/blockchain/transaction/byId/') || p.startsWith('/transactions/unconfirmed/'))
        return notFound();
      if (p === '/blockchain/indexedHeight') return { body: { indexedHeight: TIP - 3, fullHeight: TIP } };
      return undefined;
    });
    const r = await ergo.pollTransaction(TX);
    expect(r.txStatus).toBe(TransactionStatusCode.PENDING);
    expect(r.txData).toEqual({ note: expect.stringContaining('index') });
  });

  it('failed only on evidence: an input of our transaction was spent by another', async () => {
    const input = makeBox({ ergoTree: ME_TREE, value: ERG });
    const other = 'ee'.repeat(32);
    const { ergo } = chain((_m, p) => {
      if (p.startsWith('/blockchain/transaction/byId/') || p.startsWith('/transactions/unconfirmed/'))
        return notFound();
      if (p === `/blockchain/box/byId/${input.boxId}`)
        return { body: nodeBoxJson(input, { spentTransactionId: other }) };
      return undefined;
    });
    ergo.pending.record(TX, [input.boxId], []);
    const r = await ergo.pollTransaction(TX);
    expect(r.txStatus).toBe(TransactionStatusCode.FAILED);
    expect(r.error).toContain(other);
    expect(ergo.pending.isSpent(input.boxId)).toBe(false);
  });

  it('surfaces a node error rather than turning it into a status (D13)', async () => {
    const { ergo } = chain((_m, p) =>
      p.startsWith('/blockchain/transaction/byId/')
        ? { status: 500, body: { error: 500, reason: 'internal', detail: 'indexer stopped' } }
        : undefined,
    );
    await expect(ergo.pollTransaction(TX)).rejects.toThrow('indexer stopped');
  });

  it('refuses a malformed id before any request', async () => {
    const { ergo, calls } = chain(() => undefined);
    await expect(ergo.pollTransaction('../../info')).rejects.toThrow('64 hex');
    expect(calls.length).toBe(0);
  });
});

describe('submit and the pending-box view', () => {
  const funding = makeBox({
    ergoTree: ME_TREE,
    value: 5n * ERG,
    creationHeight: TIP - 30,
    assets: [{ tokenId: tokenId(3), amount: MAX_LONG }],
  });
  const routes =
    (submit: () => FakeResponse): Route =>
    (method, path) => {
      if (method === 'POST' && path.startsWith('/blockchain/box/unspent/byAddress'))
        return { body: [nodeBoxJson(funding)] };
      if (method === 'GET' && path === '/blocks/lastHeaders/10') return { body: HEADERS };
      if (method === 'POST' && path === '/transactions') return submit();
      return undefined;
    };

  it('passes the node rejection text to the caller and tracks nothing (T-2)', async () => {
    const detail = 'Malformed transaction: Scripts of all transaction inputs should pass verification';
    const { ergo } = chain(routes(() => ({ status: 400, body: { error: 400, reason: 'bad.request', detail } })));
    const built = await ergo.buildTransfer(ME, OTHER, ERG);
    const signed = await ergo.signTransaction(built, signer);
    const error = await ergo.submitTransaction(signed, built).then(
      () => null,
      (e) => e,
    );
    expect(error).toBeInstanceOf(ErgoNodeError);
    expect(error.status).toBe(400);
    expect(error.detail).toBe(detail);
    expect(error.message).toContain(detail);
    expect(ergo.pending.isSpent(funding.boxId)).toBe(false);
  });

  it('an unreachable node is an error with status 0, not a status code', async () => {
    const ergo = new Ergo('mainnet', {
      config: testConfig(),
      fetch: async () => {
        throw new Error('connect ECONNREFUSED');
      },
    });
    const error = await ergo.getCurrentBlockNumber().then(
      () => null,
      (e) => e,
    );
    expect(error).toBeInstanceOf(ErgoNodeError);
    expect(error.status).toBe(0);
    expect(error.message).toContain('ECONNREFUSED');
  });

  it('after a submit, the next build spends our unconfirmed change, not the spent box', async () => {
    let submitted: string | undefined;
    const node = fakeNode((method, path, body) => {
      if (method === 'GET' && path === '/info') return { body: infoBody() };
      if (method === 'POST' && path === '/transactions') {
        submitted = body;
        return { body: JSON.stringify(JSON.parse(body!).id) };
      }
      return routes(() => notFound())(method, path, body);
    });
    const ergo = new Ergo('mainnet', { config: testConfig(), fetch: node.fetch });
    const first = await ergo.buildTransfer(ME, OTHER, ERG, [{ tokenId: tokenId(3), amount: ABOVE_2_53 }]);
    const firstSigned = await ergo.signTransaction(first, signer);
    const firstId = await ergo.submitTransaction(firstSigned, first);
    expect(firstId).toBe(firstSigned.id);
    expect(submitted).toBe(firstSigned.json);

    // the node still lists the funding box (not indexed yet); the tracker hides it and offers the change
    const spendable = await ergo.getSpendableBoxes(ME);
    expect(spendable.map((b) => b.boxId)).not.toContain(funding.boxId);
    expect(spendable.length).toBe(1);
    expect(spendable[0].transactionId).toBe(firstId);
    expect(spendable[0].assets[0].amount).toBe(MAX_LONG - ABOVE_2_53);

    const second = await ergo.buildTransfer(ME, OTHER, ERG);
    expect(second.inputBoxes[0].transactionId).toBe(firstId);
    const secondSigned = await ergo.signTransaction(second, signer);
    expect(secondSigned.parsed.inputs[0].boxId).toBe(spendable[0].boxId);
  });
});

describe('fixed inputs and our own pending transactions', () => {
  it('refuses a fixed input that one of our pending transactions already spends', async () => {
    const pool = makeBox({ ergoTree: ME_TREE, value: 3n * ERG });
    const { ergo, calls } = chain(() => undefined);
    ergo.pending.record(TX, [pool.boxId], []);
    await expect(
      ergo.buildTransaction({
        changeAddress: ME,
        inputs: [{ box: pool }],
        walletBoxes: [],
        outputs: [{ ergoTree: ME_TREE, value: ERG }],
      }),
    ).rejects.toThrow('already spent by one of our pending transactions');
    expect(calls.length).toBe(0);
  });
});

describe('transfer', () => {
  it('unlocks the wallet, builds, checks, signs and submits; the posted body is the signed JSON', async () => {
    const funding = makeBox({ ergoTree: ME_TREE, value: 3n * ERG, creationHeight: TIP - 1 });
    let posted: string | undefined;
    const { ergo } = chain((method, path, body) => {
      if (method === 'POST' && path.startsWith('/blockchain/box/unspent/byAddress'))
        return { body: [nodeBoxJson(funding)] };
      if (method === 'GET' && path === '/blocks/lastHeaders/10') return { body: HEADERS };
      if (method === 'POST' && path === '/transactions') {
        posted = body;
        return { body: JSON.stringify(JSON.parse(body!).id) };
      }
      return undefined;
    });
    jest.spyOn(ergo, 'getWallet').mockResolvedValue({ address: ME, ergoTree: ME_TREE, signer });
    const txId = await ergo.transfer(ME, OTHER, 2n * ERG);
    const tx = JSON.parse(posted!);
    expect(tx.id).toBe(txId);
    expect(tx.inputs.map((i: { boxId: string }) => i.boxId)).toEqual([funding.boxId]);
    expect(BigInt(tx.outputs[0].value)).toBe(2n * ERG);
    expect(tx.outputs[tx.outputs.length - 1].ergoTree).toBe(FEE_TREE);
    expect(ergo.pending.isSpent(funding.boxId)).toBe(true);
  });
});

describe('balances and tokens', () => {
  const unlisted = tokenId(0x5e);
  const boxes = [
    makeBox({ ergoTree: ME_TREE, value: MAX_LONG, assets: [{ tokenId: SIGUSD, amount: ABOVE_2_53 }] }),
    makeBox({ ergoTree: ME_TREE, value: 1n, assets: [{ tokenId: unlisted, amount: 5n }] }),
  ];
  const route: Route = (method, path) => {
    if (method === 'POST' && path.startsWith('/blockchain/box/unspent/byAddress'))
      return { body: boxes.map((b) => nodeBoxJson(b)) };
    if (path === `/blockchain/token/byId/${unlisted}`)
      return { body: { id: unlisted, name: 'UNL', decimals: 1, emissionAmount: MAX_LONG } };
    if (path.startsWith('/blockchain/token/byId/')) return notFound();
    return undefined;
  };

  it('with no tokens named: native plus listed tokens held, in whole units', async () => {
    const { ergo } = chain(route);
    const balances = await ergo.getBalances(ME);
    expect(balances).toEqual([
      { key: 'ERG', symbol: 'ERG', address: null, balance: Number('9223372036.854775808') },
      { key: 'SigUSD', symbol: 'SigUSD', address: SIGUSD, balance: Number('90071992547409.93') },
    ]);
  });

  it('named by id: an unlisted token is read from the node by id', async () => {
    const { ergo } = chain(route);
    const balances = await ergo.getBalances(ME, [unlisted, 'erg', 'NOPE']);
    expect(balances).toEqual([
      { key: unlisted, symbol: 'UNL', address: unlisted, balance: 0.5 },
      { key: 'erg', symbol: 'ERG', address: null, balance: Number('9223372036.854775808') },
      { key: 'NOPE', symbol: null, address: null, balance: 0 },
    ]);
  });

  it('a symbol two tokens share is refused, never silently picked (D19)', async () => {
    const { ergo } = chain(route);
    jest.spyOn(ergo, 'getTokenList').mockResolvedValue([
      { address: tokenId(1), symbol: 'USD', name: 'one', decimals: 2 },
      { address: tokenId(2), symbol: 'usd', name: 'two', decimals: 2 },
    ]);
    await expect(ergo.getToken('USD')).rejects.toThrow(AmbiguousTokenError);
    await expect(ergo.getToken('USD')).rejects.toThrow(tokenId(1));
    expect((await ergo.getToken(tokenId(2)))?.name).toBe('two');
  });

  it('refuses an address of another network', async () => {
    const { ergo, calls } = chain(route);
    await expect(ergo.getBalances(GENERATOR_ADDRESSES[16])).rejects.toThrow('network prefix 16');
    expect(calls.length).toBe(0);
  });

  it('one class serves prefix 32 from config alone', async () => {
    const yoloAddress = encodeErgoAddress(ME_TREE, 32);
    const { ergo } = chain(route, { addressPrefix: 32, nativeCurrencySymbol: 'YOLO' });
    const balances = await ergo.getBalances(yoloAddress, ['YOLO']);
    expect(balances[0]).toEqual({
      key: 'YOLO',
      symbol: 'YOLO',
      address: null,
      balance: Number('9223372036.854775808'),
    });
    await expect(ergo.getBalances(ME)).rejects.toThrow('network prefix 0');
  });
});
