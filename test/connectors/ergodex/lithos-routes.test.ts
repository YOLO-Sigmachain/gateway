/**
 * /trading/amm/* for connector `ergodex` on LithosDex pools, through Fastify inject, with
 * the real chain layer, real fleet-sdk, real signing (the version-3 library for these
 * pools) and a node stand-in holding pool and vault boxes captured from mainnet. Covers:
 * quote and execute on an ERG/token and a token/token pool (the pool at input 0 with the
 * swap operation byte, its successor at output 0, PENDING with pendingData); the pool box
 * spent between quote and execute (rebuild on the successor); the price bounds; pool
 * info; a pool off a non-empty lithos allowlist refused with nothing posted; and, with
 * the allowlist empty, a pair-only quote on a pool found by template hash.
 */
import { parseNodeJson } from '../../../src/chains/ergo/ergo.json';
import { WasmErgoSigner } from '../../../src/chains/ergo/ergo.signer';
import { ErgoBox } from '../../../src/chains/ergo/ergo.types';
import { Ergodex, NATIVE_TOKEN_ID } from '../../../src/connectors/ergodex/ergodex';
import { decodeBigInt, decodeCollLong } from '../../../src/connectors/ergodex/venues/lithos/lithos.math';
import { tradingAmmRoutes } from '../../../src/trading/trading.routes';
import { fastifyWithTypeProvider } from '../../utils/testUtils';

import { ERG, makeBox, ME, ME_TREE, MNEMONIC_A, newNodeState, NodeState, RSN, walletBox } from './ergodex-test-helpers';
import {
  L_TIP,
  LIT,
  LIT_NFT,
  LIT_POOL,
  LIT_RSN_NFT,
  LIT_RSN_POOL,
  LIT_RSN_VAULT,
  LIT_VAULT,
  lithosDexConfig,
  makeLithosDex,
  putPools,
} from './lithos-test-helpers';

jest.mock('../../../src/trading/learn-pool', () => ({ learnPool: jest.fn() }));

const execBody = (over: Record<string, unknown> = {}) => ({
  chainNetwork: 'ergo-mainnet',
  connector: 'ergodex',
  walletAddress: ME,
  baseToken: 'ERG',
  quoteToken: 'LIT',
  amount: 1,
  side: 'SELL',
  poolAddress: LIT_NFT,
  slippagePct: 1,
  ...over,
});

const quoteUrl = (over: Record<string, string> = {}) =>
  '/trading/amm/quote-swap?' +
  new URLSearchParams({
    chainNetwork: 'ergo-mainnet',
    connector: 'ergodex',
    baseToken: 'ERG',
    quoteToken: 'LIT',
    amount: '1',
    side: 'SELL',
    poolAddress: LIT_NFT,
    slippagePct: '1',
    ...over,
  });

/** Someone else's swap on `box`, paying `amountIn` of side x, as a mempool box. */
function othersSwap(dex: Ergodex, box: ErgoBox, amountIn: bigint): ErgoBox {
  const venue = dex.venueForTree(box.ergoTree)!;
  const pool = venue.parsePool(box)!;
  const spec = venue.successor(pool, { input: 'x', amountIn, amountOut: venue.amountOut(pool, 'x', amountIn) });
  return makeBox({
    ergoTree: spec.ergoTree,
    value: spec.value,
    assets: spec.assets,
    registers: spec.additionalRegisters,
    creationHeight: L_TIP,
    inclusionHeight: null,
  });
}

const rejectSpent = { status: 400, body: { error: 400, reason: 'bad.request', detail: 'Double spending attempt' } };

