/**
 * Liquidity on Spectrum-style pools by direct spend of the pool box: quote, add, remove.
 *
 * A deposit or a redeem is one transaction, as a swap is: it spends the pool box as input
 * 0 and creates its successor at output 0; the wallet's boxes pay in, and what the wallet
 * receives (LP tokens on a deposit, the two tokens on a redeem) comes back in the change
 * at the wallet's own address. No order box is placed. LithosDex pools answer 501 (their
 * deposits and redeems go through provision boxes).
 *
 * Rounding, both directions in the pool's favour by less than one unit per side, as the
 * contract demands, and never against the offer:
 * - deposit: for an offer of at most X and Y, LP = min(floor(X * S / x0), floor(Y * S / y0))
 *   and the wallet pays x = ceil(LP * x0 / S) <= X and y = ceil(LP * y0 / S) <= Y. The rest
 *   of the offer stays in the wallet: the pool would take a surplus for nothing.
 * - redeem: for LP tokens returned, the wallet takes floor(LP * x0 / S) and floor(LP * y0 / S).
 *
 * Protections, as for a swap, all before signing: the pool box read fresh (the mempool
 * successor under the same rule, and then also bound by the confirmed box when someone
 * else's transaction made it); the pool guards and allowlist; a bound on the pool price
 * (y per x) between the first fresh read and every build, of `slippagePct` (or the config
 * default) either way, and on what the change pays (LP tokens out on a deposit, each side
 * out on a redeem) of the same percentage below the first read; the built transaction
 * checked against its plan; the rebuild when the pool box was spent first; the pending
 * tracker; submitMode (not set: refused before the key is loaded; `check`: only checked).
 *
 * The answer to an add or remove is PENDING with the transaction id. The shared response
 * has no field for the amounts a pending transaction fixes (`data` means confirmed), so
 * they are written to the log and, in check mode, into the 409's message.
 */
import { ErgoCheckOnlyError, ErgoInputSpentError, ErgoSubmitOutcomeUnknownError } from '../../../chains/ergo/ergo';
import { BuiltErgoTransaction, changeDelta, ErgoTransactionAssertionError } from '../../../chains/ergo/ergo.tx-builder';
import { Eip12BoxCandidate } from '../../../chains/ergo/ergo.types';
import { formatUnits, parseUnits, symbolForMessage, tokenForMessage } from '../../../chains/ergo/ergo.utils';
import { ErgoWalletAccount } from '../../../chains/ergo/ergo.wallet';
import {
  AddLiquidityResponseType,
  QuoteLiquidityResponseType,
  RemoveLiquidityResponseType,
} from '../../../schemas/amm-schema';
import { TransactionStatusCode } from '../../../schemas/chain-schema';
import { httpErrors } from '../../../services/error-handler';
import { logger } from '../../../services/logger';
import {
  Ergodex,
  FreshLiquidityPool,
  LiquidityPlan,
  pctToScaled,
  ratio,
  ratioWithin,
  slipDown,
  slipUp,
  toRaw,
  TokenRef,
  units,
} from '../ergodex';

import { ergodexError } from './errors';

/** Venue, pool kind, pool NFT, the exact box, and whether that box is unconfirmed. */
export function describePool(fresh: FreshLiquidityPool): string {
  return `${fresh.pool.venue}:${fresh.pool.kind} pool ${fresh.pool.poolId} box ${fresh.pool.box.boxId} (${fresh.source})`;
}

/** The pool price, quote per base, in whole units. */
function priceOf(fresh: FreshLiquidityPool): number {
  return ratio(
    fresh.pool.y.reserve * 10n ** BigInt(fresh.base.decimals),
    fresh.pool.x.reserve * 10n ** BigInt(fresh.quote.decimals),
  );
}

const sym = (token: TokenRef) => symbolForMessage(token.symbol, token.tokenId);
const named = (token: TokenRef) => tokenForMessage(token.symbol, token.tokenId);
const lpName = (plan: FreshLiquidityPool) => `LP tokens ${tokenForMessage(plan.lpToken.symbol, plan.lpToken.tokenId)}`;

