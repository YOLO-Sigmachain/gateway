import { FetchPoolsResponseType, PoolListItem } from '../../../schemas/clmm-schema';
import { Ergodex, feePctOf, ratio } from '../ergodex';

import { ergodexError } from './errors';

/**
 * Pools discovered from the node's index by exact pool tree (confirmed boxes), filtered by
 * `query` (a token id, symbol or pool NFT id) and sorted by the native-coin reserve, then
 * pool id. Boxes at a pool tree that are not pools are skipped. `tvl` is null: there is
 * no USD figure on chain.
 */
export async function fetchPools(args: {
  network: string;
  limit?: number;
  query?: string;
}): Promise<FetchPoolsResponseType> {
  try {
    const dex = await Ergodex.getInstance(args.network);
    const found = await dex.discoverPools();
    const items: Array<PoolListItem & { depth: bigint }> = [];
    for (const { pool } of found) {
      const base = await dex.tokenOfSide(pool.x.tokenId).catch(() => null);
      const quote = await dex.tokenOfSide(pool.y.tokenId).catch(() => null);
      if (!base || !quote) continue;
      const q = args.query?.toLowerCase();
      const words = [pool.poolId, base.symbol, quote.symbol, Ergodex.responseId(base), Ergodex.responseId(quote)];
      if (q && !words.some((w) => w.toLowerCase() === q)) continue;
      items.push({
        address: pool.poolId,
        name: `${base.symbol}-${quote.symbol}`,
        baseTokenAddress: Ergodex.responseId(base),
        baseTokenSymbol: base.symbol,
        quoteTokenAddress: Ergodex.responseId(quote),
        quoteTokenSymbol: quote.symbol,
        binStep: 0,
        baseFee: feePctOf(pool),
        price: ratio(pool.y.reserve * 10n ** BigInt(base.decimals), pool.x.reserve * 10n ** BigInt(quote.decimals)),
        tvl: null,
        depth: pool.x.tokenId === null ? pool.x.reserve : 0n,
      });
    }
    items.sort((a, b) => (a.depth === b.depth ? (a.address < b.address ? -1 : 1) : a.depth > b.depth ? -1 : 1));
    const pageSize = args.limit ?? 50;
    return {
      pools: items.slice(0, pageSize).map(({ depth: _depth, ...item }) => item),
      total: items.length,
      page: 1,
      pageSize,
    };
  } catch (error) {
    throw ergodexError(error, 'Failed to fetch ergodex pools');
  }
}