describe('ergodex on LithosDex pools through /trading/amm', () => {
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
    putPools(state, [
      [LIT_POOL, LIT_VAULT],
      [LIT_RSN_POOL, LIT_RSN_VAULT],
    ]);
    state.wallet = [
      walletBox(5n * ERG, [
        { tokenId: LIT, amount: 2000n * ERG },
        { tokenId: RSN, amount: 5000n },
      ]),
    ];
    dex = makeLithosDex(state);
    jest.spyOn(Ergodex, 'getInstance').mockImplementation(async () => dex);
  });

  afterEach(() => jest.restoreAllMocks());

  const posts = () => state.posted.length;

  it('quote-swap: the pool expected output as price, the slipped minimum apart, the LithosDex route', async () => {
    const res = await app.inject({ method: 'GET', url: quoteUrl() });
    expect(res.statusCode).toBe(200);
    const q = JSON.parse(res.body);
    expect(q.poolAddress).toBe(LIT_NFT);
    expect(q.tokenIn).toBe(NATIVE_TOKEN_ID);
    expect(q.tokenOut).toBe(LIT);
    expect(q.amountIn).toBe('1');
    expect(q.amountOut).toBe('241.428628025');
    expect(q.price).toBe('241.428628025');
    // floor(241428628025 * 0.99) = 239014341744
    expect(q.minAmountOut).toBe('239.014341744');
    expect(q.routePath).toContain(`lithos:n2t pool ${LIT_NFT} box ${LIT_POOL.boxId}`);
    expect(posts()).toBe(0);
  });

  it('execute-swap SELL on ERG:LIT: PENDING with pendingData; pool at input 0 with the operation byte, successor at output 0', async () => {
    const res = await app.inject({ method: 'POST', url: '/trading/amm/execute-swap', payload: execBody() });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(posts()).toBe(1);
    const tx = parseNodeJson<{
      id: string;
      inputs: Array<{ boxId: string; spendingProof: { proofBytes: string; extension: Record<string, string> } }>;
      dataInputs: unknown[];
      outputs: Array<{
        value: bigint;
        ergoTree: string;
        assets: Array<{ tokenId: string; amount: bigint }>;
        additionalRegisters: Record<string, string>;
      }>;
    }>(state.posted[0]);
    expect(body).toEqual({
      signature: tx.id,
      status: 0,
      pendingData: {
        tokenIn: NATIVE_TOKEN_ID,
        tokenOut: LIT,
        amountIn: '1',
        amountOut: '241.428628025',
        fee: '0.0011',
        baseTokenBalanceChange: '-1.0011',
        quoteTokenBalanceChange: '241.428628025',
        slippagePct: '1',
      },
    });
    expect(body).not.toHaveProperty('data');
    expect(tx.inputs[0].boxId).toBe(LIT_POOL.boxId);
    expect(tx.inputs[0].spendingProof).toEqual({ proofBytes: '', extension: { '0': '0200' } });
    expect(tx.dataInputs).toEqual([]);
    const succ = tx.outputs[0];
    expect(succ.ergoTree).toBe(LIT_POOL.ergoTree);
    expect(BigInt(succ.value)).toBe(LIT_POOL.value + ERG);
    expect(BigInt(succ.assets[1].amount)).toBe(LIT_POOL.assets[1].amount - 241428628025n);
    expect(decodeCollLong(succ.additionalRegisters.R6)).toEqual([331502945n + 1500000n, 86397776395n]);
    expect(decodeBigInt(succ.additionalRegisters.R7)).toBe(333662170938461643357895n);
    expect(succ.additionalRegisters.R8).toBe(LIT_POOL.additionalRegisters.R8);
    // the fee box is last, ERG only
    const fee = tx.outputs[tx.outputs.length - 1];
    expect(fee.assets).toEqual([]);
    expect(dex.ergo.pending.get(tx.id)).toBeDefined();
  });

  it('execute-swap BUY on LIT:RSN (exact output of RSN, paid in LIT)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/trading/amm/execute-swap',
      payload: execBody({ baseToken: 'RSN', quoteToken: 'LIT', side: 'BUY', poolAddress: LIT_RSN_NFT }),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.pendingData).toMatchObject({
      tokenIn: LIT,
      tokenOut: RSN,
      amountIn: '10.139671519',
      amountOut: '1',
      baseTokenBalanceChange: '1',
      quoteTokenBalanceChange: '-10.139671519',
    });
    const tx = parseNodeJson<{
      inputs: Array<{ boxId: string; spendingProof: { extension: Record<string, string> } }>;
      outputs: Array<{ value: bigint; assets: Array<{ amount: bigint }> }>;
    }>(state.posted[0]);
    expect(tx.inputs[0].boxId).toBe(LIT_RSN_POOL.boxId);
    expect(tx.inputs[0].spendingProof.extension).toEqual({ '0': '0200' });
    expect(BigInt(tx.outputs[0].value)).toBe(LIT_RSN_POOL.value);
    expect(tx.outputs[0].assets.map((a) => BigInt(a.amount))).toEqual([
      1n,
      234156222096602n,
      23398703n,
      999999999999998n,
    ]);
  });

  it('pool spent first, bound still holds: re-reads the successor, rebuilds on it and submits again', async () => {
    const successor = othersSwap(dex, LIT_POOL, ERG / 10n);
    let n = 0;
    state.submit = (body) => {
      n += 1;
      if (n === 1) {
        state.mempool.set(LIT_NFT, [successor]);
        state.mempoolSpent.add(LIT_POOL.boxId);
        return rejectSpent;
      }
      return { body: JSON.stringify(JSON.parse(body).id) };
    };
    const res = await app.inject({ method: 'POST', url: '/trading/amm/execute-swap', payload: execBody() });
    expect(res.statusCode).toBe(200);
    expect(posts()).toBe(2);
    const second = JSON.parse(state.posted[1]);
    expect(second.inputs[0].boxId).toBe(successor.boxId);
    expect(second.inputs[0].spendingProof.extension).toEqual({ '0': '0200' });
    expect(JSON.parse(res.body)).toMatchObject({ signature: second.id, status: 0, pendingData: { amountIn: '1' } });
  });

  it("the caller's minAmountOut refuses a swap the pool can no longer give, nothing posted", async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/trading/amm/execute-swap',
      payload: execBody({ minAmountOut: 241.5 }),
    });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).message).toMatch(/The pool moved.*at least 241\.5 LIT out/);
    expect(posts()).toBe(0);
  });

  it("someone else's unconfirmed swap moved the pool: bound by the confirmed pool box, a 409, nothing posted", async () => {
    // a large ERG buy of LIT in the mempool: the unconfirmed box gives far less LIT per ERG
    state.mempool.set(LIT_NFT, [othersSwap(dex, LIT_POOL, 100n * ERG)]);
    const res = await app.inject({ method: 'POST', url: '/trading/amm/execute-swap', payload: execBody() });
    expect(res.statusCode).toBe(409);
    expect(posts()).toBe(0);
  });

  it('BUY: maxAmountIn refuses a swap that would take more, nothing posted', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/trading/amm/execute-swap',
      payload: execBody({ baseToken: 'LIT', quoteToken: 'ERG', side: 'BUY', amount: 1000, maxAmountIn: 4.1 }),
    });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).message).toMatch(/at most 4\.1 ERG in/);
    expect(posts()).toBe(0);
  });

  it('pool-info on a LithosDex pool reports reserves net of pending fees', async () => {
    const url = `/trading/amm/pool-info?connector=ergodex&chainNetwork=ergo-mainnet&poolAddress=${LIT_NFT}`;
    const res = await app.inject({ method: 'GET', url });
    expect(res.statusCode).toBe(200);
    const info = JSON.parse(res.body);
    expect(info.address).toBe(LIT_NFT);
    expect(info.baseTokenAddress).toBe(NATIVE_TOKEN_ID);
    expect(info.quoteTokenAddress).toBe(LIT);
    expect(info.baseTokenAmount).toBe('1988.022040368'); // 1,988,353,543,313 - 331,502,945
    expect(info.quoteTokenAmount).toBe('481650.004877248'); // 481,736,402,653,643 - 86,397,776,395
    expect(info.feePct).toBe('0.299775'); // 1 - (9985/10000)^2, the costlier direction
  });

  it('a LithosDex pool off a non-empty lithos allowlist is refused for quote and execute, nothing posted', async () => {
    dex = makeLithosDex(state, lithosDexConfig([LIT_RSN_NFT]));
    const q = await app.inject({ method: 'GET', url: quoteUrl() });
    expect(q.statusCode).toBe(400);
    expect(JSON.parse(q.body).message).toContain('not on the lithos poolAllowlist');
    const e = await app.inject({ method: 'POST', url: '/trading/amm/execute-swap', payload: execBody() });
    expect(e.statusCode).toBe(400);
    expect(posts()).toBe(0);
  });

  it('a sale too small for its own fee to stay under the ceiling is refused on quote and execute; a normal one agrees', async () => {
    const rsnSale = { baseToken: 'RSN', quoteToken: 'LIT', poolAddress: LIT_RSN_NFT };
    for (const [amount, pct] of [
      ['0.002', '50.15'],
      ['0.02', '5.285'],
    ]) {
      const q = await app.inject({ method: 'GET', url: quoteUrl({ ...rsnSale, amount }) });
      expect(q.statusCode).toBe(400);
      const ceiling = new RegExp(`pays ${pct.replace('.', '\\.')}% of its input in fees, above maxPoolFeePct 3%`);
      expect(JSON.parse(q.body).message).toMatch(ceiling);
      const e = await app.inject({
        method: 'POST',
        url: '/trading/amm/execute-swap',
        payload: execBody({ ...rsnSale, amount: Number(amount) }),
      });
      expect(e.statusCode).toBe(400);
      expect(JSON.parse(e.body).message).toMatch(ceiling);
    }
    expect(posts()).toBe(0);
    // 1 RSN: the same quote as without the per-trade check, and execute moves exactly it
    const q = await app.inject({ method: 'GET', url: quoteUrl({ ...rsnSale, amount: '1' }) });
    expect(q.statusCode).toBe(200);
    expect(JSON.parse(q.body).amountOut).toBe('9.877515028');
    const e = await app.inject({ method: 'POST', url: '/trading/amm/execute-swap', payload: execBody(rsnSale) });
    expect(e.statusCode).toBe(200);
    expect(JSON.parse(e.body).pendingData).toMatchObject({ amountIn: '1', amountOut: '9.877515028' });
  });

  it('the key loaded for an execute is wiped once the send has settled, on success and on failure', async () => {
    const loaded: WasmErgoSigner[] = [];
    const disposed = () => loaded.map((l) => (l.dispose as jest.Mock).mock.calls.length);
    jest.spyOn(dex.ergo, 'getWallet').mockImplementation(async () => {
      const signer = WasmErgoSigner.fromMnemonic(MNEMONIC_A);
      jest.spyOn(signer, 'dispose');
      loaded.push(signer);
      return { address: ME, ergoTree: ME_TREE, signer };
    });
    // refused before the send (the caller's bound)
    const bound = await app.inject({
      method: 'POST',
      url: '/trading/amm/execute-swap',
      payload: execBody({ minAmountOut: 241.5 }),
    });
    expect(bound.statusCode).toBe(409);
    expect(disposed()).toEqual([1]);
    // signed, and refused by the node at submit
    const submit = state.submit;
    state.submit = () => ({ status: 400, body: { error: 400, reason: 'bad.request', detail: 'nope' } });
    const rejected = await app.inject({ method: 'POST', url: '/trading/amm/execute-swap', payload: execBody() });
    expect(rejected.statusCode).toBe(400);
    expect(posts()).toBe(1);
    expect(disposed()).toEqual([1, 1]);
    // taken by the node
    state.submit = submit;
    const ok = await app.inject({ method: 'POST', url: '/trading/amm/execute-swap', payload: execBody() });
    expect(ok.statusCode).toBe(200);
    expect(posts()).toBe(2);
    expect(disposed()).toEqual([1, 1, 1]);
    // a disposed signer cannot sign again
    const headers = { headers: (await dex.ergo.node.getLastHeaders(10)) as never };
    await expect(loaded[2].signTransaction({} as never, [], [], headers)).rejects.toThrow(/disposed/);
  });

  it('a quote with only a pair picks the LithosDex pool for it', async () => {
    const url =
      '/trading/amm/quote-swap?' +
      new URLSearchParams({
        chainNetwork: 'ergo-mainnet',
        connector: 'ergodex',
        baseToken: 'RSN',
        quoteToken: 'LIT',
        amount: '1',
        side: 'SELL',
      });
    const res = await app.inject({ method: 'GET', url });
    expect(res.statusCode).toBe(200);
    const q = JSON.parse(res.body);
    expect(q.poolAddress).toBe(LIT_RSN_NFT);
    expect(q.amountOut).toBe('9.877515028');
    expect(q.routePath).toContain('lithos:t2t');
  });

  it('with the lithos allowlist empty, a quote with only a pair picks the pool found by template hash', async () => {
    dex = makeLithosDex(state, lithosDexConfig([], { minPoolNativeReserve: 100n * ERG }));
    const url =
      '/trading/amm/quote-swap?' +
      new URLSearchParams({
        chainNetwork: 'ergo-mainnet',
        connector: 'ergodex',
        baseToken: 'RSN',
        quoteToken: 'LIT',
        amount: '1',
        side: 'SELL',
      });
    const res = await app.inject({ method: 'GET', url });
    expect(res.statusCode).toBe(200);
    const q = JSON.parse(res.body);
    expect(q.poolAddress).toBe(LIT_RSN_NFT);
    expect(q.amountOut).toBe('9.877515028');
    expect(state.calls.some((c) => c.path.startsWith('/blockchain/box/unspent/byTemplateHash/'))).toBe(true);
    expect(posts()).toBe(0);
  });
});
