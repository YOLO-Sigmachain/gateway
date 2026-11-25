/**
 * JSON at the node boundary, without losing integer precision.
 *
 * `JSON.parse` turns every number into an IEEE double, so a token amount above 2^53 comes
 * back rounded; a change box built from the rounded amount burns the difference. Node
 * 22's `JSON.parse` hands a reviver the source text of each primitive, so an integer that
 * does not fit a double exactly is rebuilt from its own digits as a `bigint`. No parser
 * dependency is needed.
 *
 * Integers that do fit a double exactly stay numbers here; the box and amount readers
 * (`toAmount`) turn every amount into a `bigint` regardless of how it arrived.
 */

const INTEGER_TEXT = /^-?\d+$/;

interface ReviverContext {
  source?: string;
}

function reviver(_key: string, value: unknown, context?: ReviverContext): unknown {
  if (typeof value !== 'number' || Number.isSafeInteger(value)) {
    return value;
  }
  if (context?.source === undefined) {
    // Without the source text the exact value is already gone.
    throw new Error('JSON.parse source text access is unavailable; refusing to parse node JSON lossily');
  }
  return INTEGER_TEXT.test(context.source) ? BigInt(context.source) : value;
}

/** Parse node JSON. Integers beyond the safe range come back as `bigint`, exact. */
export function parseNodeJson<T = unknown>(text: string): T {
  return JSON.parse(text, reviver as (key: string, value: unknown) => unknown) as T;
}

/** Stringify with `bigint` written as a plain JSON integer, digit for digit. */
export function stringifyWithBigInt(value: unknown): string {
  const marker = '__ergo_bigint__';
  const text = JSON.stringify(value, (_key, v) => (typeof v === 'bigint' ? `${marker}${v.toString()}${marker}` : v));
  return text.replace(new RegExp(`"${marker}(-?\\d+)${marker}"`, 'g'), '$1');
}

/** Replace every `bigint` in a value with its decimal string, for responses Fastify can serialize. */
export function bigintsToStrings<T>(value: T): unknown {
  return JSON.parse(JSON.stringify(value, (_key, v) => (typeof v === 'bigint' ? v.toString() : v)));
}

/**
 * An amount from node JSON or an EIP-12 object, as a `bigint`. Accepts a bigint, a safe
 * integer number, or a string of digits. Anything else (a fraction, an unsafe number, an
 * empty string) throws: a guessed amount is worse than a refused one.
 */
export function toAmount(value: unknown, what = 'amount'): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new Error(`${what} is not an exact integer: ${value}`);
    }
    return BigInt(value);
  }
  if (typeof value === 'string' && INTEGER_TEXT.test(value)) {
    return BigInt(value);
  }
  throw new Error(`${what} is not an integer: ${String(value)}`);
}
