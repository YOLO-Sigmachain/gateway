import { Ergodex } from '../ergodex';

import { ergodexError } from './errors';

/**
 * The pool to use when the caller names only a pair: among the allowed pools for that
 * pair, the one with the best result for this size (most out for SELL, least in for BUY).
 */
export async function resolvePool(args: {
  network: string;
  baseToken: string;
  quoteToken: string;
  side: 'BUY' | 'SELL';
  amount: number;
}): Promise<string> {
  try {
    const dex = await Ergodex.getInstance(args.network);
    return await dex.bestPool(args.baseToken, args.quoteToken, args.side, args.amount);
  } catch (error) {
    throw ergodexError(error, 'Failed to choose an ergodex pool');
  }
}
