/**
 * Connector `ergodex`: AMM trading on Ergo through venue modules (`venues/`): Spectrum-style
 * pools and LithosDex pools; Dexy is to follow as a further module.
 *
 * What this file holds, and nothing more: finding a pool box by its pool NFT on the node,
 * discovering pools (Spectrum by exact tree, LithosDex by template hash), picking the
 * venue that recognises the box's ErgoTree (Spectrum by exact tree, LithosDex by its
 * template's shape, bound to a real deployment only by the venue's admission check, which
 * runs before any pool is used), the guards from config (fee ceiling, minimum size,
 * allowlist), which apply to every venue alike, token resolution by id, and turning a
 * quote into a transaction request for the chain layer. Box selection, change,
 * conservation, signing, submit, locks and pending tracking are `src/chains/ergo`'s.
 *
 * A pool is addressed by its pool NFT id, which is stable; box ids change at every swap.
 * Every quote and every execute reads the pool box fresh.
 */
import { Ergo } from '../../chains/ergo/ergo';
import { ErgoNodeError, normalizeNodeBox } from '../../chains/ergo/ergo.node-client';
import { ErgoOutputSpec } from '../../chains/ergo/ergo.tx-builder';
import { ErgoBox } from '../../chains/ergo/ergo.types';
import { formatUnits, isErgoId, NATIVE_COIN_ID, parseUnits, symbolForMessage } from '../../chains/ergo/ergo.utils';
import { httpErrors } from '../../services/error-handler';
import { logger } from '../../services/logger';

import { ErgodexConfig, ErgodexNetworkConfig, ErgodexRootConfig } from './ergodex.config';
import { LithosVenue } from './venues/lithos/lithos.venue';
import { SpectrumVenue } from './venues/spectrum/spectrum.venue';
import { PoolLiquidityChange, PoolSwap, SideName, Venue, VenuePool, VenueRuleError } from './venues/venue';

/** The id under which the native coin appears in responses (`tokenIn`, `baseTokenAddress`). */
export const NATIVE_TOKEN_ID = NATIVE_COIN_ID;

/** A token as the connector uses it. `tokenId` null is the native coin. */
export interface TokenRef {
  tokenId: string | null;
  symbol: string;
  decimals: number;
}

export type PoolBoxSource = 'confirmed' | 'mempool';

/** A pool as discovery lists it: enough to choose candidates, never enough to price. */
export interface DiscoveredPool {
  poolId: string;
  venue: string;
  kind: string;
  tokenIds: [string | null, string | null];
  /** The pool's LP token, for a venue that offers liquidity on this network. */
  lpTokenId?: string;
  /** How much of that LP token the box holds, when `lpTokenId` is set. */
  lpReserve?: bigint;
  /**
   * The pool as parsed from the discovered (confirmed) box: only for dropping a candidate
   * the guards refuse before it is read live. Never priced or traded.
   */
  asDiscovered: VenuePool;
}

/** Discovery results per chain instance (one per network), by sources and limit. */
const discoveryCache = new WeakMap<
  Ergo,
  Map<string, { height: number; at: number; pools: DiscoveredPool[]; complete: boolean }>
>();

/** Where discovery reads a venue's pool boxes: an exact tree, or a template hash. */
interface DiscoverySource {
  venue: Venue;
  by: 'tree' | 'template';
  key: string;
}

function holdsPairIds(ids: Array<string | null>, a: TokenRef, b: TokenRef): boolean {
  return a.tokenId !== b.tokenId && ids.includes(a.tokenId) && ids.includes(b.tokenId);
}

function offersLiquidity(v: Venue): boolean {
  return Boolean(v.liquidity && v.depositFor && v.redeemFor && v.liquiditySuccessor);
}

export interface FreshPool {
  pool: VenuePool;
  venue: Venue;
  source: PoolBoxSource;
}

/** A priced swap against one fresh pool box, all amounts in the smallest units. */
export interface SwapPlan extends FreshPool {
  side: 'BUY' | 'SELL';
  base: TokenRef;
  quote: TokenRef;
  swap: PoolSwap;
  tokenIn: TokenRef;
  tokenOut: TokenRef;
  successor: ErgoOutputSpec;
}

/**
 * A deposit or redeem priced against one fresh pool box, all amounts in the smallest
 * units. Base is the pool's x side and quote its y side, as pool-info reports them.
 */
export interface FreshLiquidityPool extends FreshPool {
  base: TokenRef;
  quote: TokenRef;
  lpToken: TokenRef;
  /** LP tokens in circulation, as the contract counts them, before any change. */
  supply: bigint;
}

export interface LiquidityPlan extends FreshLiquidityPool {
  change: PoolLiquidityChange;
  successor: ErgoOutputSpec;
}

/** Percent with 8 decimal places as an integer: 1% is 100_000_000n. */
const PCT_SCALE = 10n ** 8n;
const HUNDRED_PCT = 100n * PCT_SCALE;

/** A caller's percentage as an exact integer; a form that is not a plain decimal is a 400. */
export function pctToScaled(pct: number | string): bigint {
  try {
    return parseUnits(typeof pct === 'number' ? pct : pct.trim(), 8);
  } catch (error) {
    throw httpErrors.badRequest(`slippagePct: ${(error as Error).message}`);
  }
}

/** floor(amount * (100% - slippage)) */
export function slipDown(amount: bigint, slippageScaled: bigint): bigint {
  return (amount * (HUNDRED_PCT - slippageScaled)) / HUNDRED_PCT;
}

