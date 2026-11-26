/**
 * The LithosDex venue without signing: reading pool boxes of both kinds, the contract's
 * acceptance rule on a successor and on the transaction's other inputs, the deployment
 * check (rebuilt trees and the single vault) on captured mainnet pools and on look-alikes,
 * the optional lithos allowlist, the size and fee guards, pool choice across venues, and
 * the shipped config. Discovery by template hash is in `lithos-discovery.test.ts`.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { Eip12BoxCandidate, ErgoBox } from '../../../src/chains/ergo/ergo.types';
import { Ergodex } from '../../../src/connectors/ergodex/ergodex';
import { ErgodexConfig } from '../../../src/connectors/ergodex/ergodex.config';
import {
  blake2b256Hex,
  ergoTreeTemplateHash,
  LithosDeployments,
} from '../../../src/connectors/ergodex/venues/lithos/lithos.deployment';
import {
  decodeLong,
  encodeBigInt,
  encodeCollLong,
  encodeLong,
  MAX_LONG,
} from '../../../src/connectors/ergodex/venues/lithos/lithos.math';
import { LithosPool, LithosVenue } from '../../../src/connectors/ergodex/venues/lithos/lithos.venue';
import { VenueRuleError } from '../../../src/connectors/ergodex/venues/venue';
import { ConfigManagerV2 } from '../../../src/services/config-manager-v2';

import { ERG, makeBox, ME_TREE, n2tPool, newNodeState, NodeState, RSN_POOL, walletBox } from './ergodex-test-helpers';
import {
  BBC_NFT,
  BBC_POOL,
  BBC_VAULT,
  LIT_NFT,
  LIT_POOL,
  LIT_RSN_NFT,
  LIT_RSN_POOL,
  LIT_RSN_VAULT,
  LIT_VAULT,
  lithosConfig,
  L_TIP,
  lithosDexConfig,
  makeLithosDex,
  putPools,
  setIndexedHeight,
  shippedMainnet,
  shippedTemplate,
} from './lithos-test-helpers';

const venue = new LithosVenue(lithosConfig([LIT_NFT, LIT_RSN_NFT]));
/** What selling 1 RSN (1000 units) into the captured LIT:RSN pool gives, in LIT units. */
const TRADE_FEE_NORMAL_OUT = 9877515028n;

function candidate(
  spec: ReturnType<LithosVenue['successor']>,
  over: Partial<Eip12BoxCandidate> = {},
): Eip12BoxCandidate {
  return {
    value: spec.value.toString(),
    ergoTree: spec.ergoTree,
    creationHeight: 1,
    assets: spec.assets!.map((a) => ({ tokenId: a.tokenId, amount: a.amount.toString() })),
    additionalRegisters: { ...spec.additionalRegisters! },
    ...over,
  };
}

