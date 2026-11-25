/**
 * Connector `ergodex`: AMM trading on Ergo through venue modules (`venues/`). Spectrum-style
 * pools are the first venue; LithosDex and Dexy are to follow as further modules.
 *
 * What this file holds, and nothing more: finding a pool box by its pool NFT on the node,
 * picking the venue by the box's exact ErgoTree, the guards from config (fee ceiling,
 * minimum size, allowlist), token resolution by id, and turning a quote into a
 * transaction request for the chain layer. Box selection, change, conservation, signing,
 * submit, locks and pending tracking are `src/chains/ergo`'s.
 *
 * A pool is addressed by its pool NFT id, which is stable; box ids change at every swap.
 * Every quote and every execute reads the pool box fresh (T-8).
 */
import { Ergo } from '../../chains/ergo/ergo';
import { ErgoNodeError } from '../../chains/ergo/ergo.node-client';
import { ErgoOutputSpec } from '../../chains/ergo/ergo.tx-builder';
import { ErgoBox } from '../../chains/ergo/ergo.types';
import { formatUnits, isErgoId, parseUnits } from '../../chains/ergo/ergo.utils';
import { httpErrors } from '../../services/error-handler';

import { ErgodexConfig, ErgodexNetworkConfig, ErgodexRootConfig } from './ergodex.config';
import { SpectrumVenue } from './venues/spectrum/spectrum.venue';
import { PoolSwap, SideName, Venue, VenuePool, VenueRuleError } from './venues/venue';

/**
 * The id under which the native coin appears in responses (`tokenIn`, `baseTokenAddress`).
 * The native coin is not a token and has no id; 32 zero bytes is the convention Ergo DEX
 * APIs use for it, and no real token id can be all zeros (it is a box id, a hash).
 */
export const NATIVE_TOKEN_ID = '0'.repeat(64);

/** A token as the connector uses it. `tokenId` null is the native coin. */
export interface TokenRef {
  tokenId: string | null;
  symbol: string;
  decimals: number;
}

export type PoolBoxSource = 'confirmed' | 'mempool';

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

/** Percent with 8 decimal places as an integer: 1% is 100_000_000n. */
const PCT_SCALE = 10n ** 8n;
const HUNDRED_PCT = 100n * PCT_SCALE;

export function pctToScaled(pct: number | string): bigint {
  return parseUnits(typeof pct === 'number' ? pct : pct.trim(), 8);
}

/** floor(amount * (100% - slippage)) */
export function slipDown(amount: bigint, slippageScaled: bigint): bigint {
  return (amount * (HUNDRED_PCT - slippageScaled)) / HUNDRED_PCT;
}

/** ceil(amount * (100% + slippage)) */
export function slipUp(amount: bigint, slippageScaled: bigint): bigint {
  return (amount * (HUNDRED_PCT + slippageScaled) + HUNDRED_PCT - 1n) / HUNDRED_PCT;
}

/** A whole-unit number for the response schemas (T-17), from exact digits. */
export function units(amount: bigint, decimals: number): number {
  return Number(formatUnits(amount, decimals));
}