/** ceil(amount * (100% + slippage)) */
export function slipUp(amount: bigint, slippageScaled: bigint): bigint {
  return (amount * (HUNDRED_PCT + slippageScaled) + HUNDRED_PCT - 1n) / HUNDRED_PCT;
}

/**
 * A whole-unit amount for the response schemas, as its exact decimal digits. Every caller
 * writes it into a decimal-string field (or a message), whose serializer passes a string
 * through as it is; going through a JS number would round amounts of 17 or more
 * significant digits. Typed `number` because the shared schemas declare it so.
 */
export function units(amount: bigint, decimals: number): number {
  return formatUnits(amount, decimals) as unknown as number;
}

/** num / den as a number, from bigints, with `digits` decimal places of exact division. */
export function ratio(num: bigint, den: bigint, digits = 18): number {
  if (den === 0n) return 0;
  return Number(formatUnits((num * 10n ** BigInt(digits)) / den, digits));
}

/**
 * Whether the pool price of `current` (y per x) lies within `slippageScaled` of the price
 * of `reference`, above or below, in exact integers:
 * |y1/x1 - y0/x0| <= slippage * y0/x0.
 */
export function ratioWithin(reference: VenuePool, current: VenuePool, slippageScaled: bigint): boolean {
  const lhs = current.y.reserve * reference.x.reserve * HUNDRED_PCT;
  const base = reference.y.reserve * current.x.reserve;
  return lhs <= base * (HUNDRED_PCT + slippageScaled) && lhs >= base * (HUNDRED_PCT - slippageScaled);
}

export function feePctOf(pool: VenuePool): number {
  return ratio((pool.feeDenom - pool.feeNum) * 100n, pool.feeDenom);
}

export class Ergodex {
  readonly network: string;
  readonly ergo: Ergo;
  readonly config: ErgodexNetworkConfig;
  readonly root: ErgodexRootConfig;
  readonly venues: Venue[];
  private readonly spectrum: SpectrumVenue;
  /** Whether discovery by template has been logged once on this network. */
  private templateDiscoveryLogged = false;

  constructor(network: string, ergo: Ergo, config: ErgodexNetworkConfig, root: ErgodexRootConfig) {
    this.network = network;
    this.ergo = ergo;
    this.config = config;
    this.root = root;
    this.spectrum = new SpectrumVenue(config.spectrum);
    this.venues = this.spectrum.configured ? [this.spectrum] : [];
    if (config.lithos) this.venues.push(new LithosVenue(config.lithos));
  }

  /** A connector for a network, with config read now (so a config update takes effect). */
  static async getInstance(network: string): Promise<Ergodex> {
    if (!ErgodexConfig.networks.includes(network)) {
      throw httpErrors.badRequest(`ergodex has no network ${network}. Available: ${ErgodexConfig.networks.join(', ')}`);
    }
    return new Ergodex(network, await Ergo.getInstance(network), ErgodexConfig.network(network), ErgodexConfig.root());
  }

  private assertConfigured(): void {
    if (this.venues.length === 0) {
      throw httpErrors.notFound(
        `No pools are configured for ergodex on ${this.network}: ergodex.networks.${this.network} names no pool trees`,
      );
    }
  }

  /**
   * The venue that recognises this tree (see `Venue.ownsTree`). Never matched on token
   * layout. For LithosDex a match is only the template's shape: the pool is bound to a
   * real deployment by `admit`, which every caller must run before using it (as
   * `getFreshPool` does).
   */
  venueForTree(ergoTree: string): Venue | undefined {
    return this.venues.find((v) => v.ownsTree(ergoTree));
  }

  // ------------------------------------------------------------------------------------
  // Tokens: identity is the token id. The native coin is named by its symbol or
  // NATIVE_TOKEN_ID; a listed token sharing the native symbol must be named by id.

  async resolveToken(name: string): Promise<TokenRef> {
    const native = this.ergo.config.nativeCurrencySymbol;
    if (name.toLowerCase() === native.toLowerCase() || name.toLowerCase() === NATIVE_TOKEN_ID) {
      return { tokenId: null, symbol: native, decimals: this.ergo.config.nativeDecimals };
    }
    let token;
    try {
      token = await this.ergo.getToken(name);
    } catch (error) {
      if (error instanceof ErgoNodeError) throw error;
      throw httpErrors.badRequest(error instanceof Error ? error.message : String(error));
    }
    if (!token) throw httpErrors.notFound(`Token ${name} is not in the token list and the node does not know it`);
    return { tokenId: token.address, symbol: token.symbol, decimals: token.decimals };
  }

  async tokenOfSide(tokenId: string | null): Promise<TokenRef> {
    if (tokenId === null) {
      return {
        tokenId: null,
        symbol: this.ergo.config.nativeCurrencySymbol,
        decimals: this.ergo.config.nativeDecimals,
      };
    }
    const info = await this.ergo.getTokenById(tokenId);
    if (!info) throw httpErrors.serviceUnavailable(`Token ${tokenId} has no known decimals on this node yet; retry`);
    return { tokenId: info.address, symbol: info.symbol, decimals: info.decimals };
  }

  static responseId(token: TokenRef): string {
    return token.tokenId ?? NATIVE_TOKEN_ID;
  }

  // ------------------------------------------------------------------------------------
  // Pool boxes

