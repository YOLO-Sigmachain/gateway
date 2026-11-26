import { httpErrors } from '../../../services/error-handler';

/**
 * Pool creation is not supported yet for `ergodex`. The shared AMM route calls this so it
 * answers 501 with a clear message instead of "unsupported connector". Liquidity (quote,
 * add, remove) and positions are in `liquidity.ts` and `positions.ts`.
 */
export function ergodexNotSupported(operation: string): never {
  throw httpErrors.createError(501, `${operation} is not supported yet for ergodex`);
}
