/**
 * LithosDex swap math, in bigint only, as `LD_LiquidityPool.ergo` (ERG/token, `n2t`) and
 * `LD_T2T_LiquidityPool.ergo` (token/token, `t2t`) enforce it on the swap path
 * (operation 0). Names follow the contracts: D is the fee denominator, `dex` is R5(0),
 * the side fee is R5(1) when selling the first side and R5(2) when selling the second.
 *
 * For a trader paying a gross amount A into the pool on one side:
 * - Side fee f, taken from A before the curve and added to that side's pending fees:
 *   n2t  f = floor(fee * A / D)              (`feeXAdded` / `feeYAdded`, integer division)
 *   t2t  f = floor((fee * A + D - 1) / D)    (the same, rounded up)
 * - traded = A - f is what reaches the curve (the change in that side's reserve).
 * - The output O on the other side must satisfy
 *     rOut * traded * dex >= O * (rIn * D + traded * dex)
 *   where rIn, rOut are the reserves before the swap: what the box holds on each side
 *   less the pending fees it owes (R6).
 * - The fee accumulator of the paying side advances by exactly f * SCALE / supply
 *   (integer division), with supply = LOCKED - R4; the other accumulator is unchanged.
 *
 * Nothing here is a contract constant: D, SCALE and LOCKED come from config.
 */

export type LithosKind = 'n2t' | 't2t';

export const MAX_LONG = 2n ** 63n - 1n;
export const MIN_LONG = -(2n ** 63n);

/** The pool's fee parameters for one direction. */
export interface LithosDirectionFees {
  denom: bigint;
  dex: bigint;
  side: bigint;
}

export interface ExactInQuote {
  gross: bigint;
  sideFee: bigint;
  traded: bigint;
  out: bigint;
}

function assertBig(name: string, v: bigint, min: bigint): void {
  if (typeof v !== 'bigint' || v < min) throw new Error(`${name} must be a bigint of at least ${min}`);
}

/** The fee parameters are usable: 0 < dex <= D and 0 <= side < D. */
export function feesUsable(fees: LithosDirectionFees): boolean {
  const { denom, dex, side } = fees;
  return denom > 0n && dex > 0n && dex <= denom && side >= 0n && side < denom;
}

/** The side fee the contract demands on a gross input, by pool kind. */
export function sideFee(kind: LithosKind, gross: bigint, fees: LithosDirectionFees): bigint {
  assertBig('gross', gross, 0n);
  const { denom, side } = fees;
  return kind === 'n2t' ? (side * gross) / denom : (side * gross + denom - 1n) / denom;
}

/** The contract's curve inequality on reserves before the swap. */
export function curveAllows(
  rIn: bigint,
  rOut: bigint,
  traded: bigint,
  out: bigint,
  fees: LithosDirectionFees,
): boolean {
  return rOut * traded * fees.dex >= out * (rIn * fees.denom + traded * fees.dex);
}

/**
 * Exact input: the largest output the contract allows for a gross input, with the side
 * fee and the traded amount. An output of 0 when the input rounds to nothing.
 */
export function quoteExactIn(
  kind: LithosKind,
  rIn: bigint,
  rOut: bigint,
  gross: bigint,
  fees: LithosDirectionFees,
): ExactInQuote {
  assertBig('rIn', rIn, 1n);
  assertBig('rOut', rOut, 1n);
  assertBig('gross', gross, 0n);
  if (!feesUsable(fees)) throw new Error('the pool fee parameters are out of range');
  const f = sideFee(kind, gross, fees);
  const traded = gross - f;
  if (traded <= 0n) return { gross, sideFee: f, traded, out: 0n };
  const out = (rOut * traded * fees.dex) / (rIn * fees.denom + traded * fees.dex);
  return { gross, sideFee: f, traded, out };
}

/**
 * Exact output: the smallest gross input for which the contract allows `out`. The curve
 * needs traded >= ceil(out * rIn * D / (dex * (rOut - out))). The traded amount never
 * falls as the input grows (one more unit in raises the side fee by at most one), so the
 * smallest gross input that leaves that much traded is the answer:
 *   n2t  traded(A) = ceil((D - fee) * A / D)  ->  A = floor((T - 1) * D / (D - fee)) + 1
 *   t2t  traded(A) = floor((D - fee) * A / D) ->  A = ceil(T * D / (D - fee))
 * Null when the pool cannot pay `out` (it would empty or overdraw that side).
 */
export function quoteExactOut(
  kind: LithosKind,
  rIn: bigint,
  rOut: bigint,
  out: bigint,
  fees: LithosDirectionFees,
): ExactInQuote | null {
  assertBig('rIn', rIn, 1n);
  assertBig('rOut', rOut, 1n);
  assertBig('out', out, 1n);
  if (!feesUsable(fees)) throw new Error('the pool fee parameters are out of range');
  if (out >= rOut) return null;
  const { denom, dex, side } = fees;
  const num = out * rIn * denom;
  const den = dex * (rOut - out);
  const traded = (num + den - 1n) / den;
  const keep = denom - side;
  const gross = kind === 'n2t' ? ((traded - 1n) * denom) / keep + 1n : (traded * denom + keep - 1n) / keep;
  // The closed forms above are exact; this only guards them against a slip.
  const q = quoteExactIn(kind, rIn, rOut, gross, fees);
  if (q.out < out || (gross > 1n && quoteExactIn(kind, rIn, rOut, gross - 1n, fees).out >= out)) {
    throw new Error('exact-output inversion failed its own check');
  }
  return { gross, sideFee: q.sideFee, traded: q.traded, out };
}