  /**
   * The pool box for a pool NFT: the node's confirmed unspent box, or (when
   * `useMempoolSuccessor`) the newest unconfirmed successor in the node's mempool, i.e.
   * the mempool output holding the NFT that no mempool transaction spends. Only boxes at a
   * tree some venue recognises count (see `venueForTree`); the NFT held anywhere else is
   * not this connector's pool. For LithosDex that is the template's shape only, so the box
   * returned here is not yet bound to a real deployment: `getFreshPool` runs the venue's
   * `admit` for that, and every caller must go through it.
   * With `confirmedOnly` the mempool is not read, whatever `useMempoolSuccessor` says.
   */
  async fetchPoolBox(
    poolId: string,
    options: { confirmedOnly?: boolean } = {},
  ): Promise<{ box: ErgoBox; source: PoolBoxSource }> {
    this.assertConfigured();
    if (!isErgoId(poolId)) {
      throw httpErrors.badRequest('A pool is addressed by its pool NFT id (64 hex characters)');
    }
    const id = poolId.toLowerCase();
    const holdsNft = (b: ErgoBox) => b.assets[0]?.tokenId.toLowerCase() === id && b.assets[0].amount === 1n;
    const node = this.ergo.node;
    const confirmedAll = await node.getUnspentBoxesByTokenId(id, {
      limit: 5,
      includeUnconfirmed: false,
      excludeMempoolSpent: false,
    });
    const confirmed = confirmedAll.filter((b) => holdsNft(b) && this.venueForTree(b.ergoTree));
    if (confirmed.length > 1) {
      // An NFT minted with a supply other than 1 is not a pool (a 400); only a real NFT
      // seen in two boxes is a state to retry.
      await this.assertSingleNft(id);
      throw httpErrors.createError(409, `${confirmed.length} unspent boxes hold pool NFT ${id}; refusing to guess`);
    }
    if (this.config.useMempoolSuccessor && !options.confirmedOnly) {
      const pending = (await node.getUnconfirmedOutputsByTokenId(id)).filter(
        (b) => holdsNft(b) && this.venueForTree(b.ergoTree),
      );
      const live: ErgoBox[] = [];
      for (const box of pending) if (!(await node.isSpentInMempool(box.boxId))) live.push(box);
      if (live.length > 1) {
        await this.assertSingleNft(id);
        throw httpErrors.createError(
          409,
          `The mempool holds ${live.length} unspent successors of pool ${id}; retry once it settles`,
        );
      }
      if (live.length === 1) return { box: live[0], source: 'mempool' };
    }
    if (confirmed.length === 1) return { box: confirmed[0], source: 'confirmed' };
    if (confirmedAll.some(holdsNft)) {
      throw httpErrors.badRequest(`Pool NFT ${id} is held by a box at a tree no configured ergodex venue owns`);
    }
    throw httpErrors.notFound(
      `No pool with pool NFT ${id} on ${this.network}. Pools are addressed by pool NFT id, never by box id`,
    );
  }

  /**
   * The pool, fresh from the node, with its venue. Only the venue's own admission applies
   * (for LithosDex: its restriction list when set, and the deployment check) and the
   * pool NFT's single issue; the connector's guards do not.
   */
  async getFreshPool(
    poolId: string,
    options: { confirmedOnly?: boolean; forLiquidity?: boolean } = {},
  ): Promise<FreshPool> {
    const { box, source } = await this.fetchPoolBox(poolId, options);
    const venue = this.venueForTree(box.ergoTree)!;
    if (options.forLiquidity) this.assertLiquidityVenue(venue, poolId);
    const pool = venue.parsePool(box);
    if (!pool) {
      throw httpErrors.badRequest(`Box ${box.boxId} holds pool NFT ${poolId} but is not a valid ${venue.name} pool`);
    }
    if (venue.admit) {
      const refused = await venue.admit(pool, this.ergo.node);
      if (refused) throw httpErrors.badRequest(`Refusing pool: ${refused}`);
    }
    await this.assertSingleNft(pool.poolId);
    return { pool, venue, source };
  }

  /**
   * Liquidity is offered only by a venue whose deposit and redeem are one direct spend of
   * the pool box. A LithosDex deposit or redeem goes through provision boxes, which this
   * connector does not build: a 501, before the pool is admitted or read further.
   */
  private assertLiquidityVenue(venue: Venue, poolId: string): void {
    if (!venue.liquidity || !venue.depositFor || !venue.redeemFor || !venue.liquiditySuccessor) {
      throw httpErrors.createError(
        501,
        `Liquidity on ${venue.name} pools is not supported by ergodex (pool ${poolId}): a deposit or redeem ` +
          'there goes through provision boxes, which this connector does not build. Spectrum-style pools only',
      );
    }
    const refusal = venue.liquidityRefusal?.();
    if (refusal) throw httpErrors.createError(501, `Liquidity is not offered on ${this.network}: ${refusal}`);
  }

  /** A 501 unless some venue on this network offers liquidity. */
  assertLiquidityOffered(): void {
    this.assertConfigured();
    const offering = this.venues.filter(offersLiquidity);
    if (offering.length === 0) {
      throw httpErrors.createError(501, `No ergodex venue on ${this.network} offers liquidity`);
    }
    const refusals = offering.map((v) => v.liquidityRefusal?.() ?? null);
    if (refusals.every((r) => r !== null)) {
      throw httpErrors.createError(501, `Liquidity is not offered on ${this.network}: ${refusals.join('; ')}`);
    }
  }