describe('reading LithosDex pool boxes', () => {
  it('the ERG:LIT box: native reserve is the value less pending ERG fees, the token reserve less pending token fees', () => {
    const pool = venue.parsePool(LIT_POOL) as LithosPool;
    expect(pool.kind).toBe('n2t');
    expect(pool.poolId).toBe(LIT_NFT);
    expect(pool.x).toEqual({ tokenId: null, reserve: 1988353543313n - 331502945n, held: 1988353543313n });
    expect(pool.y.reserve).toBe(481736402653643n - 86397776395n);
    expect(pool.lithos.supply).toBe(9223372036854775807n - 9223275248383764144n);
    expect(pool.lithos.dexFee).toBe(9985n);
    expect(pool.lithos.sideFee).toEqual({ x: 15n, y: 15n });
    // the costlier direction: (10000 - 15) * 9985 of 10000^2 reaches the curve
    expect(pool.feeNum).toBe(9985n * 9985n);
    expect(pool.feeDenom).toBe(100000000n);
    expect(pool.lithos.vaultNft).toBe(LIT_VAULT.assets[0].tokenId);
  });

  it('the LIT:RSN box: both reserves are token amounts less pending fees; the value is storage', () => {
    const pool = venue.parsePool(LIT_RSN_POOL) as LithosPool;
    expect(pool.kind).toBe('t2t');
    expect(pool.x.tokenId).toBe(LIT_RSN_POOL.assets[1].tokenId);
    expect(pool.x.reserve).toBe(234146082425083n - 55020366559n);
    expect(pool.y.reserve).toBe(23399703n - 8683n);
    expect(pool.lithos.provisionToken).toEqual(LIT_RSN_POOL.assets[3]);
  });

  it('a Spectrum pool tree is not a LithosDex tree, and a box with the wrong layout is not a pool', () => {
    expect(venue.ownsTree(RSN_POOL.ergoTree)).toBe(false);
    const short = makeBox({
      ...LIT_POOL,
      registers: LIT_POOL.additionalRegisters,
      assets: LIT_POOL.assets.slice(0, 2),
    });
    expect(venue.parsePool(short)).toBeNull();
    const { R8: _r8, ...withoutR8 } = LIT_POOL.additionalRegisters;
    const noR8 = makeBox({ ...LIT_POOL, registers: withoutR8 });
    expect(venue.parsePool(noR8)).toBeNull();
  });

  it('a box whose registers the contract arithmetic cannot hold is not a pool: pending fees below zero, a supply beyond a Long', () => {
    const withRegs = (over: Record<string, string>) =>
      makeBox({ ...LIT_POOL, registers: { ...LIT_POOL.additionalRegisters, ...over } });
    // a negative pending fee would show the pool deeper than it is
    expect(venue.parsePool(withRegs({ R6: encodeCollLong([-(10n ** 15n), 0n]) }))).toBeNull();
    expect(venue.parsePool(withRegs({ R6: encodeCollLong([0n, -1n]) }))).toBeNull();
    expect(venue.parsePool(withRegs({ R6: encodeCollLong([0n, 0n]) }))).not.toBeNull();
    // liquidity 0 gives a supply of exactly the largest Long; below 0 the supply leaves the Long range
    expect((venue.parsePool(withRegs({ R4: encodeLong(0n) })) as LithosPool).lithos.supply).toBe(MAX_LONG);
    expect(venue.parsePool(withRegs({ R4: encodeLong(-1n) }))).toBeNull();
    expect(venue.parsePool(withRegs({ R4: encodeLong(-5n) }))).toBeNull();
  });

  it('a swap whose fee accumulator would pass 256 bits is refused as a pool rule (a 400), not a crash', () => {
    const edge = makeBox({
      ...LIT_POOL,
      registers: { ...LIT_POOL.additionalRegisters, R7: encodeBigInt(2n ** 255n - 1n) },
    });
    const pool = venue.parsePool(edge) as LithosPool;
    const swap = { input: 'x' as const, amountIn: ERG, amountOut: venue.amountOut(pool, 'x', ERG) };
    expect(() => venue.successor(pool, swap)).toThrow(VenueRuleError);
    expect(() => venue.successor(pool, swap)).toThrow(/registers cannot hold the state after this swap/);
    const dex = makeLithosDex(newNodeState());
    const erg = { tokenId: null, symbol: 'ERG', decimals: 9 };
    const lit = { tokenId: LIT_POOL.assets[1].tokenId, symbol: 'LIT', decimals: 9 };
    let status: number | undefined;
    try {
      dex.plan({ pool, venue, source: 'confirmed' }, erg, lit, 'SELL', ERG);
    } catch (error) {
      status = (error as { statusCode?: number }).statusCode;
    }
    expect(status).toBe(400);
  });

  it('the swap input carries context variable 0 = the swap operation byte', () => {
    expect(venue.swapInputExtension()).toEqual({ 0: '0200' });
  });
});

describe('the contract rule on a successor and on the other inputs', () => {
  const pool = venue.parsePool(LIT_POOL) as LithosPool;
  const t2t = venue.parsePool(LIT_RSN_POOL) as LithosPool;
  const swap = { input: 'x' as const, amountIn: ERG, amountOut: venue.amountOut(pool, 'x', ERG) };
  const spec = venue.successor(pool, swap);
  const tSwap = { input: 'y' as const, amountIn: 1000n, amountOut: venue.amountOut(t2t, 'y', 1000n) };
  const tSpec = venue.successor(t2t, tSwap);

  it('accepts the planned successor of either kind', () => {
    expect(venue.contractAccepts(pool, candidate(spec))).toBe(true);
    expect(venue.contractAccepts(t2t, candidate(tSpec))).toBe(true);
  });

  it('refuses a changed liquidity register, fee parameters, NFT amount or provision token amount', () => {
    const r4 = encodeLong(decodeLong(LIT_POOL.additionalRegisters.R4)! - 1n);
    expect(
      venue.contractAccepts(pool, candidate(spec, { additionalRegisters: { ...spec.additionalRegisters, R4: r4 } })),
    ).toBe(false);
    const r5 = '1103829c011e20'; // [9985, 15, 16]
    expect(
      venue.contractAccepts(pool, candidate(spec, { additionalRegisters: { ...spec.additionalRegisters, R5: r5 } })),
    ).toBe(false);
    const assets = candidate(spec).assets.map((a) => ({ ...a }));
    assets[2].amount = (BigInt(assets[2].amount) - 1n).toString();
    expect(venue.contractAccepts(pool, candidate(spec, { assets }))).toBe(false);
  });

  it('a token/token successor may not carry R9 nor hold less ERG; an ERG/token one may not fall to the storage floor', () => {
    expect(
      venue.contractAccepts(
        t2t,
        candidate(tSpec, { additionalRegisters: { ...tSpec.additionalRegisters, R9: '0e00' } }),
      ),
    ).toBe(false);
    expect(venue.contractAccepts(t2t, candidate(tSpec, { value: (LIT_RSN_POOL.value - 1n).toString() }))).toBe(false);
    expect(venue.contractAccepts(t2t, candidate(tSpec, { value: (LIT_RSN_POOL.value + 1n).toString() }))).toBe(true);
  });

  it('with the inputs: the pool must be input 0 and no other input may hold its provision token', () => {
    const wallet = walletBox(5n * ERG);
    expect(venue.contractAccepts(pool, candidate(spec), [LIT_POOL, wallet])).toBe(true);
    expect(venue.contractAccepts(pool, candidate(spec), [wallet, LIT_POOL])).toBe(false);
    const holder = walletBox(5n * ERG, [{ tokenId: LIT_POOL.assets[2].tokenId, amount: 1n }]);
    expect(venue.contractAccepts(pool, candidate(spec), [LIT_POOL, holder])).toBe(false);
  });

  it('a swap leaving the ERG/token pool at or below the storage floor is refused before building', () => {
    const tiny = venue.parsePool(BBC_POOL) as LithosPool;
    const out = venue.amountOut(tiny, 'y', 1000000n);
    expect(out).toBeGreaterThan(0n);
    expect(() => venue.successor(tiny, { input: 'y', amountIn: 1000000n, amountOut: out })).toThrow(/storage floor/);
  });
});

