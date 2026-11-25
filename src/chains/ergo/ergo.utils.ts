import * as fs from 'fs';
import * as path from 'path';

import { ErgoAddress, Network } from '@fleet-sdk/core';

import { rootPath } from '../../paths';

/** Ergo networks are the files in the network template folder; no list is kept in code. */
export function getAvailableErgoNetworks(): string[] {
  const networksPath = path.join(rootPath(), 'dist/src/templates/chains/ergo');
  try {
    return fs
      .readdirSync(networksPath)
      .filter((file) => file.endsWith('.yml'))
      .map((file) => file.replace('.yml', ''));
  } catch {
    return [];
  }
}

const HEX_32 = /^[0-9a-fA-F]{64}$/;
const HEX = /^([0-9a-fA-F]{2})+$/;

/** A transaction, box or token id: 32 bytes as 64 hex characters. */
export function isErgoId(value: unknown): boolean {
  return typeof value === 'string' && HEX_32.test(value);
}

export function assertErgoId(value: unknown, what: string): string {
  if (typeof value !== 'string' || !isErgoId(value)) {
    throw new Error(`${what} must be 64 hex characters`);
  }
  return value.toLowerCase();
}

export function isHexBytes(value: unknown): value is string {
  return typeof value === 'string' && HEX.test(value);
}

// ---------------------------------------------------------------------------------------
// Amounts. Whole-unit decimal strings are made from bigints digit by digit: no float ever
// touches the integer part.

/** `1234567n`, 3 decimals → `"1234.567"`; trailing zeros of the fraction are dropped. */
export function formatUnits(amount: bigint, decimals: number): string {
  if (!Number.isInteger(decimals) || decimals < 0) {
    throw new Error(`Invalid decimals: ${decimals}`);
  }
  const negative = amount < 0n;
  const digits = (negative ? -amount : amount).toString();
  if (decimals === 0) {
    return (negative ? '-' : '') + digits;
  }
  const padded = digits.padStart(decimals + 1, '0');
  const whole = padded.slice(0, padded.length - decimals);
  const fraction = padded.slice(padded.length - decimals).replace(/0+$/, '');
  return (negative ? '-' : '') + whole + (fraction ? `.${fraction}` : '');
}

/**
 * `"1234.567"`, 3 decimals → `1234567n`. Refuses more fractional digits than the token has,
 * exponents, signs and anything else that is not a plain decimal.
 */
export function parseUnits(value: string | number, decimals: number): bigint {
  const text = typeof value === 'number' ? numberToPlainString(value) : value.trim();
  const match = /^(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) {
    throw new Error(`Invalid amount: ${value}`);
  }
  const [, whole, fraction = ''] = match;
  if (fraction.length > decimals) {
    throw new Error(`Amount ${value} has more than ${decimals} decimal places`);
  }
  return BigInt(whole + fraction.padEnd(decimals, '0'));
}

function numberToPlainString(value: number): string {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`Invalid amount: ${value}`);
  }
  // toString gives the shortest round-trip form; refuse exponent forms instead of guessing
  const text = value.toString();
  if (/e/i.test(text)) {
    throw new Error(`Amount ${value} must be given as a decimal string`);
  }
  return text;
}

/** For the shared response schemas, which carry amounts as JSON numbers. */
export function toDecimalNumber(amount: bigint, decimals: number): number {
  return Number(formatUnits(amount, decimals));
}

// ---------------------------------------------------------------------------------------
// Addresses. Fleet encodes any prefix, but an omitted network argument silently means
// prefix 0 and its validation does not look at the network, so every call here takes the
// prefix explicitly and every check compares it.

export interface DecodedErgoAddress {
  address: string;
  ergoTree: string;
  prefix: number;
}

export function decodeErgoAddress(address: string): DecodedErgoAddress {
  if (typeof address !== 'string' || address.length === 0 || address.length > 4096) {
    throw new Error('Invalid Ergo address');
  }
  let decoded: ErgoAddress;
  try {
    decoded = ErgoAddress.decode(address);
  } catch {
    throw new Error(`Invalid Ergo address: ${address}`);
  }
  return { address, ergoTree: decoded.ergoTree, prefix: Number(decoded.network) };
}

/** The address string for a tree on the network with this prefix. */
export function encodeErgoAddress(ergoTree: string, prefix: number): string {
  return ErgoAddress.fromErgoTree(ergoTree, prefix as Network).encode(prefix as Network);
}

export function addressFromPublicKey(publicKeyHex: string, prefix: number): string {
  return ErgoAddress.fromPublicKey(publicKeyHex, prefix as Network).encode(prefix as Network);
}

/** Decode and require the given network prefix. */
export function decodeErgoAddressForPrefix(address: string, prefix: number): DecodedErgoAddress {
  const decoded = decodeErgoAddress(address);
  if (decoded.prefix !== prefix) {
    throw new Error(`Address ${address} has network prefix ${decoded.prefix}; this network uses prefix ${prefix}`);
  }
  return decoded;
}