  /** The pool's LP token and supply; a 400 when the pool box does not allow a deposit or redeem. */
  liquidityOf(fresh: FreshPool): { lpTokenId: string; supply: bigint } {
    const liq = fresh.venue.liquidity?.(fresh.pool) ?? null;
    if (!liq) throw httpErrors.badRequest(`Pool ${fresh.pool.poolId} does not allow a deposit or redeem`);
    if (liq.supply <= 0n) throw httpErrors.badRequest(`Pool ${fresh.pool.poolId} has no LP tokens in circulation`);
    return liq;
  }

  /**
   * A pool is identified by its NFT, so exactly one unit of it may exist. With more, its
   * minter could place a second box at the pool tree holding one unit, and that box would
   * be read as the pool. The node's answer (the token's total emission) is cached by the
   * chain layer: a token is minted once.
   */
  private async assertSingleNft(poolId: string): Promise<void> {
    const emission = await this.ergo.getTokenEmission(poolId);
    if (emission === null) {
      throw httpErrors.serviceUnavailable(`The node does not report the supply of pool NFT ${poolId} yet; retry`);
    }
    if (emission !== 1n) {
      throw httpErrors.badRequest(
        `Refusing pool ${poolId}: its NFT was minted with a supply of ${emission}, not 1, so another box could ` +
          'claim to be this pool',
      );
    }
  }

  /**
   * The box must be the pool of the LP token it holds. Anyone can create a box at a pool
   * tree with an NFT of their own and one unit of a real pool's LP token, and the pool
   * contract lets a redeem there take the caller's real LP tokens for whatever that box
   * holds. The real pool is told apart by how much of the LP token it holds: a pool is
   * created holding nearly all of its LP token's emission and pays LP out only against
   * deposits, so it keeps more than half of it unless more than half is in circulation,
   * which would take reserves near the largest amount a box can hold. The boxes holding a
   * token cannot together hold more than its emission, so only one box can hold more than
   * half: a box holding half or less is not the pool of that LP token. The emission is
   * the node's answer, cached by the chain layer (a token is minted once).
   */
  private async assertPoolOfLpToken(pool: VenuePool, lpTokenId: string): Promise<void> {
    const emission = await this.lpEmission(lpTokenId);
    const held = pool.box.assets[1].amount;
    if (2n * held <= emission) {
      throw httpErrors.badRequest(
        `Box ${pool.box.boxId} (pool NFT ${pool.poolId}) is not the pool of LP token ${lpTokenId}: it holds ` +
          `${held} of the ${emission} minted, and that LP token's pool holds more than half`,
      );
    }
  }

  /** An LP token's emission as the node reports it; a 503 to retry when it does not yet. */
  private async lpEmission(lpTokenId: string): Promise<bigint> {
    const emission = await this.ergo.getTokenEmission(lpTokenId);
    if (emission === null) {
      throw httpErrors.serviceUnavailable(`The node does not report the supply of LP token ${lpTokenId} yet; retry`);
    }
    return emission;
  }

  /** Whether a box holding `held` of an LP token holds more than half of its emission. */
  async holdsMostOfLpToken(lpTokenId: string, held: bigint): Promise<boolean> {
    return 2n * held > (await this.lpEmission(lpTokenId));
  }

  /**
   * The majority rule cannot tell a pool apart when the real pool's box holds half or less
   * of its LP token: its creator kept the rest, and can place a box at a pool tree that
   * holds more than half. A redeem in that box pays out its reserves, not the pool's. So a
   * redeem or position read of `amount` LP tokens is refused with a 409 when another box
   * at a pool tree (from the discovered pool list) holds at least `amount` of the same LP
   * token. A box holding less cannot be the pool those tokens came from, so it does not
   * block. A pool tree read only in part may hide such a box: that is logged, and the
   * request goes ahead.
   */
  async assertSoleLpClaimant(fresh: FreshLiquidityPool, amount: bigint): Promise<void> {
    const lpTokenId = fresh.lpToken.tokenId!;
    const poolId = fresh.pool.poolId;
    const { pools, complete } = await this.discoverPoolList({ liquidityOnly: true });
    const others = pools.filter(
      (p) => p.poolId !== poolId && p.lpTokenId === lpTokenId && (p.lpReserve ?? 0n) >= amount,
    );
    if (others.length > 0) {
      throw httpErrors.createError(
        409,
        `Two boxes at pool trees hold LP token ${lpTokenId}: pool ${poolId}, and ` +
          others.map((p) => `pool ${p.poolId} holding ${p.lpReserve}`).join(', ') +
          `, at least the ${amount} in question; the pool of this LP token cannot be told apart for this amount`,
      );
    }
    if (!complete) {
      logger.warn(
        `ergodex: pool ${poolId}: a pool tree on ${this.network} was read only in part, so another box holding ` +
          `LP token ${lpTokenId} may have been missed; going ahead on the box that holds most of it`,
      );
    }
  }

