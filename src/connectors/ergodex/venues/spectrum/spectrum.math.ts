/**
 * Constant-product math for Spectrum-style pools, in bigint only. The pool keeps
 * `feeNum / feeDenom` of the input on the curve; the rest is its fee. The contract's swap
 * rule, for a trader paying `amountIn` of the side with reserve `reserveIn` and taking
 * `amountOut` of the other side (reserve `reserveOut`), is
 *
 *   reserveOut * amountIn * feeNum >= amountOut * (reserveIn * feeDenom + amountIn * feeNum)
 *
 * (`Pool.sc` validSwap; both branches have this shape once "in" and "out" are named).
 * The deposit and redeem rules are below, with the LP supply they rest on.
 */

function assertPositive(name: string, value: bigint): void {
  if (typeof value !== 'bigint' || value <= 0n) throw new Error(`${name} must be a positive bigint`);
}

function checkPool(reserveIn: bigint, reserveOut: bigint, feeNum: bigint, feeDenom: bigint): void {
  assertPositive('reserveIn', reserveIn);
  assertPositive('reserveOut', reserveOut);
  assertPositive('feeDenom', feeDenom);
  assertPositive('feeNum', feeNum);
}

/** The contract's inequality for one swap. */
export function swapAllowed(
  reserveIn: bigint,
  reserveOut: bigint,
  amountIn: bigint,
  amountOut: bigint,
  feeNum: bigint,
  feeDenom: bigint,
): boolean {
  return reserveOut * amountIn * feeNum >= amountOut * (reserveIn * feeDenom + amountIn * feeNum);
}

/**
 * Exact input: floor(amountIn * feeNum * reserveOut / (reserveIn * feeDenom + amountIn * feeNum)),
 * the largest output the inequality allows. 0 for an input of 0 or one that rounds to nothing.
 */
export function outputForInput(
  reserveIn: bigint,
  reserveOut: bigint,
  amountIn: bigint,
  feeNum: bigint,
  feeDenom: bigint,
): bigint {
  checkPool(reserveIn, reserveOut, feeNum, feeDenom);
  if (typeof amountIn !== 'bigint' || amountIn < 0n) throw new Error('amountIn must be a non-negative bigint');
  if (amountIn === 0n) return 0n;
  return (reserveOut * amountIn * feeNum) / (reserveIn * feeDenom + amountIn * feeNum);
}

/**
 * Exact output: the smallest input the inequality accepts,
 * ceil(amountOut * reserveIn * feeDenom / (feeNum * (reserveOut - amountOut))).
 * The inequality is increasing in the input, so this input passes and one unit less fails.
 * Null when the pool cannot pay `amountOut` (it would empty or overdraw that side).
 */
export function inputForOutput(
  reserveIn: bigint,
  reserveOut: bigint,
  amountOut: bigint,
  feeNum: bigint,
  feeDenom: bigint,
): bigint | null {
  checkPool(reserveIn, reserveOut, feeNum, feeDenom);
  assertPositive('amountOut', amountOut);
  if (amountOut >= reserveOut) return null;
  const numerator = amountOut * reserveIn * feeDenom;
  const denominator = feeNum * (reserveOut - amountOut);
  return (numerator + denominator - 1n) / denominator;
}

// ---------------------------------------------------------------------------------------
// Deposit and redeem. `Pool.sc` derives the LP supply from the LP tokens the pool holds:
//
//   supplyLP = InitiallyLockedLP - reservedLP
//
// and, for a change of supply (LP tokens leaving the pool on a deposit, coming back on a
// redeem), with x0, y0 the reserves before and S the supply before:
//
//   deposit (both reserves grow):  dLP <= min(dX * S / x0, dY * S / y0)   (integer division)
//   redeem  (otherwise):           dX * S >= dLP * x0  and  dY * S >= dLP * y0
//
// where on a redeem dLP, dX and dY are negative. So for a deposit of x and y the most LP
// the pool may pay is min(floor(x * S / x0), floor(y * S / y0)), and for lp LP tokens
// returned the most it may pay is floor(lp * x0 / S) of x and floor(lp * y0 / S) of y.

/** A deposit into a pool (or a redeem out of it): both sides and the LP tokens, all positive. */
export interface LiquidityAmounts {
  x: bigint;
  y: bigint;
  lp: bigint;
}

function ceilDiv(n: bigint, d: bigint): bigint {
  return (n + d - 1n) / d;
}

