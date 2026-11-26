/**
 * Direct swap: the trader's own transaction spends the pool box (input 0, fixed) and
 * creates its successor at output 0; what the trader receives is in the change, at the
 * wallet's own address. Amounts are fixed in the transaction, so there is no slippage
 * band on chain. The price is bound once, before the first build, and every build
 * (the first and each rebuild) must meet that bound:
 * - the caller's own limit, when given: `minAmountOut` for a SELL, `maxAmountIn` for a BUY;
 * - the slippage applied to the first fresh quote;
 * - when that quote is on an unconfirmed pool box created by someone else's transaction,
 *   the slippage applied to the confirmed pool box too, so a price no block has agreed on
 *   cannot move the bound against the trader.
 * The strictest of these binds.
 *
 * At submit:
 * - the node rejects it because the pool box is already spent: read the pool again,
 *   re-quote, and if the bound still holds rebuild and submit again, up to
 *   `ergodex.maxRebuilds` times; otherwise a 409 that says to retry.
 * - the outcome is unknown (connection lost, 5xx, no id): no rebuild and no resubmit,
 *   since a second transaction could trade twice. A TRANSACTION_TIMEOUT error carries
 *   the transaction id and says to poll it.
 *
 * The response is the submitted transaction as PENDING, with `pendingData` holding the
 * amounts its transaction fixes (what it moves if it confirms), in the fields of a
 * confirmed swap's `data`. It carries no `data`: that means confirmed. Whether it
 * confirmed is reported only by poll. No order box is ever placed, before or after.
 *
 * With the network's submitMode not set, the answer is a 503 before anything is read,
 * loaded or signed. With the network's submitMode `check`, everything up to and including
 * signing runs as above, and the signed transaction then goes to the node's check endpoint
 * only. The answer is never PENDING: a 409 that says the node found transaction <id>
 * valid, that nothing was sent, and what it would move; a 400 with the node's text when the
 * check refuses it; a 503 when the check gives no verdict.
 */
import { ErgoCheckOnlyError, ErgoInputSpentError, ErgoSubmitOutcomeUnknownError } from '../../../chains/ergo/ergo';
import { BuiltErgoTransaction, changeDelta, ErgoTransactionAssertionError } from '../../../chains/ergo/ergo.tx-builder';
import { Eip12BoxCandidate } from '../../../chains/ergo/ergo.types';
import { symbolForMessage, tokenForMessage } from '../../../chains/ergo/ergo.utils';
import { ErgoWalletAccount } from '../../../chains/ergo/ergo.wallet';
import { ChainExecuteSwapResponseType, TransactionStatusCode } from '../../../schemas/chain-schema';
import { httpErrors } from '../../../services/error-handler';
import { logger } from '../../../services/logger';
import { Ergodex, pctToScaled, slipDown, slipUp, SwapPlan, toRaw, units } from '../ergodex';

import { ergodexError } from './errors';
import { describeRoute } from './quoteSwap';

/**
 * Checks on the built transaction, run inside the chain layer's lock before signing: the
 * pool is the only fixed input and is input 0, carrying exactly the context variables
 * the venue asks for; output 0 is exactly the planned successor (tree, value, registers
 * and token amounts byte for byte), with the registers and token amounts a swap leaves
 * alone equal to the pool box's; the venue's contract rule holds for it in bigint, with
 * the built inputs; and the pool moves by exactly the planned amounts.
 */