  /** The reason a pool may not be traded, or null when every guard passes. */
  guardFailure(pool: VenuePool): string | null {
    const venueFailure = this.venues.find((v) => v.name === pool.venue)?.guardFailure?.(pool);
    if (venueFailure) return venueFailure;
    const allow = this.config.poolAllowlist;
    if (allow.length > 0 && !allow.includes(pool.poolId)) return `pool ${pool.poolId} is not on the allowlist`;
    const maxScaled = pctToScaled(this.config.maxPoolFeePct);
    // fee% = (denom - num) * 100 / denom; compare without division
    if ((pool.feeDenom - pool.feeNum) * HUNDRED_PCT > maxScaled * pool.feeDenom) {
      return `pool ${pool.poolId} charges ${feePctOf(pool)}%, above maxPoolFeePct ${this.config.maxPoolFeePct}%`;
    }
    for (const side of [pool.x, pool.y]) {
      if (side.tokenId === null && side.reserve < this.config.minPoolNativeReserve) {
        return `pool ${pool.poolId} holds ${side.reserve} of the native coin, below minPoolNativeReserve ${this.config.minPoolNativeReserve}`;
      }
      if (side.tokenId !== null && side.reserve < this.config.minPoolTokenReserve) {
        return `pool ${pool.poolId} holds ${side.reserve} of token ${side.tokenId}, below minPoolTokenReserve ${this.config.minPoolTokenReserve}`;
      }
    }
    return null;
  }

  assertAllowed(pool: VenuePool): void {
    const failure = this.guardFailure(pool);
    if (failure) throw httpErrors.badRequest(`Refusing to trade: ${failure}`);
  }

  /**
   * Every pool at the configured trees and templates, from the node's index (confirmed
   * boxes): its id, kind and tokens only, for choosing candidates; a candidate is always
   * read live, and admitted by its venue (for LithosDex the deployment check), before it
   * is priced. Spectrum-style pools are read by exact tree; LithosDex pools by template
   * hash, since each pool's tree holds its own ids, unless lithos.discoverPools is false
   * or the lithos poolAllowlist names the pools. Boxes that are not pools (another tree under the template, wrong token
   * count, no R4) are skipped. A tree or template holding more than `maxDiscoveredBoxes`
   * boxes is read in part, with a warning: a partial list can only miss a pool, and the
   * pool used is still read fresh. The list is kept for one block time at one node height,
   * so quotes do not re-read every pool box.
   */
  async discoverPools(): Promise<DiscoveredPool[]> {
    return (await this.discoverPoolList()).pools;
  }

  /**
   * The same list, and whether every source was read whole (false: a pool can be
   * missing). `liquidityOnly`: only venues that offer liquidity.
   */
  async discoverPoolList(
    options: { liquidityOnly?: boolean } = {},
  ): Promise<{ pools: DiscoveredPool[]; complete: boolean }> {
    this.assertConfigured();
    const sources = this.discoverySources(options.liquidityOnly === true);
    if (sources.length === 0) return { pools: [], complete: true };
    const max = this.config.maxDiscoveredBoxes;
    const key = `${max}:${sources.map((s) => `${s.venue.name}:${s.by}:${s.key}`).join(',')}`;
    const { fullHeight } = await this.ergo.node.getInfo();
    let cache = discoveryCache.get(this.ergo);
    if (!cache) discoveryCache.set(this.ergo, (cache = new Map()));
    const hit = cache.get(key);
    const ttlMs = this.ergo.config.blockTimeSeconds * 1000;
    if (hit && hit.height === fullHeight && Date.now() - hit.at < ttlMs) {
      return { pools: hit.pools, complete: hit.complete };
    }
    const found: DiscoveredPool[] = [];
    let allRead = true;
    for (const { venue, by, key: source } of sources) {
      if (by === 'template' && !this.templateDiscoveryLogged) {
        this.templateDiscoveryLogged = true;
        logger.info(
          `ergodex: LithosDex pools are being discovered by template (discoverPools: true) on ${this.network}`,
        );
      }
      const { boxes, complete, notServed } =
        by === 'tree'
          ? { ...(await this.ergo.node.readUnspentBoxesByErgoTree(source, max)), notServed: false }
          : await this.readUnspentBoxesByTemplateHash(source, max);
      if (notServed) {
        allRead = false;
      } else if (!complete) {
        allRead = false;
        const restrict = venue === this.spectrum ? 'poolAllowlist' : `${venue.name}.poolAllowlist`;
        logger.warn(
          `ergodex: more than ${max} unspent boxes ${by === 'tree' ? 'at' : 'under'} a ${venue.name} pool ` +
            `${by === 'tree' ? 'tree' : 'template'} on ${this.network}; choosing among the ${boxes.length} read. ` +
            `Raise maxDiscoveredBoxes or set ${restrict}.`,
        );
      }
      for (const box of boxes) {
        // a box at another tree is not this source's: under a template, any tree whose
        // constants differ from the pinned template's is junk
        if (by === 'tree' ? box.ergoTree.toLowerCase() !== source : !venue.ownsTree(box.ergoTree)) continue;
        const pool = venue.parsePool(box);
        if (!pool) continue;
        const lpTokenId = venue.liquidity?.(pool)?.lpTokenId;
        found.push({
          poolId: pool.poolId,
          venue: pool.venue,
          kind: pool.kind,
          tokenIds: [pool.x.tokenId, pool.y.tokenId],
          ...(lpTokenId ? { lpTokenId, lpReserve: pool.box.assets[1].amount } : {}),
          asDiscovered: pool,
        });
      }
    }
    cache.set(key, { height: fullHeight, at: Date.now(), pools: found, complete: allRead });
    return { pools: found, complete: allRead };
  }

