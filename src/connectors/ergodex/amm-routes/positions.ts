/**
 * Liquidity positions on Spectrum-style pools. A position is the wallet's balance of a
 * pool's LP token; there is no position account or NFT, so the shared `positions` list
 * is left out, as for other fungible-LP AMMs.
 *
 * Only what has confirmed is reported: the wallet's LP balance is read from its confirmed
 * boxes (a pending deposit's LP tokens are not counted, and a pending redeem's still are),
 * and the pool from its confirmed box. The two underlying amounts are what a redeem of the
 * whole balance would pay on that box, rounded down as the contract rounds them. `price`
 * is the pool's marginal price, quote per base, from its reserves.
 *
 * A pool counts only if it passes every check a swap requires (venue, NFT supply, guards
 * and allowlist); a pool that fails is refused by position-info and skipped by
 * positions-owned. An LP token that more than one pool box claims is skipped as ambiguous.
 */
import { Ergo } from '../../../chains/ergo/ergo';
import { PositionInfo } from '../../../schemas/amm-schema';
import { httpErrors } from '../../../services/error-handler';
import { logger } from '../../../services/logger';
import { Ergodex, FreshLiquidityPool, ratio, units } from '../ergodex';
import { VenueRuleError } from '../venues/venue';

import { ergodexError } from './errors';

/** Token amounts by id (lower case) in the address's confirmed unspent boxes. */
async function confirmedHoldings(ergo: Ergo, address: string): Promise<Map<string, bigint>> {
  ergo.addressToErgoTree(address); // refuse another network's address before any read
  const boxes = await ergo.node.getUnspentBoxesByAddress(address, {
    includeUnconfirmed: false,
    excludeMempoolSpent: false,
  });
  const held = new Map<string, bigint>();
  for (const box of boxes) {
    for (const a of box.assets) {
      const id = a.tokenId.toLowerCase();
      held.set(id, (held.get(id) ?? 0n) + a.amount);
    }
  }
  return held;
}

/** The position of `balance` LP tokens in a pool, in the shared shape. */
export function positionOf(fresh: FreshLiquidityPool, walletAddress: string, balance: bigint): PositionInfo {
  const { pool, base, quote, lpToken } = fresh;
  let x = 0n;
  let y = 0n;
  if (balance > 0n) {
    try {
      ({ x, y } = fresh.venue.redeemFor!(pool, balance));
    } catch (error) {
      if (error instanceof VenueRuleError) throw httpErrors.badRequest(`Pool ${pool.poolId}: ${error.message}`);
      throw error;
    }
  }
  return {
    poolAddress: pool.poolId,
    walletAddress,
    baseTokenAddress: Ergodex.responseId(base),
    quoteTokenAddress: Ergodex.responseId(quote),
    lpTokenAmount: units(balance, lpToken.decimals),
    baseTokenAmount: units(x, base.decimals),
    quoteTokenAmount: units(y, quote.decimals),
    price: ratio(pool.y.reserve * 10n ** BigInt(base.decimals), pool.x.reserve * 10n ** BigInt(quote.decimals)),
  };
}

/** The wallet's position in one pool (zero amounts when it holds none of its LP token). */
export async function getPositionInfo(
  network: string,
  poolAddress: string,
  walletAddress: string,
): Promise<PositionInfo> {
  try {
    const dex = await Ergodex.getInstance(network);
    const held = await confirmedHoldings(dex.ergo, walletAddress);
    const fresh = await dex.freshLiquidityPool(poolAddress, { confirmedOnly: true });
    return positionOf(fresh, walletAddress, held.get(fresh.lpToken.tokenId!) ?? 0n);
  } catch (error) {
    throw ergodexError(error, 'Failed to get ergodex position info');
  }
}

/**
 * Every position the wallet holds: each LP token in its confirmed boxes that is the LP
 * token of a pool found at the configured pool trees, for pools that pass the checks.
 */
export async function getPositionsOwned(network: string, walletAddress: string): Promise<PositionInfo[]> {
  try {
    const dex = await Ergodex.getInstance(network);
    dex.assertLiquidityOffered();
    const held = await confirmedHoldings(dex.ergo, walletAddress);
    const byLp = new Map<string, string[]>();
    for (const found of await dex.discoverPools()) {
      if (!found.lpTokenId || !held.get(found.lpTokenId)) continue;
      byLp.set(found.lpTokenId, [...(byLp.get(found.lpTokenId) ?? []), found.poolId]);
    }
    const positions: PositionInfo[] = [];
    for (const [lpTokenId, poolIds] of byLp) {
      if (poolIds.length > 1) {
        logger.warn(`ergodex: LP token ${lpTokenId} is claimed by ${poolIds.length} pool boxes; not counted`);
        continue;
      }
      let fresh: FreshLiquidityPool;
      try {
        fresh = await dex.freshLiquidityPool(poolIds[0], { confirmedOnly: true });
      } catch (error) {
        if ((error as { statusCode?: number }).statusCode === undefined) throw error;
        logger.info(`ergodex: pool ${poolIds[0]} not counted as a position: ${(error as Error).message}`);
        continue;
      }
      if (fresh.lpToken.tokenId !== lpTokenId) continue;
      positions.push(positionOf(fresh, walletAddress, held.get(lpTokenId)!));
    }
    return positions.sort((a, b) => (a.poolAddress < b.poolAddress ? -1 : 1));
  } catch (error) {
    throw ergodexError(error, 'Failed to list ergodex positions');
  }
}
