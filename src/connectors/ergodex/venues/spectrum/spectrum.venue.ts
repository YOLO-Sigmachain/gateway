/**
 * Spectrum-style constant-product pools on Ergo: ERG/token (`n2t`) and token/token (`t2t`).
 * A trader's own transaction spends the pool box and creates its successor at OUTPUTS(0).
 *
 * Layout, from the live mainnet pool trees and `spectrum-finance/ergo-dex`
 * `contracts/amm/cfmm/v1/{n2t,t2t}/Pool.sc`:
 * - n2t: tokens [pool NFT (1), LP reserve, Y]; reserve X is the box value. Successor:
 *   same tree, same R4, exactly 3 tokens with the same ids, same LP amount, value strictly
 *   above the storage floor (`n2tMinSuccessorValue`).
 * - t2t: tokens [pool NFT (1), LP reserve, X, Y]; the value is storage only and must not fall.
 * - R4 is `Int` on both live trees (the repo's t2t source says Long; that is not the
 *   deployed tree). It is copied byte for byte. The fee is R4 / feeDenominator, per pool.
 *
 * Pools are recognised only by the exact tree; a box with the right tokens elsewhere is
 * not a pool of this venue. Nothing here is network-specific: trees, denominator and
 * storage floor come from config.
 */
import { toAmount } from '../../../../chains/ergo/ergo.json';
import { ErgoOutputSpec } from '../../../../chains/ergo/ergo.tx-builder';
import { Eip12BoxCandidate, ErgoBox, ErgoTokenAmount } from '../../../../chains/ergo/ergo.types';
import { SpectrumVenueConfig } from '../../ergodex.config';
import { PoolSwap, SideName, Venue, VenuePool, VenueRuleError } from '../venue';

import { decodeSInt, inputForOutput, outputForInput } from './spectrum.math';

export const SPECTRUM_VENUE = 'spectrum';

const MAX_LONG = 2n ** 63n - 1n;

type Kind = 'n2t' | 't2t';

function reserves(pool: VenuePool, input: SideName): { rIn: bigint; rOut: bigint } {
  return input === 'x' ? { rIn: pool.x.reserve, rOut: pool.y.reserve } : { rIn: pool.y.reserve, rOut: pool.x.reserve };
}

function candidateAssets(candidate: Eip12BoxCandidate): ErgoTokenAmount[] {
  return (candidate.assets ?? []).map((a) => ({ tokenId: a.tokenId.toLowerCase(), amount: toAmount(a.amount) }));
}

export class SpectrumVenue implements Venue {
  readonly name = SPECTRUM_VENUE;
  private readonly kinds = new Map<string, Kind>();
  private readonly config: SpectrumVenueConfig;

  constructor(config: SpectrumVenueConfig) {
    this.config = config;
    for (const tree of config.n2tPoolTrees) this.kinds.set(tree.toLowerCase(), 'n2t');
    for (const tree of config.t2tPoolTrees) this.kinds.set(tree.toLowerCase(), 't2t');
  }

  /** True when this network has any Spectrum pool tree configured. */
  get configured(): boolean {
    return this.kinds.size > 0;
  }

  get trees(): string[] {
    return [...this.kinds.keys()];
  }

  ownsTree(ergoTree: string): boolean {
    return this.kinds.has(ergoTree.toLowerCase());
  }

  parsePool(box: ErgoBox): VenuePool | null {
    const kind = this.kinds.get(box.ergoTree.toLowerCase());
    if (!kind) return null;
    const fee = decodeSInt(box.additionalRegisters.R4);
    const feeDenom = this.config.feeDenominator;
    if (fee === null || fee <= 0 || BigInt(fee) > feeDenom) return null;
    const tokens = box.assets;
    const count = kind === 'n2t' ? 3 : 4;
    if (tokens.length !== count || tokens[0].amount !== 1n) return null;
    if (new Set(tokens.map((t) => t.tokenId.toLowerCase())).size !== count) return null;
    if (tokens.some((t) => t.amount <= 0n)) return null;
    const x =
      kind === 'n2t'
        ? { tokenId: null, reserve: box.value }
        : { tokenId: tokens[2].tokenId, reserve: tokens[2].amount };
    const y =
      kind === 'n2t'
        ? { tokenId: tokens[2].tokenId, reserve: tokens[2].amount }
        : { tokenId: tokens[3].tokenId, reserve: tokens[3].amount };
    return {
      venue: this.name,
      kind,
      poolId: tokens[0].tokenId.toLowerCase(),
      box,
      x,
      y,
      feeNum: BigInt(fee),
      feeDenom,
    };
  }

  amountOut(pool: VenuePool, input: SideName, amountIn: bigint): bigint {
    const { rIn, rOut } = reserves(pool, input);
    return outputForInput(rIn, rOut, amountIn, pool.feeNum, pool.feeDenom);
  }

