import { BalanceResponseType } from '../../../schemas/chain-schema';
import { logger } from '../../../services/logger';
import { balanceResponse } from '../../wallet-balances';
import { Ergo } from '../ergo';

import { toHttpError } from './errors';

export async function getErgoBalances(
  network: string,
  address: string,
  tokens?: string[],
): Promise<BalanceResponseType> {
  try {
    const ergo = await Ergo.getInstance(network);
    return balanceResponse(await ergo.getBalances(address, tokens));
  } catch (error) {
    logger.error(`Error getting Ergo balances: ${error instanceof Error ? error.message : String(error)}`);
    throw toHttpError(error, 'Failed to get balances');
  }
}