/** The accumulator advance for a side fee, as the contract writes it: f * SCALE / supply. */
export function accumulatorAdvance(fee: bigint, scale: bigint, supply: bigint): bigint {
  assertBig('supply', supply, 1n);
  return (fee * scale) / supply;
}

// ---------------------------------------------------------------------------------------
// Register codecs: the serialized constants the pool box holds. Strict: a value must read
// as exactly the type the contract reads it as, with no trailing bytes.

function vlq(n: bigint): string {
  let v = n;
  let out = '';
  do {
    let b = Number(v & 0x7fn);
    v >>= 7n;
    if (v > 0n) b |= 0x80;
    out += b.toString(16).padStart(2, '0');
  } while (v > 0n);
  return out;
}

function zigzag(v: bigint): bigint {
  return v >= 0n ? v * 2n : -v * 2n - 1n;
}

function unzigzag(z: bigint): bigint {
  return z % 2n === 0n ? z / 2n : -(z + 1n) / 2n;
}

class Reader {
  private pos = 0;
  constructor(private readonly bytes: Buffer) {}
  byte(): number {
    if (this.pos >= this.bytes.length) throw new Error('truncated');
    return this.bytes[this.pos++];
  }
  vlq(maxBytes: number): bigint {
    let result = 0n;
    let shift = 0n;
    for (let i = 0; i < maxBytes; i++) {
      const b = this.byte();
      result |= BigInt(b & 0x7f) << shift;
      if ((b & 0x80) === 0) return result;
      shift += 7n;
    }
    throw new Error('VLQ too long');
  }
  take(n: number): Buffer {
    if (this.pos + n > this.bytes.length) throw new Error('truncated');
    const out = this.bytes.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
  done(): boolean {
    return this.pos === this.bytes.length;
  }
}

function reader(hex: string | undefined, type: number): Reader | null {
  if (typeof hex !== 'string' || !/^([0-9a-fA-F]{2})+$/.test(hex)) return null;
  const r = new Reader(Buffer.from(hex, 'hex'));
  try {
    if (r.byte() !== type) return null;
  } catch {
    return null;
  }
  return r;
}

function readLong(r: Reader): bigint {
  const v = unzigzag(r.vlq(10));
  if (v > MAX_LONG || v < MIN_LONG) throw new Error('Long out of range');
  return v;
}

/** A serialized `Long` (type 0x05), or null. */
export function decodeLong(hex: string | undefined): bigint | null {
  const r = reader(hex, 0x05);
  if (!r) return null;
  try {
    const v = readLong(r);
    return r.done() ? v : null;
  } catch {
    return null;
  }
}

/** A serialized `Coll[Long]` (type 0x11), or null. */
export function decodeCollLong(hex: string | undefined): bigint[] | null {
  const r = reader(hex, 0x11);
  if (!r) return null;
  try {
    const n = Number(r.vlq(3));
    const out: bigint[] = [];
    for (let i = 0; i < n; i++) out.push(readLong(r));
    return r.done() ? out : null;
  } catch {
    return null;
  }
}

/** A serialized `BigInt` (type 0x06: length, then two's complement big-endian, at most 32 bytes), or null. */
export function decodeBigInt(hex: string | undefined): bigint | null {
  const r = reader(hex, 0x06);
  if (!r) return null;
  try {
    const n = Number(r.vlq(2));
    if (n < 1 || n > 32) return null;
    const bytes = r.take(n);
    if (!r.done()) return null;
    let v = BigInt('0x' + bytes.toString('hex'));
    if (bytes[0] & 0x80) v -= 1n << BigInt(8 * n);
    return v;
  } catch {
    return null;
  }
}

export function encodeLong(v: bigint): string {
  if (v > MAX_LONG || v < MIN_LONG) throw new Error('Long out of range');
  return '05' + vlq(zigzag(v));
}

export function encodeCollLong(values: bigint[]): string {
  return (
    '11' +
    vlq(BigInt(values.length)) +
    values
      .map((v) => {
        if (v > MAX_LONG || v < MIN_LONG) throw new Error('Long out of range');
        return vlq(zigzag(v));
      })
      .join('')
  );
}

/** The shortest two's complement form, as the node writes a BigInt (Java's toByteArray). */
export function encodeBigInt(v: bigint): string {
  let n = 1;
  while (!(v >= -(1n << BigInt(8 * n - 1)) && v < 1n << BigInt(8 * n - 1))) n++;
  if (n > 32) throw new Error('BigInt above 256 bits');
  const twos = v < 0n ? (1n << BigInt(8 * n)) + v : v;
  return '06' + vlq(BigInt(n)) + twos.toString(16).padStart(2 * n, '0');
}
