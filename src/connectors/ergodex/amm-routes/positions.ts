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
 * A pool counts if it is a pool (venue, NFT supply 1) and the real pool of its LP token
 * (it holds more than half of that token's emission). The entry guards (fee ceiling, size
 * floors, allowlist) do not apply: a holder must see a position in a pool they could no
 * longer enter, to leave it. When more than one box at a pool tree holds the same LP
 * token, the real pool among them is used and the others are ignored. An error the
 * caller should retry (status 500 or above, or 409) while reading a pool fails the
 * request, unless another box holding that LP token is its real pool: a list missing a
 * position because of it would look complete.
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
    const fresh = await dex.freshLiquidityPool(poolAddress, { confirmedOnly: true, exit: true });
    return positionOf(fresh, walletAddress, held.get(fresh.lpToken.tokenId!) ?? 0n);
  } catch (error) {
    throw ergodexError(error, 'Failed to get ergodex position info');
  }
}

/** An error the caller should retry, or that is not a refusal of this one pool. */
function mustRethrow(error: unknown): boolean {
  const status = (error as { statusCode?: number }).statusCode;
  return status === undefined || status >= 500 || status === 409;
}

/**
 * Every position the wallet holds: each LP token in its confirmed boxes whose real pool
 * is found at the configured pool trees.
 */
export async function getPositionsOwned(network: string, walletAddress: string): Promise<PositionInfo[]> {
  try {
    const dex = await Ergodex.getInstance(network);
    dex.assertLiquidityOffered();
    const held = await confirmedHoldings(dex.ergo, walletAddress);
    const { pools, complete } = await dex.discoverPoolList();
    if (!complete) {
      logger.warn(
        `ergodex: positions-owned on ${network} read only part of a pool tree (more than maxDiscoveredBoxes ` +
          'boxes); a position can be missing from the list',
      );
    }
    const byLp = new Map<string, string[]>();
    for (const found of pools) {
      if (!found.lpTokenId || !held.get(found.lpTokenId)) continue;
      byLp.set(found.lpTokenId, [...(byLp.get(found.lpTokenId) ?? []), found.poolId]);
    }
    const positions: PositionInfo[] = [];
    for (const [lpTokenId, poolIds] of byLp) {
      // Only one box can be the real pool of an LP token (see freshLiquidityPool); any
      // other box holding it is refused there with a 400 and ignored here.
      let position: PositionInfo | null = null;
      let retry: unknown;
      for (const poolId of poolIds) {
        let fresh: FreshLiquidityPool;
        try {
          fresh = await dex.freshLiquidityPool(poolId, { confirmedOnly: true, exit: true });
        } catch (error) {
          if (mustRethrow(error)) {
            retry ??= error;
          } else {
            logger.info(`ergodex: pool ${poolId} not counted for LP token ${lpTokenId}: ${(error as Error).message}`);
          }
          continue;
        }
        if (fresh.lpToken.tokenId !== lpTokenId) continue;
        position = positionOf(fresh, walletAddress, held.get(lpTokenId)!);
        break;
      }
      if (position) positions.push(position);
      else if (retry !== undefined) throw retry;
      // else: no box is the real pool of this token, so it is not a position
    }
    return positions.sort((a, b) => (a.poolAddress < b.poolAddress ? -1 : 1));
  } catch (error) {
    throw ergodexError(error, 'Failed to list ergodex positions');
  }
}
