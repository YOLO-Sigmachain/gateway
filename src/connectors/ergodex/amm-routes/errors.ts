import { toHttpError } from '../../../chains/ergo/routes/errors';
import { logger } from '../../../services/logger';

/** Pass HTTP errors through; turn chain-layer errors into HTTP ones with their own text. */
export function ergodexError(error: unknown, action: string): Error {
  const message = error instanceof Error ? error.message : String(error);
  logger.error(`ergodex: ${action}: ${message}`);
  return toHttpError(error, action);
}
