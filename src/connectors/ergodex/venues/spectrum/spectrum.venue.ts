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
 * - Token index 1 is the LP reserve: the LP tokens not in circulation. A deposit pays LP
 *   tokens out of it, a redeem returns them; the LP supply is `lockedLiquidity` minus it.
 *
 * Pools are recognised only by the exact tree; a box with the right tokens elsewhere is
 * not a pool of this venue. Nothing here is network-specific: trees, denominator,
 * storage floor and LP constant come from config.
 */
import { toAmount } from '../../../../chains/ergo/ergo.json';
import { ErgoOutputSpec } from '../../../../chains/ergo/ergo.tx-builder';
import { Eip12BoxCandidate, ErgoBox, ErgoTokenAmount } from '../../../../chains/ergo/ergo.types';
import { SpectrumVenueConfig } from '../../ergodex.config';
import { PoolLiquidity, PoolLiquidityChange, PoolSwap, SideName, Venue, VenuePool, VenueRuleError } from '../venue';

import { decodeSInt, depositFor, inputForOutput, lpSupply, outputForInput, redeemFor } from './spectrum.math';

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

  liquidityRefusal(): string | null {
    return this.config.lockedLiquidity === undefined
      ? 'spectrum.lockedLiquidity is not set for this network in the ergodex config'
      : null;
  }

  /** The LP token (index 1) and the supply in circulation; null when the LP constant is unset or the box is inconsistent with it. */
  liquidity(pool: VenuePool): PoolLiquidity | null {
    const locked = this.config.lockedLiquidity;
    if (locked === undefined) return null;
    const reserve = pool.box.assets[1];
    if (!reserve || reserve.amount > locked) return null;
    return { lpTokenId: reserve.tokenId.toLowerCase(), supply: lpSupply(locked, reserve.amount) };
  }

  private supplyOf(pool: VenuePool): bigint {
    const liq = this.liquidity(pool);
    if (!liq)
      throw new VenueRuleError(
        'the pool does not allow deposits or redeems here (no LP constant, or an LP reserve above it)',
      );
    if (liq.supply <= 0n) throw new VenueRuleError('the pool has no LP tokens in circulation');
    return liq.supply;
  }

  depositFor(pool: VenuePool, offerX: bigint | null, offerY: bigint | null): PoolLiquidityChange {
    const amounts = depositFor(pool.x.reserve, pool.y.reserve, this.supplyOf(pool), offerX, offerY);
    return { action: 'deposit', ...amounts };
  }

  redeemFor(pool: VenuePool, lp: bigint): PoolLiquidityChange {
    const supply = this.supplyOf(pool);
    if (lp > supply) throw new VenueRuleError(`${lp} LP tokens is more than the ${supply} in circulation`);
    return { action: 'redeem', ...redeemFor(pool.x.reserve, pool.y.reserve, supply, lp) };
  }

  /**
   * The successor for a deposit or redeem: tree, R4 and every token id as the pool box
   * holds them, the two reserves and the LP reserve moved by exactly the change, and on a
   * token/token pool the value unchanged. Refused here when a side would empty, the LP
   * reserve would leave its range, the storage floor would be crossed, or the contract
   * rule would not hold.
   */
  liquiditySuccessor(pool: VenuePool, change: PoolLiquidityChange): ErgoOutputSpec {
    if (change.x <= 0n || change.y <= 0n || change.lp <= 0n) {
      throw new VenueRuleError(`a ${change.action} must move both sides and some LP tokens`);
    }
    const locked = this.config.lockedLiquidity;
    if (locked === undefined) throw new VenueRuleError(this.liquidityRefusal()!);
    const sign = change.action === 'deposit' ? 1n : -1n;
    const x1 = pool.x.reserve + sign * change.x;
    const y1 = pool.y.reserve + sign * change.y;
    const [nft, lp] = pool.box.assets;
    const lp1 = lp.amount - sign * change.lp;
    if (x1 <= 0n || y1 <= 0n) throw new VenueRuleError(`the ${change.action} would empty one side of the pool`);
    if (lp1 <= 0n || lp1 > locked)
      throw new VenueRuleError(`the ${change.action} would move the LP reserve out of range`);
    let value: bigint;
    let assets: ErgoTokenAmount[];
    const lpOut = { tokenId: lp.tokenId, amount: lp1 };
    if (pool.kind === 'n2t') {
      value = x1;
      if (value <= this.config.n2tMinSuccessorValue) {
        throw new VenueRuleError(
          `the pool would keep ${value}, not above its storage floor ${this.config.n2tMinSuccessorValue}`,
        );
      }
      assets = [nft, lpOut, { tokenId: pool.y.tokenId!, amount: y1 }];
    } else {
      value = pool.box.value;
      assets = [nft, lpOut, { tokenId: pool.x.tokenId!, amount: x1 }, { tokenId: pool.y.tokenId!, amount: y1 }];
    }
    const spec = this.spec(pool, value, assets);
    if (!this.contractAccepts(pool, this.candidateOf(pool, spec))) {
      throw new VenueRuleError(`the pool contract would refuse this ${change.action}`);
    }
    return spec;
  }

  private spec(pool: VenuePool, value: bigint, assets: ErgoTokenAmount[]): ErgoOutputSpec {
    return {
      ergoTree: pool.box.ergoTree,
      value,
      assets: assets.map((a) => ({ tokenId: a.tokenId, amount: a.amount })),
      // every register exactly as the pool box holds it: R4 byte for byte
      additionalRegisters: { ...pool.box.additionalRegisters },
    };
  }

  private candidateOf(pool: VenuePool, spec: ErgoOutputSpec): Eip12BoxCandidate {
    return {
      value: spec.value.toString(),
      ergoTree: spec.ergoTree,
      creationHeight: pool.box.creationHeight,
      assets: spec.assets!.map((a) => ({ tokenId: a.tokenId, amount: a.amount.toString() })),
      additionalRegisters: spec.additionalRegisters!,
    };
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
   * `Pool.sc`, line by line, in bigint: the checks every successor must pass, then the
   * swap rule when the LP supply is unchanged, the deposit rule when it changes and both
   * reserves grow, and the redeem rule otherwise. Without the LP constant in config a
   * change of LP supply is refused, as before.
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
    const x0 = pool.x.reserve;
    const y0 = pool.y.reserve;
    const x1 = pool.kind === 'n2t' ? value1 : t1[2].amount;
    const y1 = pool.kind === 'n2t' ? t1[2].amount : t1[3].amount;
    const dx = x1 - x0;
    const dy = y1 - y0;
    if (t1[1].amount !== t0[1].amount) {
      // deltaSupplyLP != 0: a deposit or a redeem
      const locked = this.config.lockedLiquidity;
      if (locked === undefined || t0[1].amount > locked || t1[1].amount > locked) return false;
      const supply0 = locked - t0[1].amount;
      const dSupply = t0[1].amount - t1[1].amount; // supplyLP1 - supplyLP0
      if (dx > 0n && dy > 0n) {
        // validDepositing; BigInt division by a zero reserve fails the script
        if (x0 <= 0n || y0 <= 0n) return false;
        const byX = (dx * supply0) / x0;
        const byY = (dy * supply0) / y0;
        return dSupply <= (byX < byY ? byX : byY);
      }
      return dx * supply0 >= dSupply * x0 && dy * supply0 >= dSupply * y0; // validRedemption
    }
    const f = pool.feeNum;
    const d = pool.feeDenom;
    // The script computes `delta * feeNum` as a Long before widening it, and Long
    // arithmetic that overflows fails the script; so must the check here.
    const longOk = (v: bigint) => v <= MAX_LONG && v >= -MAX_LONG - 1n;
    if (dx > 0n) return longOk(dx * f) && y0 * dx * f >= -dy * (x0 * d + dx * f);
    return longOk(dy * f) && x0 * dy * f >= -dx * (y0 * d + dy * f);
  }
}
