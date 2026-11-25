import { httpErrors } from '../../../services/error-handler';

/**
 * Liquidity (quote, add, remove), positions and pool creation are not supported yet
 * for `ergodex`. The shared AMM routes call this so they answer 501 with a clear message
 * instead of "unsupported connector".
 */
export function ergodexNotSupported(operation: string): never {
  throw httpErrors.createError(501, `${operation} is not supported yet for ergodex`);
}