/**
 * What the wallet gains (positive) or loses (negative) by a plan, by token id (`null` the
 * native coin), miner fee excluded.
 */
function plannedWalletChange(plan: LiquidityPlan): Map<string | null, bigint> {
  const sign = plan.change.action === 'deposit' ? -1n : 1n;
  const expected = new Map<string | null, bigint>();
  const add = (key: string | null, amount: bigint) => expected.set(key, (expected.get(key) ?? 0n) + amount);
  add(plan.base.tokenId, sign * plan.change.x);
  add(plan.quote.tokenId, sign * plan.change.y);
  add(plan.lpToken.tokenId, -sign * plan.change.lp);
  return expected;
}

/**
 * Checks on the built transaction, run inside the chain layer's lock before signing: the
 * pool is the only fixed input and is input 0, with no context variables; output 0 is
 * exactly the planned successor (tree, value, registers and every token id and amount),
 * with every register as the pool box holds it; the venue's contract rule holds for it in
 * bigint; the pool's two reserves and its LP reserve move by exactly the plan; and the
 * wallet's balance changes by exactly the plan and the miner fee, and by nothing else.
 */
export function verifyLiquidityTransaction(plan: LiquidityPlan, built: BuiltErgoTransaction): void {
  const fail = (message: string): never => {
    throw new ErgoTransactionAssertionError(`ergodex ${plan.change.action} check: ${message}`);
  };
  const { pool, venue, successor, change } = plan;
  if (built.fixedInputCount !== 1 || built.inputBoxes[0]?.boxId !== pool.box.boxId) fail('the pool must be input 0');
  if (built.inputBoxes.slice(1).some((b) => b.boxId === pool.box.boxId)) fail('the pool box is spent twice');
  if (Object.keys(built.unsigned.inputs[0].extension ?? {}).length > 0)
    fail('the pool input carries context variables');
  const out0: Eip12BoxCandidate | undefined = built.unsigned.outputs[0];
  if (!out0) fail('no successor at output 0');
  if (out0.ergoTree.toLowerCase() !== pool.box.ergoTree.toLowerCase()) fail('successor tree differs from the pool');
  const regs0 = pool.box.additionalRegisters as Record<string, string>;
  const regs1 = (out0.additionalRegisters ?? {}) as Record<string, string>;
  const planned = (successor.additionalRegisters ?? {}) as Record<string, string>;
  for (const k of new Set([...Object.keys(planned), ...Object.keys(regs1), ...Object.keys(regs0)])) {
    if ((planned[k] ?? '').toLowerCase() !== (regs1[k] ?? '').toLowerCase()) fail(`successor register ${k} differs`);
    if ((regs0[k] ?? '').toLowerCase() !== (regs1[k] ?? '').toLowerCase()) fail(`successor register ${k} differs`);
  }
  const assets = out0.assets ?? [];
  if (assets.length !== pool.box.assets.length || assets.length !== successor.assets!.length) {
    fail('successor token count differs');
  }
  pool.box.assets.forEach((a, i) => {
    if (assets[i].tokenId.toLowerCase() !== a.tokenId.toLowerCase()) fail(`successor token ${i} differs`);
  });
  if (BigInt(out0.value) !== successor.value) fail('successor value differs from the plan');
  successor.assets!.forEach((a, i) => {
    if (BigInt(assets[i].amount) !== a.amount) fail(`successor token ${i} amount differs from the plan`);
  });
  if (!venue.contractAccepts(pool, out0, built.inputBoxes))
    fail('the pool contract rule does not hold for the successor');
  // the pool moves by exactly the plan, read from the successor itself
  const reserveOf = (side: 'x' | 'y') => {
    const tokenId = pool[side].tokenId;
    return tokenId === null
      ? BigInt(out0.value)
      : BigInt(assets.find((a) => a.tokenId.toLowerCase() === tokenId.toLowerCase())!.amount);
  };
  const sign = change.action === 'deposit' ? 1n : -1n;
  if (reserveOf('x') - pool.x.reserve !== sign * change.x) fail('the pool x reserve does not move by the plan');
  if (reserveOf('y') - pool.y.reserve !== sign * change.y) fail('the pool y reserve does not move by the plan');
  if (pool.box.assets[1].amount - BigInt(assets[1].amount) !== sign * change.lp) {
    fail('the pool LP reserve does not move by the plan');
  }
  if (pool.kind !== 'n2t' && BigInt(out0.value) !== pool.box.value) fail('the pool value changes');
  // the wallet moves by exactly the plan and the miner fee, and by nothing else
  const expected = plannedWalletChange(plan);
  expected.set(null, (expected.get(null) ?? 0n) - built.fee);
  const actual = changeDelta(built);
  for (const key of new Set([...expected.keys(), ...actual.keys()])) {
    if ((expected.get(key) ?? 0n) !== (actual.get(key) ?? 0n)) {
      fail(`the wallet's ${key ?? 'native'} balance change differs`);
    }
  }
}

