/**
 * /trading/amm/* for connector `ergodex` through Fastify inject, with the real chain
 * layer, real fleet-sdk and real wasm signing, and a node stand-in. Covers: a direct swap
 * returned as PENDING with its id; the pool spent between quote and execute (rebuild, or
 * a retryable 409); the price bound at execute (the caller's limit, and the confirmed
 * pool when the box traded is someone else's unconfirmed one); an unknown submit outcome
 * (one POST, the id, poll); a rejection that does not name the pool box; a pair-only
 * quote choosing the best pool; and the liquidity routes answering 501. Also the shipped
 * ergodex template as the connector reads it.
 */
import * as fs from 'fs';
import * as path from 'path';

import * as yaml from 'js-yaml';

import { parseNodeJson } from '../../../src/chains/ergo/ergo.json';
import { normalizeNodeBox } from '../../../src/chains/ergo/ergo.node-client';
import { ErgoBox } from '../../../src/chains/ergo/ergo.types';
import { Ergodex, NATIVE_TOKEN_ID } from '../../../src/connectors/ergodex/ergodex';
import { ErgodexConfig } from '../../../src/connectors/ergodex/ergodex.config';
import { ConfigManagerV2 } from '../../../src/services/config-manager-v2';
import { AMM_CONNECTORS } from '../../../src/trading/connector-registry';
import { learnPool } from '../../../src/trading/learn-pool';
import { tradingAmmRoutes } from '../../../src/trading/trading.routes';
import { fastifyWithTypeProvider } from '../../utils/testUtils';

import {
  dexConfig,
  ERG,
  makeBox,
  makeDex,
  ME,
  N2T_TREE,
  n2tPool,
  newNodeState,
  NodeState,
  ROOT,
  RSN,
  RSN_POOL,
  T2T_TREE,
  TIP,
  walletBox,
} from './ergodex-test-helpers';

// bookkeeping after a fill writes to conf/; not what these tests are about
jest.mock('../../../src/trading/learn-pool', () => ({ learnPool: jest.fn() }));

const NFT = RSN_POOL.assets[0].tokenId;
const execBody = (over: Record<string, unknown> = {}) => ({
  chainNetwork: 'ergo-mainnet',
  connector: 'ergodex',
  walletAddress: ME,
  baseToken: 'ERG',
  quoteToken: 'RSN',
  amount: 1,
  side: 'SELL',
  poolAddress: NFT,
  slippagePct: 1,
  ...over,
});

/** Someone else's swap on `box`: they pay `ergIn` and the pool pays them the token. */
function othersSwap(dex: Ergodex, box: ErgoBox, ergIn: bigint): ErgoBox {
  const venue = dex.venueForTree(box.ergoTree)!;
  const pool = venue.parsePool(box)!;
  const spec = venue.successor(pool, { input: 'x', amountIn: ergIn, amountOut: venue.amountOut(pool, 'x', ergIn) });
  return makeBox({
    ergoTree: spec.ergoTree,
    value: spec.value,
    assets: spec.assets,
    registers: spec.additionalRegisters,
    creationHeight: TIP,
    inclusionHeight: null,
  });
}

/** The pool successor our posted transaction creates, read bigint-safe as the node lists it. */
function ourSuccessor(txJson: string): ErgoBox {
  const tx = parseNodeJson<{ id: string; outputs: Array<Record<string, unknown>> }>(txJson);
  return normalizeNodeBox({ ...tx.outputs[0], transactionId: tx.id, index: 0 });
}

const rejectSpent = { status: 400, body: { error: 400, reason: 'bad.request', detail: 'Double spending attempt' } };

