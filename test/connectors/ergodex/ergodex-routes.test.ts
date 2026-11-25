/**
 * /trading/amm/* for connector `ergodex` through Fastify inject, with the real chain
 * layer, real fleet-sdk and real wasm signing, and a node stand-in. Covers: a direct swap
 * returned as PENDING with its id; the pool spent between quote and execute (rebuild, or
 * a retryable 409); an unknown submit outcome (one POST, the id, poll); a pair-only quote
 * choosing the best pool; and the liquidity routes answering 501.
 */
import { ErgoBox } from '../../../src/chains/ergo/ergo.types';
import { Ergodex } from '../../../src/connectors/ergodex/ergodex';
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

  it('execute-swap: submitted and PENDING, with the id the node took, and no fill data', async () => {
    const res = await app.inject({ method: 'POST', url: '/trading/amm/execute-swap', payload: execBody() });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(posts()).toBe(1);
    const tx = JSON.parse(state.posted[0]);
    expect(body).toEqual({ signature: tx.id, status: 0 });
    // input 0 the pool, output 0 its successor with the same tree, tokens and R4
    expect(tx.inputs[0].boxId).toBe(RSN_POOL.boxId);
    expect(tx.outputs[0].ergoTree).toBe(RSN_POOL.ergoTree);
    expect(tx.outputs[0].additionalRegisters).toEqual({ R4: '04bc0f' });
    expect(BigInt(tx.outputs[0].value)).toBe(RSN_POOL.value + ERG);
    // the fee box carries no token (T-16); the received RSN is in the change at our address
    const fee = tx.outputs[tx.outputs.length - 1];
    expect(fee.assets).toEqual([]);
    const change = tx.outputs.slice(1, -1);
    expect(change.some((o: { assets: Array<{ tokenId: string }> }) => o.assets.some((a) => a.tokenId === RSN))).toBe(
      true,
    );
    expect(dex.ergo.pending.get(tx.id)).toBeDefined();
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
    expect(JSON.parse(res.body)).toEqual({ signature: second.id, status: 0 });
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

  it('a 5xx from the node is an unknown outcome too', async () => {
    state.submit = () => ({ status: 503, body: { error: 503, reason: 'unavailable', detail: 'busy' } });
    const res = await app.inject({ method: 'POST', url: '/trading/amm/execute-swap', payload: execBody() });
    expect(res.statusCode).toBe(504);
    expect(posts()).toBe(1);
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

it('the shipped ergodex config reaches the connector (config wiring)', () => {
  expect(dexConfig().spectrum.n2tPoolTrees[0]).toBe(N2T_TREE);
});