/**
 * The amounts a built deposit or redeem fixes, in words: what it moves if it confirms.
 * Each token is named by its symbol and the start of its id.
 */
export function describeLiquidityMoves(plan: LiquidityPlan, built: BuiltErgoTransaction, native: TokenRef): string {
  const { change, base, quote } = plan;
  const x = `${formatUnits(change.x, base.decimals)} ${named(base)}`;
  const y = `${formatUnits(change.y, quote.decimals)} ${named(quote)}`;
  const lp = `${formatUnits(change.lp, plan.lpToken.decimals)} ${lpName(plan)}`;
  const what =
    change.action === 'deposit' ? `a deposit of ${x} and ${y} for ${lp}` : `a redeem of ${lp} for ${x} and ${y}`;
  const delta = changeDelta(built);
  const tokens = [native, base, quote, plan.lpToken].filter(
    (t, i, all) => all.findIndex((o) => o.tokenId === t.tokenId) === i,
  );
  const walletChange = tokens
    .map((t) => `${formatUnits(delta.get(t.tokenId) ?? 0n, t.decimals)} ${t === plan.lpToken ? 'LP' : named(t)}`)
    .join(', ');
  return (
    `${what} on ${describePool(plan)}, miner fee ${formatUnits(built.fee, native.decimals)} ` +
    `${sym(native)}; the wallet would change by ${walletChange}`
  );
}

// ---------------------------------------------------------------------------------------
// quote-liquidity

/**
 * The deposit an offer makes, in the shared quote shape. Base is the pool's x side (the
 * native coin on an ERG/token pool) and quote its y side, as pool-info reports them.
 * An amount of 0 on one side means "no limit on that side": the other side alone sets the
 * deposit. `baseLimited` is true when the base amount is what limits it.
 * - `baseTokenAmount`, `quoteTokenAmount`: exactly what the deposit takes now (each at
 *   most the offer), and what add-liquidity would take for the same offer on this pool box.
 * - `baseTokenAmountMax`, `quoteTokenAmountMax`: what to offer so that a move of the pool
 *   price of up to `slippagePct` still lets the limiting side be deposited whole: the
 *   limiting side as taken, the other side raised by the slippage (rounded up).
 * The LP tokens the deposit pays have no field in the shared shape; they are in the log.
 */
