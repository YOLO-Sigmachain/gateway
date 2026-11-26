/**
 * LithosDex pools found on chain by template hash, and admitted by the same rules as
 * Spectrum-style pools: the deployment check, the pool NFT issued once, the fee ceiling,
 * the native and token reserve floors, and the optional lithos allowlist as a
 * restriction. The node is a stand-in answering `byTemplateHash` from the captured pools
 * and from synthetic deployments rebuilt from the pinned templates.
 */
import { ErgoNodeError } from '../../../src/chains/ergo/ergo.node-client';
import { ErgoBox } from '../../../src/chains/ergo/ergo.types';
import { ergoTreeTemplateHash } from '../../../src/connectors/ergodex/venues/lithos/lithos.deployment';
import { decodeCollLong, encodeCollLong } from '../../../src/connectors/ergodex/venues/lithos/lithos.math';
import { logger } from '../../../src/services/logger';
import { testConfig } from '../../chains/ergo/ergo-test-helpers';

import { ERG, makeBox, newNodeState, NodeState, RSN_POOL } from './ergodex-test-helpers';
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
  lithosDexConfig,
  makeLithosDex,
  putPools,
  putUnderTemplate,
  syntheticPool,
} from './lithos-test-helpers';

const N2T_HASH = lithosConfig().n2t.poolTemplateHash;
const T2T_HASH = lithosConfig().t2t.poolTemplateHash;
const ERG_REF = { tokenId: null, symbol: 'ERG', decimals: 9 };

/** The shipped mainnet guards: 3% fee ceiling, 100 ERG floor. */
const guarded = (allow: string[] = [], over: Parameters<typeof lithosDexConfig>[1] = {}) =>
  lithosDexConfig(allow, { minPoolNativeReserve: 100n * ERG, maxPoolFeePct: '3', ...over });

/** A deployment of ERG/LIT other than the captured one, holding twice its LIT (so it pays more). */
function richErgLit(
  tag: number,
  over: { registers?: Record<string, string>; value?: bigint } = {},
): { pool: ErgoBox; vault: ErgoBox } {
  const hex = (n: number) => n.toString(16).padStart(2, '0').repeat(32);
  return syntheticPool(
    LIT_POOL,
    { poolNft: hex(tag), vaultNft: hex(tag + 1), provisionToken: hex(tag + 2) },
    { ...over, tokenAmounts: [1n, LIT_POOL.assets[1].amount * 2n, LIT_POOL.assets[2].amount] },
  );
}

const templateCalls = (state: NodeState, hash?: string) =>
  state.calls.filter((c) => c.path.startsWith(`/blockchain/box/unspent/byTemplateHash/${hash ?? ''}`));

