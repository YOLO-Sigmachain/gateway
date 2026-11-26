/**
 * /trading/amm liquidity and position routes for connector `ergodex` through Fastify
 * inject, with the real chain layer, real fleet-sdk and real wasm signing (a throw-away
 * test key), and a node stand-in; nothing leaves the process. Covers: quote-liquidity in
 * exact units; add and remove answered PENDING with the id and `pendingData` equal to what
 * the posted transaction does to the wallet (both pool kinds), the posted transaction holding
 * exactly the plan; remove by an exact `lpTokenAmount`; the rebuild when the pool box was spent first; the pool price bound
 * (on a rebuild, and against the confirmed box when someone else's unconfirmed box moved
 * it); submitMode not set (refused before the key is loaded) and `check` (checked only);
 * the guards on entry only (remove and the position reads go ahead on a pool an entry
 * guard refuses); a box at a pool tree that is not the pool of the LP token it holds,
 * refused everywhere and ignored by positions-owned; two boxes at pool trees holding enough
 * of one LP token that the pool cannot be told apart (a 409); an NFT of supply 2 in two
 * boxes (a 400, skipped by positions-owned); a removal the pool cannot pay naming
 * what it can; positions from confirmed LP balances; LithosDex pools and create-pool
 * answering 501.
 */
import * as fs from 'fs';
import * as path from 'path';

import * as yaml from 'js-yaml';

import { parseNodeJson } from '../../../src/chains/ergo/ergo.json';
import { normalizeNodeBox } from '../../../src/chains/ergo/ergo.node-client';
import { ErgoBox } from '../../../src/chains/ergo/ergo.types';
import { formatUnits, parseUnits } from '../../../src/chains/ergo/ergo.utils';
import { percentToRemove, removeLiquidity } from '../../../src/connectors/ergodex/amm-routes/liquidity';
import { Ergodex, NATIVE_TOKEN_ID } from '../../../src/connectors/ergodex/ergodex';
import { ErgodexConfig } from '../../../src/connectors/ergodex/ergodex.config';
import { encodeLong } from '../../../src/connectors/ergodex/venues/lithos/lithos.math';
import { ergoTreeConstants } from '../../../src/connectors/ergodex/venues/spectrum/spectrum.math';
import { ConfigManagerV2 } from '../../../src/services/config-manager-v2';
import { logger } from '../../../src/services/logger';
import { tradingAmmRoutes } from '../../../src/trading/trading.routes';
import { fastifyWithTypeProvider } from '../../utils/testUtils';

