import { StatusResponseType } from '../../../schemas/chain-schema';
import { logger, redactUrl } from '../../../services/logger';
import { Ergo } from '../ergo';

import { toHttpError } from './errors';

export async function getErgoStatus(network: string): Promise<StatusResponseType> {
  try {
    const ergo = await Ergo.getInstance(network);
    return {
      chain: 'ergo',
      network,
      rpcUrl: redactUrl(ergo.config.nodeURL),
      rpcProvider: 'url',
      currentBlockNumber: await ergo.getCurrentBlockNumber(),
      nativeCurrency: ergo.config.nativeCurrencySymbol,
      swapProvider: ergo.config.swapProvider || '',
    };
  } catch (error) {
    logger.error(`Error getting Ergo status: ${redactUrl(error instanceof Error ? error.message : String(error))}`);
    throw toHttpError(error, 'Failed to get Ergo status');
  }
}