describe('LithosDex discovery by template hash', () => {
  let state: NodeState;
  beforeEach(() => {
    state = newNodeState();
    putPools(state, [
      [LIT_POOL, LIT_VAULT],
      [LIT_RSN_POOL, LIT_RSN_VAULT],
      [BBC_POOL, BBC_VAULT],
    ]);
    state.pools.set(RSN_POOL.assets[0].tokenId, [RSN_POOL]);
    state.byTree.set(RSN_POOL.ergoTree, [RSN_POOL]);
  });
  afterEach(() => jest.restoreAllMocks());

  it('every captured pool box sits under its kind template hash, which the config carries', () => {
    expect(ergoTreeTemplateHash(LIT_POOL.ergoTree)).toBe(N2T_HASH);
    expect(ergoTreeTemplateHash(BBC_POOL.ergoTree)).toBe(N2T_HASH);
    expect(ergoTreeTemplateHash(LIT_RSN_POOL.ergoTree)).toBe(T2T_HASH);
    // the vault and Spectrum trees are other templates
    expect(ergoTreeTemplateHash(LIT_VAULT.ergoTree)).not.toBe(N2T_HASH);
    expect(ergoTreeTemplateHash(RSN_POOL.ergoTree)).not.toBe(N2T_HASH);
    for (const bad of ['zz', '00', '']) expect(ergoTreeTemplateHash(bad)).toBeNull();
  });

  it('with the allowlist empty: lists every pool under both templates beside the Spectrum pools, by GET', async () => {
    const dex = makeLithosDex(state, guarded());
    const found = await dex.discoverPools();
    // newest first under each template: BBC was put under the ERG/token template after LIT
    expect(found.filter((f) => f.venue === 'lithos').map((f) => f.poolId)).toEqual([BBC_NFT, LIT_NFT, LIT_RSN_NFT]);
    expect(found.filter((f) => f.venue === 'spectrum').map((f) => f.poolId)).toEqual([RSN_POOL.assets[0].tokenId]);
    expect(found.find((f) => f.poolId === LIT_RSN_NFT)).toMatchObject({
      kind: 't2t',
      tokenIds: [LIT_RSN_POOL.assets[1].tokenId, LIT_RSN_POOL.assets[2].tokenId],
    });
    const calls = templateCalls(state);
    expect(calls.map((c) => c.method)).toEqual(['GET', 'GET']);
    expect(calls[0].path).toMatch(
      new RegExp(
        `/${N2T_HASH}\\?offset=0&limit=100&sortDirection=desc&includeUnconfirmed=false&excludeMempoolSpent=false$`,
      ),
    );
    expect(calls[1].path).toContain(`/${T2T_HASH}?offset=0&limit=100`);
    // no LP token: LithosDex pools offer no liquidity here
    expect(found.filter((f) => f.venue === 'lithos').every((f) => f.lpTokenId === undefined)).toBe(true);
  });

  it('skips junk under a template: another tree with the same template, and a box at the pool tree that is not a pool', async () => {
    // the pool tree with its first constant (Int 0) changed to Int 1: same template hash, not the pinned tree
    expect(LIT_POOL.ergoTree.slice(8, 12)).toBe('0400');
    const otherTree = LIT_POOL.ergoTree.slice(0, 8) + '0402' + LIT_POOL.ergoTree.slice(12);
    expect(ergoTreeTemplateHash(otherTree)).toBe(N2T_HASH);
    const lookalike = makeBox({
      ...LIT_POOL,
      ergoTree: otherTree,
      registers: LIT_POOL.additionalRegisters,
      assets: [{ tokenId: 'e1'.repeat(32), amount: 1n }, ...LIT_POOL.assets.slice(1)],
    });
    const empty = makeBox({ ergoTree: LIT_POOL.ergoTree, value: 1000000n, assets: [] });
    const noRegisters = makeBox({
      ergoTree: LIT_POOL.ergoTree,
      value: LIT_POOL.value,
      assets: [{ tokenId: 'e2'.repeat(32), amount: 1n }, ...LIT_POOL.assets.slice(1)],
    });
    for (const box of [lookalike, empty, noRegisters]) putUnderTemplate(state, box);
    state.pools.set('e1'.repeat(32), [lookalike]);
    const dex = makeLithosDex(state, guarded());
    expect(dex.venueForTree(otherTree)).toBeUndefined();
    const ids = (await dex.discoverPools()).map((f) => f.poolId);
    expect(ids).not.toContain('e1'.repeat(32));
    expect(ids).not.toContain('e2'.repeat(32));
    expect(ids).toContain(LIT_NFT);
    // named directly, the look-alike's box is at a tree no venue owns
    await expect(dex.getFreshPool('e1'.repeat(32))).rejects.toThrow(/at a tree no configured ergodex venue owns/);
  });

  it('reads a template newest first in pages of the box page size, and in part beyond maxDiscoveredBoxes, with a warning', async () => {
    const junk = Array.from({ length: 150 }, (_, i) =>
      makeBox({ ergoTree: LIT_POOL.ergoTree, value: 1000000n + BigInt(i), assets: [] }),
    );
    // oldest first, as the node's index holds them: the dust ERG/BBC pool, a flood of
    // junk, then the ERG/LIT pool (re-created by its last swap, so the newest box)
    state.byTemplate.set(N2T_HASH, [BBC_POOL, ...junk, LIT_POOL]);
    const dex = makeLithosDex(state, guarded(), testConfig({ boxPageSize: 100 }));
    expect((await dex.discoverPools()).map((f) => f.poolId)).toEqual(expect.arrayContaining([LIT_NFT, BBC_NFT]));
    const calls = templateCalls(state, N2T_HASH);
    expect(calls.every((c) => c.path.includes('sortDirection=desc'))).toBe(true);
    const pages = calls.map((c) => /offset=(\d+)&limit=(\d+)/.exec(c.path)!.slice(1));
    expect(pages).toEqual([
      ['0', '100'],
      ['100', '100'],
    ]);
    // at most 100 boxes: the newest pool is read, the oldest past the junk is missed, and
    // the log says so
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => logger);
    const capped = makeLithosDex(state, guarded([], { maxDiscoveredBoxes: 100 }), testConfig({ boxPageSize: 100 }));
    const { pools, complete } = await capped.discoverPoolList();
    expect(complete).toBe(false);
    expect(pools.map((f) => f.poolId)).toContain(LIT_NFT);
    expect(pools.map((f) => f.poolId)).not.toContain(BBC_NFT);
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/more than 100 unspent boxes under a lithos pool template .*set lithos\.poolAllowlist/),
    );
  });

  it('a template the node has no box under (an empty list) is an empty, complete read', async () => {
    state.byTemplate.delete(T2T_HASH);
    const dex = makeLithosDex(state, guarded());
    const { pools, complete } = await dex.discoverPoolList();
    expect(complete).toBe(true);
    expect(pools.some((f) => f.poolId === LIT_RSN_NFT)).toBe(false);
    expect(templateCalls(state, T2T_HASH).length).toBe(1);
  });

  it('a 404 from the template route (the node does not serve it) is a partial read, with a warning', async () => {
    state.noTemplateRoute = true;
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => logger);
    const dex = makeLithosDex(state, guarded());
    const { pools, complete } = await dex.discoverPoolList();
    expect(complete).toBe(false);
    expect(pools.some((f) => f.venue === 'lithos')).toBe(false);
    // the Spectrum pools are still listed
    expect(pools.map((f) => f.poolId)).toContain(RSN_POOL.assets[0].tokenId);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/404 .*\/blockchain\/box\/unspent\/byTemplateHash/));
    expect(warn).not.toHaveBeenCalledWith(expect.stringMatching(/more than .* unspent boxes/));
  });

  it('is read once per node height and block time, and not at all for liquidity', async () => {
    const dex = makeLithosDex(state, guarded());
    expect(await dex.bestPool('ERG', 'LIT', 'SELL', 1)).toBe(LIT_NFT);
    const first = templateCalls(state).length;
    expect(first).toBe(2);
    expect(await dex.bestPool('RSN', 'LIT', 'SELL', 1)).toBe(LIT_RSN_NFT);
    expect(templateCalls(state).length).toBe(first);
    // the liquidity routes list Spectrum-style pools only
    const liquidity = await dex.discoverPoolList({ liquidityOnly: true });
    expect(liquidity.pools.map((f) => f.venue)).toEqual(['spectrum']);
    expect(templateCalls(state).length).toBe(first);
  });

  it('a discovered pool that fails the deployment check is never chosen, and refused when named', async () => {
    // a richer ERG/LIT pool whose tree names another vault NFT: same layout, not a deployment
    const fakeVault = 'ab'.repeat(32);
    const { pool: rich } = richErgLit(0x31);
    const tree = LIT_POOL.ergoTree.replace(LIT_VAULT.assets[0].tokenId, fakeVault);
    const fake = makeBox({ ...rich, ergoTree: tree, registers: rich.additionalRegisters });
    // no vault box: the tree check fails first, before any vault read
    putPools(state, [[fake, []]]);
    const dex = makeLithosDex(state, guarded());
    expect((await dex.discoverPools()).map((f) => f.poolId)).toContain(fake.assets[0].tokenId);
    expect(await dex.bestPool('ERG', 'LIT', 'SELL', 1)).toBe(LIT_NFT);
    await expect(dex.getFreshPool(fake.assets[0].tokenId)).rejects.toThrow(
      /fails the deployment check: its tree is not the pool contract rebuilt from its own ids/,
    );
  });

  it('a real deployment other than the captured ones, richer, is chosen: the rules, not a list, admit it', async () => {
    const { pool, vault } = richErgLit(0x41);
    putPools(state, [[pool, vault]]);
    const dex = makeLithosDex(state, guarded());
    expect(await dex.bestPool('ERG', 'LIT', 'SELL', 1)).toBe(pool.assets[0].tokenId);
    const plan = await dex.freshPlan(pool.assets[0].tokenId, ERG_REF, 'SELL', ERG);
    expect(plan.pool.venue).toBe('lithos');
  });

  it('the native reserve floor: an ERG/token pool under 100 ERG is skipped and refused; at 100 ERG it is not', async () => {
    const pendingX = decodeCollLong(LIT_POOL.additionalRegisters.R6)![0]; // the captured pool's pending ERG fees
    const under = richErgLit(0x51, { value: 100n * ERG + pendingX - 1n });
    const at = richErgLit(0x61, { value: 100n * ERG + pendingX });
    putPools(state, [[under.pool, under.vault]]);
    const dex = makeLithosDex(state, guarded());
    // BBC holds 0.01 ERG; the richer pool holds 99.999999999 ERG of reserve
    await expect(dex.bestPool('ERG', 'BBC', 'SELL', 1)).rejects.toThrow(/No allowed ergodex pool/);
    await expect(dex.freshPlan(BBC_NFT, ERG_REF, 'SELL', ERG)).rejects.toThrow(/below minPoolNativeReserve/);
    expect(await dex.bestPool('ERG', 'LIT', 'SELL', 0.001)).toBe(LIT_NFT);
    await expect(dex.freshPlan(under.pool.assets[0].tokenId, ERG_REF, 'SELL', ERG)).rejects.toThrow(
      /holds 99999999999 of the native coin, below minPoolNativeReserve 100000000000/,
    );
    const again = newNodeState();
    putPools(again, [
      [LIT_POOL, LIT_VAULT],
      [at.pool, at.vault],
    ]);
    const atFloor = makeLithosDex(again, guarded());
    expect(atFloor.guardFailure((await atFloor.getFreshPool(at.pool.assets[0].tokenId)).pool)).toBeNull();
  });

  it('the fee ceiling: a pool above 3% is skipped and refused; one just under it is chosen', async () => {
    // [dex 9700, side 100, side 100]: 9900 x 9700 of 10^8 reaches the curve, 3.97% in fees
    const above = richErgLit(0x71, { registers: { R5: encodeCollLong([9700n, 100n, 100n]) } });
    putPools(state, [[above.pool, above.vault]]);
    const dex = makeLithosDex(state, guarded());
    expect(await dex.bestPool('ERG', 'LIT', 'SELL', 1)).toBe(LIT_NFT);
    await expect(dex.freshPlan(above.pool.assets[0].tokenId, ERG_REF, 'SELL', ERG)).rejects.toThrow(
      /charges 3\.97%, above maxPoolFeePct 3%/,
    );
    // [9800, 100, 100]: 2.98%, under the ceiling, and richer: chosen
    const under = richErgLit(0x81, { registers: { R5: encodeCollLong([9800n, 100n, 100n]) } });
    const again = newNodeState();
    putPools(again, [
      [LIT_POOL, LIT_VAULT],
      [under.pool, under.vault],
    ]);
    expect(await makeLithosDex(again, guarded()).bestPool('ERG', 'LIT', 'SELL', 1)).toBe(under.pool.assets[0].tokenId);
  });

  it('a pool whose NFT was minted with a supply above 1 is skipped and refused', async () => {
    const { pool, vault } = richErgLit(0x91);
    putPools(state, [[pool, vault]]);
    state.emission.set(pool.assets[0].tokenId, 2n);
    const dex = makeLithosDex(state, guarded());
    expect(await dex.bestPool('ERG', 'LIT', 'SELL', 1)).toBe(LIT_NFT);
    await expect(dex.getFreshPool(pool.assets[0].tokenId)).rejects.toThrow(/minted with a supply of 2, not 1/);
  });

  it('a non-empty lithos allowlist restricts: only listed pools, no template read', async () => {
    const { pool, vault } = richErgLit(0xa1);
    putPools(state, [[pool, vault]]);
    const dex = makeLithosDex(state, guarded([LIT_NFT]));
    const found = await dex.discoverPools();
    expect(found.some((f) => f.venue === 'lithos')).toBe(false);
    expect(templateCalls(state).length).toBe(0);
    // the richer pool passes every rule but is not listed
    expect(await dex.bestPool('ERG', 'LIT', 'SELL', 1)).toBe(LIT_NFT);
    await expect(dex.bestPool('RSN', 'LIT', 'SELL', 1)).rejects.toThrow(/No allowed ergodex pool/);
    await expect(dex.getFreshPool(pool.assets[0].tokenId)).rejects.toThrow(/not on the lithos poolAllowlist/);
    // a listed pool must still pass the guards
    const dust = makeLithosDex(state, guarded([BBC_NFT]));
    await expect(dust.bestPool('ERG', 'BBC', 'SELL', 1)).rejects.toThrow(/No allowed ergodex pool/);
  });

  it('a discovered pair candidate the guards refuse on its discovered box is never read live', async () => {
    // above the fee ceiling, and the dust ERG/BBC pool under the native floor
    const above = richErgLit(0xb1, { registers: { R5: encodeCollLong([9700n, 100n, 100n]) } });
    putPools(state, [[above.pool, above.vault]]);
    const dex = makeLithosDex(state, guarded());
    const liveReads = (id: string) => state.calls.filter((c) => c.path.includes(`/byTokenId/${id}`)).length;
    expect(await dex.bestPool('ERG', 'LIT', 'SELL', 1)).toBe(LIT_NFT);
    await expect(dex.bestPool('ERG', 'BBC', 'SELL', 1)).rejects.toThrow(/No allowed ergodex pool/);
    expect(liveReads(above.pool.assets[0].tokenId)).toBe(0);
    expect(liveReads(BBC_NFT)).toBe(0);
    expect(liveReads(LIT_NFT)).toBeGreaterThan(0);
    // named, it is still read and refused
    await expect(dex.freshPlan(above.pool.assets[0].tokenId, ERG_REF, 'SELL', ERG)).rejects.toThrow(
      /above maxPoolFeePct/,
    );
  });

  it('a candidate whose live read meets a transient node error is skipped, with a warning; pair routing goes on', async () => {
    const { pool, vault } = richErgLit(0xc1);
    putPools(state, [[pool, vault]]);
    const dex = makeLithosDex(state, guarded());
    const node = dex.ergo.node;
    const real = node.getUnspentBoxesByTokenId.bind(node);
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => logger);
    for (const failure of [new ErgoNodeError(503, 'node busy'), new ErgoNodeError(0, 'connection refused')]) {
      const spy = jest.spyOn(node, 'getUnspentBoxesByTokenId').mockImplementation(async (tokenId, query) => {
        if (tokenId === pool.assets[0].tokenId) throw failure;
        return real(tokenId, query);
      });
      // the richer pool would win; its read fails, so the captured pool is chosen
      expect(await dex.bestPool('ERG', 'LIT', 'SELL', 1)).toBe(LIT_NFT);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(`pool ${pool.assets[0].tokenId}`));
      spy.mockRestore();
    }
    expect(await dex.bestPool('ERG', 'LIT', 'SELL', 1)).toBe(pool.assets[0].tokenId);
  });

  it('discoverPools false with the allowlist empty: no template read and no LithosDex pool, chosen or named', async () => {
    const config = guarded();
    const dex = makeLithosDex(state, { ...config, lithos: { ...config.lithos!, discoverPools: false } });
    const vaultReads = () => state.calls.filter((c) => c.path.includes(LIT_VAULT.assets[0].tokenId)).length;
    expect((await dex.discoverPools()).map((f) => f.venue)).toEqual(['spectrum']);
    await expect(dex.bestPool('RSN', 'LIT', 'SELL', 1)).rejects.toThrow(/No allowed ergodex pool/);
    await expect(dex.getFreshPool(LIT_NFT)).rejects.toThrow(
      /not offered: lithos\.discoverPools is false and lithos\.poolAllowlist is empty/,
    );
    await expect(dex.freshPlan(LIT_NFT, ERG_REF, 'SELL', ERG)).rejects.toThrow(/lithos\.discoverPools is false/);
    expect(templateCalls(state).length).toBe(0);
    expect(vaultReads()).toBe(0);
    // Spectrum is untouched
    expect((await dex.freshPlan(RSN_POOL.assets[0].tokenId, ERG_REF, 'SELL', ERG)).pool.venue).toBe('spectrum');
  });

  it('discoverPools false with pools listed: only those, no template read', async () => {
    const config = guarded([LIT_RSN_NFT]);
    const dex = makeLithosDex(state, { ...config, lithos: { ...config.lithos!, discoverPools: false } });
    expect(await dex.bestPool('RSN', 'LIT', 'SELL', 1)).toBe(LIT_RSN_NFT);
    await expect(dex.getFreshPool(LIT_NFT)).rejects.toThrow(/not on the lithos poolAllowlist/);
    expect(templateCalls(state).length).toBe(0);
  });

  it('the first discovery by template is logged once, at info', async () => {
    const info = jest.spyOn(logger, 'info').mockImplementation(() => logger);
    const dex = makeLithosDex(state, guarded());
    const said = () =>
      info.mock.calls.filter(([m]) =>
        String(m).includes('LithosDex pools are being discovered by template (discoverPools: true)'),
      ).length;
    await dex.discoverPools();
    expect(said()).toBe(1);
    // a later read past the cache does not log again
    state.calls.length = 0;
    jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 10 ** 9);
    await dex.discoverPools();
    expect(templateCalls(state).length).toBeGreaterThan(0);
    expect(said()).toBe(1);
    // with discovery off, nothing is logged
    const config = guarded();
    await makeLithosDex(state, { ...config, lithos: { ...config.lithos!, discoverPools: false } }).discoverPools();
    expect(said()).toBe(1);
  });

  it('the top-level allowlist names the candidates of every venue, LithosDex included, with no discovery', async () => {
    const dex = makeLithosDex(state, guarded([], { poolAllowlist: [LIT_RSN_NFT] }));
    expect(await dex.bestPool('RSN', 'LIT', 'SELL', 1)).toBe(LIT_RSN_NFT);
    await expect(dex.bestPool('ERG', 'LIT', 'SELL', 1)).rejects.toThrow(/No allowed ergodex pool/);
    expect(templateCalls(state).length).toBe(0);
  });
});

describe('a LithosDex venue without Spectrum trees', () => {
  afterEach(() => jest.restoreAllMocks());

  it('still discovers its pools and chooses among them', async () => {
    const state = newNodeState();
    putPools(state, [[LIT_RSN_POOL, LIT_RSN_VAULT]]);
    const config = guarded();
    const dex = makeLithosDex(state, {
      ...config,
      spectrum: { ...config.spectrum, n2tPoolTrees: [], t2tPoolTrees: [] },
    });
    expect(dex.venues.map((v) => v.name)).toEqual(['lithos']);
    expect(await dex.bestPool('RSN', 'LIT', 'SELL', 1)).toBe(LIT_RSN_NFT);
    expect(state.calls.some((c) => c.path.startsWith('/blockchain/box/unspent/byErgoTree'))).toBe(false);
  });
});
