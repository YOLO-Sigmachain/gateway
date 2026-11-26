/**
 * /trading/amm liquidity and position routes for connector `ergodex` through Fastify
 * inject, with the real chain layer, real fleet-sdk and real wasm signing (a throw-away
 * test key), and a node stand-in; nothing leaves the process. Covers: quote-liquidity in
 * exact units; add and remove answered PENDING with the id, the posted transaction holding
 * exactly the plan; the rebuild when the pool box was spent first; the pool price bound
 * (on a rebuild, and against the confirmed box when someone else's unconfirmed box moved
 * it); submitMode not set (refused before the key is loaded) and `check` (checked only);
 * the guards; positions from confirmed LP balances, skipping a pool that fails a guard;
 * LithosDex pools and create-pool answering 501.
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
import { tradingAmmRoutes } from '../../../src/trading/trading.routes';
import { fastifyWithTypeProvider } from '../../utils/testUtils';

import {
  checkTestConfig,
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
  testConfig,
  TIP,
  TOKENS,
  walletBox,
  withoutSubmitMode,
} from './ergodex-test-helpers';
import { LIT_NFT, LIT_POOL, LIT_VAULT, makeLithosDex, putPools } from './lithos-test-helpers';

jest.mock('../../../src/trading/learn-pool', () => ({ learnPool: jest.fn() }));

const NFT = RSN_POOL.assets[0].tokenId;
const LP = RSN_POOL.assets[1].tokenId;
const X0 = RSN_POOL.value;
const Y0 = RSN_POOL.assets[2].amount;
const LP0 = RSN_POOL.assets[1].amount;
/** The pool's LP supply: 9223372036854775807 - 9223370866119426648. */
const SUPPLY = 1170735349159n;

