/**
 * What the `ergodex` connector needs from a venue module. A venue owns its pool contract
 * knowledge (which trees are its pools, the box layout, the pricing rule, the successor it
 * must create) and nothing else; box reads, selection, change, signing and submit are the
 * chain layer's.
 */
import { ErgoOutputSpec } from '../../../chains/ergo/ergo.tx-builder';
import { Eip12BoxCandidate, ErgoBox } from '../../../chains/ergo/ergo.types';

/** One side of a pool. `tokenId` null means the chain's native coin (the box value). */
export interface PoolSide {
  tokenId: string | null;
  reserve: bigint;
}

export type SideName = 'x' | 'y';

export interface VenuePool {
  /** Venue module name, e.g. `spectrum`. */
  venue: string;
  /** Pool kind inside the venue, e.g. `n2t` (native/token) or `t2t` (token/token). */
  kind: string;
  /** The pool's stable id (its pool NFT). Box ids change at every swap. */
  poolId: string;
  box: ErgoBox;
  x: PoolSide;
  y: PoolSide;
  feeNum: bigint;
  feeDenom: bigint;
}

/** A swap against one pool: `input` is the side the trader pays into the pool. */
export interface PoolSwap {
  input: SideName;
  amountIn: bigint;
  amountOut: bigint;
}

export class VenueRuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VenueRuleError';
  }
}

export interface Venue {
  readonly name: string;
  /** True when the tree is, byte for byte, one of this venue's configured pool trees. */
  ownsTree(ergoTree: string): boolean;
  /** The pool in a box at one of this venue's trees, or null if the box is not a pool (wrong layout). */
  parsePool(box: ErgoBox): VenuePool | null;
  /** Largest output the contract allows for an exact input; 0 when it rounds to nothing. */
  amountOut(pool: VenuePool, input: SideName, amountIn: bigint): bigint;
  /** Smallest input the contract accepts for an exact output, or null if the pool cannot pay it. */
  amountInFor(pool: VenuePool, input: SideName, amountOut: bigint): bigint | null;
  /** The pool's successor box for a swap. Throws VenueRuleError when the contract would refuse it. */
  successor(pool: VenuePool, swap: PoolSwap): ErgoOutputSpec;
  /**
   * The pool contract's own rule, evaluated in bigint on a built transaction's output:
   * true when `candidate` is a successor the contract accepts for `pool.box`.
   */
  contractAccepts(pool: VenuePool, candidate: Eip12BoxCandidate): boolean;
}
