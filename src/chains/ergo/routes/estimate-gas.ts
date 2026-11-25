import { EstimateGasResponse } from '../../../schemas/chain-schema';
import { Ergo } from '../ergo';
import { toDecimalNumber } from '../ergo.utils';

import { toHttpError } from './errors';

/**
 * Ergo has no gas price: a transaction pays one miner fee, set per network in config. It is
 * reported as one "compute unit" priced at the fee in the smallest native unit.
 */
export async function estimateGasErgo(network: string): Promise<EstimateGasResponse> {
  try {
    const ergo = await Ergo.getInstance(network);
    const { minerFee, nativeDecimals, nativeCurrencySymbol } = ergo.config;
    return {
      feePerComputeUnit: Number(minerFee),
      denomination: `smallest ${nativeCurrencySymbol} unit (10^-${nativeDecimals})`,
      computeUnits: 1,
      feeAsset: nativeCurrencySymbol,
      fee: toDecimalNumber(minerFee, nativeDecimals),
      timestamp: Date.now(),
    };
  } catch (error) {
    throw toHttpError(error, 'Failed to estimate fee');
  }
}
