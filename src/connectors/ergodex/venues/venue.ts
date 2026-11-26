/**
 * What the `ergodex` connector needs from a venue module. A venue owns its pool contract
 * knowledge (which trees are its pools, the box layout, the pricing rule, the successor it
 * must create) and nothing else; box reads, selection, change, signing and submit are the
 * chain layer's.
 */
import { ErgoNodeClient } from '../../../chains/ergo/ergo.node-client';
import { ErgoOutputSpec } from '../../../chains/ergo/ergo.tx-builder';
import { Eip12BoxCandidate, ErgoBox, ErgoContextExtension, RegisterId } from '../../../chains/ergo/ergo.types';

/** One side of a pool. `tokenId` null means the chain's native coin (the box value). */
export interface PoolSide {
  tokenId: string | null;
  /** What the pool trades with on this side. */
  reserve: bigint;
  /**
   * What the box holds on this side (its value, or its token amount), when that differs
   * from `reserve` (a pool that keeps owed fees in the box apart from its reserves).
   * Absent: the box holds exactly `reserve`.
   */
  held?: bigint;
}

/** The node reads a venue may make to admit a pool. */
export type VenueNodeReader = Pick<ErgoNodeClient, 'getUnspentBoxesByTokenId' | 'getIndexedHeight' | 'getInfo'>;

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
  /**
   * The fraction of the input that reaches the curve, as feeNum / feeDenom. A venue whose
   * fee differs by direction reports its costlier direction here, so the fee ceiling
   * guard judges the worst case.
   */
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
  /**
   * True when this venue recognises the tree as one of its pool trees: Spectrum by an exact
   * configured tree, LithosDex by the shape of its pinned pool template (any deployment's
   * ids in its terms). For LithosDex this does not bind the pool to a real deployment;
   * only `admit` does, and every caller must run it before the pool is used.
   */
  ownsTree(ergoTree: string): boolean;
  /** The pool in a box at one of this venue's trees, or null if the box is not a pool (wrong layout). */
  parsePool(box: ErgoBox): VenuePool | null;
  /** Largest output the contract allows for an exact input; 0 when it rounds to nothing. */
  amountOut(pool: VenuePool, input: SideName, amountIn: bigint): bigint;
  /** Smallest input the contract accepts for an exact output, or null if the pool cannot pay it. */
  amountInFor(pool: VenuePool, input: SideName, amountOut: bigint): bigint | null;
  /**
   * The share of this swap's gross input that goes to fees, as num / den, for a venue
   * whose fee on one trade can be above the pool's own figure (`feeNum` / `feeDenom`), for
   * example when a fee is rounded up on a small amount. The fee ceiling is applied to it
   * as well. Absent: the pool's figure is every trade's.
   */
  tradeFee?(pool: VenuePool, swap: PoolSwap): { num: bigint; den: bigint };
  /** The pool's successor box for a swap. Throws VenueRuleError when the contract would refuse it. */
  successor(pool: VenuePool, swap: PoolSwap): ErgoOutputSpec;
  /**
   * The pool contract's own rule, evaluated in bigint on a built transaction's output:
   * true when `candidate` is a successor the contract accepts for `pool.box`. With
   * `inputs` (the built transaction's input boxes, in order), the rules the contract
   * places on the other inputs are checked too.
   */
  contractAccepts(pool: VenuePool, candidate: Eip12BoxCandidate, inputs?: ErgoBox[]): boolean;
  /**
   * Context variables the pool input must carry for a swap. Absent: none. The chain layer
   * attaches them to the pool input, which is always input 0.
   */
  swapInputExtension?(pool: VenuePool): ErgoContextExtension;
  /**
   * Registers the successor must hold byte for byte as the pool box holds them. Absent:
   * every register of the pool box.
   */
  unchangedRegisters?(pool: VenuePool): RegisterId[];
  /**
   * Token indexes (after the pool NFT) whose amount a swap leaves unchanged. Absent: [1]
   * (the LP reserve of a Spectrum-style pool).
   */
  unchangedTokenIndexes?(pool: VenuePool): number[];
  /**
   * Whether this pool may be offered at all, read from the node if need be (for example a
   * deployment check and an operator allowlist): null when it may, else the reason.
   * Absent: every parsed pool may be offered.
   */
  admit?(pool: VenuePool, node: VenueNodeReader): Promise<string | null>;
  /** A venue's own guard on a parsed pool, beside the connector's: null, or the reason to refuse. */
  guardFailure?(pool: VenuePool): string | null;
  /** Pool ids this venue offers when a pool is chosen by pair (beside discovery by tree). */
  candidatePoolIds?(): string[];
}
