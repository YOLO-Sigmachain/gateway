/**
 * Shapes the Ergo chain layer works in. Every amount is a `bigint`.
 */

export type RegisterId = 'R4' | 'R5' | 'R6' | 'R7' | 'R8' | 'R9';
export const REGISTER_IDS: readonly RegisterId[] = ['R4', 'R5', 'R6', 'R7', 'R8', 'R9'];

/** Registers as serialized constants (hex), exactly as stored in the box. */
export type ErgoRegisters = Partial<Record<RegisterId, string>>;

/** Context extension: variable id (0..255) to serialized constant (hex). */
export type ErgoContextExtension = Record<number, string>;

export interface ErgoTokenAmount {
  tokenId: string;
  amount: bigint;
}

/** A box as the chain layer holds it. */
export interface ErgoBox {
  boxId: string;
  transactionId: string;
  index: number;
  value: bigint;
  ergoTree: string;
  creationHeight: number;
  assets: ErgoTokenAmount[];
  additionalRegisters: ErgoRegisters;
  /** Height of the block that holds the creating transaction; undefined while unconfirmed. */
  inclusionHeight?: number;
}

export interface ErgoTokenInfo {
  /** Token id, 64 hex. The token's identity: symbols and names collide. */
  address: string;
  symbol: string;
  name: string;
  decimals: number;
}

// EIP-12 plain objects (what fleet emits and the signer consumes). Amounts are strings.

export interface Eip12TokenAmount {
  tokenId: string;
  amount: string;
}

export interface Eip12BoxCandidate {
  value: string;
  ergoTree: string;
  creationHeight: number;
  assets: Eip12TokenAmount[];
  additionalRegisters: ErgoRegisters;
}

export interface Eip12UnsignedInput extends Eip12BoxCandidate {
  boxId: string;
  transactionId: string;
  index: number;
  extension: Record<string, string>;
}

export interface Eip12DataInput extends Eip12BoxCandidate {
  boxId: string;
  transactionId: string;
  index: number;
}

export interface Eip12UnsignedTransaction {
  id?: string;
  inputs: Eip12UnsignedInput[];
  dataInputs: Eip12DataInput[];
  outputs: Eip12BoxCandidate[];
}

/** A node's JSON for a header, passed through to the signer as received. */
export type NodeHeaderJson = Record<string, unknown> & { height: number; id: string };
