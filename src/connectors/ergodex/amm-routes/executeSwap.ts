/**
 * Direct swap: the trader's own transaction spends the pool box (input 0, fixed) and
 * creates its successor at output 0; what the trader receives is in the change, at the
 * wallet's own address. Amounts are fixed in the transaction, so there is no slippage
 * band on chain: the caller's slippage is applied once, to the first fresh quote, and
 * every rebuild must still meet that bound.
 *
 * At submit:
 * - the node rejects it because the pool box is already spent: read the pool again,
 *   re-quote, and if the bound still holds rebuild and submit again, up to
 *   `ergodex.maxRebuilds` times; otherwise a 409 that says to retry.
 * - the outcome is unknown (connection lost, 5xx, no id): no rebuild and no resubmit,
 *   since a second transaction could trade twice. A TRANSACTION_TIMEOUT error carries
 *   the transaction id and says to poll it.
 *
 * The response is the submitted transaction as PENDING; a fill is reported only by poll,
 * after confirmation (T-11). No order box is ever placed, before or after.
 */
import { ErgoInputSpentError, ErgoSubmitOutcomeUnknownError } from '../../../chains/ergo/ergo';
import { BuiltErgoTransaction, ErgoTransactionAssertionError } from '../../../chains/ergo/ergo.tx-builder';
import { Eip12BoxCandidate } from '../../../chains/ergo/ergo.types';
import { ChainExecuteSwapResponseType, TransactionStatusCode } from '../../../schemas/chain-schema';
import { httpErrors } from '../../../services/error-handler';
import { logger } from '../../../services/logger';
import { Ergodex, pctToScaled, slipDown, slipUp, SwapPlan, toRaw, units } from '../ergodex';

import { ergodexError } from './errors';
import { describeRoute } from './quoteSwap';

/**
 * Checks on the built transaction, run inside the chain layer's lock before signing: the
 * pool is the only fixed input and is input 0; output 0 is exactly the planned successor
 * (tree, registers byte for byte, token ids and order, LP amount); the venue's contract
 * rule holds for it in bigint; and the pool moves by exactly the planned amounts.
 */
export function verifySwapTransaction(plan: SwapPlan, built: BuiltErgoTransaction): void {
  const fail = (message: string): never => {
    throw new ErgoTransactionAssertionError(`ergodex swap check: ${message}`);
  };
  const { pool, venue, successor, swap } = plan;
  if (built.fixedInputCount !== 1 || built.inputBoxes[0]?.boxId !== pool.box.boxId) fail('the pool must be input 0');
  if (built.inputBoxes.slice(1).some((b) => b.boxId === pool.box.boxId)) fail('the pool box is spent twice');
  const out0: Eip12BoxCandidate | undefined = built.unsigned.outputs[0];
  if (!out0) fail('no successor at output 0');
  if (out0.ergoTree.toLowerCase() !== pool.box.ergoTree.toLowerCase()) fail('successor tree differs from the pool');
  const regs0 = pool.box.additionalRegisters as Record<string, string>;
  const regs1 = (out0.additionalRegisters ?? {}) as Record<string, string>;
  const keys = new Set([...Object.keys(regs0), ...Object.keys(regs1)]);
  for (const k of keys) {
    if ((regs0[k] ?? '').toLowerCase() !== (regs1[k] ?? '').toLowerCase()) fail(`successor register ${k} differs`);
  }
  const assets = out0.assets ?? [];
  if (assets.length !== pool.box.assets.length) fail('successor token count differs');
  pool.box.assets.forEach((a, i) => {
    if (assets[i].tokenId.toLowerCase() !== a.tokenId.toLowerCase()) fail(`successor token ${i} differs`);
  });
  if (BigInt(assets[1].amount) !== pool.box.assets[1].amount) fail('successor LP amount differs');
  if (BigInt(out0.value) !== successor.value) fail('successor value differs from the plan');
  successor.assets!.forEach((a, i) => {
    if (BigInt(assets[i].amount) !== a.amount) fail(`successor token ${i} amount differs from the plan`);
  });
  if (!venue.contractAccepts(pool, out0)) fail('the pool contract rule does not hold for the successor');
  // the planned deltas, from the successor itself
  const reserveOf = (side: 'x' | 'y') => {
    const tokenId = pool[side].tokenId;
    return tokenId === null
      ? BigInt(out0.value)
      : BigInt(assets.find((a) => a.tokenId.toLowerCase() === tokenId.toLowerCase())!.amount);
  };
  const outSide = swap.input === 'x' ? 'y' : 'x';
  if (reserveOf(swap.input) - pool[swap.input].reserve !== swap.amountIn) fail('the pool does not receive the input');
  if (pool[outSide].reserve - reserveOf(outSide) !== swap.amountOut) fail('the pool does not pay the output');
}