describe('the deployment check', () => {
  const deployments = new LithosDeployments(lithosConfig());
  const ids = (box: ErgoBox) => {
    const p = venue.parsePool(box) as LithosPool;
    return {
      kind: p.lithos.kind,
      poolNft: p.poolId,
      vaultNft: p.lithos.vaultNft,
      provisionToken: p.lithos.provisionToken.tokenId,
    };
  };
  // the index is caught up unless a lower indexed height is given
  const node = (boxes: Record<string, ErgoBox[]>, indexedHeight = 1000) => ({
    getUnspentBoxesByTokenId: jest.fn(async (id: string) => boxes[id] ?? []),
    getInfo: jest.fn(async () => ({ fullHeight: 1000 })),
    getIndexedHeight: jest.fn(async () => ({ indexedHeight, fullHeight: 1000 })),
  });

  it.each([
    ['ERG:LIT', LIT_POOL, LIT_VAULT],
    ['LIT:RSN', LIT_RSN_POOL, LIT_RSN_VAULT],
    ['ERG:BBC', BBC_POOL, BBC_VAULT],
  ])('accepts the captured %s pool: its tree and its vault rebuild from its own ids', async (_n, pool, vault) => {
    const i = ids(pool);
    const rebuilt = deployments.rebuild(i);
    expect(rebuilt.poolTree).toBe(pool.ergoTree);
    expect(rebuilt.feeVaultTree).toBe(vault.ergoTree);
    const reader = node({ [i.vaultNft]: [vault] });
    expect(await deployments.check(pool.ergoTree, i, reader)).toBeNull();
    // the vault is read confirmed only, as the client reads it
    expect(reader.getUnspentBoxesByTokenId).toHaveBeenCalledWith(i.vaultNft, {
      limit: 2,
      includeUnconfirmed: false,
      excludeMempoolSpent: false,
    });
  });

  it('the guard hash in the live ERG:LIT tree is the hash of the rebuilt guard', () => {
    const rebuilt = deployments.rebuild(ids(LIT_POOL));
    expect(LIT_POOL.ergoTree).toContain('0e20' + blake2b256Hex(rebuilt.provisionGuardTree));
  });

  it('refuses a look-alike: the same layout and template at another vault NFT (so another tree)', async () => {
    const i = ids(LIT_POOL);
    const fakeVault = 'ab'.repeat(32);
    const tree = LIT_POOL.ergoTree.replace(i.vaultNft, fakeVault);
    expect(tree).not.toBe(LIT_POOL.ergoTree);
    const fake = makeBox({ ...LIT_POOL, ergoTree: tree, registers: LIT_POOL.additionalRegisters });
    const p = venue.parsePool(fake) as LithosPool;
    expect(p.lithos.vaultNft).toBe(fakeVault);
    const vault = makeBox({ ...LIT_VAULT, registers: LIT_VAULT.additionalRegisters });
    expect(await deployments.check(tree, { ...i, vaultNft: fakeVault }, node({ [fakeVault]: [vault] }))).toMatch(
      /not the pool contract rebuilt/,
    );
  });

  it('refuses a pool whose ids rebuild a different tree (another pool NFT in the same box)', async () => {
    const i = ids(LIT_POOL);
    expect(await deployments.check(LIT_POOL.ergoTree, { ...i, poolNft: 'cd'.repeat(32) }, node({}))).toMatch(
      /not the pool contract rebuilt/,
    );
  });

  it('refuses two boxes carrying the vault NFT', async () => {
    const i = ids(LIT_POOL);
    const second = makeBox({ ...LIT_VAULT, registers: LIT_VAULT.additionalRegisters, transactionId: 'ee'.repeat(32) });
    expect(await deployments.check(LIT_POOL.ergoTree, i, node({ [i.vaultNft]: [LIT_VAULT, second] }))).toMatch(
      /2 confirmed unspent boxes carry its vault NFT/,
    );
    expect(await deployments.check(LIT_POOL.ergoTree, i, node({}))).toMatch(/0 confirmed unspent boxes/);
  });

  it('an index behind the chain is a 503 to retry, not a failed check, when it lists no vault or two', async () => {
    const i = ids(LIT_POOL);
    const second = makeBox({ ...LIT_VAULT, registers: LIT_VAULT.additionalRegisters, transactionId: 'ee'.repeat(32) });
    for (const listed of [[], [LIT_VAULT, second]]) {
      const lagging = node({ [i.vaultNft]: listed }, 999);
      const error = await deployments.check(LIT_POOL.ergoTree, i, lagging).then(
        () => null,
        (e) => e,
      );
      expect(error?.statusCode).toBe(503);
      expect(error.message).toMatch(/index has not caught up with the chain \(indexed to 999, chain at 1000\).*retry/);
      expect(error.message).not.toMatch(/fails the deployment check/);
    }
    // with the index caught up, the same answers are a failed check
    expect(await deployments.check(LIT_POOL.ergoTree, i, node({ [i.vaultNft]: [] }))).toMatch(/0 confirmed unspent/);
    // one vault box: the index height is not read
    const one = node({ [i.vaultNft]: [LIT_VAULT] }, 999);
    expect(await deployments.check(LIT_POOL.ergoTree, i, one)).toBeNull();
    expect(one.getIndexedHeight).not.toHaveBeenCalled();
  });

  it('refuses a vault NFT held at a wrong tree', async () => {
    const i = ids(LIT_POOL);
    const elsewhere = makeBox({ ergoTree: ME_TREE, value: ERG, assets: [{ tokenId: i.vaultNft, amount: 1n }] });
    expect(await deployments.check(LIT_POOL.ergoTree, i, node({ [i.vaultNft]: [elsewhere] }))).toMatch(
      /not at the vault contract/,
    );
    // the token/token vault tree for the same ids is a wrong tree too
    const t2tTree = deployments.rebuild({ ...i, kind: 't2t' }).feeVaultTree;
    const wrongKind = makeBox({ ergoTree: t2tTree, value: ERG, assets: [{ tokenId: i.vaultNft, amount: 1n }] });
    expect(await deployments.check(LIT_POOL.ergoTree, i, node({ [i.vaultNft]: [wrongKind] }))).toMatch(
      /not at the vault contract/,
    );
  });

  it('a template whose term does not appear exactly once is a config error', () => {
    const cfg = lithosConfig();
    expect(
      () =>
        new LithosDeployments({
          ...cfg,
          n2t: { ...cfg.n2t, poolTree: cfg.n2t.poolTree.replace('0e20' + '5e'.repeat(32), '') },
        }),
    ).toThrow(/vaultNft must appear exactly once/);
  });
});

