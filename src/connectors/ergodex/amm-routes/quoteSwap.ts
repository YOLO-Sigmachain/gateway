import { ChainQuoteSwapResponseType } from '../../../schemas/chain-schema';
import { Ergodex, ratio, SwapPlan, pctToScaled, slipDown, slipUp, toRaw, units } from '../ergodex';

import { ergodexError } from './errors';

/** Where the quote came from: venue, pool kind, pool NFT, the exact box, and whether that box is unconfirmed. */
export function describeRoute(plan: SwapPlan): string {
  return `${plan.pool.venue}:${plan.pool.kind} pool ${plan.pool.poolId} box ${plan.pool.box.boxId} (${plan.source})`;
}

/**
 * The quote response, with field meanings as in the Raydium AMM connector: amounts
 * in whole units and positive; `price` is quote per base from the pool's expected amounts
 *; the slipped bound is apart, in `minAmountOut` (SELL) or `maxAmountIn` (BUY).
 */
export function quoteResponse(plan: SwapPlan, slippagePct: number): ChainQuoteSwapResponseType {
  const { swap, tokenIn, tokenOut, side } = plan;
  const slip = pctToScaled(slippagePct);
  const minOut = side === 'SELL' ? slipDown(swap.amountOut, slip) : swap.amountOut;
  const maxIn = side === 'SELL' ? swap.amountIn : slipUp(swap.amountIn, slip);
  const base = plan.base;
  const quote = plan.quote;
  const [baseRaw, quoteRaw] = side === 'SELL' ? [swap.amountIn, swap.amountOut] : [swap.amountOut, swap.amountIn];
  const reserveOut = swap.input === 'x' ? plan.pool.y.reserve : plan.pool.x.reserve;
  return {
    poolAddress: plan.pool.poolId,
    tokenIn: Ergodex.responseId(tokenIn),
    tokenOut: Ergodex.responseId(tokenOut),
    amountIn: units(swap.amountIn, tokenIn.decimals),
    amountOut: units(swap.amountOut, tokenOut.decimals),
    price: ratio(quoteRaw * 10n ** BigInt(base.decimals), baseRaw * 10n ** BigInt(quote.decimals)),
    slippagePct,
    minAmountOut: units(minOut, tokenOut.decimals),
    maxAmountIn: units(maxIn, tokenIn.decimals),
    priceImpactPct: ratio(swap.amountOut * 100n, reserveOut),
    routePath: describeRoute(plan),
  };
}

export async function quoteSwap(
  network: string,
  poolAddress: string,
  baseToken: string,
  side: 'BUY' | 'SELL',
  amount: number,
  slippagePct?: number,
): Promise<ChainQuoteSwapResponseType> {
  try {
    const dex = await Ergodex.getInstance(network);
    const slip = slippagePct ?? dex.root.slippagePct;
    const base = await dex.resolveToken(baseToken);
    const plan = await dex.freshPlan(poolAddress, base, side, toRaw(amount, base));
    return quoteResponse(plan, slip);
  } catch (error) {
    throw ergodexError(error, 'Failed to quote ergodex swap');
  }
}