const addBody = (over: Record<string, unknown> = {}) => ({
  chainNetwork: 'ergo-mainnet',
  connector: 'ergodex',
  walletAddress: ME,
  poolAddress: NFT,
  baseTokenAmount: 1,
  quoteTokenAmount: 100,
  slippagePct: 1,
  ...over,
});
const removeBody = (over: Record<string, unknown> = {}) => ({
  chainNetwork: 'ergo-mainnet',
  connector: 'ergodex',
  walletAddress: ME,
  poolAddress: NFT,
  percentageToRemove: 50,
  ...over,
});
const quoteUrl = (over: Record<string, string> = {}) =>
  '/trading/amm/quote-liquidity?' +
  new URLSearchParams({
    chainNetwork: 'ergo-mainnet',
    connector: 'ergodex',
    poolAddress: NFT,
    baseTokenAmount: '1',
    quoteTokenAmount: '100',
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

/** The pool successor a posted transaction creates, read as the node lists it. */
function successorOf(txJson: string): ErgoBox {
  const tx = parseNodeJson<{ id: string; outputs: Array<Record<string, unknown>> }>(txJson);
  return normalizeNodeBox({ ...tx.outputs[0], transactionId: tx.id, index: 0 });
}

interface PostedTx {
  id: string;
  inputs: Array<{ boxId: string }>;
  outputs: Array<{
    value: bigint;
    ergoTree: string;
    assets: Array<{ tokenId: string; amount: bigint }>;
    additionalRegisters: Record<string, string>;
  }>;
}

/** What the change outputs of a posted transaction hold of a token (null: ERG). */
function changeHolds(txJson: string, tokenId: string | null): bigint {
  const tx = parseNodeJson<PostedTx>(txJson);
  const change = tx.outputs.slice(1, -1);
  return tokenId === null
    ? change.reduce((n, o) => n + BigInt(o.value), 0n)
    : change.flatMap((o) => o.assets).reduce((n, a) => n + (a.tokenId === tokenId ? BigInt(a.amount) : 0n), 0n);
}

const rejectSpent = { status: 400, body: { error: 400, reason: 'bad.request', detail: 'Double spending attempt' } };

describe('ergodex liquidity through /trading/amm', () => {
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

  const useDex = (d: Ergodex) => {
    dex = d;
    jest.spyOn(Ergodex, 'getInstance').mockImplementation(async () => dex);
  };

  beforeEach(() => {
    state = newNodeState();
    state.pools.set(NFT, [RSN_POOL]);
    // the LP token as the node's index knows it: 0 decimals
    state.emission.set(LP, 9223372036854774807n);
    state.wallet = [walletBox(5n * ERG, [{ tokenId: RSN, amount: 100000n }])];
    useDex(makeDex(state));
  });

  afterEach(() => jest.restoreAllMocks());

  const posts = () => state.posted.length;
  const add = (over: Record<string, unknown> = {}) =>
    app.inject({ method: 'POST', url: '/trading/amm/add', payload: addBody(over) });
  const remove = (over: Record<string, unknown> = {}) =>
    app.inject({ method: 'POST', url: '/trading/amm/remove', payload: removeBody(over) });

  describe('quote-liquidity', () => {
    it('base limits: the proportional amounts in exact units, and the offer to make for the slippage', async () => {
      const res = await app.inject({ method: 'GET', url: quoteUrl({ slippagePct: '1' }) });
      expect(res.statusCode).toBe(200);
      // 1 ERG buys floor(1e9 * S / X0) = 4,867,691 LP, for ceil(LP * X0 / S) = 999,999,878 nanoERG
      // and ceil(LP * Y0 / S) = 23,934 RSN units; 24,174 is 23,934 raised by 1%, rounded up
      expect(JSON.parse(res.body)).toEqual({
        poolAddress: NFT,
        baseLimited: true,
        baseTokenAmount: '0.999999878',
        quoteTokenAmount: '23.934',
        baseTokenAmountMax: '0.999999878',
        quoteTokenAmountMax: '24.174',
      });
      expect(posts()).toBe(0);
    });

    it('quote limits, and 0 on a side means no limit there', async () => {
      const limited = JSON.parse(
        (await app.inject({ method: 'GET', url: quoteUrl({ baseTokenAmount: '100', quoteTokenAmount: '10' }) })).body,
      );
      const open = JSON.parse(
        (await app.inject({ method: 'GET', url: quoteUrl({ baseTokenAmount: '0', quoteTokenAmount: '10' }) })).body,
      );
      expect(limited).toEqual(open);
      expect(open).toMatchObject({
        baseLimited: false,
        baseTokenAmount: '0.417826184',
        quoteTokenAmount: '10',
        baseTokenAmountMax: '0.422004446',
        quoteTokenAmountMax: '10',
      });
    });

    it('a deposit that buys no LP token, and an offer of nothing, are 400s', async () => {
      const dust = await app.inject({
        method: 'GET',
        url: quoteUrl({ baseTokenAmount: '0.000000001', quoteTokenAmount: '100' }),
      });
      expect(dust.statusCode).toBe(400);
      expect(JSON.parse(dust.body).message).toContain('buys no LP token');
      const none = await app.inject({ method: 'GET', url: quoteUrl({ baseTokenAmount: '0', quoteTokenAmount: '0' }) });
      expect(none.statusCode).toBe(400);
    });

    it('an amount finer than the token is a 400', async () => {
      const res = await app.inject({ method: 'GET', url: quoteUrl({ quoteTokenAmount: '1.0001' }) });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).message).toContain('quoteTokenAmount');
    });
  });

  describe('add', () => {
    it('submitted and PENDING with the id; the transaction deposits exactly the quoted amounts', async () => {
      const res = await add();
      expect(res.statusCode).toBe(200);
      expect(posts()).toBe(1);
      const tx = parseNodeJson<PostedTx>(state.posted[0]);
      // PENDING carries no `data`: that means confirmed
      expect(JSON.parse(res.body)).toEqual({ signature: tx.id, status: 0 });
      expect(tx.inputs[0].boxId).toBe(RSN_POOL.boxId);
      const out0 = tx.outputs[0];
      expect(out0.ergoTree).toBe(RSN_POOL.ergoTree);
      expect(out0.additionalRegisters).toEqual(RSN_POOL.additionalRegisters);
      expect(BigInt(out0.value)).toBe(X0 + 999999878n);
      expect(out0.assets.map((a) => a.tokenId)).toEqual(RSN_POOL.assets.map((a) => a.tokenId));
      expect(BigInt(out0.assets[1].amount)).toBe(LP0 - 4867691n);
      expect(BigInt(out0.assets[2].amount)).toBe(Y0 + 23934n);
      // the wallet gets the LP tokens and keeps the RSN the ratio did not take
      expect(changeHolds(state.posted[0], LP)).toBe(4867691n);
      expect(changeHolds(state.posted[0], RSN)).toBe(100000n - 23934n);
      expect(changeHolds(state.posted[0], null)).toBe(5n * ERG - 999999878n - 1100000n);
      const fee = tx.outputs[tx.outputs.length - 1];
      expect(fee.assets).toEqual([]);
      expect(dex.ergo.pending.get(tx.id)).toBeDefined();
    });

    it('a zero on either side is a 400, nothing posted', async () => {
      const res = await add({ quoteTokenAmount: 0 });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).message).toContain('both must be above zero');
      expect(posts()).toBe(0);
    });

    it('more than the wallet holds is a 400, nothing posted', async () => {
      // 100 ERG limits this offer (10,000 RSN would buy more LP), and the wallet holds 5
      const res = await add({ baseTokenAmount: 100, quoteTokenAmount: 10000 });
      expect(res.statusCode).toBe(400);
      expect(posts()).toBe(0);
    });

    it('pool spent first, price still in bound: re-reads the successor, rebuilds and submits again', async () => {
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
      const res = await add();
      expect(res.statusCode).toBe(200);
      expect(posts()).toBe(2);
      const second = JSON.parse(state.posted[1]);
      expect(second.inputs[0].boxId).toBe(successor.boxId);
      expect(JSON.parse(res.body)).toEqual({ signature: second.id, status: 0 });
    });

    it('pool spent first and its price moved past the bound: a 409, nothing more posted', async () => {
      const successor = othersSwap(dex, RSN_POOL, 20000n * ERG);
      state.submit = () => {
        state.mempool.set(NFT, [successor]);
        state.mempoolSpent.add(RSN_POOL.boxId);
        return rejectSpent;
      };
      const res = await add();
      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body).message).toMatch(/The pool moved: the pool price is now .* more than 1% from/);
      expect(posts()).toBe(1);
    });

    it('a wider slippage lets the same rebuild through', async () => {
      const successor = othersSwap(dex, RSN_POOL, 20000n * ERG);
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
      const res = await add({ slippagePct: 30 });
      expect(res.statusCode).toBe(200);
      expect(posts()).toBe(2);
    });

    it("someone else's unconfirmed swap moved the pool: bound by the confirmed box, a 409, nothing posted", async () => {
      const moved = othersSwap(dex, RSN_POOL, 20000n * ERG);
      state.mempool.set(NFT, [moved]);
      state.mempoolSpent.add(RSN_POOL.boxId);
      const res = await add();
      expect(res.statusCode).toBe(409);
      // 1% around the confirmed box's 23.93 RSN per ERG; the unconfirmed box is at 20.42
      expect(JSON.parse(res.body).message).toContain(
        `now 20.415292775904096 RSN per ERG, more than 1% from 23.9333889614416 on spectrum:n2t pool ${NFT}`,
      );
      expect(JSON.parse(res.body).message).toContain('(confirmed)');
      expect(posts()).toBe(0);
    });

    it('an unconfirmed pool box from our own pending deposit is built on as it is', async () => {
      state.wallet = [walletBox(50n * ERG, [{ tokenId: RSN, amount: 10000000n }])];
      expect((await add({ baseTokenAmount: 10, quoteTokenAmount: 10000 })).statusCode).toBe(200);
      const ours = successorOf(state.posted[0]);
      state.mempool.set(NFT, [ours]);
      state.mempoolSpent.add(RSN_POOL.boxId);
      const second = await add();
      expect(second.statusCode).toBe(200);
      expect(posts()).toBe(2);
      expect(JSON.parse(state.posted[1]).inputs[0].boxId).toBe(ours.boxId);
    });

    it('a pool below the size guard is refused before anything is built', async () => {
      useDex(makeDex(state, dexConfig({ minPoolNativeReserve: 10n ** 6n * ERG })));
      const res = await add();
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).message).toContain('minPoolNativeReserve');
      expect(posts()).toBe(0);
    });

    it('a pool not on the allowlist is refused', async () => {
      useDex(makeDex(state, dexConfig({ poolAllowlist: ['fe'.repeat(32)] })));
      const res = await add();
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).message).toContain('not on the allowlist');
    });

    it('submitMode not set: a 503 before any read, and the key is never loaded', async () => {
      useDex(makeDex(state, dexConfig(), ROOT, TOKENS, withoutSubmitMode(testConfig())));
      const res = await add();
      expect(res.statusCode).toBe(503);
      expect(JSON.parse(res.body).message).toContain('submitMode is not set');
      expect(dex.ergo.getWallet).not.toHaveBeenCalled();
      expect(state.calls).toEqual([]);
      const rem = await remove();
      expect(rem.statusCode).toBe(503);
      expect(dex.ergo.getWallet).not.toHaveBeenCalled();
    });

    it('submitMode check: checked by the node only, a 409 saying what it would move, nothing posted or kept', async () => {
      useDex(makeDex(state, dexConfig(), ROOT, TOKENS, checkTestConfig()));
      const res = await add();
      expect(res.statusCode).toBe(409);
      const message = JSON.parse(res.body).message;
      expect(message).toContain('Check only');
      expect(message).toContain('nothing was sent');
      expect(message).toContain('a deposit of 0.999999878 ERG and 23.934 RSN');
      expect(message).toContain('for 4867691 LP tokens');
      expect(posts()).toBe(0);
      expect(state.checked.length).toBe(1);
      expect(dex.ergo.pending.spentBoxIds().size).toBe(0);
    });

    it('without the LP constant in config: a 501 that names the key', async () => {
      useDex(makeDex(state, dexConfig({}, { lockedLiquidity: undefined })));
      const res = await add();
      expect(res.statusCode).toBe(501);
      expect(JSON.parse(res.body).message).toContain('spectrum.lockedLiquidity');
    });
  });

  describe('remove', () => {
    const HELD = 4867691n;
    beforeEach(() => {
      state.wallet = [walletBox(ERG / 10n, [{ tokenId: LP, amount: HELD }])];
    });

    it('half the LP tokens: PENDING, and the transaction takes out exactly the most the pool allows', async () => {
      const res = await remove();
      expect(res.statusCode).toBe(200);
      expect(posts()).toBe(1);
      const tx = parseNodeJson<PostedTx>(state.posted[0]);
      expect(JSON.parse(res.body)).toEqual({ signature: tx.id, status: 0 });
      // floor(4,867,691 / 2) = 2,433,845 LP; floor(LP * X0 / S) and floor(LP * Y0 / S)
      const lp = 2433845n;
      const x = (lp * X0) / SUPPLY;
      const y = (lp * Y0) / SUPPLY;
      expect([x, y]).toEqual([499999836n, 11966n]);
      const out0 = tx.outputs[0];
      expect(BigInt(out0.value)).toBe(X0 - x);
      expect(BigInt(out0.assets[1].amount)).toBe(LP0 + lp);
      expect(BigInt(out0.assets[2].amount)).toBe(Y0 - y);
      expect(changeHolds(state.posted[0], LP)).toBe(HELD - lp);
      expect(changeHolds(state.posted[0], RSN)).toBe(y);
      expect(changeHolds(state.posted[0], null)).toBe(ERG / 10n + x - 1100000n);
    });

    it('all of it', async () => {
      const res = await remove({ percentageToRemove: 100 });
      expect(res.statusCode).toBe(200);
      const out0 = parseNodeJson<PostedTx>(state.posted[0]).outputs[0];
      expect(BigInt(out0.assets[1].amount)).toBe(LP0 + HELD);
      expect(changeHolds(state.posted[0], LP)).toBe(0n);
    });

    it('no LP tokens, or a percentage of zero, is a 400, nothing posted', async () => {
      const zero = await remove({ percentageToRemove: 0 });
      expect(zero.statusCode).toBe(400);
      state.wallet = [walletBox(ERG)];
      const none = await remove();
      expect(none.statusCode).toBe(400);
      expect(JSON.parse(none.body).message).toContain('holds no LP tokens');
      expect(posts()).toBe(0);
    });

    it('a redeem whose side rounds to zero is a 400', async () => {
      state.wallet = [walletBox(ERG, [{ tokenId: LP, amount: 100n }])];
      const res = await remove({ percentageToRemove: 10 });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).message).toContain('rounds to zero');
      expect(posts()).toBe(0);
    });

    it('pool spent first and moved past the bound: a 409, nothing more posted', async () => {
      const successor = othersSwap(dex, RSN_POOL, 20000n * ERG);
      state.submit = () => {
        state.mempool.set(NFT, [successor]);
        state.mempoolSpent.add(RSN_POOL.boxId);
        return rejectSpent;
      };
      const res = await remove({ slippagePct: 1 });
      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body).message).toContain('The pool moved');
      expect(posts()).toBe(1);
    });

    it('pool spent first, in bound: rebuilt on the successor', async () => {
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
      const res = await remove();
      expect(res.statusCode).toBe(200);
      expect(posts()).toBe(2);
      expect(JSON.parse(state.posted[1]).inputs[0].boxId).toBe(successor.boxId);
    });

    it('submitMode check: a 409 that says what it would move', async () => {
      useDex(makeDex(state, dexConfig(), ROOT, TOKENS, checkTestConfig()));
      const res = await remove();
      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body).message).toContain('a redeem of 2433845 LP tokens');
      expect(posts()).toBe(0);
    });
  });

  describe('positions', () => {
    const posInfo = () =>
      app.inject({
        method: 'GET',
        url: `/trading/amm/position-info?connector=ergodex&chainNetwork=ergo-mainnet&poolAddress=${NFT}&walletAddress=${ME}`,
      });

    it('position-info: the LP balance and what a redeem of all of it would pay', async () => {
      state.wallet = [walletBox(ERG, [{ tokenId: LP, amount: 4867691n }])];
      const res = await posInfo();
      expect(res.statusCode).toBe(200);
      const pos = JSON.parse(res.body);
      const info = JSON.parse(
        (
          await app.inject({
            method: 'GET',
            url: `/trading/amm/pool-info?connector=ergodex&chainNetwork=ergo-mainnet&poolAddress=${NFT}`,
          })
        ).body,
      );
      expect(pos).toEqual({
        poolAddress: NFT,
        walletAddress: ME,
        baseTokenAddress: NATIVE_TOKEN_ID,
        quoteTokenAddress: RSN,
        lpTokenAmount: '4867691',
        // floor(4,867,691 * X0 / S) and floor(4,867,691 * Y0 / S): one unit under the deposit that bought it
        baseTokenAmount: '0.999999877',
        quoteTokenAmount: '23.933',
        price: info.price,
      });
    });

    it('position-info with no LP tokens: zero amounts', async () => {
      const pos = JSON.parse((await posInfo()).body);
      expect(pos).toMatchObject({ lpTokenAmount: '0', baseTokenAmount: '0', quoteTokenAmount: '0' });
    });

    it('positions-owned: each pool whose LP token the wallet holds, skipping a pool that fails a guard', async () => {
      const small = n2tPool({ x: 50n * ERG, y: 1000000n, fee: 997, token: RSN, nft: 'fd'.repeat(32) });
      state.byTree.set(N2T_TREE, [RSN_POOL, small]);
      state.pools.set('fd'.repeat(32), [small]);
      state.wallet = [
        walletBox(ERG, [
          { tokenId: LP, amount: 4867691n },
          { tokenId: small.assets[1].tokenId, amount: 1000n },
          { tokenId: RSN, amount: 5n },
        ]),
      ];
      useDex(makeDex(state, dexConfig({ minPoolNativeReserve: 100n * ERG })));
      const res = await app.inject({
        method: 'GET',
        url: `/trading/amm/positions-owned?connector=ergodex&chainNetwork=ergo-mainnet&walletAddress=${ME}`,
      });
      expect(res.statusCode).toBe(200);
      const list = JSON.parse(res.body);
      expect(list.map((p: { poolAddress: string }) => p.poolAddress)).toEqual([NFT]);
      expect(list[0].lpTokenAmount).toBe('4867691');
    });

    it('positions-owned with nothing held: an empty list', async () => {
      state.byTree.set(N2T_TREE, [RSN_POOL]);
      const res = await app.inject({
        method: 'GET',
        url: `/trading/amm/positions-owned?connector=ergodex&chainNetwork=ergo-mainnet&walletAddress=${ME}`,
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual([]);
    });
  });

  describe('not offered', () => {
    it('a LithosDex pool: 501 for quote, add, remove and position-info, before admission; nothing posted', async () => {
      putPools(state, [[LIT_POOL, LIT_VAULT]]);
      useDex(makeLithosDex(state));
      const results = [
        await app.inject({ method: 'GET', url: quoteUrl({ poolAddress: LIT_NFT }) }),
        await add({ poolAddress: LIT_NFT }),
        await remove({ poolAddress: LIT_NFT }),
        await app.inject({
          method: 'GET',
          url: `/trading/amm/position-info?connector=ergodex&chainNetwork=ergo-mainnet&poolAddress=${LIT_NFT}&walletAddress=${ME}`,
        }),
      ];
      for (const r of results) {
        expect(r.statusCode).toBe(501);
        expect(JSON.parse(r.body).message).toContain('pools is not supported by ergodex');
        expect(JSON.parse(r.body).message).toContain('provision boxes');
      }
      expect(posts()).toBe(0);
    });

    it('create-pool still answers 501', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/trading/amm/create-pool',
        payload: {
          connector: 'ergodex',
          chainNetwork: 'ergo-mainnet',
          walletAddress: ME,
          baseToken: 'ERG',
          quoteToken: 'RSN',
          baseTokenAmount: 1,
          quoteTokenAmount: 1,
        },
      });
      expect(res.statusCode).toBe(501);
      expect(JSON.parse(res.body).message).toContain('create-pool is not supported yet for ergodex');
    });
  });
});

it('the shipped ergodex template sets the LP constant for both networks', () => {
  const template = yaml.load(
    fs.readFileSync(path.join(__dirname, '../../../src/templates/connectors/ergodex.yml'), 'utf8'),
  ) as Record<string, unknown>;
  jest
    .spyOn(ConfigManagerV2, 'getInstance')
    .mockReturnValue({ get: (k: string) => template[k.replace(/^ergodex\./, '')] } as never);
  expect(ErgodexConfig.network('mainnet').spectrum.lockedLiquidity).toBe(9223372036854775807n);
  expect(ErgodexConfig.network('testnet').spectrum.lockedLiquidity).toBe(9223372036854775807n);
  jest.restoreAllMocks();
});
