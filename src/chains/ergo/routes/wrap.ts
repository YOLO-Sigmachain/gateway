import { httpErrors } from '../../../services/error-handler';

/** Ergo's native currency is not a token, so there is nothing to wrap or unwrap. */
export async function wrapErgo(): Promise<never> {
  throw httpErrors.createError(501, 'wrap does not apply to ergo: the native currency is not a token');
}

export async function unwrapErgo(): Promise<never> {
  throw httpErrors.createError(501, 'unwrap does not apply to ergo: the native currency is not a token');
}