export async function quoteLiquidity(
  network: string,
  poolAddress: string,
  baseTokenAmount: number,
  quoteTokenAmount: number,
  slippagePct?: number,
): Promise<QuoteLiquidityResponseType> {
  try {
    const dex = await Ergodex.getInstance(network);
    const applied = slippagePct ?? dex.root.slippagePct;
    const slip = pctToScaled(applied);
    const fresh = await dex.freshLiquidityPool(poolAddress);
    const offerX = toRaw(baseTokenAmount, fresh.base, 'baseTokenAmount');
    const offerY = toRaw(quoteTokenAmount, fresh.quote, 'quoteTokenAmount');
    if (offerX === 0n && offerY === 0n) {
      throw httpErrors.badRequest('Give an amount above zero on at least one side (0 means no limit on that side)');
    }
    const plan = dex.planDeposit(fresh, offerX === 0n ? null : offerX, offerY === 0n ? null : offerY);
    const { supply, pool } = plan;
    const baseLimited =
      offerY === 0n || (offerX !== 0n && (offerX * supply) / pool.x.reserve <= (offerY * supply) / pool.y.reserve);
    const { x, y, lp } = plan.change;
    logger.info(
      `ergodex: quote deposit on ${describePool(plan)}: ${formatUnits(x, plan.base.decimals)} ${sym(plan.base)} and ` +
        `${formatUnits(y, plan.quote.decimals)} ${sym(plan.quote)} for ${formatUnits(lp, plan.lpToken.decimals)} LP`,
    );
    return {
      baseLimited,
      baseTokenAmount: units(x, plan.base.decimals),
      quoteTokenAmount: units(y, plan.quote.decimals),
      baseTokenAmountMax: units(baseLimited ? x : slipUp(x, slip), plan.base.decimals),
      quoteTokenAmountMax: units(baseLimited ? slipUp(y, slip) : y, plan.quote.decimals),
    };
  } catch (error) {
    throw ergodexError(error, 'Failed to quote ergodex liquidity');
  }
}

// ---------------------------------------------------------------------------------------
// add and remove

/** A bound every build must meet: the reason it does not, or null. */
type LiquidityBound = (plan: LiquidityPlan) => string | null;

/**
 * The plans the bound is taken from: the first fresh plan, and the plan on the confirmed
 * pool box when the first is on an unconfirmed box that none of our own transactions
 * created.
 */
async function referencePlans(
  dex: Ergodex,
  first: LiquidityPlan,
  replanConfirmed: () => Promise<LiquidityPlan>,
): Promise<LiquidityPlan[]> {
  const refs = [first];
  if (first.source === 'mempool' && !dex.ergo.pending.get(first.pool.box.transactionId))
    refs.push(await replanConfirmed());
  return refs;
}

/** The pool price of every build within the slippage of every reference plan. */
function priceBound(refs: LiquidityPlan[], slip: bigint, slippagePct: number): LiquidityBound {
  return (plan) => {
    for (const ref of refs) {
      if (!ratioWithin(ref.pool, plan.pool, slip)) {
        return (
          `the pool price is now ${priceOf(plan)} ${sym(plan.quote)} per ${sym(plan.base)}, more than ` +
          `${slippagePct}% from ${priceOf(ref)} on ${describePool(ref)}`
        );
      }
    }
    return null;
  };
}

/**
 * Build, check, sign and submit a deposit or redeem, rebuilding on a spent pool box while
 * the bound holds, as a swap does. Answers PENDING with the transaction id.
 */