function meetsBound(plan: SwapPlan, bound: { minOut?: bigint; maxIn?: bigint }): boolean {
  if (bound.minOut !== undefined && plan.swap.amountOut < bound.minOut) return false;
  if (bound.maxIn !== undefined && plan.swap.amountIn > bound.maxIn) return false;
  return true;
}

export async function executeSwap(
  network: string,
  walletAddress: string,
  poolAddress: string,
  baseToken: string,
  side: 'BUY' | 'SELL',
  amount: number,
  slippagePct?: number,
): Promise<ChainExecuteSwapResponseType> {
  try {
    const dex = await Ergodex.getInstance(network);
    const ergo = dex.ergo;
    const slip = pctToScaled(slippagePct ?? dex.root.slippagePct);
    const wallet = await ergo.getWallet(walletAddress);
    const base = await dex.resolveToken(baseToken);
    const raw = toRaw(amount, base);

    let plan = await dex.freshPlan(poolAddress, base, side, raw);
    const bound =
      side === 'SELL' ? { minOut: slipDown(plan.swap.amountOut, slip) } : { maxIn: slipUp(plan.swap.amountIn, slip) };
    const boundText =
      side === 'SELL'
        ? `at least ${units(bound.minOut!, plan.tokenOut.decimals)} ${plan.tokenOut.symbol} out`
        : `at most ${units(bound.maxIn!, plan.tokenIn.decimals)} ${plan.tokenIn.symbol} in`;

    for (let attempt = 0; ; attempt++) {
      if (attempt > 0) plan = await dex.freshPlan(poolAddress, base, side, raw);
      if (!meetsBound(plan, bound)) {
        throw httpErrors.createError(
          409,
          `The pool moved: ${describeRoute(plan)} now gives ${units(plan.swap.amountOut, plan.tokenOut.decimals)} ` +
            `${plan.tokenOut.symbol} for ${units(plan.swap.amountIn, plan.tokenIn.decimals)} ${plan.tokenIn.symbol}, ` +
            `outside the bound (${boundText}). Nothing that can still execute was submitted; retry with a fresh quote.`,
        );
      }
      try {
        const current = plan;
        const { txId } = await ergo.sendTransaction(
          { changeAddress: wallet.address, inputs: [{ box: current.pool.box }], outputs: [current.successor] },
          wallet.signer,
          { verify: (built) => verifySwapTransaction(current, built) },
        );
        logger.info(`ergodex: submitted ${side} on ${describeRoute(current)} as ${txId}`);
        return { signature: txId, status: TransactionStatusCode.PENDING };
      } catch (error) {
        if (error instanceof ErgoSubmitOutcomeUnknownError) {
          // Never rebuild here: the first transaction may still execute.
          throw httpErrors.transactionTimeout(
            `Transaction ${error.txId} pending: the node's answer to the submit was lost (${error.detail ?? error.message}). ` +
              `Poll /chains/ergo/poll with this signature until it confirms or fails before any new swap; do not resubmit.`,
          );
        }
        if (error instanceof ErgoInputSpentError && error.boxIds.includes(plan.pool.box.boxId)) {
          logger.info(
            `ergodex: pool box ${plan.pool.box.boxId} was spent first (attempt ${attempt + 1}): ${error.message}`,
          );
          if (attempt >= dex.root.maxRebuilds) {
            throw httpErrors.createError(
              409,
              `Pool ${plan.pool.poolId} changed under ${attempt + 1} attempt(s); nothing that can still execute was ` +
                `submitted. Retry. Last rejection: ${error.message}`,
            );
          }
          continue;
        }
        throw error;
      }
    }
  } catch (error) {
    throw ergodexError(error, 'Failed to execute ergodex swap');
  }
}