describe('the allowlist, the guards and pool choice', () => {
  let state: NodeState;
  beforeEach(() => {
    state = newNodeState();
    putPools(state, [
      [LIT_POOL, LIT_VAULT],
      [LIT_RSN_POOL, LIT_RSN_VAULT],
      [BBC_POOL, BBC_VAULT],
    ]);
    state.pools.set(RSN_POOL.assets[0].tokenId, [RSN_POOL]);
  });
  afterEach(() => jest.restoreAllMocks());

  const vaultReads = () => state.calls.filter((c) => c.path.includes(LIT_VAULT.assets[0].tokenId)).length;

  it('with an empty allowlist a LithosDex pool that passes the deployment check and the guards is offered', async () => {
    const dex = makeLithosDex(state, lithosDexConfig([], { minPoolNativeReserve: 100n * ERG }));
    const lithosPlan = await dex.freshPlan(LIT_NFT, { tokenId: null, symbol: 'ERG', decimals: 9 }, 'SELL', ERG);
    expect(lithosPlan.pool.venue).toBe('lithos');
    expect(lithosPlan.swap.amountOut).toBe(241428628025n);
    expect(vaultReads()).toBe(1);
    // the dust pool passes the deployment check but not the native reserve floor
    expect((await dex.getFreshPool(BBC_NFT)).pool.venue).toBe('lithos');
    await expect(dex.freshPlan(BBC_NFT, { tokenId: null, symbol: 'ERG', decimals: 9 }, 'SELL', ERG)).rejects.toThrow(
      /minPoolNativeReserve/,
    );
    // Spectrum is untouched
    const plan = await dex.freshPlan(
      RSN_POOL.assets[0].tokenId,
      { tokenId: null, symbol: 'ERG', decimals: 9 },
      'SELL',
      ERG,
    );
    expect(plan.pool.venue).toBe('spectrum');
  });

  it('a pool off a non-empty lithos allowlist is refused, and its vault is never read', async () => {
    const dex = makeLithosDex(state, lithosDexConfig([LIT_RSN_NFT]));
    await expect(dex.freshPlan(LIT_NFT, { tokenId: null, symbol: 'ERG', decimals: 9 }, 'SELL', ERG)).rejects.toThrow(
      /not on the lithos poolAllowlist/,
    );
    await expect(dex.getFreshPool(LIT_NFT)).rejects.toThrow(/not on the lithos poolAllowlist/);
    expect(vaultReads()).toBe(0);
  });

  it('a listed pool that passes the deployment check is offered, after its vault is read', async () => {
    const dex = makeLithosDex(state, lithosDexConfig([LIT_NFT]));
    const plan = await dex.freshPlan(LIT_NFT, { tokenId: null, symbol: 'ERG', decimals: 9 }, 'SELL', ERG);
    expect(plan.pool.venue).toBe('lithos');
    expect(plan.swap.amountOut).toBe(241428628025n);
    expect(vaultReads()).toBe(1);
  });

  it('a listed pool whose vault moved to a second box is refused', async () => {
    const second = makeBox({ ...LIT_VAULT, registers: LIT_VAULT.additionalRegisters, transactionId: 'ee'.repeat(32) });
    state.pools.set(LIT_VAULT.assets[0].tokenId, [LIT_VAULT, second]);
    const dex = makeLithosDex(state, lithosDexConfig([LIT_NFT]));
    await expect(dex.getFreshPool(LIT_NFT)).rejects.toThrow(/fails the deployment check/);
  });

  it('a listed pool whose vault the lagging index lists twice is a 503 (retry), not a 400', async () => {
    const second = makeBox({ ...LIT_VAULT, registers: LIT_VAULT.additionalRegisters, transactionId: 'ee'.repeat(32) });
    state.pools.set(LIT_VAULT.assets[0].tokenId, [LIT_VAULT, second]);
    setIndexedHeight(state, L_TIP - 1);
    const dex = makeLithosDex(state, lithosDexConfig([LIT_NFT]));
    const error = await dex.getFreshPool(LIT_NFT).then(
      () => null,
      (e) => e,
    );
    expect(error?.statusCode).toBe(503);
    expect(error.message).toMatch(/index has not caught up/);
  });

  it('the guardFailure of the connector names a non-empty lithos allowlist too; an empty one restricts nothing', () => {
    const dex = makeLithosDex(state, lithosDexConfig([LIT_RSN_NFT]));
    const pool = venue.parsePool(LIT_POOL)!;
    expect(dex.guardFailure(pool)).toMatch(/not on the lithos poolAllowlist/);
    expect(makeLithosDex(state, lithosDexConfig([])).guardFailure(pool)).toBeNull();
    // the top-level allowlist still applies to LithosDex pools
    const top = makeLithosDex(state, lithosDexConfig([], { poolAllowlist: [LIT_RSN_NFT] }));
    expect(top.guardFailure(pool)).toMatch(/not on the allowlist/);
  });

  it('the native reserve floor applies to the ERG/token pool; a token/token pool is judged on its token reserves only', () => {
    const dex = makeLithosDex(
      state,
      lithosDexConfig([LIT_NFT, LIT_RSN_NFT, BBC_NFT], { minPoolNativeReserve: 100n * ERG }),
    );
    expect(dex.guardFailure(venue.parsePool(LIT_POOL)!)).toBeNull();
    const bbc = new LithosVenue(lithosConfig([BBC_NFT])).parsePool(BBC_POOL)!;
    expect(dex.guardFailure(bbc)).toMatch(/minPoolNativeReserve/);
    expect(dex.guardFailure(venue.parsePool(LIT_RSN_POOL)!)).toBeNull();
    const strict = makeLithosDex(state, lithosDexConfig([LIT_RSN_NFT], { minPoolTokenReserve: 23399703n }));
    expect(strict.guardFailure(venue.parsePool(LIT_RSN_POOL)!)).toMatch(/minPoolTokenReserve/);
  });

  it('the fee ceiling judges the costlier direction: LIT:RSN keeps 99% x 99.7% on the curve, about 1.297%', () => {
    const dex = makeLithosDex(state, lithosDexConfig([LIT_RSN_NFT], { maxPoolFeePct: '1.29' }));
    expect(dex.guardFailure(venue.parsePool(LIT_RSN_POOL)!)).toMatch(/1\.297%.*maxPoolFeePct 1\.29/);
    const looser = makeLithosDex(state, lithosDexConfig([LIT_RSN_NFT], { maxPoolFeePct: '1.3' }));
    expect(looser.guardFailure(venue.parsePool(LIT_RSN_POOL)!)).toBeNull();
  });

  it('a trade whose own fee is above the ceiling is refused: on LIT:RSN 2 and 20 RSN units pay 50.15% and 5.285%', () => {
    const dex = makeLithosDex(state, lithosDexConfig([LIT_RSN_NFT]));
    const pool = venue.parsePool(LIT_RSN_POOL)!;
    const rsn = { tokenId: LIT_RSN_POOL.assets[2].tokenId, symbol: 'RSN', decimals: 3 };
    const lit = { tokenId: LIT_RSN_POOL.assets[1].tokenId, symbol: 'LIT', decimals: 9 };
    const plan = (d: Ergodex, amount: bigint) => d.plan({ pool, venue, source: 'confirmed' }, rsn, lit, 'SELL', amount);
    // the pool's own figure is under the ceiling
    expect(dex.guardFailure(pool)).toBeNull();
    // 2 units: a side fee of 1 (rounded up) and 1 traded: (2 * 10000 - 1 * 9970) / (2 * 10000)
    expect(() => plan(dex, 2n)).toThrow(
      /swap of 0\.002 RSN into pool .* pays 50\.15% of its input in fees, above maxPoolFeePct 3%/,
    );
    // 20 units: a side fee of 1 and 19 traded: (20 * 10000 - 19 * 9970) / (20 * 10000)
    expect(() => plan(dex, 20n)).toThrow(/pays 5\.285% of its input in fees, above maxPoolFeePct 3%/);
    // a fee exactly at the ceiling passes; one step under it is refused
    const atCeiling = makeLithosDex(state, lithosDexConfig([LIT_RSN_NFT], { maxPoolFeePct: '5.285' }));
    expect(plan(atCeiling, 20n).swap.amountIn).toBe(20n);
    const under = makeLithosDex(state, lithosDexConfig([LIT_RSN_NFT], { maxPoolFeePct: '5.28499999' }));
    expect(() => plan(under, 20n)).toThrow(/5\.285%/);
    // a normal-sized sale passes with the venue's exact-input quote
    const normal = plan(dex, 1000n);
    expect(normal.swap.amountOut).toBe(venue.amountOut(pool, 'y', 1000n));
    expect(normal.swap.amountOut).toBe(TRADE_FEE_NORMAL_OUT);
  });

  it('pool choice by pair skips a pool whose fee on this size is above the ceiling', async () => {
    const dex = makeLithosDex(state, lithosDexConfig([LIT_RSN_NFT]));
    await expect(dex.bestPool('RSN', 'LIT', 'SELL', 0.002)).rejects.toThrow(/No allowed ergodex pool/);
    expect(await dex.bestPool('RSN', 'LIT', 'SELL', 1)).toBe(LIT_RSN_NFT);
  });

  it('pool choice by pair weighs the Spectrum pools and the listed LithosDex pools, and skips a dust pool', async () => {
    state.byTree.set(RSN_POOL.ergoTree, [RSN_POOL]);
    const dex = makeLithosDex(state, lithosDexConfig([LIT_NFT, BBC_NFT], { minPoolNativeReserve: 100n * ERG }));
    // ERG:LIT is the only pool for the pair; ERG:BBC is listed but fails the reserve floor
    expect(await dex.bestPool('ERG', 'LIT', 'SELL', 1)).toBe(LIT_NFT);
    await expect(dex.bestPool('ERG', 'BBC', 'SELL', 1)).rejects.toThrow(/No allowed ergodex pool/);
    // Spectrum's pool for its pair is still found by discovery beside the listed LithosDex pools
    expect(await dex.bestPool('ERG', 'RSN', 'SELL', 1)).toBe(RSN_POOL.assets[0].tokenId);
  });

  it('pool choice picks by output across venues for the same pair', async () => {
    // a Spectrum-style pool for ERG/LIT that pays more than the LithosDex pool for 1 ERG
    const rich = n2tPool({
      x: 1000n * ERG,
      y: 10n ** 15n,
      fee: 997,
      token: LIT_POOL.assets[1].tokenId,
      nft: 'fa'.repeat(32),
    });
    state.byTree.set(rich.ergoTree, [rich]);
    state.pools.set('fa'.repeat(32), [rich]);
    const dex = makeLithosDex(state, lithosDexConfig([LIT_NFT]));
    expect(await dex.bestPool('ERG', 'LIT', 'SELL', 1)).toBe('fa'.repeat(32));
    // and the LithosDex pool when it pays more
    const poor = n2tPool({
      x: 1000n * ERG,
      y: 10n ** 12n,
      fee: 997,
      token: LIT_POOL.assets[1].tokenId,
      nft: 'fa'.repeat(32),
    });
    state.byTree.set(rich.ergoTree, [poor]);
    state.pools.set('fa'.repeat(32), [poor]);
    const again = makeLithosDex(state, lithosDexConfig([LIT_NFT]));
    expect(await again.bestPool('ERG', 'LIT', 'SELL', 1)).toBe(LIT_NFT);
  });
});