async function sendLiquidity(
  dex: Ergodex,
  wallet: ErgoWalletAccount,
  first: LiquidityPlan,
  replan: () => Promise<LiquidityPlan>,
  bound: LiquidityBound,
): Promise<{ signature: string; status: number }> {
  const ergo = dex.ergo;
  const native: TokenRef = { tokenId: null, symbol: ergo.nativeTokenSymbol, decimals: ergo.config.nativeDecimals };
  let plan = first;
  for (let attempt = 0; ; attempt++) {
    if (attempt > 0) plan = await replan();
    const outside = bound(plan);
    if (outside) {
      throw httpErrors.createError(
        409,
        `The pool moved: ${outside}. Nothing that can still execute was submitted; retry with a fresh quote.`,
      );
    }
    const current = plan;
    // worked out before signing, so nothing after the submit can fail
    let moves: string | undefined;
    try {
      const { txId } = await ergo.sendTransaction(
        { changeAddress: wallet.address, inputs: [{ box: current.pool.box }], outputs: [current.successor] },
        wallet.signer,
        {
          verify: (built) => {
            verifyLiquidityTransaction(current, built);
            moves = describeLiquidityMoves(current, built, native);
          },
        },
      );
      logger.info(`ergodex: submitted ${current.change.action} as ${txId}, PENDING; if it confirms: ${moves}`);
      return { signature: txId, status: TransactionStatusCode.PENDING };
    } catch (error) {
      if (error instanceof ErgoCheckOnlyError) {
        // check mode: never PENDING, never a signature; the message says what it would move
        throw moves ? error.withMoves(moves) : error;
      }
      if (error instanceof ErgoSubmitOutcomeUnknownError) {
        // Never rebuild here: the first transaction may still execute.
        throw httpErrors.transactionTimeout(
          `Transaction ${error.txId} pending: the node's answer to the submit was lost (${error.detail ?? error.message}). ` +
            `Poll /chains/ergo/poll with this signature until it confirms or fails before any new ${current.change.action}; ` +
            'do not resubmit.',
        );
      }
      if (error instanceof ErgoInputSpentError && error.boxIds.includes(current.pool.box.boxId)) {
        logger.info(
          `ergodex: pool box ${current.pool.box.boxId} was spent first (attempt ${attempt + 1}): ${error.message}`,
        );
        if (attempt >= dex.root.maxRebuilds) {
          throw httpErrors.createError(
            409,
            `Pool ${current.pool.poolId} changed under ${attempt + 1} attempt(s); nothing that can still execute was ` +
              `submitted. Retry. Last rejection: ${error.message}`,
          );
        }
        if (error.nodeText === undefined) {
          // spent by one of our own pending transactions: give the node a moment to list its successor
          await new Promise((resolve) => setTimeout(resolve, dex.root.rebuildWaitMs * (attempt + 1)));
        }
        continue;
      }
      throw error;
    }
  }
}

/**
 * Add liquidity: deposit at most `baseTokenAmount` of base and `quoteTokenAmount` of quote
 * (both above zero), in the pool's ratio; whatever does not fit the ratio stays in the
 * wallet. Bound at every build: the pool price within `slippagePct` of the first fresh
 * read, and the LP tokens paid at least that read's less `slippagePct`.
 */
export async function addLiquidity(
  network: string,
  walletAddress: string,
  poolAddress: string,
  baseTokenAmount: number,
  quoteTokenAmount: number,
  slippagePct?: number,
): Promise<AddLiquidityResponseType> {
  let wallet: ErgoWalletAccount | undefined;
  try {
    const dex = await Ergodex.getInstance(network);
    // before any pool or box is read and before the wallet's key is loaded
    dex.ergo.assertSubmitModeSet();
    const applied = slippagePct ?? dex.root.slippagePct;
    const slip = pctToScaled(applied);
    const fresh = await dex.freshLiquidityPool(poolAddress);
    const offerX = toRaw(baseTokenAmount, fresh.base, 'baseTokenAmount');
    const offerY = toRaw(quoteTokenAmount, fresh.quote, 'quoteTokenAmount');
    if (offerX === 0n || offerY === 0n) {
      throw httpErrors.badRequest(
        'baseTokenAmount and quoteTokenAmount are each the most the wallet gives, and both must be above zero; ' +
          'quote-liquidity works out the other side for an amount on one',
      );
    }
    const replan = async (options: { confirmedOnly?: boolean } = {}) =>
      dex.planDeposit(await dex.freshLiquidityPool(poolAddress, options), offerX, offerY);
    const first = dex.planDeposit(fresh, offerX, offerY);
    const refs = await referencePlans(dex, first, () => replan({ confirmedOnly: true }));
    const minLp = refs.map((r) => slipDown(r.change.lp, slip)).reduce((a, b) => (b > a ? b : a));
    const price = priceBound(refs, slip, applied);
    const bound: LiquidityBound = (plan) =>
      price(plan) ??
      (plan.change.lp < minLp
        ? `the deposit now pays ${formatUnits(plan.change.lp, plan.lpToken.decimals)} LP tokens, below ` +
          `${formatUnits(minLp, plan.lpToken.decimals)}`
        : null);
    wallet = await dex.ergo.getWallet(walletAddress);
    return await sendLiquidity(dex, wallet, first, () => replan(), bound);
  } catch (error) {
    throw ergodexError(error, 'Failed to add ergodex liquidity');
  } finally {
    // the key is loaded for this one request; wipe it once the send has settled
    wallet?.signer.dispose?.();
  }
}