import {
  checkTestConfig,
  dexConfig,
  ERG,
  makeBox,
  makeDex,
  ME,
  ME_TREE,
  N2T_TREE,
  n2tPool,
  newNodeState,
  NodeState,
  R4,
  ROOT,
  RSN,
  RSN_POOL,
  T2T_POOL,
  T2T_TREE,
  testConfig,
  TIP,
  TOKENS,
  walletBox,
  withoutSubmitMode,
  WT_ADA,
  WT_ERG,
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

/** The LP token's emission as the node reports it: the contract's constant less 1000. */
const LP_EMISSION = 9223372036854774807n;

/**
 * A box anyone can create: at the real token/token pool tree, with an NFT of its own, one
 * unit of the ERG/RSN pool's LP token, and two junk tokens of near-largest supply.
 */
const FAKE_NFT = 'f1'.repeat(32);
const FX = 'f2'.repeat(32);
const FY = 'f3'.repeat(32);
const FAKE_POOL = makeBox({
  ergoTree: T2T_TREE,
  value: 4000000n,
  creationHeight: TIP - 5,
  assets: [
    { tokenId: FAKE_NFT, amount: 1n },
    { tokenId: LP, amount: 1n },
    { tokenId: FX, amount: 2n ** 63n - 2n },
    { tokenId: FY, amount: 2n ** 63n - 2n },
  ],
  registers: { R4: R4(997) },
});

/** The same, at the ERG/token pool tree. */
const FAKE_N2T_NFT = 'f4'.repeat(32);
const FAKE_N2T_POOL = makeBox({
  ergoTree: N2T_TREE,
  value: ERG,
  creationHeight: TIP - 5,
  assets: [
    { tokenId: FAKE_N2T_NFT, amount: 1n },
    { tokenId: LP, amount: 1n },
    { tokenId: FX, amount: 1000n },
  ],
  registers: { R4: R4(997) },
});

const positionsOwnedUrl = `/trading/amm/positions-owned?connector=ergodex&chainNetwork=ergo-mainnet&walletAddress=${ME}`;
const positionInfoUrl = (pool: string) =>
  `/trading/amm/position-info?connector=ergodex&chainNetwork=ergo-mainnet&poolAddress=${pool}&walletAddress=${ME}`;

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
    state.emission.set(LP, LP_EMISSION);
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
      // PENDING carries no `data`, which means confirmed; what it fixes is in pendingData
      expect(JSON.parse(res.body)).toEqual({
        signature: tx.id,
        status: 0,
        pendingData: {
          fee: '0.0011',
          poolAddress: NFT,
          baseTokenAmountAdded: '0.999999878',
          quoteTokenAmountAdded: '23.934',
          lpTokenAmountAdded: '4867691',
        },
      });
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
      // pendingData is from the rebuilt transaction, the one that was sent
      const body = JSON.parse(res.body);
      expect(body).toMatchObject({ signature: second.id, status: 0 });
      expect(body.pendingData.lpTokenAmountAdded).toBe(String(changeHolds(state.posted[1], LP)));
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
      expect(JSON.parse(res.body)).toEqual({
        signature: tx.id,
        status: 0,
        pendingData: {
          fee: '0.0011',
          poolAddress: NFT,
          baseTokenAmountRemoved: '0.499999836',
          quoteTokenAmountRemoved: '11.966',
          lpTokenAmountRemoved: '2433845',
        },
      });
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

    /** The LP tokens a posted redeem returns to the pool. */
    const redeemedLp = () => BigInt(parseNodeJson<PostedTx>(state.posted[0]).outputs[0].assets[1].amount) - LP0;

    it.each([
      // 100/3 as a JSON number has 17 significant digits; cut to 33.33333333
      [100 / 3, 3333333333n],
      [12.123456789, 1212345678n],
    ])('a percentage of %p is cut to 8 decimals, never refused for its precision', async (pct, scaled) => {
      const res = await remove({ percentageToRemove: pct });
      expect(res.statusCode).toBe(200);
      expect(redeemedLp()).toBe((HELD * scaled) / 10n ** 10n);
    });

    it('a percentage that is 0 once cut to 8 decimals is a 400, nothing posted', async () => {
      const res = await remove({ percentageToRemove: 0.000000001 });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).message).toContain('percentageToRemove must be above 0 and at most 100');
      expect(posts()).toBe(0);
    });

    it('a sole provider asking for all of it on an ERG/token pool: a 400 naming what can be removed now', async () => {
      // the wallet holds every LP token minted: the supply less the 1000 that never exist
      const all = SUPPLY - 1000n;
      state.wallet = [walletBox(ERG, [{ tokenId: LP, amount: all }])];
      const res = await remove({ percentageToRemove: 100 });
      expect(res.statusCode).toBe(400);
      const message: string = JSON.parse(res.body).message;
      expect(message).toContain('not above its storage floor 10000000');
      const m = /at most (\d+) LP tokens, ([\d.]+)% of the wallet's (\d+), can be removed now/.exec(message);
      expect(m).not.toBeNull();
      const most = BigInt(m![1]);
      expect(BigInt(m![3])).toBe(all);
      // the most is exact: the pool keeps more than its floor and some RSN for it, and not for one more
      const pays = (lp: bigint) => X0 - (lp * X0) / SUPPLY > 10000000n && Y0 - (lp * Y0) / SUPPLY > 0n;
      expect(pays(most)).toBe(true);
      expect(pays(most + 1n)).toBe(false);
      expect(posts()).toBe(0);
      // the percentage named, sent back, removes at most that much and is submitted
      const pct = m![2];
      expect(parseUnits(pct, 8)).toBe((most * 10n ** 10n) / all);
      const ok = await remove({ percentageToRemove: Number(pct) });
      expect(ok.statusCode).toBe(200);
      expect(redeemedLp() <= most).toBe(true);
      expect(redeemedLp()).toBe((all * ((most * 10n ** 10n) / all)) / 10n ** 10n);
    });

    describe('by lpTokenAmount: an exact number of LP tokens', () => {
      const exact = (lpTokenAmount: unknown, over: Record<string, unknown> = {}) =>
        remove({ percentageToRemove: undefined, lpTokenAmount, ...over });

      it('returns exactly that many LP tokens to the pool and keeps the rest in the wallet', async () => {
        const res = await exact(1234567);
        expect(res.statusCode).toBe(200);
        expect(posts()).toBe(1);
        const tx = parseNodeJson<PostedTx>(state.posted[0]);
        const lp = 1234567n;
        const x = (lp * X0) / SUPPLY;
        const y = (lp * Y0) / SUPPLY;
        const out0 = tx.outputs[0];
        expect(BigInt(out0.assets[1].amount)).toBe(LP0 + lp);
        expect(BigInt(out0.value)).toBe(X0 - x);
        expect(BigInt(out0.assets[2].amount)).toBe(Y0 - y);
        expect(changeHolds(state.posted[0], LP)).toBe(HELD - lp);
        expect(changeHolds(state.posted[0], RSN)).toBe(y);
        const body = JSON.parse(res.body);
        expect(body).not.toHaveProperty('data');
        expect(body.pendingData).toEqual({
          fee: '0.0011',
          poolAddress: NFT,
          baseTokenAmountRemoved: formatUnits(x, 9),
          quoteTokenAmountRemoved: formatUnits(y, 3),
          lpTokenAmountRemoved: '1234567',
        });
      });

      it('all the wallet holds, named exactly', async () => {
        const res = await exact(Number(HELD));
        expect(res.statusCode).toBe(200);
        expect(redeemedLp()).toBe(HELD);
        expect(changeHolds(state.posted[0], LP)).toBe(0n);
      });

      it('more than the wallet can spend is a 400 naming both amounts, never cut down; nothing posted', async () => {
        const res = await exact(Number(HELD + 1n));
        expect(res.statusCode).toBe(400);
        expect(JSON.parse(res.body).message).toContain(
          `lpTokenAmount 4867692 is more than the 4867691 LP tokens of pool ${NFT}`,
        );
        expect(posts()).toBe(0);
      });

      it('more than the wallet can spend when it holds none is a 400 naming both amounts', async () => {
        state.wallet = [walletBox(ERG)];
        const res = await exact(5);
        expect(res.statusCode).toBe(400);
        expect(JSON.parse(res.body).message).toContain('lpTokenAmount 5 is more than the 0 LP tokens');
        expect(posts()).toBe(0);
      });

      it('more decimal places than the LP token has is a 400, never rounded; nothing posted', async () => {
        // the LP token has 0 decimals
        const res = await exact(1234567.5);
        expect(res.statusCode).toBe(400);
        const message: string = JSON.parse(res.body).message;
        expect(message).toContain('lpTokenAmount');
        expect(message).toContain('more than 0 decimal places');
        expect(posts()).toBe(0);
      });

      it('zero is a 400, nothing posted', async () => {
        const res = await exact(0);
        expect(res.statusCode).toBe(400);
        expect(JSON.parse(res.body).message).toContain('lpTokenAmount must be above zero');
        expect(posts()).toBe(0);
      });

      it('both lpTokenAmount and percentageToRemove, or neither, is a 400; nothing read or posted', async () => {
        const both = await exact(1234567, { percentageToRemove: 50 });
        expect(both.statusCode).toBe(400);
        expect(JSON.parse(both.body).message).toContain('Send exactly one of percentageToRemove and lpTokenAmount');
        const neither = await exact(undefined);
        expect(neither.statusCode).toBe(400);
        expect(JSON.parse(neither.body).message).toContain('Send exactly one of percentageToRemove and lpTokenAmount');
        expect(posts()).toBe(0);
        expect(state.calls).toEqual([]);
      });

      it('the connector itself refuses both or neither', async () => {
        for (const amount of [{}, { percentageToRemove: 50, lpTokenAmount: 1 }]) {
          await expect(removeLiquidity('mainnet', ME, NFT, amount)).rejects.toMatchObject({
            statusCode: 400,
            message: 'Send exactly one of percentageToRemove and lpTokenAmount',
          });
        }
        expect(posts()).toBe(0);
      });

      it('a sole provider naming all of it on an ERG/token pool: the 400 naming the most, which then goes through', async () => {
        const all = SUPPLY - 1000n;
        state.wallet = [walletBox(ERG, [{ tokenId: LP, amount: all }])];
        const res = await exact(Number(all));
        expect(res.statusCode).toBe(400);
        const m = /at most (\d+) LP tokens, [\d.]+% of the wallet's (\d+), can be removed now/.exec(
          JSON.parse(res.body).message,
        );
        expect(m).not.toBeNull();
        expect(BigInt(m![2])).toBe(all);
        expect(posts()).toBe(0);
        const most = BigInt(m![1]);
        const ok = await exact(Number(most));
        expect(ok.statusCode).toBe(200);
        expect(redeemedLp()).toBe(most);
        expect(JSON.parse(ok.body).pendingData.lpTokenAmountRemoved).toBe(String(most));
      });

      it('pool spent first, in bound: rebuilt on the successor for the same exact amount', async () => {
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
        const res = await exact(1234567);
        expect(res.statusCode).toBe(200);
        expect(posts()).toBe(2);
        const second = parseNodeJson<PostedTx>(state.posted[1]);
        expect(second.inputs[0].boxId).toBe(successor.boxId);
        expect(BigInt(second.outputs[0].assets[1].amount) - successor.assets[1].amount).toBe(1234567n);
        expect(JSON.parse(res.body).pendingData.lpTokenAmountRemoved).toBe('1234567');
      });

      it('submitMode check: the same 409 text as for a percentage, with the exact amount; nothing posted', async () => {
        useDex(makeDex(state, dexConfig(), ROOT, TOKENS, checkTestConfig()));
        const res = await exact(1234567);
        expect(res.statusCode).toBe(409);
        const body = JSON.parse(res.body);
        expect(body.message).toContain('Check only');
        expect(body.message).toContain('a redeem of 1234567 LP tokens');
        expect(body).not.toHaveProperty('pendingData');
        expect(posts()).toBe(0);
      });

      it('submitMode not set: a 503 before any read, and the key is never loaded', async () => {
        useDex(makeDex(state, dexConfig(), ROOT, TOKENS, withoutSubmitMode(testConfig())));
        const res = await exact(1234567);
        expect(res.statusCode).toBe(503);
        expect(JSON.parse(res.body).message).toContain('submitMode is not set');
        expect(dex.ergo.getWallet).not.toHaveBeenCalled();
        expect(state.calls).toEqual([]);
      });
    });
  });

  describe('pendingData is exactly what the sent transaction does to the wallet, on both pool kinds', () => {
    const T2T_NFT = T2T_POOL.assets[0].tokenId;
    const T2T_LP = T2T_POOL.assets[1].tokenId;
    const T2T_SUPPLY = 9223372036854775807n - T2T_POOL.assets[1].amount;

    interface Kind {
      name: string;
      nft: string;
      lp: string;
      /** Base and quote token ids (null: ERG) and decimals, as pool-info reports them. */
      base: [string | null, number];
      quote: [string | null, number];
      /** What the wallet holds besides some ERG for the miner fee. */
      tokens: Array<{ tokenId: string; amount: bigint }>;
      /** An offer the base side limits, and one the quote side limits. */
      baseLimited: [number, number];
      quoteLimited: [number, number];
      /** LP tokens to hold for a remove. */
      held: bigint;
    }

    const KINDS: Kind[] = [
      {
        name: 'ERG/RSN (ERG/token pool)',
        nft: NFT,
        lp: LP,
        base: [null, 9],
        quote: [RSN, 3],
        tokens: [{ tokenId: RSN, amount: 100000n }],
        baseLimited: [1, 100],
        quoteLimited: [4, 10],
        held: 4867691n,
      },
      {
        name: 'WT_ERG/WT_ADA (token/token pool)',
        nft: T2T_NFT,
        lp: T2T_LP,
        base: [WT_ERG, 9],
        quote: [WT_ADA, 8],
        tokens: [
          { tokenId: WT_ERG, amount: 10n ** 15n },
          { tokenId: WT_ADA, amount: 10n ** 15n },
        ],
        baseLimited: [1, 1000000],
        quoteLimited: [1000000, 1],
        held: T2T_SUPPLY / 1000n,
      },
    ];

    /**
     * What a posted transaction does to the wallet, read from it alone: the wallet's own
     * outputs less the wallet boxes it spends, by token id (null: ERG), and the miner fee.
     */
    function walletChange(txJson: string, walletBoxes: ErgoBox[]): { delta: Map<string | null, bigint>; fee: bigint } {
      const tx = parseNodeJson<PostedTx>(txJson);
      const delta = new Map<string | null, bigint>();
      const add = (k: string | null, n: bigint) => delta.set(k, (delta.get(k) ?? 0n) + n);
      for (const input of tx.inputs) {
        const box = walletBoxes.find((b) => b.boxId === input.boxId);
        if (!box) continue;
        add(null, -box.value);
        for (const a of box.assets) add(a.tokenId, -a.amount);
      }
      for (const out of tx.outputs) {
        if (out.ergoTree !== ME_TREE) continue;
        add(null, BigInt(out.value));
        for (const a of out.assets) add(a.tokenId, BigInt(a.amount));
      }
      return { delta, fee: BigInt(tx.outputs[tx.outputs.length - 1].value) };
    }

    const setUp = (tokens: Array<{ tokenId: string; amount: bigint }>) => {
      state.pools.set(T2T_NFT, [T2T_POOL]);
      state.emission.set(T2T_LP, LP_EMISSION);
      state.wallet = [walletBox(5n * ERG, tokens)];
    };

    const cases = KINDS.flatMap((kind) => [
      { kind, limit: 'base' as const, offer: kind.baseLimited },
      { kind, limit: 'quote' as const, offer: kind.quoteLimited },
    ]);

    it.each(cases)('add on $kind.name, the $limit side limiting', async ({ kind, offer }) => {
      setUp(kind.tokens);
      const walletBoxes = state.wallet;
      const res = await add({ poolAddress: kind.nft, baseTokenAmount: offer[0], quoteTokenAmount: offer[1] });
      expect(res.statusCode).toBe(200);
      expect(posts()).toBe(1);
      const body = JSON.parse(res.body);
      expect(body.status).toBe(0);
      expect(body).not.toHaveProperty('data');
      const { delta, fee } = walletChange(state.posted[0], walletBoxes);
      const paid = ([id]: [string | null, number]) => -((delta.get(id) ?? 0n) + (id === null ? fee : 0n));
      expect(paid(kind.base) > 0n && paid(kind.quote) > 0n && (delta.get(kind.lp) ?? 0n) > 0n).toBe(true);
      expect(body.pendingData).toEqual({
        fee: formatUnits(fee, 9),
        poolAddress: kind.nft,
        baseTokenAmountAdded: formatUnits(paid(kind.base), kind.base[1]),
        quoteTokenAmountAdded: formatUnits(paid(kind.quote), kind.quote[1]),
        lpTokenAmountAdded: formatUnits(delta.get(kind.lp)!, 0),
      });
      // exact decimal strings on the wire, never a JSON number
      for (const v of Object.values(body.pendingData)) expect(typeof v).toBe('string');
      // and the wallet moves by nothing else
      const others = [...delta.keys()].filter(
        (k) => k !== null && k !== kind.lp && k !== kind.base[0] && k !== kind.quote[0],
      );
      expect(others).toEqual([]);
    });

    it.each(
      KINDS.flatMap((kind) => [
        { kind, how: 'by percentage', over: { percentageToRemove: 50 } },
        {
          kind,
          how: 'by lpTokenAmount',
          over: { percentageToRemove: undefined, lpTokenAmount: Number(kind.held / 3n) },
        },
      ]),
    )('remove on $kind.name, $how', async ({ kind, over }) => {
      setUp([{ tokenId: kind.lp, amount: kind.held }]);
      const walletBoxes = state.wallet;
      const res = await remove({ poolAddress: kind.nft, ...over });
      expect(res.statusCode).toBe(200);
      expect(posts()).toBe(1);
      const body = JSON.parse(res.body);
      expect(body.status).toBe(0);
      expect(body).not.toHaveProperty('data');
      const { delta, fee } = walletChange(state.posted[0], walletBoxes);
      const got = ([id]: [string | null, number]) => (delta.get(id) ?? 0n) + (id === null ? fee : 0n);
      const returned = -(delta.get(kind.lp) ?? 0n);
      expect(returned).toBe('lpTokenAmount' in over ? kind.held / 3n : kind.held / 2n);
      expect(got(kind.base) > 0n && got(kind.quote) > 0n).toBe(true);
      expect(body.pendingData).toEqual({
        fee: formatUnits(fee, 9),
        poolAddress: kind.nft,
        baseTokenAmountRemoved: formatUnits(got(kind.base), kind.base[1]),
        quoteTokenAmountRemoved: formatUnits(got(kind.quote), kind.quote[1]),
        lpTokenAmountRemoved: formatUnits(returned, 0),
      });
      for (const v of Object.values(body.pendingData)) expect(typeof v).toBe('string');
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

    it('positions-owned: each pool whose LP token the wallet holds, a pool an entry guard refuses included', async () => {
      const small = n2tPool({ x: 50n * ERG, y: 1000000n, fee: 997, token: RSN, nft: 'fd'.repeat(32) });
      state.byTree.set(N2T_TREE, [RSN_POOL, small]);
      state.pools.set('fd'.repeat(32), [small]);
      state.emission.set(small.assets[1].tokenId, LP_EMISSION);
      state.wallet = [
        walletBox(ERG, [
          { tokenId: LP, amount: 4867691n },
          { tokenId: small.assets[1].tokenId, amount: 1000n },
          { tokenId: RSN, amount: 5n },
        ]),
      ];
      // the small pool holds 50 ERG, below this floor: a deposit there is refused, its position is not
      useDex(makeDex(state, dexConfig({ minPoolNativeReserve: 100n * ERG })));
      const warn = jest.spyOn(logger, 'warn');
      const res = await app.inject({ method: 'GET', url: positionsOwnedUrl });
      expect(res.statusCode).toBe(200);
      const list = JSON.parse(res.body);
      expect(list.map((p: { poolAddress: string }) => p.poolAddress)).toEqual([NFT, 'fd'.repeat(32)].sort());
      expect(list.find((p: { poolAddress: string }) => p.poolAddress === NFT).lpTokenAmount).toBe('4867691');
      expect(list.find((p: { poolAddress: string }) => p.poolAddress !== NFT).lpTokenAmount).toBe('1000');
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(`pool ${'fd'.repeat(32)} holds`));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('below minPoolNativeReserve'));
    });

    it('positions-owned: a box planted at a pool tree with one unit of the LP token does not hide the position', async () => {
      // one at each pool tree, the one at the ERG/token tree listed before the real pool
      state.byTree.set(N2T_TREE, [FAKE_N2T_POOL, RSN_POOL]);
      state.byTree.set(T2T_TREE, [FAKE_POOL]);
      state.pools.set(FAKE_NFT, [FAKE_POOL]);
      state.pools.set(FAKE_N2T_NFT, [FAKE_N2T_POOL]);
      state.wallet = [walletBox(ERG, [{ tokenId: LP, amount: 4867691n }])];
      const res = await app.inject({ method: 'GET', url: positionsOwnedUrl });
      expect(res.statusCode).toBe(200);
      const list = JSON.parse(res.body);
      expect(list.map((p: { poolAddress: string }) => p.poolAddress)).toEqual([NFT]);
      expect(list[0]).toMatchObject({ lpTokenAmount: '4867691', baseTokenAmount: '0.999999877' });
    });

    it('positions-owned: an LP token that only a box which is not its pool holds is not a position', async () => {
      const orphanLp = 'f5'.repeat(32);
      const orphan = makeBox({
        ergoTree: N2T_TREE,
        value: ERG,
        creationHeight: TIP - 5,
        assets: [
          { tokenId: 'f6'.repeat(32), amount: 1n },
          { tokenId: orphanLp, amount: 1n },
          { tokenId: FX, amount: 1000n },
        ],
        registers: { R4: R4(997) },
      });
      state.byTree.set(N2T_TREE, [RSN_POOL, orphan]);
      state.pools.set('f6'.repeat(32), [orphan]);
      state.emission.set(orphanLp, 1000n);
      state.wallet = [
        walletBox(ERG, [
          { tokenId: LP, amount: 4867691n },
          { tokenId: orphanLp, amount: 999n },
        ]),
      ];
      const res = await app.inject({ method: 'GET', url: positionsOwnedUrl });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).map((p: { poolAddress: string }) => p.poolAddress)).toEqual([NFT]);
    });

    it('positions-owned: each box and token not counted is logged as a warning, with the token, the pool and why', async () => {
      // a box holding 1 of its LP token's 1000: dropped for holding half or less
      const orphanLp = 'f5'.repeat(32);
      const orphan = makeBox({
        ergoTree: N2T_TREE,
        value: ERG,
        creationHeight: TIP - 5,
        assets: [
          { tokenId: 'f6'.repeat(32), amount: 1n },
          { tokenId: orphanLp, amount: 1n },
          { tokenId: FX, amount: 1000n },
        ],
        registers: { R4: R4(997) },
      });
      // a box holding all of its LP token, refused on its fresh read: its NFT's supply is 2
      const refusedLp = 'f7'.repeat(32);
      const refusedNft = 'f8'.repeat(32);
      const refused = makeBox({
        ergoTree: N2T_TREE,
        value: ERG,
        creationHeight: TIP - 5,
        assets: [
          { tokenId: refusedNft, amount: 1n },
          { tokenId: refusedLp, amount: 999n },
          { tokenId: FX, amount: 1000n },
        ],
        registers: { R4: R4(997) },
      });
      state.byTree.set(N2T_TREE, [RSN_POOL, orphan, refused]);
      state.pools.set('f6'.repeat(32), [orphan]);
      state.pools.set(refusedNft, [refused]);
      state.emission.set(orphanLp, 1000n);
      state.emission.set(refusedLp, 1000n);
      state.emission.set(refusedNft, 2n);
      state.wallet = [
        walletBox(ERG, [
          { tokenId: LP, amount: 4867691n },
          { tokenId: orphanLp, amount: 999n },
          { tokenId: refusedLp, amount: 1n },
        ]),
      ];
      const warn = jest.spyOn(logger, 'warn');
      const res = await app.inject({ method: 'GET', url: positionsOwnedUrl });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).map((p: { poolAddress: string }) => p.poolAddress)).toEqual([NFT]);
      expect(warn).toHaveBeenCalledWith(
        `ergodex: positions-owned: pool ${'f6'.repeat(32)} not counted for LP token ${orphanLp}: it holds 1, ` +
          'half or less of the LP token minted',
      );
      expect(warn).toHaveBeenCalledWith(
        `ergodex: positions-owned: LP token ${orphanLp} is not counted: no box at a pool tree is its pool`,
      );
      expect(warn).toHaveBeenCalledWith(
        expect.stringMatching(
          new RegExp(`pool ${refusedNft} not counted for LP token ${refusedLp}: .*supply of 2, not 1`),
        ),
      );
      expect(warn).toHaveBeenCalledWith(
        `ergodex: positions-owned: LP token ${refusedLp} is not counted: no box at a pool tree is its pool`,
      );
    });

    it('positions-owned: a pool tree read only in part is logged as a warning, since a position can be missing', async () => {
      // boxes with no tokens at the pool tree: cheap to create, never spendable
      const junk = Array.from({ length: 200 }, (_, i) =>
        makeBox({ ergoTree: N2T_TREE, value: 200000n + BigInt(i), assets: [], creationHeight: TIP - 1 }),
      );
      state.byTree.set(N2T_TREE, [RSN_POOL, ...junk]);
      state.wallet = [walletBox(ERG, [{ tokenId: LP, amount: 4867691n }])];
      useDex(makeDex(state, dexConfig({ maxDiscoveredBoxes: 200 })));
      const warn = jest.spyOn(logger, 'warn');
      const res = await app.inject({ method: 'GET', url: positionsOwnedUrl });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).map((p: { poolAddress: string }) => p.poolAddress)).toEqual([NFT]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('a position can be missing from the list'));
    });

    it('a retryable error while reading a pool fails positions-owned and position-info, not an empty list', async () => {
      state.byTree.set(N2T_TREE, [RSN_POOL]);
      state.wallet = [walletBox(ERG, [{ tokenId: LP, amount: 4867691n }])];
      // the node does not know the LP token yet
      state.emission.delete(LP);
      for (const url of [positionsOwnedUrl, positionInfoUrl(NFT)]) {
        const res = await app.inject({ method: 'GET', url });
        expect(res.statusCode).toBe(503);
        expect(JSON.parse(res.body).message).toContain('retry');
      }
    });

    it('positions-owned: two confirmed boxes holding the pool NFT is a 409, not an empty list', async () => {
      state.byTree.set(N2T_TREE, [RSN_POOL]);
      state.pools.set(NFT, [RSN_POOL, RSN_POOL]);
      state.wallet = [walletBox(ERG, [{ tokenId: LP, amount: 4867691n }])];
      const res = await app.inject({ method: 'GET', url: positionsOwnedUrl });
      expect(res.statusCode).toBe(409);
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

  describe('a box at a pool tree that is not the pool of the LP token it holds', () => {
    beforeEach(() => {
      state.pools.set(FAKE_NFT, [FAKE_POOL]);
      state.emission.set(FX, 2n ** 63n - 1n);
      state.emission.set(FY, 2n ** 63n - 1n);
      state.wallet = [walletBox(ERG, [{ tokenId: LP, amount: 4867691n }])];
    });

    it('is refused by remove, add, quote-liquidity and position-info; nothing is posted', async () => {
      const results = [
        await remove({ poolAddress: FAKE_NFT, percentageToRemove: 100 }),
        await add({ poolAddress: FAKE_NFT }),
        await app.inject({ method: 'GET', url: quoteUrl({ poolAddress: FAKE_NFT }) }),
        await app.inject({ method: 'GET', url: positionInfoUrl(FAKE_NFT) }),
      ];
      for (const r of results) {
        expect(r.statusCode).toBe(400);
        expect(JSON.parse(r.body).message).toContain(`is not the pool of LP token ${LP}`);
      }
      expect(posts()).toBe(0);
    });

    it('the real pool of that LP token still works', async () => {
      const res = await remove({ percentageToRemove: 100 });
      expect(res.statusCode).toBe(200);
      expect(posts()).toBe(1);
    });

    it('the node not knowing the LP token yet is a 503 to retry, nothing posted', async () => {
      state.emission.delete(LP);
      const res = await remove();
      expect(res.statusCode).toBe(503);
      expect(JSON.parse(res.body).message).toContain(`supply of LP token ${LP} yet; retry`);
      expect(posts()).toBe(0);
    });
  });

  describe('two boxes at pool trees holding the same LP token', () => {
    /**
     * A real pool whose creator kept 60% of its LP token's emission, so its box holds 40%,
     * and a box the creator placed at the same tree with a fresh NFT, 55% of that LP token
     * and a junk token: it holds more than half, so the majority rule takes it for the pool.
     */
    const SPLIT_LP = 'e0'.repeat(32);
    const SPLIT_NFT = 'e1'.repeat(32);
    const PLANTED_NFT = 'e2'.repeat(32);
    const SPLIT_POOL = makeBox({
      ergoTree: N2T_TREE,
      value: 1000n * ERG,
      creationHeight: TIP - 5,
      assets: [
        { tokenId: SPLIT_NFT, amount: 1n },
        { tokenId: SPLIT_LP, amount: (LP_EMISSION * 40n) / 100n },
        { tokenId: RSN, amount: 1000000000n },
      ],
      registers: { R4: R4(997) },
    });
    const PLANTED = makeBox({
      ergoTree: N2T_TREE,
      value: ERG,
      creationHeight: TIP - 5,
      assets: [
        { tokenId: PLANTED_NFT, amount: 1n },
        { tokenId: SPLIT_LP, amount: (LP_EMISSION * 55n) / 100n },
        { tokenId: FX, amount: 1000n },
      ],
      registers: { R4: R4(997) },
    });
    const HELD = 10n ** 16n;

    describe('a real pool holding half or less of its LP token, and a planted box holding more', () => {
      beforeEach(() => {
        state.byTree.set(N2T_TREE, [SPLIT_POOL, PLANTED]);
        state.pools.set(SPLIT_NFT, [SPLIT_POOL]);
        state.pools.set(PLANTED_NFT, [PLANTED]);
        state.emission.set(SPLIT_LP, LP_EMISSION);
        state.emission.set(FX, 1000n);
        state.wallet = [walletBox(ERG, [{ tokenId: SPLIT_LP, amount: HELD }])];
      });

      it('positions-owned is a 409 naming the LP token and both pools, not a position in the planted box', async () => {
        const res = await app.inject({ method: 'GET', url: positionsOwnedUrl });
        expect(res.statusCode).toBe(409);
        const message: string = JSON.parse(res.body).message;
        expect(message).toContain(`Two boxes at pool trees hold LP token ${SPLIT_LP}`);
        expect(message).toContain(`pool ${PLANTED_NFT}`);
        expect(message).toContain(`pool ${SPLIT_NFT} holding ${(LP_EMISSION * 40n) / 100n}`);
        expect(message).toContain('cannot be told apart for this amount');
      });

      it('remove and position-info naming the planted box are 409s, nothing posted', async () => {
        const results = [
          await remove({ poolAddress: PLANTED_NFT, percentageToRemove: 100 }),
          await app.inject({ method: 'GET', url: positionInfoUrl(PLANTED_NFT) }),
        ];
        for (const r of results) {
          expect(r.statusCode).toBe(409);
          const message: string = JSON.parse(r.body).message;
          expect(message).toContain(`Two boxes at pool trees hold LP token ${SPLIT_LP}: pool ${PLANTED_NFT}`);
          expect(message).toContain(`pool ${SPLIT_NFT} holding`);
          expect(message).toContain(`at least the ${HELD} in question`);
        }
        expect(posts()).toBe(0);
      });

      it('naming the real pool is still refused by the majority rule', async () => {
        const results = [
          await remove({ poolAddress: SPLIT_NFT, percentageToRemove: 100 }),
          await app.inject({ method: 'GET', url: positionInfoUrl(SPLIT_NFT) }),
        ];
        for (const r of results) {
          expect(r.statusCode).toBe(400);
          expect(JSON.parse(r.body).message).toContain(`is not the pool of LP token ${SPLIT_LP}`);
        }
        expect(posts()).toBe(0);
      });
    });

    describe('a box with one unit of the LP token beside a normal real pool', () => {
      beforeEach(() => {
        state.byTree.set(N2T_TREE, [FAKE_N2T_POOL, RSN_POOL]);
        state.pools.set(FAKE_N2T_NFT, [FAKE_N2T_POOL]);
      });

      it('a remove of a normal amount on the real pool goes ahead', async () => {
        state.wallet = [walletBox(ERG, [{ tokenId: LP, amount: 4867691n }])];
        const res = await remove({ percentageToRemove: 50 });
        expect(res.statusCode).toBe(200);
        expect(posts()).toBe(1);
      });

      it('a remove or position read of one LP unit is a 409, nothing posted', async () => {
        state.wallet = [walletBox(ERG, [{ tokenId: LP, amount: 1n }])];
        const results = [
          await remove({ percentageToRemove: 100 }),
          await app.inject({ method: 'GET', url: positionInfoUrl(NFT) }),
        ];
        for (const r of results) {
          expect(r.statusCode).toBe(409);
          const message: string = JSON.parse(r.body).message;
          expect(message).toContain(`pool ${NFT}, and pool ${FAKE_N2T_NFT} holding 1, at least the 1 in question`);
        }
        expect(posts()).toBe(0);
      });

      it('position-info with no LP tokens is not refused', async () => {
        state.wallet = [walletBox(ERG)];
        const res = await app.inject({ method: 'GET', url: positionInfoUrl(NFT) });
        expect(res.statusCode).toBe(200);
        expect(JSON.parse(res.body).lpTokenAmount).toBe('0');
      });
    });

    it('a pool tree read only in part: the remove goes ahead, and a warning names the pool', async () => {
      const junk = Array.from({ length: 200 }, (_, i) =>
        makeBox({ ergoTree: N2T_TREE, value: 200000n + BigInt(i), assets: [], creationHeight: TIP - 1 }),
      );
      state.byTree.set(N2T_TREE, [...junk, RSN_POOL]);
      state.wallet = [walletBox(ERG, [{ tokenId: LP, amount: 4867691n }])];
      useDex(makeDex(state, dexConfig({ maxDiscoveredBoxes: 200 })));
      const warn = jest.spyOn(logger, 'warn');
      const res = await remove();
      expect(res.statusCode).toBe(200);
      expect(posts()).toBe(1);
      expect(warn).toHaveBeenCalledWith(
        expect.stringMatching(new RegExp(`pool ${NFT}: a pool tree on mainnet was read only in part`)),
      );
    });
  });

  describe('an NFT minted with a supply of 2, held by two boxes at a pool tree', () => {
    const NFT2 = 'e3'.repeat(32);
    const Z = 'e4'.repeat(32);
    const twin = (value: bigint) =>
      makeBox({
        ergoTree: N2T_TREE,
        value,
        creationHeight: TIP - 5,
        assets: [
          { tokenId: NFT2, amount: 1n },
          { tokenId: Z, amount: 1n },
          { tokenId: FX, amount: 10n },
        ],
        registers: { R4: R4(997) },
      });
    const TWINS = [twin(ERG), twin(ERG + 1n)];

    beforeEach(() => {
      state.byTree.set(N2T_TREE, [...TWINS, RSN_POOL]);
      state.pools.set(NFT2, TWINS);
      state.emission.set(NFT2, 2n);
      state.emission.set(Z, 1000n);
      state.emission.set(FX, 1000n);
      // one unit of Z sent to the wallet, beside a real position
      state.wallet = [
        walletBox(ERG, [
          { tokenId: LP, amount: 4867691n },
          { tokenId: Z, amount: 1n },
        ]),
      ];
    });

    it('positions-owned lists the real position, and never reads the twin boxes fresh', async () => {
      const res = await app.inject({ method: 'GET', url: positionsOwnedUrl });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).map((p: { poolAddress: string }) => p.poolAddress)).toEqual([NFT]);
      expect(state.calls.some((c) => c.path.startsWith(`/blockchain/box/unspent/byTokenId/${NFT2}`))).toBe(false);
      // the real pool was read fresh, so the path matched here is the one such a read uses
      expect(state.calls.some((c) => c.path.startsWith(`/blockchain/box/unspent/byTokenId/${NFT}`))).toBe(true);
    });

    it('naming that NFT is a 400 for its supply, not a 409 to retry', async () => {
      const res = await app.inject({ method: 'GET', url: positionInfoUrl(NFT2) });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).message).toContain('supply of 2, not 1');
    });
  });

  describe('leaving a pool an entry guard refuses', () => {
    const HELD = 4867691n;
    beforeEach(() => {
      state.byTree.set(N2T_TREE, [RSN_POOL]);
      state.wallet = [walletBox(ERG, [{ tokenId: LP, amount: HELD }])];
    });

    it.each([
      ['minPoolNativeReserve', { minPoolNativeReserve: 10n ** 6n * ERG }],
      ['minPoolTokenReserve', { minPoolTokenReserve: Y0 + 1n }],
      ['maxPoolFeePct', { maxPoolFeePct: '0.1' }],
      ['allowlist', { poolAllowlist: ['fe'.repeat(32)] }],
    ])(
      'under %s: add is refused; remove posts, position-info answers, positions-owned lists it',
      async (guard, over) => {
        useDex(makeDex(state, dexConfig(over)));
        const warn = jest.spyOn(logger, 'warn');
        const entry = await add();
        expect(entry.statusCode).toBe(400);
        expect(JSON.parse(entry.body).message).toContain(guard);
        expect(posts()).toBe(0);

        const info = await app.inject({ method: 'GET', url: positionInfoUrl(NFT) });
        expect(info.statusCode).toBe(200);
        expect(JSON.parse(info.body).lpTokenAmount).toBe('4867691');
        const owned = await app.inject({ method: 'GET', url: positionsOwnedUrl });
        expect(owned.statusCode).toBe(200);
        expect(JSON.parse(owned.body).map((p: { poolAddress: string }) => p.poolAddress)).toEqual([NFT]);

        const res = await remove({ percentageToRemove: 100 });
        expect(res.statusCode).toBe(200);
        expect(posts()).toBe(1);
        expect(changeHolds(state.posted[0], LP)).toBe(0n);
        // each skipped guard is logged, naming the pool and the guard
        expect(warn).toHaveBeenCalledWith(expect.stringMatching(new RegExp(`pool ${NFT} .*${guard}`)));
      },
    );
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

describe('the LP constant must be the one the configured pool trees carry', () => {
  type Spectrum = { n2tPoolTrees: string[]; t2tPoolTrees: string[]; lockedLiquidity: string };
  /** The shipped template with mainnet's spectrum block changed, as the config manager hands it over. */
  const loadPatched = (patch: (spectrum: Spectrum) => void) => {
    const template = yaml.load(
      fs.readFileSync(path.join(__dirname, '../../../src/templates/connectors/ergodex.yml'), 'utf8'),
    ) as { networks: { mainnet: { spectrum: Spectrum } } };
    patch(template.networks.mainnet.spectrum);
    jest.spyOn(ConfigManagerV2, 'getInstance').mockReturnValue({
      get: (k: string) => (template as unknown as Record<string, unknown>)[k.replace(/^ergodex\./, '')],
    } as never);
  };
  const key = 'ergodex.networks.mainnet.spectrum';

  afterEach(() => jest.restoreAllMocks());

  it('both shipped trees hold it as a Long constant, twice', () => {
    for (const tree of [N2T_TREE, T2T_TREE]) {
      const constants = ergoTreeConstants(tree)!;
      expect(constants.filter((c) => c === encodeLong(2n ** 63n - 1n)).length).toBe(2);
    }
    expect(ergoTreeConstants(N2T_TREE)!.length).toBe(15);
  });

  it.each([
    ["the LP token's emission, 1000 lower", '9223372036854774807'],
    ['a value 10^11 lower', '9223371936854775807'],
  ])('%s is refused at load, naming the tree and the key', (_what, value) => {
    loadPatched((spectrum) => {
      spectrum.lockedLiquidity = value;
    });
    expect(() => ErgodexConfig.network('mainnet')).toThrow(
      `${key}.n2tPoolTrees[0] does not hold ${key}.lockedLiquidity (${value}) as a Long constant`,
    );
  });

  it('a configured tree that lacks the constant is refused at load, naming that tree', () => {
    loadPatched((spectrum) => {
      // the same tree with its LP constant one lower (2^63 - 2), so the configured value is not in it
      spectrum.t2tPoolTrees = [spectrum.t2tPoolTrees[0].replace(/05feffffffffffffffff01/g, '05fcffffffffffffffff01')];
    });
    expect(() => ErgodexConfig.network('mainnet')).toThrow(
      `${key}.t2tPoolTrees[0] does not hold ${key}.lockedLiquidity (9223372036854775807) as a Long constant`,
    );
  });

  it('without the key there is nothing to check, and the trees load for swaps', () => {
    loadPatched((spectrum) => {
      spectrum.t2tPoolTrees = [spectrum.t2tPoolTrees[0].replace(/05feffffffffffffffff01/g, '05fcffffffffffffffff01')];
      delete (spectrum as Partial<Spectrum>).lockedLiquidity;
    });
    expect(ErgodexConfig.network('mainnet').spectrum.lockedLiquidity).toBeUndefined();
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

describe('percentageToRemove as read for a remove', () => {
  it.each([
    [100, 10n ** 10n],
    [50, 5n * 10n ** 9n],
    [100 / 3, 3333333333n],
    [33.333333333333336, 3333333333n],
    [12.123456789, 1212345678n],
    [0.00000001, 1n],
    [1e-7, 10n],
    [99.999999999999, 9999999999n],
  ])('%p is cut toward zero to 8 decimals', (pct, scaled) => {
    expect(percentToRemove(pct)).toBe(scaled);
  });

  it.each([0, -1, 0.000000009, 1e-9, 100.000000001, 101, 1e21, NaN, Infinity, -Infinity])(
    '%p is refused with a 400',
    (pct) => {
      let refused: unknown;
      try {
        percentToRemove(pct);
      } catch (error) {
        refused = error;
      }
      expect((refused as { statusCode?: number } | undefined)?.statusCode).toBe(400);
    },
  );
});
