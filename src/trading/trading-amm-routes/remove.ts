import { Type, Static } from '@sinclair/typebox';
import { FastifyPluginAsync } from 'fastify';

import { removeLiquidity as ergodexRemoveLiquidity } from '../../connectors/ergodex/amm-routes/liquidity';
import { removeLiquidity as meteoraRemoveLiquidity } from '../../connectors/meteora/amm-routes/removeLiquidity';
import { removeLiquidity as pancakeswapRemoveLiquidity } from '../../connectors/pancakeswap/amm-routes/removeLiquidity';
import { removeLiquidity as raydiumRemoveLiquidity } from '../../connectors/raydium/amm-routes/removeLiquidity';
import { removeLiquidity as uniswapRemoveLiquidity } from '../../connectors/uniswap/amm-routes/removeLiquidity';
import { RemoveLiquidityResponse, RemoveLiquidityResponseType } from '../../schemas/amm-schema';
import { httpErrors } from '../../services/error-handler';
import {
  AMM_CONNECTORS,
  chainNetworkField,
  connectorField,
  resolveWalletAddress,
  walletAddressField,
  resolveChainNetwork,
  rethrowRouteError,
  withIdentifiers,
  slippagePctField,
} from '../common';
import { learnPool } from '../learn-pool';

export const UnifiedAmmRemoveLiquidityRequest = Type.Object(
  {
    connector: connectorField(AMM_CONNECTORS, 'AMM connector', { defaulted: false }),
    chainNetwork: chainNetworkField(),
    walletAddress: walletAddressField('Wallet address'),
    poolAddress: Type.String({ description: 'Pool contract address' }),
    positionAddress: Type.Optional(
      Type.String({
        'x-connectors': ['meteora'],
        description:
          'Required for meteora (DAMM v2 positions are NFTs): the specific position to remove from. ' +
          'List positions with position-info or positions-owned. Ignored by fungible-LP AMMs.',
      }),
    ),
    percentageToRemove: Type.Optional(
      Type.Number({
        format: 'decimal',
        minimum: 0,
        maximum: 100,
        description: 'Percentage of liquidity to remove. Send this or lpTokenAmount, not both.',
        examples: [100],
      }),
    ),
    lpTokenAmount: Type.Optional(
      Type.Number({
        format: 'decimal',
        description:
          "The exact LP tokens to return, in the LP token's units. Send this or percentageToRemove, not both. " +
          'Only connectors that support it (ergodex) take it; any other answers 400.',
      }),
    ),
    slippagePct: slippagePctField(),
  },
  { $id: 'AmmRemoveRequest', additionalProperties: false },
);

export const removeLiquidityRoute: FastifyPluginAsync = async (fastify) => {
  fastify.post<{
    Body: Static<typeof UnifiedAmmRemoveLiquidityRequest>;
    Reply: RemoveLiquidityResponseType;
  }>(
    '/remove',
    {
      schema: {
        description: 'Remove liquidity from an AMM pool from any supported connector',
        tags: ['/trading/amm'],
        body: UnifiedAmmRemoveLiquidityRequest,
        response: { 200: RemoveLiquidityResponse },
      },
    },
    async (request) => {
      try {
        const {
          connector,
          chainNetwork,
          walletAddress: requestedWallet,
          poolAddress,
          positionAddress,
          lpTokenAmount,
          slippagePct,
        } = request.body;
        let { percentageToRemove } = request.body;
        const { chain, network } = resolveChainNetwork(chainNetwork, connector, 'amm');
        if (percentageToRemove !== undefined && lpTokenAmount !== undefined) {
          throw httpErrors.badRequest('Send exactly one of percentageToRemove and lpTokenAmount');
        }
        // ergodex must be told what to remove; every other connector keeps the old default of 100%
        if (percentageToRemove === undefined && lpTokenAmount === undefined) {
          if (connector === 'ergodex') {
            throw httpErrors.badRequest('Send exactly one of percentageToRemove and lpTokenAmount');
          }
          percentageToRemove = 100;
        }
        if (lpTokenAmount !== undefined && connector !== 'ergodex') {
          throw httpErrors.badRequest(`lpTokenAmount is not supported by ${connector}; send percentageToRemove`);
        }
        const walletAddress = resolveWalletAddress(chain, requestedWallet);
        const result = await (async () => {
          switch (connector) {
            case 'meteora':
              if (!positionAddress) {
                throw httpErrors.badRequest(
                  'positionAddress is required for meteora: DAMM v2 positions are NFTs and a wallet may hold ' +
                    'several per pool. List them with position-info or positions-owned.',
                );
              }
              return await meteoraRemoveLiquidity(
                network,
                walletAddress,
                poolAddress,
                positionAddress,
                percentageToRemove,
                slippagePct,
              );
            case 'raydium':
              return await raydiumRemoveLiquidity(network, walletAddress, poolAddress, percentageToRemove, slippagePct);
            case 'uniswap':
              return await uniswapRemoveLiquidity(network, walletAddress, poolAddress, percentageToRemove, slippagePct);
            case 'pancakeswap':
              return await pancakeswapRemoveLiquidity(
                network,
                walletAddress,
                poolAddress,
                percentageToRemove,
                slippagePct,
              );
            case 'ergodex':
              return await ergodexRemoveLiquidity(
                network,
                walletAddress,
                poolAddress,
                { percentageToRemove, lpTokenAmount },
                slippagePct,
              );
            default:
              throw httpErrors.badRequest(
                `Unsupported AMM connector: ${connector}. Supported: ${AMM_CONNECTORS.join(', ')}`,
              );
          }
        })();

        // Funds moved through this pool, so it is worth naming next time.
        // Read-only routes deliberately do not do this; see learn-pool.ts.
        // ergodex never reads the pool list, as for its swaps, so nothing is learned for it.
        if (connector !== 'ergodex')
          await learnPool(fastify, 'amm', chain, network, connector, chainNetwork, poolAddress);

        return withIdentifiers(result, { poolAddress, positionAddress });
      } catch (e: any) {
        rethrowRouteError(e, 'Failed to remove AMM liquidity');
      }
    },
  );
};

export default removeLiquidityRoute;
