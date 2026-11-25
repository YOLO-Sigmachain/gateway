import { PoolInfo } from '../../../schemas/amm-schema';
import { Ergodex, feePctOf, ratio, units } from '../ergodex';

import { ergodexError } from './errors';

/**
 * Pool info for one pool, by pool NFT id, read fresh from the node. Base and quote are the
 * pool's own order (ERG/token pools: the native coin is base). `price` is the marginal
 * price in quote per base, from the reserves; the fee is reported apart in `feePct`.
 *
 * The response schema has no field for the venue; the venue is reported in a quote's
 * `routePath`.
 */
export async function getPoolInfo(network: string, poolAddress: string): Promise<PoolInfo> {
  try {
    const dex = await Ergodex.getInstance(network);
    const { pool } = await dex.getFreshPool(poolAddress);
    const base = await dex.tokenOfSide(pool.x.tokenId);
    const quote = await dex.tokenOfSide(pool.y.tokenId);
    return {
      address: pool.poolId,
      baseTokenAddress: Ergodex.responseId(base),
      quoteTokenAddress: Ergodex.responseId(quote),
      feePct: feePctOf(pool),
      price: ratio(pool.y.reserve * 10n ** BigInt(base.decimals), pool.x.reserve * 10n ** BigInt(quote.decimals)),
      baseTokenAmount: units(pool.x.reserve, base.decimals),
      quoteTokenAmount: units(pool.y.reserve, quote.decimals),
    };
  } catch (error) {
    throw ergodexError(error, 'Failed to get ergodex pool info');
  }
}