describe('ergodex through /trading/amm', () => {
  let app: ReturnType<typeof fastifyWithTypeProvider>;
  let state: NodeState;
  let dex: Ergodex;

  beforeAll(async () => {
    app = fastifyWithTypeProvider();
    await app.register(require('@fastify/sensible'));
    await app.register(tradingAmmRoutes, { prefix: '/trading/amm' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    state = newNodeState();
    state.pools.set(NFT, [RSN_POOL]);
    state.wallet = [walletBox(5n * ERG)];
    dex = makeDex(state);
    jest.spyOn(Ergodex, 'getInstance').mockImplementation(async () => dex);
  });

  afterEach(() => jest.restoreAllMocks());

  const posts = () => state.posted.length;

  it('execute-swap: submitted and PENDING, with the id the node took and the amounts its transaction fixes', async () => {
    const res = await app.inject({ method: 'POST', url: '/trading/amm/execute-swap', payload: execBody() });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(posts()).toBe(1);
    const tx = JSON.parse(state.posted[0]);
    // still PENDING: the amounts are what it moves if it confirms, under pendingData. No
    // `data`, which the shared schema and its clients read as confirmed.
    expect(body).toEqual({
      signature: tx.id,
      status: 0,
      pendingData: {
        tokenIn: NATIVE_TOKEN_ID,
        tokenOut: RSN,
        amountIn: '1',
        amountOut: '23.693',
        fee: '0.0011',
        baseTokenBalanceChange: '-1.0011',
        quoteTokenBalanceChange: '23.693',
        slippagePct: '1',
      },
    });
    expect(body).not.toHaveProperty('data');
    // the same amounts, read from the posted transaction itself
    const changeAssets: Array<{ tokenId: string; amount: number }> = tx.outputs
      .slice(1, -1)
      .flatMap((o: { assets: Array<{ tokenId: string; amount: number }> }) => o.assets);
    const rsnReceived = changeAssets.filter((a) => a.tokenId === RSN).reduce((n, a) => n + BigInt(a.amount), 0n);
    expect(rsnReceived).toBe(23693n);
    // input 0 the pool, output 0 its successor with the same tree, tokens and R4
    expect(tx.inputs[0].boxId).toBe(RSN_POOL.boxId);
    expect(tx.outputs[0].ergoTree).toBe(RSN_POOL.ergoTree);
    expect(tx.outputs[0].additionalRegisters).toEqual({ R4: '04bc0f' });
    expect(BigInt(tx.outputs[0].value)).toBe(RSN_POOL.value + ERG);
    // the fee box carries no token; the received RSN is in the change at our address
    const fee = tx.outputs[tx.outputs.length - 1];
    expect(fee.assets).toEqual([]);
    const change = tx.outputs.slice(1, -1);
    expect(change.some((o: { assets: Array<{ tokenId: string }> }) => o.assets.some((a) => a.tokenId === RSN))).toBe(
      true,
    );
    expect(dex.ergo.pending.get(tx.id)).toBeDefined();
  });

  it('execute-swap does not try to learn the pool into the pool list: ergodex never reads that list', async () => {
    (learnPool as jest.Mock).mockClear();
    const res = await app.inject({ method: 'POST', url: '/trading/amm/execute-swap', payload: execBody() });
    expect(res.statusCode).toBe(200);
    expect(learnPool).not.toHaveBeenCalled();
  });

  it('pool spent first, bound still holds: re-reads the successor, rebuilds and submits again', async () => {
    const successor = othersSwap(dex, RSN_POOL, ERG / 10n);
    let n = 0;
    state.submit = (body) => {
      n += 1;
      if (n === 1) {
        state.mempool.set(NFT, [successor]);
        state.mempoolSpent.add(RSN_POOL.boxId);
        return rejectSpent;
      }
      return { body: JSON.stringify(JSON.parse(body).id) };
    };
    const res = await app.inject({ method: 'POST', url: '/trading/amm/execute-swap', payload: execBody() });
    expect(res.statusCode).toBe(200);
    expect(posts()).toBe(2);
    const second = JSON.parse(state.posted[1]);
    expect(second.inputs[0].boxId).toBe(successor.boxId);
    expect(JSON.parse(res.body)).toMatchObject({ signature: second.id, status: 0, pendingData: { amountIn: '1' } });
  });

  it('pool spent first and moved past the bound: a retryable 409, nothing more posted', async () => {
    const successor = othersSwap(dex, RSN_POOL, 20000n * ERG); // a big buy of RSN: ours now gets much less
    state.submit = () => {
      state.mempool.set(NFT, [successor]);
      state.mempoolSpent.add(RSN_POOL.boxId);
      return rejectSpent;
    };
    const res = await app.inject({ method: 'POST', url: '/trading/amm/execute-swap', payload: execBody() });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).message).toMatch(/The pool moved.*retry/);
    expect(posts()).toBe(1);
  });

  it('pool keeps changing: stops after maxRebuilds rebuilds with a retryable 409', async () => {
    let current = RSN_POOL;
    state.submit = () => {
      const next = othersSwap(dex, current, 1000000n);
      state.mempool.set(NFT, [next]);
      state.mempoolSpent.add(current.boxId);
      current = next;
      return rejectSpent;
    };
    const res = await app.inject({ method: 'POST', url: '/trading/amm/execute-swap', payload: execBody() });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).message).toContain('Retry');
    expect(posts()).toBe(1 + ROOT.maxRebuilds);
  });

  it('unknown outcome: one POST, a TRANSACTION_TIMEOUT error carrying the id, no rebuild', async () => {
    state.submit = () => 'throw';
    const res = await app.inject({ method: 'POST', url: '/trading/amm/execute-swap', payload: execBody() });
    expect(posts()).toBe(1);
    const id = JSON.parse(state.posted[0]).id;
    expect(res.statusCode).toBe(504);
    const body = JSON.parse(res.body);
    expect(body.code).toBe('TRANSACTION_TIMEOUT');
    expect(body.message).toContain(`Transaction ${id} pending`);
    expect(body.message).toContain('do not resubmit');
    // still tracked: its inputs are not offered to the next build
    expect(dex.ergo.pending.isSpent(RSN_POOL.boxId)).toBe(true);
  });

  it('the connection to the node is refused: a 503 that says nothing was submitted, and nothing tracked', async () => {
    state.submit = () => 'refused';
    const res = await app.inject({ method: 'POST', url: '/trading/amm/execute-swap', payload: execBody() });
    expect(posts()).toBe(1);
    expect(res.statusCode).toBe(503);
    const body = JSON.parse(res.body);
    expect(body.code).not.toBe('TRANSACTION_TIMEOUT');
    expect(body.message).toContain('was not submitted');
    expect(dex.ergo.pending.isSpent(RSN_POOL.boxId)).toBe(false);
  });

  it('a 5xx from the node is an unknown outcome too', async () => {
    state.submit = () => ({ status: 503, body: { error: 503, reason: 'unavailable', detail: 'busy' } });
    const res = await app.inject({ method: 'POST', url: '/trading/amm/execute-swap', payload: execBody() });
    expect(res.statusCode).toBe(504);
    expect(posts()).toBe(1);
  });

  describe('the price is bound at execute', () => {
    const quoteUrl = (over: Record<string, string> = {}) =>
      '/trading/amm/quote-swap?' +
      new URLSearchParams({
        chainNetwork: 'ergo-mainnet',
        connector: 'ergodex',
        baseToken: 'ERG',
        quoteToken: 'RSN',
        amount: '1',
        side: 'SELL',
        poolAddress: NFT,
        slippagePct: '1',
        ...over,
      });
    const execute = (over: Record<string, unknown> = {}) =>
      app.inject({ method: 'POST', url: '/trading/amm/execute-swap', payload: execBody(over) });
    /** RSN received by the swap in a posted transaction, from the pool's side. */
    const rsnOut = (txJson: string, before: ErgoBox) =>
      before.assets[2].amount - BigInt(JSON.parse(txJson).outputs[0].assets[2].amount);

    it("the pool moved (confirmed) between quote and execute: the caller's minAmountOut refuses it, nothing posted", async () => {
      const q = JSON.parse((await app.inject({ method: 'GET', url: quoteUrl() })).body);
      expect(q.amountOut).toBe('23.693');
      expect(q.minAmountOut).toBe('23.456');
      // someone else's 20,000 ERG buy of RSN confirms before our execute
      const moved = othersSwap(dex, RSN_POOL, 20000n * ERG);
      state.pools.set(NFT, [moved]);
      const res = await execute({ minAmountOut: Number(q.minAmountOut) });
      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body).message).toMatch(/The pool moved.*at least 23\.456 RSN out/);
      expect(posts()).toBe(0);
    });

    it('without minAmountOut the same execute still succeeds at the new price (back-compatible)', async () => {
      const moved = othersSwap(dex, RSN_POOL, 20000n * ERG);
      state.pools.set(NFT, [moved]);
      const res = await execute();
      expect(res.statusCode).toBe(200);
      expect(posts()).toBe(1);
      expect(JSON.parse(state.posted[0]).inputs[0].boxId).toBe(moved.boxId);
      expect(rsnOut(state.posted[0], moved)).toBe(20211n);
    });

    it("someone else's unconfirmed swap moved the pool: bound by the confirmed pool box, a 409, nothing posted", async () => {
      const moved = othersSwap(dex, RSN_POOL, 20000n * ERG);
      state.mempool.set(NFT, [moved]);
      state.mempoolSpent.add(RSN_POOL.boxId);
      const res = await execute();
      expect(res.statusCode).toBe(409);
      // 1% under the confirmed box's 23.693 RSN; the unconfirmed box gives 20.211
      expect(JSON.parse(res.body).message).toContain('now gives 20.211 RSN');
      expect(JSON.parse(res.body).message).toContain('at least 23.456 RSN out');
      expect(posts()).toBe(0);
    });

    it('an unconfirmed pool box from our own pending swap is traded on its own price', async () => {
      state.wallet = [walletBox(30000n * ERG)];
      const first = await execute({ amount: 20000 });
      expect(first.statusCode).toBe(200);
      const ours = ourSuccessor(state.posted[0]);
      state.mempool.set(NFT, [ours]);
      state.mempoolSpent.add(RSN_POOL.boxId);
      const second = await execute();
      expect(second.statusCode).toBe(200);
      expect(posts()).toBe(2);
      expect(JSON.parse(state.posted[1]).inputs[0].boxId).toBe(ours.boxId);
    });

    it("BUY: the caller's maxAmountIn refuses a swap that would take more, nothing posted", async () => {
      const res = await execute({ side: 'BUY', maxAmountIn: 0.001 });
      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body).message).toContain('at most 0.001 RSN in');
      expect(posts()).toBe(0);
    });

    it('a limit for the other side, or finer than the token, is a 400', async () => {
      const wrong = [
        await execute({ side: 'BUY', minAmountOut: 1 }),
        await execute({ side: 'SELL', maxAmountIn: 1 }),
        await execute({ minAmountOut: 23.4567 }),
      ];
      for (const r of wrong) expect(r.statusCode).toBe(400);
      expect(JSON.parse(wrong[2].body).message).toContain('minAmountOut');
      expect(posts()).toBe(0);
    });
  });

  it('a rejection that names a missing wallet input is not read as the pool spent: one POST, a 400 with the node text', async () => {
    const detail = 'Malformed transaction: Every input of the transaction should be in UTXO. Input 1 not found';
    state.submit = () => ({ status: 400, body: { error: 400, reason: 'bad.request', detail } });
    const res = await app.inject({ method: 'POST', url: '/trading/amm/execute-swap', payload: execBody() });
    expect(posts()).toBe(1);
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).message).toContain(detail);
    expect(dex.ergo.pending.isSpent(RSN_POOL.boxId)).toBe(false);
  });

  it('any other definite node rejection is a 400 with the node text; nothing is kept as pending', async () => {
    const detail = 'Malformed transaction: Scripts of all transaction inputs should pass verification';
    state.submit = () => ({ status: 400, body: { error: 400, reason: 'bad.request', detail } });
    const res = await app.inject({ method: 'POST', url: '/trading/amm/execute-swap', payload: execBody() });
    expect(posts()).toBe(1);
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).message).toContain(detail);
    expect(dex.ergo.pending.spentBoxIds().size).toBe(0);
  });

  it('a pool whose NFT was minted with a supply above 1 is refused, for quote and execute, nothing posted', async () => {
    state.emission.set(NFT, 2n);
    const quote = await app.inject({
      method: 'GET',
      url:
        '/trading/amm/quote-swap?' +
        new URLSearchParams({
          chainNetwork: 'ergo-mainnet',
          connector: 'ergodex',
          baseToken: 'ERG',
          quoteToken: 'RSN',
          amount: '1',
          side: 'SELL',
          poolAddress: NFT,
        }),
    });
    expect(quote.statusCode).toBe(400);
    expect(JSON.parse(quote.body).message).toContain('supply of 2, not 1');
    const exec = await app.inject({ method: 'POST', url: '/trading/amm/execute-swap', payload: execBody() });
    expect(exec.statusCode).toBe(400);
    expect(posts()).toBe(0);
  });

  it("the NFT's supply is asked of the node once per pool, then cached", async () => {
    const url =
      '/trading/amm/quote-swap?' +
      new URLSearchParams({
        chainNetwork: 'ergo-mainnet',
        connector: 'ergodex',
        baseToken: 'ERG',
        quoteToken: 'RSN',
        amount: '1',
        side: 'SELL',
        poolAddress: NFT,
      });
    expect((await app.inject({ method: 'GET', url })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url })).statusCode).toBe(200);
    expect(state.calls.filter((c) => c.path.startsWith('/blockchain/token/byId/')).length).toBe(1);
  });

  it('a limit JavaScript prints in exponent form is read exactly, not refused', async () => {
    // 4e-7 ERG is printed "4e-7"; as a BUY limit on ERG in it is read as 400 nanoERG exactly,
    // so it binds, and the answer names that bound, not an unreadable amount
    const res = await app.inject({
      method: 'POST',
      url: '/trading/amm/execute-swap',
      payload: execBody({ baseToken: 'RSN', quoteToken: 'ERG', side: 'BUY', amount: 1, maxAmountIn: 4e-7 }),
    });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).message).toContain('at most 0.0000004 ERG in');
    expect(posts()).toBe(0);
  });

  it('a whole-number limit above the largest exact integer is refused, stating the largest one', async () => {
    state.wallet = [walletBox(5n * ERG, [{ tokenId: RSN, amount: 100000n }])];
    const res = await app.inject({
      method: 'POST',
      url: '/trading/amm/execute-swap',
      headers: { 'content-type': 'application/json' },
      // written as the caller sent it: JSON reads it as the double 1e21
      payload: JSON.stringify(execBody({ side: 'BUY', amount: 1, maxAmountIn: 0 })).replace(
        '"maxAmountIn":0',
        '"maxAmountIn":1e21',
      ),
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).message).toContain('a whole number at most 9007199254740991');
    expect(posts()).toBe(0);
  });

  it('a limit sent as a string reaches the swap as a JSON number: above the largest exact integer it is refused', async () => {
    state.wallet = [walletBox(5n * ERG, [{ tokenId: RSN, amount: 100000n }])];
    const res = await app.inject({
      method: 'POST',
      url: '/trading/amm/execute-swap',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(execBody({ side: 'BUY', amount: 1, maxAmountIn: '9007199254740993' })),
    });
    expect(res.statusCode).toBe(400);
    const message = JSON.parse(res.body).message;
    expect(message).toContain('a whole number at most 9007199254740991');
    expect(message).not.toContain('as a string');
    expect(posts()).toBe(0);
  });

  describe('no connector named', () => {
    const quoteNoConnector = (chainNetwork: string) =>
      app.inject({
        method: 'GET',
        url:
          '/trading/amm/quote-swap?' +
          new URLSearchParams({
            chainNetwork,
            baseToken: 'ERG',
            quoteToken: 'RSN',
            amount: '1',
            side: 'SELL',
            poolAddress: NFT,
          }),
      });
    let configGet: jest.SpyInstance;
    beforeEach(() => {
      const manager = ConfigManagerV2.getInstance();
      const realGet = manager.get.bind(manager);
      configGet = jest
        .spyOn(manager, 'get')
        .mockImplementation((key: string) => (key === 'ergo-mainnet.swapProvider' ? 'ergodex/amm' : realGet(key)));
    });
    afterEach(() => configGet.mockRestore());

    it("on an Ergo network: the network's swapProvider is used for a quote", async () => {
      const res = await quoteNoConnector('ergo-mainnet');
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).routePath).toContain('spectrum:n2t');
    });

    it("on an Ergo network: the network's swapProvider is used for an execute", async () => {
      const { connector: _omitted, ...body } = execBody();
      const res = await app.inject({ method: 'POST', url: '/trading/amm/execute-swap', payload: body });
      expect(res.statusCode).toBe(200);
      expect(posts()).toBe(1);
    });

    it('a connector named for another chain is still refused on an Ergo network', async () => {
      const other = AMM_CONNECTORS.find((c) => c !== 'ergodex')!;
      const res = await app.inject({
        method: 'GET',
        url:
          '/trading/amm/quote-swap?' +
          new URLSearchParams({
            chainNetwork: 'ergo-mainnet',
            connector: other,
            baseToken: 'ERG',
            quoteToken: 'RSN',
            amount: '1',
            side: 'SELL',
            poolAddress: NFT,
          }),
      });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).message).toContain(`'${other}'`);
    });

    it('on Ethereum, unchanged: the schema default connector is used, as before', async () => {
      const res = await quoteNoConnector('ethereum-mainnet');
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).message).toContain(`'${AMM_CONNECTORS[0]}'`);
    });
  });

  it('the pool box spent by our own pending swap: waits for its successor before rebuilding', async () => {
    const WAIT_MS = 137;
    dex = makeDex(state, dexConfig(), { ...ROOT, rebuildWaitMs: WAIT_MS });
    const first = await app.inject({ method: 'POST', url: '/trading/amm/execute-swap', payload: execBody() });
    expect(first.statusCode).toBe(200);
    const ours = ourSuccessor(state.posted[0]);
    // The node lists our successor only once some time has passed: here, once the connector
    // waits. Without a wait, every rebuild re-reads the spent box and the swap ends in a 409.
    const realSetTimeout = global.setTimeout;
    const waits: number[] = [];
    jest.spyOn(global, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
      if (ms === WAIT_MS) {
        waits.push(ms);
        state.mempool.set(NFT, [ours]);
        state.mempoolSpent.add(RSN_POOL.boxId);
      }
      return realSetTimeout(fn, ms);
    }) as typeof setTimeout);
    const second = await app.inject({ method: 'POST', url: '/trading/amm/execute-swap', payload: execBody() });
    expect(waits).toEqual([WAIT_MS]);
    expect(second.statusCode).toBe(200);
    expect(posts()).toBe(2);
    expect(JSON.parse(state.posted[1]).inputs[0].boxId).toBe(ours.boxId);
  });

  it('a slippage that is not a plain decimal of at most 8 places is a 400', async () => {
    const quote = await app.inject({
      method: 'GET',
      url:
        '/trading/amm/quote-swap?' +
        new URLSearchParams({
          chainNetwork: 'ergo-mainnet',
          connector: 'ergodex',
          baseToken: 'ERG',
          quoteToken: 'RSN',
          amount: '1',
          side: 'SELL',
          poolAddress: NFT,
          slippagePct: '0.123456789',
        }),
    });
    expect(quote.statusCode).toBe(400);
    expect(JSON.parse(quote.body).message).toContain('slippagePct');
    const exec = await app.inject({
      method: 'POST',
      url: '/trading/amm/execute-swap',
      payload: execBody({ slippagePct: 1e-9 }),
    });
    expect(exec.statusCode).toBe(400);
    expect(JSON.parse(exec.body).message).toContain('slippagePct');
    expect(posts()).toBe(0);
  });

  it('a pool above the fee ceiling is refused before anything is built', async () => {
    const pricey = n2tPool({ x: 1000n * ERG, y: 5000000n, fee: 900, token: RSN, nft: 'fe'.repeat(32) });
    state.pools.set('fe'.repeat(32), [pricey]);
    const res = await app.inject({
      method: 'POST',
      url: '/trading/amm/execute-swap',
      payload: execBody({ poolAddress: 'fe'.repeat(32) }),
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).message).toContain('maxPoolFeePct');
    expect(posts()).toBe(0);
  });

  it('quote-swap with only a pair picks the best allowed pool by output', async () => {
    const shallow = n2tPool({ x: 50000n * ERG, y: 2000000000n, fee: 997, token: RSN, nft: 'fd'.repeat(32) });
    state.byTree.set(N2T_TREE, [RSN_POOL, shallow]);
    state.pools.set('fd'.repeat(32), [shallow]);
    const url =
      '/trading/amm/quote-swap?' +
      new URLSearchParams({
        chainNetwork: 'ergo-mainnet',
        connector: 'ergodex',
        baseToken: 'ERG',
        quoteToken: 'RSN',
        amount: '1',
        side: 'SELL',
      });
    const res = await app.inject({ method: 'GET', url });
    expect(res.statusCode).toBe(200);
    const q = JSON.parse(res.body);
    // 1 ERG: the second pool here is priced 40 RSN per ERG against about 24 in the deep live one
    expect(q.poolAddress).toBe('fd'.repeat(32));
    expect(q.routePath).toContain('spectrum:n2t');
  });

  it('pool-info answers for ergodex', async () => {
    const url = `/trading/amm/pool-info?connector=ergodex&chainNetwork=ergo-mainnet&poolAddress=${NFT}`;
    const res = await app.inject({ method: 'GET', url });
    expect(res.statusCode).toBe(200);
    const info = JSON.parse(res.body);
    expect(info.address).toBe(NFT);
    expect(info.quoteTokenAddress).toBe(RSN);
    expect(info.feePct).toBe('1'); // DecimalNumber: a decimal string on the wire
  });

  it('liquidity and position routes answer 501 not supported yet', async () => {
    const q = new URLSearchParams({
      connector: 'ergodex',
      chainNetwork: 'ergo-mainnet',
      poolAddress: NFT,
      baseTokenAmount: '1',
      quoteTokenAmount: '1',
    });
    const results = [
      await app.inject({ method: 'GET', url: `/trading/amm/quote-liquidity?${q}` }),
      await app.inject({
        method: 'POST',
        url: '/trading/amm/add',
        payload: {
          connector: 'ergodex',
          chainNetwork: 'ergo-mainnet',
          walletAddress: ME,
          poolAddress: NFT,
          baseTokenAmount: 1,
          quoteTokenAmount: 1,
        },
      }),
      await app.inject({
        method: 'POST',
        url: '/trading/amm/remove',
        payload: {
          connector: 'ergodex',
          chainNetwork: 'ergo-mainnet',
          walletAddress: ME,
          poolAddress: NFT,
          percentageToRemove: 50,
        },
      }),
      await app.inject({
        method: 'GET',
        url: `/trading/amm/position-info?connector=ergodex&chainNetwork=ergo-mainnet&poolAddress=${NFT}&walletAddress=${ME}`,
      }),
    ];
    for (const r of results) {
      expect(r.statusCode).toBe(501);
      expect(JSON.parse(r.body).message).toContain('not supported yet for ergodex');
    }
    expect(posts()).toBe(0);
  });
});

it('the shipped ergodex template, read as the connector reads it', () => {
  const template = yaml.load(
    fs.readFileSync(path.join(__dirname, '../../../src/templates/connectors/ergodex.yml'), 'utf8'),
  ) as Record<string, unknown>;
  jest
    .spyOn(ConfigManagerV2, 'getInstance')
    .mockReturnValue({ get: (k: string) => template[k.replace(/^ergodex\./, '')] } as never);
  const main = ErgodexConfig.network('mainnet');
  expect(main.spectrum.n2tPoolTrees).toEqual([N2T_TREE]);
  expect(main.spectrum.t2tPoolTrees).toEqual([T2T_TREE]);
  expect(main.spectrum.feeDenominator).toBe(1000n);
  expect(main.spectrum.n2tMinSuccessorValue).toBe(10000000n);
  expect(main.maxPoolFeePct).toBe('3');
  expect(main.minPoolNativeReserve).toBe(100000000000n);
  expect(main.maxDiscoveredBoxes).toBe(5000);
  expect(ErgodexConfig.root()).toEqual({ slippagePct: 1, maxRebuilds: 2, rebuildWaitMs: 500 });
  jest.restoreAllMocks();
});