  /**
   * What discovery reads: each Spectrum pool tree, and each template hash of a venue
   * found by template (LithosDex) unless that venue is restricted to listed pools or its
   * discovery is switched off (no template hashes).
   */
  private discoverySources(liquidityOnly: boolean): DiscoverySource[] {
    const sources: DiscoverySource[] = [];
    for (const venue of this.venues) {
      if (liquidityOnly && !offersLiquidity(venue)) continue;
      if (venue === this.spectrum) {
        for (const tree of this.spectrum.trees) sources.push({ venue, by: 'tree', key: tree });
      } else if ((venue.candidatePoolIds?.() ?? []).length === 0) {
        for (const hash of venue.poolTemplateHashes?.() ?? []) sources.push({ venue, by: 'template', key: hash });
      }
    }
    return sources;
  }

  /**
   * Confirmed unspent boxes the node's index files under a template hash, newest first
   * (a pool box is re-created at every swap, so a pool that trades stays inside the cap
   * however many older boxes sit under the template), in pages of the chain's box page
   * size: at most about `maxBoxes`, and `complete` false when there are more. A GET; the
   * node answers an empty list for a hash it has no box under. A 404 means the node does
   * not serve this route: `complete` false and `notServed` true, with a warning, and the
   * boxes read so far.
   */
  private async readUnspentBoxesByTemplateHash(
    hash: string,
    maxBoxes: number,
  ): Promise<{ boxes: ErgoBox[]; complete: boolean; notServed: boolean }> {
    if (!isErgoId(hash)) throw new Error('a template hash is 32 bytes of hex');
    const pageSize = this.ergo.config.boxPageSize;
    const boxes: ErgoBox[] = [];
    const unique = () => {
      const seen = new Set<string>();
      return boxes.filter((box) => (seen.has(box.boxId) ? false : (seen.add(box.boxId), true)));
    };
    for (let offset = 0; offset < maxBoxes; offset += pageSize) {
      const params = new URLSearchParams({
        offset: String(offset),
        limit: String(pageSize),
        sortDirection: 'desc',
        includeUnconfirmed: 'false',
        excludeMempoolSpent: 'false',
      });
      const body = await this.ergo.node.request<
        Array<Record<string, unknown>> | { items?: Array<Record<string, unknown>> }
      >('GET', `/blockchain/box/unspent/byTemplateHash/${hash.toLowerCase()}?${params.toString()}`, {
        notFoundIsNull: true,
      });
      if (body === null) {
        logger.warn(
          `ergodex: the node at ${this.network} answered 404 for GET /blockchain/box/unspent/byTemplateHash/` +
            `${hash.toLowerCase()}: it does not serve this route, so pools under this template are not discovered`,
        );
        return { boxes: unique(), complete: false, notServed: true };
      }
      const batch = Array.isArray(body) ? body : (body.items ?? []);
      boxes.push(...batch.map(normalizeNodeBox));
      if (batch.length < pageSize) return { boxes: unique(), complete: true, notServed: false };
    }
    return { boxes: unique(), complete: false, notServed: false };
  }

  // ------------------------------------------------------------------------------------
  // Pricing

  /**
   * Price a swap on a fresh pool. `amount` is in base units: SELL is an exact input
   * of base, BUY an exact output of base. Throws a 400 for a swap the pool cannot do.
   */
  plan(fresh: FreshPool, base: TokenRef, quote: TokenRef, side: 'BUY' | 'SELL', amount: bigint): SwapPlan {
    const { pool, venue } = fresh;
    const baseSide: SideName = pool.x.tokenId === base.tokenId ? 'x' : 'y';
    const quoteSide: SideName = baseSide === 'x' ? 'y' : 'x';
    if (pool[baseSide].tokenId !== base.tokenId || pool[quoteSide].tokenId !== quote.tokenId) {
      throw httpErrors.badRequest(
        `Pool ${pool.poolId} does not trade ` +
          `${symbolForMessage(base.symbol, base.tokenId)}/${symbolForMessage(quote.symbol, quote.tokenId)}`,
      );
    }
    if (amount <= 0n) throw httpErrors.badRequest('amount must be greater than zero');
    let swap: PoolSwap;
    if (side === 'SELL') {
      const out = venue.amountOut(pool, baseSide, amount);
      if (out <= 0n) {
        throw httpErrors.badRequest(
          `Selling ${formatUnits(amount, base.decimals)} ${symbolForMessage(base.symbol, base.tokenId)} into pool ` +
            `${pool.poolId} gives nothing (rounds to zero)`,
        );
      }
      swap = { input: baseSide, amountIn: amount, amountOut: out };
    } else {
      const needed = venue.amountInFor(pool, quoteSide, amount);
      if (needed === null) {
        throw httpErrors.badRequest(
          `Pool ${pool.poolId} cannot pay ${formatUnits(amount, base.decimals)} ${symbolForMessage(base.symbol, base.tokenId)}: ` +
            `it holds ${formatUnits(pool[baseSide].reserve, base.decimals)}`,
        );
      }
      swap = { input: quoteSide, amountIn: needed, amountOut: amount };
    }
    const [tokenIn, tokenOut] = side === 'SELL' ? [base, quote] : [quote, base];
    const tradeFee = venue.tradeFee?.(pool, swap);
    if (tradeFee) {
      const maxScaled = pctToScaled(this.config.maxPoolFeePct);
      // fee% = num * 100 / den; compare without division, so a fee at the ceiling passes
      if (tradeFee.num * HUNDRED_PCT > maxScaled * tradeFee.den) {
        throw httpErrors.badRequest(
          `This swap of ${formatUnits(swap.amountIn, tokenIn.decimals)} ${symbolForMessage(tokenIn.symbol, tokenIn.tokenId)} ` +
            `into pool ${pool.poolId} ` +
            `pays ${ratio(tradeFee.num * 100n, tradeFee.den)}% of its input in fees, above maxPoolFeePct ` +
            `${this.config.maxPoolFeePct}%; trade a larger amount`,
        );
      }
    }
    const outSide: SideName = swap.input === 'x' ? 'y' : 'x';
    const minerFee = this.ergo.config.minerFee;
    if (pool[outSide].tokenId === null && swap.amountOut <= minerFee) {
      const native = symbolForMessage(this.ergo.config.nativeCurrencySymbol, null);
      const decimals = this.ergo.config.nativeDecimals;
      throw httpErrors.badRequest(
        `The output of ${formatUnits(swap.amountOut, decimals)} ${native} from pool ${pool.poolId} does not cover ` +
          `the miner fee of ${formatUnits(minerFee, decimals)} ${native}; trade a larger amount`,
      );
    }
    let successor: ErgoOutputSpec;
    try {
      successor = venue.successor(pool, swap);
    } catch (error) {
      if (error instanceof VenueRuleError) throw httpErrors.badRequest(`Pool ${pool.poolId}: ${error.message}`);
      throw error;
    }
    return { ...fresh, side, base, quote, swap, tokenIn, tokenOut, successor };
  }