export function verifySwapTransaction(plan: SwapPlan, built: BuiltErgoTransaction): void {
  const fail = (message: string): never => {
    throw new ErgoTransactionAssertionError(`ergodex swap check: ${message}`);
  };
  const { pool, venue, successor, swap } = plan;
  if (built.fixedInputCount !== 1 || built.inputBoxes[0]?.boxId !== pool.box.boxId) fail('the pool must be input 0');
  if (built.inputBoxes.slice(1).some((b) => b.boxId === pool.box.boxId)) fail('the pool box is spent twice');
  const wantExt: Record<string, string> = { ...(venue.swapInputExtension?.(pool) ?? {}) };
  const gotExt: Record<string, string> = built.unsigned.inputs[0].extension ?? {};
  for (const k of new Set([...Object.keys(wantExt), ...Object.keys(gotExt)])) {
    if ((wantExt[k] ?? '').toLowerCase() !== (gotExt[k] ?? '').toLowerCase()) fail(`pool input context variable ${k}`);
  }
  const out0: Eip12BoxCandidate | undefined = built.unsigned.outputs[0];
  if (!out0) fail('no successor at output 0');
  if (out0.ergoTree.toLowerCase() !== pool.box.ergoTree.toLowerCase()) fail('successor tree differs from the pool');
  const regs0 = pool.box.additionalRegisters as Record<string, string>;
  const regs1 = (out0.additionalRegisters ?? {}) as Record<string, string>;
  const planned = (successor.additionalRegisters ?? {}) as Record<string, string>;
  for (const k of new Set([...Object.keys(planned), ...Object.keys(regs1)])) {
    if ((planned[k] ?? '').toLowerCase() !== (regs1[k] ?? '').toLowerCase()) fail(`successor register ${k} differs`);
  }
  for (const k of venue.unchangedRegisters?.(pool) ?? Object.keys(regs0)) {
    if ((regs0[k] ?? '').toLowerCase() !== (regs1[k] ?? '').toLowerCase()) fail(`successor register ${k} differs`);
  }
  const assets = out0.assets ?? [];
  if (assets.length !== pool.box.assets.length) fail('successor token count differs');
  pool.box.assets.forEach((a, i) => {
    if (assets[i].tokenId.toLowerCase() !== a.tokenId.toLowerCase()) fail(`successor token ${i} differs`);
  });
  for (const i of venue.unchangedTokenIndexes?.(pool) ?? [1]) {
    if (BigInt(assets[i].amount) !== pool.box.assets[i].amount) {
      fail(
        i === 1 && !venue.unchangedTokenIndexes ? 'successor LP amount differs' : `successor token ${i} amount differs`,
      );
    }
  }
  if (BigInt(out0.value) !== successor.value) fail('successor value differs from the plan');
  successor.assets!.forEach((a, i) => {
    if (BigInt(assets[i].amount) !== a.amount) fail(`successor token ${i} amount differs from the plan`);
  });
  if (!venue.contractAccepts(pool, out0, built.inputBoxes))
    fail('the pool contract rule does not hold for the successor');
  // the planned deltas, from the successor itself
  const reserveOf = (side: 'x' | 'y') => {
    const tokenId = pool[side].tokenId;
    return tokenId === null
      ? BigInt(out0.value)
      : BigInt(assets.find((a) => a.tokenId.toLowerCase() === tokenId.toLowerCase())!.amount);
  };
  const outSide = swap.input === 'x' ? 'y' : 'x';
  const heldBefore = (side: 'x' | 'y') => pool[side].held ?? pool[side].reserve;
  if (reserveOf(swap.input) - heldBefore(swap.input) !== swap.amountIn) fail('the pool does not receive the input');
  if (heldBefore(outSide) - reserveOf(outSide) !== swap.amountOut) fail('the pool does not pay the output');
  // the wallet moves by exactly the swap and the miner fee, and by nothing else
  const expected = new Map<string | null, bigint>();
  const add = (key: string | null, amount: bigint) => expected.set(key, (expected.get(key) ?? 0n) + amount);
  add(plan.tokenIn.tokenId, -swap.amountIn);
  add(plan.tokenOut.tokenId, swap.amountOut);
  add(null, -built.fee);
  const actual = changeDelta(built);
  for (const key of new Set([...expected.keys(), ...actual.keys()])) {
    if ((expected.get(key) ?? 0n) !== (actual.get(key) ?? 0n))
      fail(`the wallet's ${key ?? 'native'} balance change differs`);
  }
}

/**
 * The amounts a submitted swap moves, all fixed in its transaction: if it confirms, it
 * moves exactly these. In the shape of a confirmed swap's `data`, sent as `pendingData`;
 * the answer stays PENDING.
 */
export function fixedSwapData(
  plan: SwapPlan,
  built: BuiltErgoTransaction,
  nativeDecimals: number,
  slippagePct: number,
): NonNullable<ChainExecuteSwapResponseType['data']> {
  const delta = changeDelta(built);
  const change = (token: SwapPlan['base']) => units(delta.get(token.tokenId) ?? 0n, token.decimals);
  return {
    tokenIn: Ergodex.responseId(plan.tokenIn),
    tokenOut: Ergodex.responseId(plan.tokenOut),
    amountIn: units(plan.swap.amountIn, plan.tokenIn.decimals),
    amountOut: units(plan.swap.amountOut, plan.tokenOut.decimals),
    fee: units(built.fee, nativeDecimals),
    baseTokenBalanceChange: change(plan.base),
    quoteTokenBalanceChange: change(plan.quote),
    slippagePct,
  };
}

/**
 * What a checked (not sent) swap would move, in words, from the same amounts as
 * `pendingData`. Each token is named by its symbol and the start of its id, so a token
 * named like another can be told apart; the native coin by its symbol.
 */
export function describeCheckedSwap(
  plan: SwapPlan,
  data: NonNullable<ChainExecuteSwapResponseType['data']>,
  nativeSymbol: string,
): string {
  const sym = (token: SwapPlan['base']) => tokenForMessage(token.symbol, token.tokenId);
  return (
    `${data.amountIn} ${sym(plan.tokenIn)} in and ${data.amountOut} ${sym(plan.tokenOut)} out on ` +
    `${describeRoute(plan)}, miner fee ${data.fee} ${symbolForMessage(nativeSymbol, null)}; the wallet would ` +
    `change by ${data.baseTokenBalanceChange} ${sym(plan.base)} and ${data.quoteTokenBalanceChange} ${sym(plan.quote)}`
  );
}

interface SwapBound {
  minOut?: bigint;
  maxIn?: bigint;
}