describe('the shipped config', () => {
  afterEach(() => jest.restoreAllMocks());

  it('mainnet carries the LithosDex templates with an empty allowlist; testnet has no LithosDex venue', () => {
    const main = shippedMainnet();
    expect(main.lithos!.poolAllowlist).toEqual([]);
    // LithosDex pools are discovered by template, by the operator's decision
    expect(main.lithos!.discoverPools).toBe(true);
    // the shipped guards: 3% fee ceiling, 100 ERG floor
    expect(main.maxPoolFeePct).toBe('3');
    expect(main.minPoolNativeReserve).toBe(100n * ERG);
    // the template hashes, each that of its pool tree and of the captured pool boxes
    expect(main.lithos!.n2t.poolTemplateHash).toBe('76fb608217788427bc0ee0c4f7319982b618d98857ba5c1c8753b2c12ee4c139');
    expect(main.lithos!.t2t.poolTemplateHash).toBe('4b8ced39b69eb50b2474e8399034111bb7be6c49055110cd0396f0fe1570055a');
    expect(ergoTreeTemplateHash(main.lithos!.n2t.poolTree)).toBe(main.lithos!.n2t.poolTemplateHash);
    expect(ergoTreeTemplateHash(main.lithos!.t2t.poolTree)).toBe(main.lithos!.t2t.poolTemplateHash);
    for (const box of [LIT_POOL, BBC_POOL])
      expect(ergoTreeTemplateHash(box.ergoTree)).toBe(main.lithos!.n2t.poolTemplateHash);
    expect(ergoTreeTemplateHash(LIT_RSN_POOL.ergoTree)).toBe(main.lithos!.t2t.poolTemplateHash);
    expect(main.lithos!.feeDenominator).toBe(10000n);
    expect(main.lithos!.accumulatorScale).toBe(10n ** 27n);
    expect(main.lithos!.lockedLiquidity).toBe(2n ** 63n - 1n);
    expect(main.lithos!.n2tMinSuccessorValue).toBe(10000000n);
    expect(main.lithos!.swapOperation).toBe(0);
    // every pinned template is ErgoTree version 3, except the provision logic's inlined expression
    for (const t of [main.lithos!.provisionGuardTree, main.lithos!.n2t.poolTree, main.lithos!.t2t.poolTree]) {
      expect(t.slice(0, 2)).toBe('1b');
    }
    const template = shippedTemplate();
    jest
      .spyOn(ConfigManagerV2, 'getInstance')
      .mockReturnValue({ get: (k: string) => template[k.replace(/^ergodex\./, '')] } as never);
    expect(ErgodexConfig.network('testnet').lithos).toBeUndefined();
  });

  it('the shipped mainnet config builds a connector with both venues', () => {
    const dex = new Ergodex('mainnet', makeLithosDex(newNodeState()).ergo, shippedMainnet(), {
      slippagePct: 1,
      maxRebuilds: 2,
      rebuildWaitMs: 0,
    });
    expect(dex.venues.map((v) => v.name)).toEqual(['spectrum', 'lithos']);
    expect(dex.venueForTree(LIT_POOL.ergoTree)?.name).toBe('lithos');
    expect(dex.venueForTree(LIT_RSN_POOL.ergoTree)?.name).toBe('lithos');
  });

  it('a lithos block missing a value is refused', () => {
    const template = shippedTemplate();
    const networks = template.networks as Record<string, Record<string, unknown>>;
    const lithos = { ...(networks.mainnet.lithos as Record<string, unknown>) };
    delete lithos.accumulatorScale;
    const patched = { ...template, networks: { ...networks, mainnet: { ...networks.mainnet, lithos } } };
    jest.spyOn(ConfigManagerV2, 'getInstance').mockReturnValue({
      get: (k: string) => (patched as Record<string, unknown>)[k.replace(/^ergodex\./, '')],
    } as never);
    expect(() => ErgodexConfig.network('mainnet')).toThrow(/lithos\.accumulatorScale must be set/);
  });

  it('a lithos block whose discoverPools is not a boolean is refused', () => {
    const template = shippedTemplate();
    const networks = template.networks as Record<string, Record<string, unknown>>;
    for (const value of [undefined, 'false', 0]) {
      const lithos = { ...(networks.mainnet.lithos as Record<string, unknown>), discoverPools: value };
      const patched = { ...template, networks: { ...networks, mainnet: { ...networks.mainnet, lithos } } };
      jest.spyOn(ConfigManagerV2, 'getInstance').mockReturnValue({
        get: (k: string) => (patched as Record<string, unknown>)[k.replace(/^ergodex\./, '')],
      } as never);
      expect(() => ErgodexConfig.network('mainnet')).toThrow(/lithos\.discoverPools must be true or false/);
    }
  });

  it('through the config loader: an old file without discoverPools is filled in as true; false is kept', () => {
    const templates = path.join(__dirname, '../../../src/templates');
    const schema = path.join(templates, 'namespace/ergodex-schema.json');
    const templateFile = path.join(templates, 'connectors/ergodex.yml');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ergodex-discover-'));
    try {
      const load = (text: string) => {
        const file = path.join(dir, 'ergodex.yml');
        fs.writeFileSync(path.join(dir, 'root.yml'), 'version: 1\nconfigurations: {}\n');
        fs.writeFileSync(file, text);
        const manager = new ConfigManagerV2(path.join(dir, 'root.yml'));
        manager.addNamespace('ergodex', schema, file, templateFile);
        jest.spyOn(ConfigManagerV2, 'getInstance').mockReturnValue(manager);
        return ErgodexConfig.network('mainnet').lithos!;
      };
      const shipped = fs.readFileSync(templateFile, 'utf8');
      expect(shipped.match(/^ {6}discoverPools: true$/gm)).toHaveLength(1);
      // a file written before the key existed, with its empty allowlist: the merge fills in true
      const old = shipped.replace(/^ {6}discoverPools: true\n/m, '');
      expect(old).not.toMatch(/^\s*discoverPools:/m);
      expect(load(old)).toMatchObject({ discoverPools: true, poolAllowlist: [] });
      // false, as an operator sets it to keep LithosDex off, is kept
      expect(load(shipped.replace(/^ {6}discoverPools: true$/m, '      discoverPools: false')).discoverPools).toBe(
        false,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a lithos block without a pool template hash, or with one that is not its pool tree's, is refused", () => {
    const template = shippedTemplate();
    const networks = template.networks as Record<string, Record<string, unknown>>;
    const shipped = networks.mainnet.lithos as Record<string, Record<string, unknown>>;
    const load = (t2t: Record<string, unknown>) => {
      const lithos = { ...shipped, t2t };
      const patched = { ...template, networks: { ...networks, mainnet: { ...networks.mainnet, lithos } } };
      jest.spyOn(ConfigManagerV2, 'getInstance').mockReturnValue({
        get: (k: string) => (patched as Record<string, unknown>)[k.replace(/^ergodex\./, '')],
      } as never);
      return () => ErgodexConfig.network('mainnet');
    };
    const { poolTemplateHash: _h, ...noHash } = shipped.t2t;
    expect(load(noHash)).toThrow(/lithos\.t2t\.poolTemplateHash must be 32 bytes of hex/);
    // the message says what discovery does, and how to keep LithosDex off
    expect(load(noHash)).toThrow(
      /discovered on chain under this hash: with .*lithos\.discoverPools true .*every pool found .* is offered \(set .*lithos\.discoverPools false/,
    );
    // the ERG/token hash in the token/token block: the message names the right value
    expect(load({ ...shipped.t2t, poolTemplateHash: shipped.n2t.poolTemplateHash })).toThrow(
      /lithos\.t2t\.poolTemplateHash is not the template hash of .*lithos\.t2t\.poolTree \(4b8ced39/,
    );
    // upper case is read as the same hash
    const upper = String(shipped.t2t.poolTemplateHash).toUpperCase();
    expect(load({ ...shipped.t2t, poolTemplateHash: upper })().lithos!.t2t.poolTemplateHash).toBe(
      shipped.t2t.poolTemplateHash,
    );
  });

  it('an absent lithos allowlist is read as empty', () => {
    const template = shippedTemplate();
    const networks = template.networks as Record<string, Record<string, unknown>>;
    const { poolAllowlist: _a, ...lithos } = networks.mainnet.lithos as Record<string, unknown>;
    const patched = { ...template, networks: { ...networks, mainnet: { ...networks.mainnet, lithos } } };
    jest.spyOn(ConfigManagerV2, 'getInstance').mockReturnValue({
      get: (k: string) => (patched as Record<string, unknown>)[k.replace(/^ergodex\./, '')],
    } as never);
    expect(ErgodexConfig.network('mainnet').lithos!.poolAllowlist).toEqual([]);
  });
});
