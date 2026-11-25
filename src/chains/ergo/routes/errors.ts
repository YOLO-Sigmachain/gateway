import { httpErrors } from '../../../services/error-handler';
import { AmbiguousTokenError } from '../ergo';
import { ErgoNodeError } from '../ergo.node-client';
import { ErgoBuildError } from '../ergo.tx-builder';

/**
 * Turn an Ergo error into an HTTP one. A caller's mistake (an address of another network,
 * an ambiguous symbol, a transaction that cannot be built) is a 400; an unreachable node is a 503; anything the node rejected
 * keeps the node's own text.
 */
export function toHttpError(error: unknown, action: string): Error {
  if (error && typeof error === 'object' && 'statusCode' in error) {
    return error as unknown as Error;
  }
  // a request the builder cannot satisfy (including insufficient funds) is the caller's to fix
  if (error instanceof AmbiguousTokenError || error instanceof ErgoBuildError) {
    return httpErrors.badRequest(error.message);
  }
  if (error instanceof ErgoNodeError) {
    return error.status === 0
      ? httpErrors.serviceUnavailable(`${action}: ${error.message}`)
      : httpErrors.internalServerError(`${action}: ${error.message}`);
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/Invalid Ergo address|network prefix|must be 64 hex/.test(message)) {
    return httpErrors.badRequest(message);
  }
  return httpErrors.internalServerError(`${action}: ${message}`);
}