  // ------------------------------------------------------------------------------------
  // Liquidity (Spectrum-style pools): a deposit or redeem is one direct spend of the pool
  // box, as a swap is.

  /**
   * Read the pool fresh for a deposit or redeem: only a venue that offers liquidity (else
   * 501), the box the real pool of the LP token it holds (else 400), and the pool's two
   * tokens and LP token resolved.
   * Entering (quote, add) applies every guard a swap applies. Leaving (`exit`: remove and
   * the position reads) does not: the fee ceiling, the size floors and the allowlist keep
   * a caller out of a pool, and applied to a redeem they would only keep the caller's
   * funds in it. A redeem pays no pool fee and takes the holder's share as the contract
   * fixes it. A guard that would have refused an entry is logged as a warning.
   */
  async freshLiquidityPool(
    poolId: string,
    options: { confirmedOnly?: boolean; exit?: boolean } = {},
  ): Promise<FreshLiquidityPool> {
    const { exit, ...read } = options;
    const fresh = await this.getFreshPool(poolId, { ...read, forLiquidity: true });
    if (!exit) this.assertAllowed(fresh.pool);
    const { lpTokenId, supply } = this.liquidityOf(fresh);
    await this.assertPoolOfLpToken(fresh.pool, lpTokenId);
    if (exit) {
      const failure = this.guardFailure(fresh.pool);
      if (failure) {
        logger.warn(
          `ergodex: ${failure}; a deposit would be refused, but leaving the pool or reading a position is not`,
        );
      }
    }
    const base = await this.tokenOfSide(fresh.pool.x.tokenId);
    const quote = await this.tokenOfSide(fresh.pool.y.tokenId);
    const lpToken = await this.tokenOfSide(lpTokenId);
    return { ...fresh, base, quote, lpToken, supply };
  }

  /**
   * Price a deposit of at most `offerX` of base and `offerY` of quote (null: no limit on
   * that side) on a fresh pool: the most LP tokens the offer buys and the least of each
   * side that buys them (see `depositFor` in the venue math). A 400 when it buys none.
   */
  planDeposit(fresh: FreshLiquidityPool, offerX: bigint | null, offerY: bigint | null): LiquidityPlan {
    const { pool, venue, base, quote } = fresh;
    const change = venue.depositFor!(pool, offerX, offerY);
    if (change.lp <= 0n) {
      throw httpErrors.badRequest(
        `A deposit of ${this.offerText(offerX, base)} and ${this.offerText(offerY, quote)} into pool ` +
          `${pool.poolId} buys no LP token (it rounds to zero); deposit more`,
      );
    }
    if ((offerX !== null && change.x > offerX) || (offerY !== null && change.y > offerY)) {
      throw new Error('deposit plan takes more than offered'); // cannot happen: see depositFor
    }
    return this.liquidityPlan(fresh, change);
  }

  /** Price a redeem of `lp` LP tokens on a fresh pool: the most it may take of each side. */
  planRedeem(fresh: FreshLiquidityPool, lp: bigint): LiquidityPlan {
    const { pool, venue, base, quote, lpToken } = fresh;
    if (lp <= 0n) throw httpErrors.badRequest('The LP amount to redeem must be greater than zero');
    let change: PoolLiquidityChange;
    try {
      change = venue.redeemFor!(pool, lp);
    } catch (error) {
      if (error instanceof VenueRuleError) throw httpErrors.badRequest(`Pool ${pool.poolId}: ${error.message}`);
      throw error;
    }
    if (change.x <= 0n || change.y <= 0n) {
      throw httpErrors.badRequest(
        `Redeeming ${formatUnits(lp, lpToken.decimals)} LP tokens of pool ${pool.poolId} pays ` +
          `${formatUnits(change.x, base.decimals)} ${symbolForMessage(base.symbol, base.tokenId)} and ` +
          `${formatUnits(change.y, quote.decimals)} ${symbolForMessage(quote.symbol, quote.tokenId)}: one side rounds ` +
          'to zero; redeem more',
      );
    }
    return this.liquidityPlan(fresh, change);
  }