  amountInFor(pool: VenuePool, input: SideName, amountOut: bigint): bigint | null {
    const { rIn, rOut } = reserves(pool, input);
    return inputForOutput(rIn, rOut, amountOut, pool.feeNum, pool.feeDenom);
  }

  successor(pool: VenuePool, swap: PoolSwap): ErgoOutputSpec {
    if (swap.amountIn <= 0n || swap.amountOut <= 0n) throw new VenueRuleError('a swap must move both sides');
    const dx = swap.input === 'x' ? swap.amountIn : -swap.amountOut;
    const dy = swap.input === 'y' ? swap.amountIn : -swap.amountOut;
    const x1 = pool.x.reserve + dx;
    const y1 = pool.y.reserve + dy;
    if (x1 <= 0n || y1 <= 0n) throw new VenueRuleError('the swap would empty one side of the pool');
    const [nft, lp] = pool.box.assets;
    let value: bigint;
    let assets: ErgoTokenAmount[];
    if (pool.kind === 'n2t') {
      value = x1;
      if (value <= this.config.n2tMinSuccessorValue) {
        throw new VenueRuleError(
          `the pool would keep ${value}, not above its storage floor ${this.config.n2tMinSuccessorValue}`,
        );
      }
      assets = [nft, lp, { tokenId: pool.y.tokenId!, amount: y1 }];
    } else {
      value = pool.box.value;
      assets = [nft, lp, { tokenId: pool.x.tokenId!, amount: x1 }, { tokenId: pool.y.tokenId!, amount: y1 }];
    }
    const spec: ErgoOutputSpec = {
      ergoTree: pool.box.ergoTree,
      value,
      assets: assets.map((a) => ({ tokenId: a.tokenId, amount: a.amount })),
      // every register exactly as the pool box holds it: R4 byte for byte
      additionalRegisters: { ...pool.box.additionalRegisters },
    };
    const candidate: Eip12BoxCandidate = {
      value: spec.value.toString(),
      ergoTree: spec.ergoTree,
      creationHeight: pool.box.creationHeight,
      assets: spec.assets!.map((a) => ({ tokenId: a.tokenId, amount: a.amount.toString() })),
      additionalRegisters: spec.additionalRegisters!,
    };
    if (!this.contractAccepts(pool, candidate)) throw new VenueRuleError('the pool contract would refuse this swap');
    return spec;
  }

  /**
   * `Pool.sc` for a swap, line by line, in bigint. A change in LP supply would be a
   * deposit or redeem; this connector never makes one, so it is refused here.
   */
  contractAccepts(pool: VenuePool, candidate: Eip12BoxCandidate): boolean {
    const self = pool.box;
    if (candidate.ergoTree.toLowerCase() !== self.ergoTree.toLowerCase()) return false; // validSuccessorScript
    const fee1 = decodeSInt(candidate.additionalRegisters?.R4);
    if (fee1 === null || BigInt(fee1) !== pool.feeNum) return false; // preservedFeeConfig
    const t1 = candidateAssets(candidate);
    const t0 = self.assets;
    if (pool.kind === 'n2t' && t1.length !== 3) return false; // noMoreTokens
    if (t1.length < t0.length) return false; // successor.tokens(i) must exist
    if (t1[0].tokenId !== t0[0].tokenId.toLowerCase() || t1[0].amount !== t0[0].amount) return false; // NFT
    for (let i = 1; i < t0.length; i++) if (t1[i].tokenId !== t0[i].tokenId.toLowerCase()) return false; // LP, pair
    const value1 = toAmount(candidate.value);
    if (pool.kind === 'n2t' ? !(value1 > this.config.n2tMinSuccessorValue) : !(value1 >= self.value)) return false;
    if (t1[1].amount !== t0[1].amount) return false; // deltaSupplyLP == 0: a swap
    const x0 = pool.x.reserve;
    const y0 = pool.y.reserve;
    const x1 = pool.kind === 'n2t' ? value1 : t1[2].amount;
    const y1 = pool.kind === 'n2t' ? t1[2].amount : t1[3].amount;
    const dx = x1 - x0;
    const dy = y1 - y0;
    const f = pool.feeNum;
    const d = pool.feeDenom;
    // The script computes `delta * feeNum` as a Long before widening it, and Long
    // arithmetic that overflows fails the script; so must the check here.
    const longOk = (v: bigint) => v <= MAX_LONG && v >= -MAX_LONG - 1n;
    if (dx > 0n) return longOk(dx * f) && y0 * dx * f >= -dy * (x0 * d + dx * f);
    return longOk(dy * f) && x0 * dy * f >= -dx * (y0 * d + dy * f);
  }
}