function meetsBound(plan: SwapPlan, bound: SwapBound): boolean {
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
  minAmountOut?: number,
  maxAmountIn?: number,
): Promise<ChainExecuteSwapResponseType> {
  let wallet: ErgoWalletAccount | undefined;
  try {
    if (side === 'BUY' && minAmountOut !== undefined) {
      throw httpErrors.badRequest('minAmountOut applies to a SELL (exact input); a BUY is limited by maxAmountIn');
    }
    if (side === 'SELL' && maxAmountIn !== undefined) {
      throw httpErrors.badRequest('maxAmountIn applies to a BUY (exact output); a SELL is limited by minAmountOut');
    }
    const dex = await Ergodex.getInstance(network);
    const ergo = dex.ergo;
    // before any pool or box is read and before the wallet's key is loaded
    ergo.assertSubmitModeSet();
    const appliedSlippagePct = slippagePct ?? dex.root.slippagePct;
    const slip = pctToScaled(appliedSlippagePct);
    wallet = await ergo.getWallet(walletAddress);
    const signer = wallet.signer;
    const changeAddress = wallet.address;
    const base = await dex.resolveToken(baseToken);
    const raw = toRaw(amount, base);

    let plan = await dex.freshPlan(poolAddress, base, side, raw);
    // The plans the slippage applies to: the first fresh quote, and the confirmed pool box
    // when that quote is on an unconfirmed box that none of our own transactions created.
    const priced = [plan];
    if (plan.source === 'mempool' && !ergo.pending.get(plan.pool.box.transactionId)) {
      priced.push(await dex.freshPlan(poolAddress, base, side, raw, { confirmedOnly: true }));
    }
    const bound: SwapBound = {};
    if (side === 'SELL') {
      const limits = priced.map((p) => slipDown(p.swap.amountOut, slip));
      if (minAmountOut !== undefined) limits.push(toRaw(minAmountOut, plan.tokenOut, 'minAmountOut'));
      bound.minOut = limits.reduce((a, b) => (b > a ? b : a));
    } else {
      const limits = priced.map((p) => slipUp(p.swap.amountIn, slip));
      if (maxAmountIn !== undefined) limits.push(toRaw(maxAmountIn, plan.tokenIn, 'maxAmountIn'));
      bound.maxIn = limits.reduce((a, b) => (b < a ? b : a));
    }
    const boundText =
      side === 'SELL'
        ? `at least ${units(bound.minOut!, plan.tokenOut.decimals)} ${symbolForMessage(plan.tokenOut.symbol, plan.tokenOut.tokenId)} out`
        : `at most ${units(bound.maxIn!, plan.tokenIn.decimals)} ${symbolForMessage(plan.tokenIn.symbol, plan.tokenIn.tokenId)} in`;

    for (let attempt = 0; ; attempt++) {
      if (attempt > 0) plan = await dex.freshPlan(poolAddress, base, side, raw);
      if (!meetsBound(plan, bound)) {
        throw httpErrors.createError(
          409,
          `The pool moved: ${describeRoute(plan)} now gives ${units(plan.swap.amountOut, plan.tokenOut.decimals)} ` +
            `${symbolForMessage(plan.tokenOut.symbol, plan.tokenOut.tokenId)} for ` +
            `${units(plan.swap.amountIn, plan.tokenIn.decimals)} ${symbolForMessage(plan.tokenIn.symbol, plan.tokenIn.tokenId)}, ` +
            `outside the bound (${boundText}). Nothing that can still execute was submitted; retry with a fresh quote.`,
        );
      }
      const current = plan;
      // worked out before signing, so nothing after the submit can fail
      let pendingData: ReturnType<typeof fixedSwapData> | undefined;
      try {
        const { txId } = await ergo.sendTransaction(
          {
            changeAddress,
            inputs: [{ box: current.pool.box, extension: current.venue.swapInputExtension?.(current.pool) }],
            outputs: [current.successor],
          },
          signer,
          {
            verify: (built) => {
              verifySwapTransaction(current, built);
              pendingData = fixedSwapData(current, built, ergo.config.nativeDecimals, appliedSlippagePct);
            },
          },
        );
        logger.info(`ergodex: submitted ${side} on ${describeRoute(current)} as ${txId}`);
        return { signature: txId, status: TransactionStatusCode.PENDING, pendingData };
      } catch (error) {
        if (error instanceof ErgoCheckOnlyError) {
          // check mode: never PENDING, never a signature; the amounts come from pendingData
          throw pendingData
            ? error.withMoves(describeCheckedSwap(current, pendingData, ergo.nativeTokenSymbol))
            : error;
        }
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
          if (error.nodeText === undefined) {
            // Spent by one of our own pending transactions, found before any POST: the node
            // may not list that transaction's successor box yet. Give it a moment.
            const waitMs = dex.root.rebuildWaitMs * (attempt + 1);
            await new Promise((resolve) => setTimeout(resolve, waitMs));
          }
          continue;
        }
        throw error;
      }
    }
  } catch (error) {
    throw ergodexError(error, 'Failed to execute ergodex swap');
  } finally {
    // the key is loaded for this one request; wipe it once the send has settled
    wallet?.signer.dispose?.();
  }
}