/** `percentageToRemove` as an exact integer with 8 decimal places; a 400 unless above 0 and at most 100. */
function percentToRemove(pct: number): bigint {
  let scaled: bigint;
  try {
    scaled = parseUnits(pct, 8);
  } catch (error) {
    throw httpErrors.badRequest(`percentageToRemove: ${(error as Error).message}`);
  }
  if (scaled <= 0n || scaled > 100n * 10n ** 8n) {
    throw httpErrors.badRequest('percentageToRemove must be above 0 and at most 100');
  }
  return scaled;
}

/**
 * Remove liquidity: return `percentageToRemove` of the wallet's spendable LP tokens of the
 * pool (rounded down to a whole LP unit) and take out the most the pool allows for them.
 * Bound at every build: the pool price within `slippagePct` of the first fresh read, and
 * each side paid at least that read's less `slippagePct`.
 */
export async function removeLiquidity(
  network: string,
  walletAddress: string,
  poolAddress: string,
  percentageToRemove: number,
  slippagePct?: number,
): Promise<RemoveLiquidityResponseType> {
  let wallet: ErgoWalletAccount | undefined;
  try {
    const dex = await Ergodex.getInstance(network);
    // before any pool or box is read and before the wallet's key is loaded
    dex.ergo.assertSubmitModeSet();
    const applied = slippagePct ?? dex.root.slippagePct;
    const slip = pctToScaled(applied);
    const pct = percentToRemove(percentageToRemove);
    const fresh = await dex.freshLiquidityPool(poolAddress);
    const lpId = fresh.lpToken.tokenId!;
    const boxes = await dex.ergo.getSpendableBoxes(walletAddress);
    const held = boxes
      .flatMap((b) => b.assets)
      .filter((a) => a.tokenId.toLowerCase() === lpId)
      .reduce((n, a) => n + a.amount, 0n);
    if (held === 0n) {
      throw httpErrors.badRequest(`The wallet holds no LP tokens of pool ${fresh.pool.poolId} (${lpId})`);
    }
    const lp = (held * pct) / (100n * 10n ** 8n);
    if (lp === 0n) {
      throw httpErrors.badRequest(
        `${percentageToRemove}% of the wallet's ${formatUnits(held, fresh.lpToken.decimals)} LP tokens rounds to zero`,
      );
    }
    const replan = async (options: { confirmedOnly?: boolean } = {}) =>
      dex.planRedeem(await dex.freshLiquidityPool(poolAddress, options), lp);
    const first = dex.planRedeem(fresh, lp);
    const refs = await referencePlans(dex, first, () => replan({ confirmedOnly: true }));
    const minX = refs.map((r) => slipDown(r.change.x, slip)).reduce((a, b) => (b > a ? b : a));
    const minY = refs.map((r) => slipDown(r.change.y, slip)).reduce((a, b) => (b > a ? b : a));
    const price = priceBound(refs, slip, applied);
    const bound: LiquidityBound = (plan) => {
      const moved = price(plan);
      if (moved) return moved;
      if (plan.change.x < minX || plan.change.y < minY) {
        return (
          `the redeem now pays ${formatUnits(plan.change.x, plan.base.decimals)} ${sym(plan.base)} and ` +
          `${formatUnits(plan.change.y, plan.quote.decimals)} ${sym(plan.quote)}, below ` +
          `${formatUnits(minX, plan.base.decimals)} and ${formatUnits(minY, plan.quote.decimals)}`
        );
      }
      return null;
    };
    wallet = await dex.ergo.getWallet(walletAddress);
    return await sendLiquidity(dex, wallet, first, () => replan(), bound);
  } catch (error) {
    throw ergodexError(error, 'Failed to remove ergodex liquidity');
  } finally {
    wallet?.signer.dispose?.();
  }
}
