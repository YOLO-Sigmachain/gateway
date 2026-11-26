import { httpErrors } from '../../../services/error-handler';
import {
  AmbiguousTokenError,
  ErgoCheckIncompleteError,
  ErgoCheckOnlyError,
  ErgoInputSpentError,
  ErgoNotSubmittedError,
  ErgoTransactionRejectedError,
} from '../ergo';
import { ErgoNodeError } from '../ergo.node-client';
import { ErgoBuildError } from '../ergo.tx-builder';

/**
 * Turn an Ergo error into an HTTP one. A caller's mistake (an address of another network,
 * an ambiguous symbol, a transaction that cannot be built) is a 400; an unreachable node is a 503; anything the node rejected
 * keeps the node's own text. A transaction the node refused at submit (it answered 4xx)
 * is a 400: it was not taken, so nothing from that submit can confirm. A submit that never
 * reached the node (the connection was refused) is a 503 that says nothing was submitted.
 * An unknown submit outcome is never one of these.
 *
 * With submitMode `check`: a transaction the node's check found valid is a 409 (the
 * request was understood and deliberately not carried out), with the id and the words
 * "nothing was sent"; one the check refused is a 400, like a refusal at submit; a check
 * that gave no verdict is a 503 that says nothing was sent. None of them is a pending
 * transaction, and none carries a code a client would poll on.
 */
export function toHttpError(error: unknown, action: string): Error {
  if (error && typeof error === 'object' && 'statusCode' in error) {
    return error as unknown as Error;
  }
  if (error instanceof ErgoCheckOnlyError) {
    return httpErrors.createError(409, error.message);
  }
  if (error instanceof ErgoCheckIncompleteError) {
    return httpErrors.serviceUnavailable(`${action}: ${error.message}`);
  }
  // a contract box someone spent first: retry after reading its successor
  if (error instanceof ErgoInputSpentError) {
    return httpErrors.createError(409, error.message);
  }
  // a request the builder cannot satisfy (including insufficient funds) is the caller's to fix
  if (error instanceof AmbiguousTokenError || error instanceof ErgoBuildError) {
    return httpErrors.badRequest(error.message);
  }
  // includes a refusal by the node's check (ErgoCheckRejectedError), whose text says so
  if (error instanceof ErgoTransactionRejectedError) {
    return httpErrors.badRequest(`${action}: ${error.message}`);
  }
  if (error instanceof ErgoNotSubmittedError) {
    return httpErrors.serviceUnavailable(`${action}: ${error.message}`);
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
