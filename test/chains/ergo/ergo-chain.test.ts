/**
 * The Ergo chain class against a node stand-in: poll states, the node's rejection text,
 * mempool-aware boxes, balances and token identity, and a transfer end to end (built with
 * real fleet, signed with real wasm, submitted to the stand-in).
 */
import * as path from 'path';

import * as yaml from 'js-yaml';

import { AmbiguousTokenError, Ergo, ErgoTransactionRejectedError } from '../../../src/chains/ergo/ergo';
import { ErgoNodeError } from '../../../src/chains/ergo/ergo.node-client';
import { ErgoSigner, WasmErgoSigner } from '../../../src/chains/ergo/ergo.signer';
import { buildUnsignedTransaction, ErgoTransactionAssertionError } from '../../../src/chains/ergo/ergo.tx-builder';
import { addressFromPublicKey, encodeErgoAddress, NATIVE_COIN_ID } from '../../../src/chains/ergo/ergo.utils';
import { balanceResponse } from '../../../src/chains/wallet-balances';
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

  // The node's numConfirmations counts blocks after the inclusion block: 0 at the tip.
  const indexedAs = (inclusionHeight: number, numConfirmations: number) => (_m: string, p: string) => {
    if (p === `/transactions/unconfirmed/byTransactionId/${TX}`) return notFound();
    if (p === `/blockchain/transaction/byId/${TX}`) return { body: { ...tx, inclusionHeight, numConfirmations } };
    return undefined;
  };

  it('confirmed: indexed with enough confirmations', async () => {
    const { ergo } = chain(indexedAs(TIP - 2, 2));
    const r = await ergo.pollTransaction(TX);
    expect(r.txStatus).toBe(TransactionStatusCode.CONFIRMED);
    expect(r.txBlock).toBe(TIP - 2);
    expect(r.fee).toBe(0.0011);
    expect(r.currentBlock).toBe(TIP);
  });

  it('confirmed with confirmations 1 when included in the tip block (node says 0)', async () => {
    const { ergo } = chain(indexedAs(TIP, 0), { confirmations: 1 });
    const r = await ergo.pollTransaction(TX);
    expect(r.txStatus).toBe(TransactionStatusCode.CONFIRMED);
    expect(r.txBlock).toBe(TIP);
  });

  it('pending: indexed but fewer confirmations than the network config asks for', async () => {
    const { ergo } = chain(indexedAs(TIP, 0), { confirmations: 3 });
    const r = await ergo.pollTransaction(TX);
    expect(r.txStatus).toBe(TransactionStatusCode.PENDING);
    expect(r.txBlock).toBe(TIP);
  });

  it('pending, not "not found", when a block lands mid-poll and the index has not taken it yet', async () => {
    // /info said TIP; the transaction left the mempool for block TIP+1, which the index lacks
    const { ergo } = chain((_m, p) => {
      if (p.startsWith('/blockchain/transaction/byId/') || p.startsWith('/transactions/unconfirmed/'))
        return notFound();
      if (p === '/blockchain/indexedHeight') return { body: { indexedHeight: TIP, fullHeight: TIP + 1 } };
      return undefined;
    });
    const r = await ergo.pollTransaction(TX);
    expect(r.txStatus).toBe(TransactionStatusCode.PENDING);
  });

  it('asks the mempool before the index, so a transaction moving into a block is not missed', async () => {
    const { ergo, calls } = chain((_m, p) => {
      if (p.startsWith('/transactions/unconfirmed/')) return notFound();
      if (p === `/blockchain/transaction/byId/${TX}`)
        return { body: { ...tx, inclusionHeight: TIP, numConfirmations: 0 } };
      return undefined;
    });
    await ergo.pollTransaction(TX);
    const paths = calls.map((c) => c.path);
    expect(paths.findIndex((p) => p.startsWith('/transactions/unconfirmed/'))).toBeLessThan(
      paths.findIndex((p) => p.startsWith('/blockchain/transaction/byId/')),
    );
  });

  it('pending: in the mempool (not failed)', async () => {
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
      if (p === '/blockchain/indexedHeight') return { body: { indexedHeight: TIP, fullHeight: TIP } };
      return undefined;
    });
    ergo.pending.record(TX, [input.boxId], [], '{}');
    const r = await ergo.pollTransaction(TX);
    expect(r.txStatus).toBe(TransactionStatusCode.FAILED);
    expect(r.error).toContain(other);
    expect(ergo.pending.isSpent(input.boxId)).toBe(false);
  });

  it('surfaces a node error rather than turning it into a status', async () => {
    const { ergo } = chain((_m, p) => {
      if (p.startsWith('/transactions/unconfirmed/')) return notFound();
      return p.startsWith('/blockchain/transaction/byId/')
        ? { status: 500, body: { error: 500, reason: 'internal', detail: 'indexer stopped' } }
        : undefined;
    });
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

  it('passes the node rejection text to the caller and tracks nothing', async () => {
    const detail = 'Malformed transaction: Scripts of all transaction inputs should pass verification';
    const { ergo } = chain(routes(() => ({ status: 400, body: { error: 400, reason: 'bad.request', detail } })));
    const built = await ergo.buildTransfer(ME, OTHER, ERG);
    const signed = await ergo.signTransaction(built, signer);
    const error = await ergo.submitTransaction(signed, built).then(
      () => null,
      (e) => e,
    );
    expect(error).toBeInstanceOf(ErgoNodeError);
    expect(error).toBeInstanceOf(ErgoTransactionRejectedError);
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
    ergo.pending.record(TX, [pool.boxId], [], '{}');
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

  it('refuses a data input that one of our pending transactions already spends', async () => {
    const lp = makeBox({ ergoTree: ME_TREE, value: 3n * ERG });
    const { ergo, calls } = chain(() => undefined);
    ergo.pending.record(TX, [lp.boxId], [], '{}');
    await expect(
      ergo.buildTransaction({
        changeAddress: ME,
        dataInputs: [lp],
        walletBoxes: [makeBox({ ergoTree: ME_TREE, value: 5n * ERG })],
        outputs: [{ ergoTree: ME_TREE, value: ERG }],
      }),
    ).rejects.toThrow(`Data input ${lp.boxId} is already spent by one of our pending transactions`);
    expect(calls.length).toBe(0);
  });
});

describe('miner fee limits', () => {
  const funding = makeBox({ ergoTree: ME_TREE, value: 5n * ERG, creationHeight: TIP - 30 });
  const node = (method: string, path: string) => {
    if (method === 'GET' && path === '/blocks/lastHeaders/10') return { body: HEADERS };
    return undefined;
  };

  it('refuses a requested fee above maxMinerFee or below minerFee before any node request', async () => {
    const { ergo, calls } = chain(node);
    const request = { changeAddress: ME, walletBoxes: [funding], outputs: [{ ergoTree: ME_TREE, value: ERG }] };
    await expect(ergo.buildTransaction({ ...request, fee: ergo.config.maxMinerFee + 1n })).rejects.toThrow(
      'outside the allowed range',
    );
    await expect(ergo.buildTransaction({ ...request, fee: ergo.config.minerFee - 1n })).rejects.toThrow(
      'outside the allowed range',
    );
    expect(calls.length).toBe(0);
    const ok = await ergo.buildTransaction({ ...request, fee: ergo.config.maxMinerFee });
    expect(ok.fee).toBe(ergo.config.maxMinerFee);
  });

  it('refuses to sign a built transaction whose fee is above maxMinerFee', async () => {
    const { ergo } = chain(node);
    const built = buildUnsignedTransaction({
      height: TIP,
      minValuePerByte: 360n,
      fee: ergo.config.maxMinerFee + 1n,
      feeErgoTree: FEE_TREE,
      changeErgoTree: ME_TREE,
      walletBoxes: [funding],
      outputs: [{ ergoTree: ME_TREE, value: ERG }],
    });
    const spy: ErgoSigner = { publicKeys: signer.publicKeys, signTransaction: jest.fn() };
    await expect(ergo.signTransaction(built, spy)).rejects.toThrow(ErgoTransactionAssertionError);
    await expect(ergo.signTransaction(built, spy)).rejects.toThrow('above maxMinerFee');
    expect(spy.signTransaction).not.toHaveBeenCalled();
  });
});

describe('box listing limit', () => {
  it('refuses a partial set when every page it may read is full', async () => {
    const box = makeBox({ ergoTree: ME_TREE, value: ERG });
    const { ergo, calls } = chain(
      (method, path) =>
        method === 'POST' && path.startsWith('/blockchain/box/unspent/byAddress')
          ? { body: [nodeBoxJson(box)] }
          : undefined,
      { boxPageSize: 1 },
    );
    await expect(ergo.getSpendableBoxes(ME)).rejects.toThrow('refusing to report a partial set');
    expect(calls.filter((c) => c.path.startsWith('/blockchain/box/unspent/byAddress')).length).toBe(1000);
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

  // The token list is fixed here, not read from this machine's untracked conf/.
  let listSpy: jest.SpyInstance;
  beforeEach(() => {
    listSpy = jest
      .spyOn(Ergo.prototype, 'getTokenList')
      .mockResolvedValue([{ address: SIGUSD, symbol: 'SigUSD', name: 'SigUSD', decimals: 2 }]);
  });
  afterEach(() => listSpy.mockRestore());

  it('a held token the node has no decimals for yet is refused, not reported as 0, and not cached', async () => {
    const fresh = tokenId(0x5a);
    const held = makeBox({ ergoTree: ME_TREE, value: ERG, assets: [{ tokenId: fresh, amount: 700n }] });
    let nodeKnowsToken = false;
    const { ergo } = chain((method, path) => {
      if (method === 'POST' && path.startsWith('/blockchain/box/unspent/byAddress'))
        return { body: [nodeBoxJson(held)] };
      if (path === `/blockchain/token/byId/${fresh}`)
        return nodeKnowsToken ? { body: { id: fresh, name: 'FRESH', decimals: 0, emissionAmount: 700 } } : notFound();
      return undefined;
    });
    listSpy.mockResolvedValue([]);
    const first = await ergo.getBalances(ME, [fresh]).then(
      () => null,
      (e) => e,
    );
    expect(first.statusCode).toBe(503);
    expect(first.message).toContain('held but the node has no decimals');
    nodeKnowsToken = true;
    const second = await ergo.getBalances(ME, [fresh]);
    expect(second).toEqual([{ key: fresh, symbol: 'FRESH', address: fresh, balance: 700 }]);
  });

  it('a listed token named like the native currency does not overwrite the native balance', async () => {
    const fake = tokenId(0x6b);
    const held = makeBox({ ergoTree: ME_TREE, value: 5n * ERG, assets: [{ tokenId: fake, amount: 1n }] });
    const { ergo } = chain((method, path) =>
      method === 'POST' && path.startsWith('/blockchain/box/unspent/byAddress')
        ? { body: [nodeBoxJson(held)] }
        : undefined,
    );
    listSpy.mockResolvedValue([{ address: fake, symbol: 'ERG', name: 'fake', decimals: 9 }]);
    const res = balanceResponse(await ergo.getBalances(ME));
    expect(res.balances.ERG).toBe(5);
    expect(res.balances[fake]).toBe(0.000000001);
  });

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

  it('a symbol two tokens share is refused, never silently picked', async () => {
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

describe('a pending transaction is forgotten only on evidence, never for its age', () => {
  const input = makeBox({ ergoTree: ME_TREE, value: 5n * ERG, creationHeight: TIP - 30 });
  const TIMEOUT_MS = 15 * 120 * 1000; // pendingTxTimeoutBlocks x blockTimeSeconds in testConfig

  function setup(box: () => FakeResponse, confirmed: () => FakeResponse = notFound) {
    let now = 0;
    const node = fakeNode((method, p) => {
      if (method === 'GET' && p === '/info') return { body: infoBody() };
      if (method === 'POST' && p.startsWith('/blockchain/box/unspent/byAddress')) return { body: [nodeBoxJson(input)] };
      if (p.startsWith('/transactions/unconfirmed/byTransactionId/')) return notFound();
      if (p === `/blockchain/transaction/byId/${TX}`) return confirmed();
      if (p === '/blockchain/indexedHeight') return { body: { indexedHeight: TIP, fullHeight: TIP } };
      if (p === `/blockchain/box/byId/${input.boxId}`) return box();
      return undefined;
    });
    const ergo = new Ergo('mainnet', { config: testConfig(), fetch: node.fetch, now: () => now });
    ergo.pending.record(TX, [input.boxId], [], '{}');
    const boxReads = () => node.calls.filter((c) => c.path === `/blockchain/box/byId/${input.boxId}`).length;
    return { ergo, boxReads, advance: (ms: number) => (now += ms) };
  }

  it('kept past the timeout while its inputs are unspent: its inputs stay hidden', async () => {
    const { ergo, boxReads, advance } = setup(() => ({ body: nodeBoxJson(input) }));
    advance(TIMEOUT_MS + 1);
    expect(await ergo.getSpendableBoxes(ME)).toEqual([]);
    expect(ergo.pending.get(TX)).toBeDefined();
    expect(boxReads()).toBe(1); // the node was asked; the clock decided nothing
  });

  it('checked again at most once per block time', async () => {
    const { ergo, boxReads, advance } = setup(() => ({ body: nodeBoxJson(input) }));
    advance(TIMEOUT_MS + 1);
    await ergo.getSpendableBoxes(ME);
    await ergo.getSpendableBoxes(ME);
    expect(boxReads()).toBe(1);
    advance(120_000);
    await ergo.getSpendableBoxes(ME);
    expect(boxReads()).toBe(2);
  });

  it('not checked before the timeout', async () => {
    const { ergo, boxReads, advance } = setup(() => ({ body: nodeBoxJson(input) }));
    advance(TIMEOUT_MS - 1);
    await ergo.getSpendableBoxes(ME);
    expect(boxReads()).toBe(0);
  });

  it('released past the timeout once an input is spent by another transaction', async () => {
    const { ergo, advance } = setup(() => ({ body: nodeBoxJson(input, { spentTransactionId: 'ee'.repeat(32) }) }));
    advance(TIMEOUT_MS + 1);
    await ergo.getSpendableBoxes(ME);
    expect(ergo.pending.get(TX)).toBeUndefined();
  });

  it('released past the timeout once it is confirmed', async () => {
    const { ergo, advance } = setup(
      () => ({ body: nodeBoxJson(input, { spentTransactionId: TX }) }),
      () => ({ body: { id: TX, inputs: [], outputs: [], inclusionHeight: TIP - 2, numConfirmations: 2 } }),
    );
    advance(TIMEOUT_MS + 1);
    await ergo.getSpendableBoxes(ME);
    expect(ergo.pending.get(TX)).toBeUndefined();
  });

  it('an input neither the index nor a tracked transaction knows: forgotten at the timeout, as before', async () => {
    const { ergo, advance } = setup(notFound);
    advance(TIMEOUT_MS + 1);
    await ergo.getSpendableBoxes(ME);
    expect(ergo.pending.get(TX)).toBeUndefined();
  });

  it('a node error during the check keeps the entry', async () => {
    const { ergo, advance } = setup(() => ({ status: 500, body: { error: 500, reason: 'internal', detail: 'x' } }));
    advance(TIMEOUT_MS + 1);
    await ergo.getSpendableBoxes(ME);
    expect(ergo.pending.get(TX)).toBeDefined();
  });
});

describe('poll of a chained transaction whose input is our own unconfirmed change', () => {
  const PARENT = 'c1'.repeat(32);
  const funding = makeBox({ ergoTree: ME_TREE, value: 5n * ERG, creationHeight: TIP - 30 });
  const change = makeBox({ ergoTree: ME_TREE, value: 3n * ERG, transactionId: PARENT, inclusionHeight: null });

  function setup() {
    const node = fakeNode((method, p) => {
      if (method === 'GET' && p === '/info') return { body: infoBody() };
      if (p.startsWith('/transactions/unconfirmed/byTransactionId/')) return notFound();
      if (p.startsWith('/blockchain/transaction/byId/')) return notFound();
      if (p === '/blockchain/indexedHeight') return { body: { indexedHeight: TIP, fullHeight: TIP } };
      if (p === `/blockchain/box/byId/${funding.boxId}`) return { body: nodeBoxJson(funding) };
      if (p === `/blockchain/box/byId/${change.boxId}`) return notFound(); // unconfirmed: not indexed
      return undefined;
    });
    const ergo = new Ergo('mainnet', { config: testConfig(), fetch: node.fetch });
    ergo.pending.record(PARENT, [funding.boxId], [change], '{}');
    ergo.pending.record(TX, [change.boxId], [], '{}');
    return { ergo, calls: node.calls };
  }

  it('answers pending, naming the tracked parent, and posts nothing', async () => {
    const { ergo, calls } = setup();
    const r = await ergo.pollTransaction(TX);
    expect(r.txStatus).toBe(TransactionStatusCode.PENDING);
    expect(r.txData).toEqual({ note: expect.stringContaining(PARENT) });
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
    expect(ergo.pending.get(TX)).toBeDefined();
  });

  it('once the parent is no longer tracked, the same transaction reads as not found', async () => {
    const { ergo } = setup();
    ergo.pending.release(PARENT);
    expect((await ergo.pollTransaction(TX)).txStatus).toBe(TransactionStatusCode.NOT_FOUND);
  });
});

describe('the native coin in the shipped token lists', () => {
  const realFs = jest.requireActual<typeof import('fs')>('fs');
  const templates = path.join(__dirname, '../../../src/templates');

  it.each(['mainnet', 'testnet'])(
    '%s lists the native coin under the all-zero id, as its network config names it',
    (net) => {
      const list = JSON.parse(realFs.readFileSync(path.join(templates, 'tokens/ergo', `${net}.json`), 'utf8'));
      const config = yaml.load(
        realFs.readFileSync(path.join(templates, 'chains/ergo', `${net}.yml`), 'utf8'),
      ) as Record<string, unknown>;
      const native = list.filter((t: { address: string }) => t.address === NATIVE_COIN_ID);
      expect(native).toEqual([
        { name: 'Ergo', symbol: config.nativeCurrencySymbol, address: NATIVE_COIN_ID, decimals: config.nativeDecimals },
      ]);
    },
  );

  it('the chain reads the list without that entry: the native coin stays the network config native coin', async () => {
    const text = realFs.readFileSync(path.join(templates, 'tokens/ergo/mainnet.json'), 'utf8');
    const held = makeBox({ ergoTree: ME_TREE, value: 5n * ERG });
    const { ergo } = chain((method, p) =>
      method === 'POST' && p.startsWith('/blockchain/box/unspent/byAddress')
        ? { body: [nodeBoxJson(held)] }
        : undefined,
    );
    // the shipped list stands in for conf/'s copy of it
    const isList = (file: unknown) => String(file).endsWith(path.join('tokens', 'ergo', 'mainnet.json'));
    const originalExists = realFs.existsSync.bind(realFs);
    const originalRead = realFs.readFileSync.bind(realFs);
    const exists = jest.spyOn(realFs, 'existsSync').mockImplementation((file) => isList(file) || originalExists(file));
    const read = jest
      .spyOn(realFs, 'readFileSync')
      .mockImplementation(((file: string, ...rest: unknown[]) =>
        isList(file) ? text : originalRead(file, ...(rest as []))) as never);
    try {
      const list = await ergo.getTokenList();
      expect(list.some((t) => t.address === NATIVE_COIN_ID)).toBe(false);
      expect(list.length).toBe(JSON.parse(text).length - 1);
      const balances = await ergo.getBalances(ME);
      expect(balances.filter((b) => b.symbol === 'ERG')).toEqual([
        { key: 'ERG', symbol: 'ERG', address: null, balance: 5 },
      ]);
      // named by the all-zero id, the native balance is answered, not a zero for an unknown token
      expect(await ergo.getBalances(ME, [NATIVE_COIN_ID])).toEqual([
        { key: NATIVE_COIN_ID, symbol: 'ERG', address: null, balance: 5 },
      ]);
      expect((await ergo.getBalances(ME, ['erg']))[0].balance).toBe(5);
    } finally {
      exists.mockRestore();
      read.mockRestore();
    }
  });
});

describe('token emission', () => {
  it('is read from the node once and cached; an unknown token is not cached', async () => {
    const nft = tokenId(0x7e);
    let known = false;
    const { ergo, calls } = chain((_m, p) => {
      if (p === `/blockchain/token/byId/${nft}`)
        return known ? { body: { id: nft, name: '', decimals: 0, emissionAmount: 1 } } : notFound();
      return undefined;
    });
    expect(await ergo.getTokenEmission(nft)).toBeNull();
    known = true;
    expect(await ergo.getTokenEmission(nft)).toBe(1n);
    expect(await ergo.getTokenEmission(nft)).toBe(1n);
    expect(calls.filter((c) => c.path.startsWith('/blockchain/token/byId/')).length).toBe(2);
  });
});