function checkReserves(x0: bigint, y0: bigint, supply: bigint): void {
  assertPositive('x0', x0);
  assertPositive('y0', y0);
  assertPositive('supply', supply);
}

/** The LP tokens outside the pool: `lockedLiquidity - reservedLP`. */
export function lpSupply(lockedLiquidity: bigint, lpReserve: bigint): bigint {
  return lockedLiquidity - lpReserve;
}

/** The contract's deposit rule: `lp` LP tokens may leave the pool for `x` and `y` put in. */
export function depositAllowed(x0: bigint, y0: bigint, supply: bigint, x: bigint, y: bigint, lp: bigint): boolean {
  if (x <= 0n || y <= 0n) return false;
  const byX = (x * supply) / x0;
  const byY = (y * supply) / y0;
  return lp <= (byX < byY ? byX : byY);
}

/**
 * The deposit for an offer of at most `offerX` and at most `offerY` (null: no limit on
 * that side; at least one must be given): the most LP tokens the offer can buy,
 * `lp = min(floor(offerX * S / x0), floor(offerY * S / y0))`, and the least of each side
 * that still buys them, `x = ceil(lp * x0 / S)`, `y = ceil(lp * y0 / S)`.
 *
 * So `x <= offerX` and `y <= offerY` (from lp * x0 <= offerX * S); the deposit rule holds
 * for (x, y, lp); it fails for lp + 1 (the limiting side's floor is lp), and for x - 1 or
 * y - 1 (each is the least for lp). Whatever the offer holds beyond (x, y) stays with the
 * offerer: the pool would take a surplus and pay nothing for it. All zero when the offer
 * buys no LP token.
 */
export function depositFor(
  x0: bigint,
  y0: bigint,
  supply: bigint,
  offerX: bigint | null,
  offerY: bigint | null,
): LiquidityAmounts {
  checkReserves(x0, y0, supply);
  if (offerX === null && offerY === null) throw new Error('a deposit needs an amount on at least one side');
  for (const v of [offerX, offerY]) {
    if (v !== null && (typeof v !== 'bigint' || v < 0n)) throw new Error('an offer must be a non-negative bigint');
  }
  const byX = offerX === null ? null : (offerX * supply) / x0;
  const byY = offerY === null ? null : (offerY * supply) / y0;
  const lp = byX === null ? byY! : byY === null ? byX : byX < byY ? byX : byY;
  if (lp === 0n) return { x: 0n, y: 0n, lp: 0n };
  return { x: ceilDiv(lp * x0, supply), y: ceilDiv(lp * y0, supply), lp };
}

/** The contract's redeem rule: `outX` and `outY` may leave the pool for `lp` LP tokens returned. */
export function redeemAllowed(x0: bigint, y0: bigint, supply: bigint, outX: bigint, outY: bigint, lp: bigint): boolean {
  return outX * supply <= lp * x0 && outY * supply <= lp * y0;
}

/**
 * The most a redeem of `lp` LP tokens may take: floor(lp * x0 / S) and floor(lp * y0 / S).
 * One unit more of either fails the redeem rule. `lp` must not exceed the supply.
 */
export function redeemFor(x0: bigint, y0: bigint, supply: bigint, lp: bigint): LiquidityAmounts {
  checkReserves(x0, y0, supply);
  assertPositive('lp', lp);
  if (lp > supply) throw new Error('lp is more than the LP supply');
  return { x: (lp * x0) / supply, y: (lp * y0) / supply, lp };
}

/**
 * Decode a serialized `Int` constant (type byte 0x04, then a ZigZag VLQ of at most 5
 * bytes). Null for anything else, including trailing bytes: R4 must read as the live
 * trees read it (`SELF.R4[Int]`).
 */
export function decodeSInt(hex: string | undefined): number | null {
  if (typeof hex !== 'string' || !/^04([0-9a-f]{2})+$/i.test(hex)) return null;
  const bytes = Buffer.from(hex.slice(2), 'hex');
  let value = 0;
  let shift = 0;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (i >= 5) return null;
    value += (b & 0x7f) * 2 ** shift;
    shift += 7;
    if ((b & 0x80) === 0) {
      if (i !== bytes.length - 1 || value > 0xffffffff) return null;
      return value % 2 === 0 ? value / 2 : -(value + 1) / 2;
    }
  }
  return null;
}