/** num / den as a number, from bigints, with `digits` decimal places of exact division. */
export function ratio(num: bigint, den: bigint, digits = 18): number {
  if (den === 0n) return 0;
  return Number(formatUnits((num * 10n ** BigInt(digits)) / den, digits));
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

  constructor(network: string, ergo: Ergo, config: ErgodexNetworkConfig, root: ErgodexRootConfig) {
    this.network = network;
    this.ergo = ergo;
    this.config = config;
    this.root = root;
    this.spectrum = new SpectrumVenue(config.spectrum);
    this.venues = this.spectrum.configured ? [this.spectrum] : [];
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

  /** The venue whose configured trees include this exact tree. Never matched on token layout. */
  venueForTree(ergoTree: string): Venue | undefined {
    return this.venues.find((v) => v.ownsTree(ergoTree));
  }

  // ------------------------------------------------------------------------------------
  // Tokens: identity is the token id (T-14). The native coin is named by its symbol or
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
   * configured pool tree count; the NFT held anywhere else is not this connector's pool.
   */
  async fetchPoolBox(poolId: string): Promise<{ box: ErgoBox; source: PoolBoxSource }> {
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
      throw httpErrors.createError(409, `${confirmed.length} unspent boxes hold pool NFT ${id}; refusing to guess`);
    }
    if (this.config.useMempoolSuccessor) {
      const pending = (await node.getUnconfirmedOutputsByTokenId(id)).filter(
        (b) => holdsNft(b) && this.venueForTree(b.ergoTree),
      );
      const live: ErgoBox[] = [];
      for (const box of pending) if (!(await node.isSpentInMempool(box.boxId))) live.push(box);
      if (live.length > 1) {
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

  /** The pool, fresh from the node, with its venue. No guards applied. */
  async getFreshPool(poolId: string): Promise<FreshPool> {
    const { box, source } = await this.fetchPoolBox(poolId);
    const venue = this.venueForTree(box.ergoTree)!;
    const pool = venue.parsePool(box);
    if (!pool) {
      throw httpErrors.badRequest(`Box ${box.boxId} holds pool NFT ${poolId} but is not a valid ${venue.name} pool`);
    }
    return { pool, venue, source };
  }

  /** The reason a pool may not be traded, or null when every guard passes. */
  guardFailure(pool: VenuePool): string | null {
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
   * Every pool at the configured trees, from the node's index (confirmed boxes). Boxes at
   * a pool tree that are not pools (wrong token count, no R4) are skipped.
   */
  async discoverPools(): Promise<FreshPool[]> {
    this.assertConfigured();
    const found: FreshPool[] = [];
    for (const venue of this.venues) {
      const trees = venue === this.spectrum ? this.spectrum.trees : [];
      for (const tree of trees) {
        const boxes = await this.ergo.node.getUnspentBoxesByErgoTree(tree, this.config.maxDiscoveredBoxes);
        for (const box of boxes) {
          if (box.ergoTree.toLowerCase() !== tree) continue;
          const pool = venue.parsePool(box);
          if (pool) found.push({ pool, venue, source: 'confirmed' });
        }
      }
    }
    return found;
  }

  // ------------------------------------------------------------------------------------
  // Pricing

  /**
   * Price a swap on a fresh pool. `amount` is in base units (T-9): SELL is an exact input
   * of base, BUY an exact output of base. Throws a 400 for a swap the pool cannot do.
   */
  plan(fresh: FreshPool, base: TokenRef, quote: TokenRef, side: 'BUY' | 'SELL', amount: bigint): SwapPlan {
    const { pool, venue } = fresh;
    const baseSide: SideName = pool.x.tokenId === base.tokenId ? 'x' : 'y';
    const quoteSide: SideName = baseSide === 'x' ? 'y' : 'x';
    if (pool[baseSide].tokenId !== base.tokenId || pool[quoteSide].tokenId !== quote.tokenId) {
      throw httpErrors.badRequest(`Pool ${pool.poolId} does not trade ${base.symbol}/${quote.symbol}`);
    }
    if (amount <= 0n) throw httpErrors.badRequest('amount must be greater than zero');
    let swap: PoolSwap;
    if (side === 'SELL') {
      const out = venue.amountOut(pool, baseSide, amount);
      if (out <= 0n) {
        throw httpErrors.badRequest(
          `Selling ${formatUnits(amount, base.decimals)} ${base.symbol} into pool ${pool.poolId} gives nothing (rounds to zero)`,
        );
      }
      swap = { input: baseSide, amountIn: amount, amountOut: out };
    } else {
      const needed = venue.amountInFor(pool, quoteSide, amount);
      if (needed === null) {
        throw httpErrors.badRequest(
          `Pool ${pool.poolId} cannot pay ${formatUnits(amount, base.decimals)} ${base.symbol}: it holds ${formatUnits(pool[baseSide].reserve, base.decimals)}`,
        );
      }
      swap = { input: quoteSide, amountIn: needed, amountOut: amount };
    }
    let successor: ErgoOutputSpec;
    try {
      successor = venue.successor(pool, swap);
    } catch (error) {
      if (error instanceof VenueRuleError) throw httpErrors.badRequest(`Pool ${pool.poolId}: ${error.message}`);
      throw error;
    }
    const [tokenIn, tokenOut] = side === 'SELL' ? [base, quote] : [quote, base];
    return { ...fresh, side, base, quote, swap, tokenIn, tokenOut, successor };
  }

  /** The other token of a pool that holds `base`. */
  async counterToken(pool: VenuePool, base: TokenRef): Promise<TokenRef> {
    if (pool.x.tokenId === base.tokenId) return this.tokenOfSide(pool.y.tokenId);
    if (pool.y.tokenId === base.tokenId) return this.tokenOfSide(pool.x.tokenId);
    throw httpErrors.badRequest(`Base token ${base.symbol} is not in pool ${pool.poolId}`);
  }

  /** Read the pool fresh, apply the guards, and price the swap. */
  async freshPlan(poolId: string, base: TokenRef, side: 'BUY' | 'SELL', amount: bigint): Promise<SwapPlan> {
    const fresh = await this.getFreshPool(poolId);
    this.assertAllowed(fresh.pool);
    const quote = await this.counterToken(fresh.pool, base);
    return this.plan(fresh, base, quote, side, amount);
  }

  /**
   * The allowed pool for a pair that gives the best result for this size: the most out
   * for a SELL, the least in for a BUY. Pools the guards refuse, and pools too small for
   * the size (dust, rounding to zero, storage floor), are skipped, never thrown on (T-13).
   */
  async bestPool(baseName: string, quoteName: string, side: 'BUY' | 'SELL', amount: number): Promise<string> {
    this.assertConfigured();
    const base = await this.resolveToken(baseName);
    const quote = await this.resolveToken(quoteName);
    const raw = toRaw(amount, base);
    const candidates =
      this.config.poolAllowlist.length > 0
        ? await this.allowlistedPools()
        : (await this.discoverPools()).filter((p) => this.holdsPair(p.pool, base, quote));
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
          `${amount} ${base.symbol} for ${quote.symbol}`,
      );
    }
    return best.poolId;
  }

  private holdsPair(pool: VenuePool, a: TokenRef, b: TokenRef): boolean {
    const ids = [pool.x.tokenId, pool.y.tokenId];
    return a.tokenId !== b.tokenId && ids.includes(a.tokenId) && ids.includes(b.tokenId);
  }

  private async allowlistedPools(): Promise<FreshPool[]> {
    const pools: FreshPool[] = [];
    for (const id of this.config.poolAllowlist) {
      try {
        pools.push(await this.getFreshPool(id));
      } catch (error) {
        if ((error as { statusCode?: number }).statusCode === undefined) throw error;
        // an allowlisted pool that is gone or invalid is skipped
      }
    }
    return pools;
  }
}

/** The caller's whole-unit amount in the token's smallest unit; refuses anything inexact. */
export function toRaw(amount: number | string, token: TokenRef): bigint {
  try {
    return parseUnits(amount, token.decimals);
  } catch (error) {
    throw httpErrors.badRequest(`amount: ${error instanceof Error ? error.message : String(error)}`);
  }
}