  private liquidityPlan(fresh: FreshLiquidityPool, change: PoolLiquidityChange): LiquidityPlan {
    let successor: ErgoOutputSpec;
    try {
      successor = fresh.venue.liquiditySuccessor!(fresh.pool, change);
    } catch (error) {
      if (error instanceof VenueRuleError) throw httpErrors.badRequest(`Pool ${fresh.pool.poolId}: ${error.message}`);
      throw error;
    }
    return { ...fresh, change, successor };
  }

  private offerText(offer: bigint | null, token: TokenRef): string {
    const sym = symbolForMessage(token.symbol, token.tokenId);
    return offer === null ? `any amount of ${sym}` : `${formatUnits(offer, token.decimals)} ${sym}`;
  }

  /** The other token of a pool that holds `base`. */
  async counterToken(pool: VenuePool, base: TokenRef): Promise<TokenRef> {
    if (pool.x.tokenId === base.tokenId) return this.tokenOfSide(pool.y.tokenId);
    if (pool.y.tokenId === base.tokenId) return this.tokenOfSide(pool.x.tokenId);
    throw httpErrors.badRequest(
      `Base token ${symbolForMessage(base.symbol, base.tokenId)} is not in pool ${pool.poolId}`,
    );
  }

  /** Read the pool fresh, apply the guards, and price the swap. */
  async freshPlan(
    poolId: string,
    base: TokenRef,
    side: 'BUY' | 'SELL',
    amount: bigint,
    options: { confirmedOnly?: boolean } = {},
  ): Promise<SwapPlan> {
    const fresh = await this.getFreshPool(poolId, options);
    this.assertAllowed(fresh.pool);
    const quote = await this.counterToken(fresh.pool, base);
    return this.plan(fresh, base, quote, side, amount);
  }

  /**
   * The allowed pool for a pair that gives the best result for this size: the most out
   * for a SELL, the least in for a BUY. Pools the guards refuse, and pools too small for
   * the size (dust, rounding to zero, storage floor, a fee above the ceiling at this
   * size), are skipped, never thrown on.
   * Every candidate is scored on the box a swap would trade: each is read live, as quote
   * and execute read it (the mempool successor when `useMempoolSuccessor`), never on the
   * confirmed box discovery listed.
   */
  async bestPool(baseName: string, quoteName: string, side: 'BUY' | 'SELL', amount: number): Promise<string> {
    this.assertConfigured();
    const base = await this.resolveToken(baseName);
    const quote = await this.resolveToken(quoteName);
    const raw = toRaw(amount, base);
    // Pools found by discovery (Spectrum by tree, LithosDex by template), and the pools of a
    // venue restricted to listed ones (a non-empty lithos poolAllowlist). A discovered pool
    // the guards refuse on its discovered box is dropped before any live read. Every
    // candidate is read live, admitted by its venue, must hold the pair, and must pass the
    // guards again on the live box.
    const ids =
      this.config.poolAllowlist.length > 0
        ? this.config.poolAllowlist
        : [
            ...new Set([
              ...(await this.discoverPools())
                .filter((p) => holdsPairIds(p.tokenIds, base, quote) && !this.guardFailure(p.asDiscovered))
                .map((p) => p.poolId),
              ...this.venues.flatMap((v) => v.candidatePoolIds?.() ?? []),
            ]),
          ];
    const candidates = await this.livePools(ids);
    let best: { poolId: string; score: bigint } | null = null;
    for (const fresh of candidates) {
      if (!this.holdsPair(fresh.pool, base, quote) || this.guardFailure(fresh.pool)) continue;
      let plan: SwapPlan;
      try {
        plan = this.plan(fresh, base, quote, side, raw);
      } catch {
        continue; // this pool cannot do this size
      }
      const score = side === 'SELL' ? plan.swap.amountOut : -plan.swap.amountIn;
      if (!best || score > best.score || (score === best.score && fresh.pool.poolId < best.poolId)) {
        best = { poolId: fresh.pool.poolId, score };
      }
    }
    if (!best) {
      throw httpErrors.notFound(
        `No allowed ergodex pool on ${this.network} can ${side === 'SELL' ? 'sell' : 'buy'} ` +
          `${amount} ${symbolForMessage(base.symbol, base.tokenId)} for ${symbolForMessage(quote.symbol, quote.tokenId)}`,
      );
    }
    return best.poolId;
  }

  private holdsPair(pool: VenuePool, a: TokenRef, b: TokenRef): boolean {
    return holdsPairIds([pool.x.tokenId, pool.y.tokenId], a, b);
  }

  /**
   * Each pool read live; a pool that is gone, invalid or ambiguous right now is skipped,
   * and so is one whose read meets a node error that may pass (unreachable, or a 5xx),
   * with a warning.
   */
  private async livePools(ids: string[]): Promise<FreshPool[]> {
    const pools: FreshPool[] = [];
    for (const id of ids) {
      try {
        pools.push(await this.getFreshPool(id));
      } catch (error) {
        if (error instanceof ErgoNodeError && (error.status === 0 || error.status >= 500)) {
          logger.warn(`ergodex: pool ${id} skipped for this choice: the node read failed (${error.message})`);
          continue;
        }
        if ((error as { statusCode?: number }).statusCode === undefined) throw error;
      }
    }
    return pools;
  }
}

/** The caller's whole-unit amount in the token's smallest unit; refuses anything inexact. */
export function toRaw(amount: number | string, token: TokenRef, field = 'amount'): bigint {
  try {
    return parseUnits(amount, token.decimals);
  } catch (error) {
    throw httpErrors.badRequest(`${field}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
