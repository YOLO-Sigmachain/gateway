/**
 * Constant-product math for Spectrum-style pools, in bigint only (T-12). The pool keeps
 * `feeNum / feeDenom` of the input on the curve; the rest is its fee. The contract's swap
 * rule, for a trader paying `amountIn` of the side with reserve `reserveIn` and taking
 * `amountOut` of the other side (reserve `reserveOut`), is
 *
 *   reserveOut * amountIn * feeNum >= amountOut * (reserveIn * feeDenom + amountIn * feeNum)
 *
 * (`Pool.sc` validSwap; both branches have this shape once "in" and "out" are named).
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
