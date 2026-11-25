import { PollResponseType } from '../../../schemas/chain-schema';
import { logger } from '../../../services/logger';
import { Ergo } from '../ergo';

import { toHttpError } from './errors';

export async function pollErgoTransaction(network: string, signature: string): Promise<PollResponseType> {
  try {
    const ergo = await Ergo.getInstance(network);
    const result = await ergo.pollTransaction(signature);
    logger.info(`Poll ergo ${network}, transaction ${signature}, status ${result.txStatus}`);
    return result;
  } catch (error) {
    logger.error(`Error polling Ergo transaction: ${error instanceof Error ? error.message : String(error)}`);
    throw toHttpError(error, 'Failed to poll transaction');
  }
}
