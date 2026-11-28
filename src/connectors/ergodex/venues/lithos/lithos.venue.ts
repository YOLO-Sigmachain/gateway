/**
 * LithosDex pools on Ergo: ERG/token (`n2t`, `LD_LiquidityPool.ergo`) and token/token
 * (`t2t`, `LD_T2T_LiquidityPool.ergo`), traded by direct swap: the trader's own
 * transaction spends the pool box at input 0, with context variable 0 on it set to the
 * swap operation byte, and creates its successor at output 0. No data inputs.
 *
 * Layout, from the contracts:
 * - n2t: tokens [pool NFT (1), token Y, provision token], exactly 3. The box value is the
 *   ERG reserve plus the pending ERG fees, and the successor must hold more than the
 *   storage floor (`n2tMinSuccessorValue`).
 * - t2t: tokens [pool NFT (1), token X, token Y, provision token], exactly 4. The box
 *   value is storage only: the successor may not hold less. No R9.
 * - R4 Long liquidity (supply = lockedLiquidity - R4), R5 Coll[Long] [dexFee, fee of the
 *   first side, fee of the second side] over feeDenominator, R6 Coll[Long] pending fees
 *   [first side, second side], R7 and R8 BigInt fee accumulators of the two sides.
 * - Reserves are what the box holds on a side less that side's pending fee.
 *
 * Pools are discovered on chain by their template hash (one per kind). A pool is
 * recognised by the shape of a pinned pool template (any deployment's ids in its terms)
 * and offered only after the deployment check (`admit`), then judged by the same guards
 * as a Spectrum-style pool. The optional `poolAllowlist` restricts the venue to listed
 * pools. The swap rule is in `lithos.math.ts`. Templates and contract constants come from
 * config.
 */
import { toAmount } from '../../../../chains/ergo/ergo.json';
import { ErgoOutputSpec } from '../../../../chains/ergo/ergo.tx-builder';
import {
  Eip12BoxCandidate,
  ErgoBox,
  ErgoContextExtension,
  ErgoRegisters,
  ErgoTokenAmount,
  RegisterId,
} from '../../../../chains/ergo/ergo.types';
import { LithosVenueConfig } from '../../ergodex.config';
import { PoolSwap, SideName, Venue, VenueNodeReader, VenuePool, VenueRuleError } from '../venue';

import { LithosDeployments } from './lithos.deployment';
import {
  accumulatorAdvance,
  curveAllows,
  decodeBigInt,
  decodeCollLong,
  decodeLong,
  encodeBigInt,
  encodeCollLong,
  LithosDirectionFees,
  LithosKind,
  MAX_LONG,
  MIN_LONG,
  quoteExactIn,
  quoteExactOut,
  sideFee,
} from './lithos.math';

export const LITHOS_VENUE = 'lithos';

/** What a LithosDex pool box holds beyond the common pool view. */
export interface LithosState {
  kind: LithosKind;
  denom: bigint;
  dexFee: bigint;
  /** The side fee numerator charged when this side is paid in. */
  sideFee: Record<SideName, bigint>;
  pending: Record<SideName, bigint>;
  held: Record<SideName, bigint>;
  acc: Record<SideName, bigint>;
  liquidity: bigint;
  supply: bigint;
  feeParams: bigint[];
  provisionToken: ErgoTokenAmount;
  vaultNft: string;
}

export interface LithosPool extends VenuePool {
  lithos: LithosState;
}

const ACC_REGISTER: Record<SideName, RegisterId> = { x: 'R7', y: 'R8' };

function other(side: SideName): SideName {
  return side === 'x' ? 'y' : 'x';
}

function lithosOf(pool: VenuePool): LithosState {
  const state = (pool as LithosPool).lithos;
  if (pool.venue !== LITHOS_VENUE || !state) throw new VenueRuleError('not a LithosDex pool');
  return state;
}

function fees(state: LithosState, input: SideName): LithosDirectionFees {
  return { denom: state.denom, dex: state.dexFee, side: state.sideFee[input] };
}

function candidateAssets(candidate: Eip12BoxCandidate): ErgoTokenAmount[] {
  return (candidate.assets ?? []).map((a) => ({ tokenId: a.tokenId.toLowerCase(), amount: toAmount(a.amount) }));
}

export class LithosVenue implements Venue {
  readonly name = LITHOS_VENUE;
  private readonly config: LithosVenueConfig;
  private readonly deployments: LithosDeployments;
  private readonly allow: Set<string>;

  constructor(config: LithosVenueConfig) {
    this.config = config;
    this.deployments = new LithosDeployments(config);
    this.allow = new Set(config.poolAllowlist.map((id) => id.toLowerCase()));
  }

  get deploymentCheck(): LithosDeployments {
    return this.deployments;
  }

  ownsTree(ergoTree: string): boolean {
    return this.deployments.poolTemplateOf(ergoTree) !== null;
  }

  parsePool(box: ErgoBox): LithosPool | null {
    const template = this.deployments.poolTemplateOf(box.ergoTree);
    if (!template) return null;
    const { kind, vaultNft } = template;
    const tokens = box.assets;
    const count = kind === 'n2t' ? 3 : 4;
    if (tokens.length !== count || tokens[0].amount !== 1n) return null;
    if (new Set(tokens.map((t) => t.tokenId.toLowerCase())).size !== count) return null;
    if (tokens.some((t) => t.amount <= 0n)) return null;
    const r = box.additionalRegisters;
    const liquidity = decodeLong(r.R4);
    const feeParams = decodeCollLong(r.R5);
    const pending = decodeCollLong(r.R6);
    const accX = decodeBigInt(r.R7);
    const accY = decodeBigInt(r.R8);
    if (liquidity === null || !feeParams || !pending || accX === null || accY === null) return null;
    if (feeParams.length < 3 || pending.length !== 2) return null;
    // Pending fees are owed to providers; one below zero would show the pool deeper than it is.
    if (pending[0] < 0n || pending[1] < 0n) return null;
    // The contract computes the supply in Long (lockedLiquidity - R4): out of that range it
    // fails on every spend.
    const supply = this.config.lockedLiquidity - liquidity;
    if (supply <= 0n || supply > MAX_LONG) return null;
    const denom = this.config.feeDenominator;
    const [dexFee, feeX, feeY] = feeParams;
    if (!(dexFee > 0n && dexFee <= denom && feeX >= 0n && feeX < denom && feeY >= 0n && feeY < denom)) return null;
    const heldX = kind === 'n2t' ? box.value : tokens[1].amount;
    const heldY = kind === 'n2t' ? tokens[1].amount : tokens[2].amount;
    // the reserves, also computed in Long by the contract
    const reserveX = heldX - pending[0];
    const reserveY = heldY - pending[1];
    if (reserveX <= 0n || reserveY <= 0n || reserveX > MAX_LONG || reserveY > MAX_LONG) return null;
    const tokenX = kind === 'n2t' ? null : tokens[1].tokenId.toLowerCase();
    const tokenY = (kind === 'n2t' ? tokens[1] : tokens[2]).tokenId.toLowerCase();
    // the costlier direction, as the fraction of the input that reaches the curve
    const keepX = (denom - feeX) * dexFee;
    const keepY = (denom - feeY) * dexFee;
    const prov = tokens[count - 1];
    return {
      venue: this.name,
      kind,
      poolId: tokens[0].tokenId.toLowerCase(),
      box,
      x: { tokenId: tokenX, reserve: reserveX, held: heldX },
      y: { tokenId: tokenY, reserve: reserveY, held: heldY },
      feeNum: keepX < keepY ? keepX : keepY,
      feeDenom: denom * denom,
      lithos: {
        kind,
        denom,
        dexFee,
        sideFee: { x: feeX, y: feeY },
        pending: { x: pending[0], y: pending[1] },
        held: { x: heldX, y: heldY },
        acc: { x: accX, y: accY },
        liquidity,
        supply,
        feeParams,
        provisionToken: { tokenId: prov.tokenId.toLowerCase(), amount: prov.amount },
        vaultNft,
      },
    };
  }

  amountOut(pool: VenuePool, input: SideName, amountIn: bigint): bigint {
    const s = lithosOf(pool);
    return quoteExactIn(s.kind, pool[input].reserve, pool[other(input)].reserve, amountIn, fees(s, input)).out;
  }

  amountInFor(pool: VenuePool, input: SideName, amountOut: bigint): bigint | null {
    const s = lithosOf(pool);
    const q = quoteExactOut(s.kind, pool[input].reserve, pool[other(input)].reserve, amountOut, fees(s, input));
    return q ? q.gross : null;
  }

  /**
   * What this swap pays in fees, over its gross input A: the side fee f taken from A,
   * plus the dex fee's share of the traded amount T = A - f, that is f + T * (D - dex) / D,
   * so the share is (A * D - T * dex) / (A * D). Exact, in bigint. On a small trade the
   * side fee is rounded (up, on a token/token pool), so this can be well above the pool's
   * figure.
   */
  tradeFee(pool: VenuePool, swap: PoolSwap): { num: bigint; den: bigint } {
    const s = lithosOf(pool);
    const gross = swap.amountIn;
    const traded = gross - sideFee(s.kind, gross, fees(s, swap.input));
    return { num: gross * s.denom - traded * s.dexFee, den: gross * s.denom };
  }

  swapInputExtension(): ErgoContextExtension {
    return { 0: '02' + this.config.swapOperation.toString(16).padStart(2, '0') };
  }

  unchangedRegisters(): RegisterId[] {
    // R4 (liquidity) and R5 (feeParams) stay byte-for-byte equal to the pool box; R6 and one
    // accumulator advance, and R9 is omitted by successor() (and rejected by contractAccepts on t2t).
    return ['R4', 'R5'];
  }

  unchangedTokenIndexes(pool: VenuePool): number[] {
    return [lithosOf(pool).kind === 'n2t' ? 2 : 3];
  }

  /**
   * With a non-empty lithos poolAllowlist, a pool off it is refused. Empty: no restriction
   * when `discoverPools` is set, else every pool is refused.
   */
  guardFailure(pool: VenuePool): string | null {
    if (this.allow.size > 0) {
      return this.allow.has(pool.poolId.toLowerCase())
        ? null
        : `LithosDex pool ${pool.poolId} is not on the lithos poolAllowlist`;
    }
    if (!this.config.discoverPools) {
      return `LithosDex pool ${pool.poolId} is not offered: lithos.discoverPools is false and lithos.poolAllowlist is empty`;
    }
    return null;
  }

  candidatePoolIds(): string[] {
    return [...this.allow];
  }

  /** The two kinds' template hashes; none when `discoverPools` is false. */
  poolTemplateHashes(): string[] {
    return this.config.discoverPools ? [this.config.n2t.poolTemplateHash, this.config.t2t.poolTemplateHash] : [];
  }

  /** The restriction list first (no node read), then the deployment check. */
  async admit(pool: VenuePool, node: VenueNodeReader): Promise<string | null> {
    const listed = this.guardFailure(pool);
    if (listed) return listed;
    const s = lithosOf(pool);
    const failure = await this.deployments.check(
      pool.box.ergoTree,
      { kind: s.kind, poolNft: pool.poolId, vaultNft: s.vaultNft, provisionToken: s.provisionToken.tokenId },
      node,
    );
    return failure ? `LithosDex pool ${pool.poolId} fails the deployment check: ${failure}` : null;
  }

  successor(pool: VenuePool, swap: PoolSwap): ErgoOutputSpec {
    const s = lithosOf(pool);
    if (swap.amountIn <= 0n || swap.amountOut <= 0n) throw new VenueRuleError('a swap must move both sides');
    const input = swap.input;
    const out = other(input);
    const f = sideFee(s.kind, swap.amountIn, fees(s, input));
    const held = { ...s.held };
    held[input] += swap.amountIn;
    held[out] -= swap.amountOut;
    const pending = { ...s.pending };
    pending[input] += f;
    if (held[input] > MAX_LONG) throw new VenueRuleError('the pool would hold more than a Long can count');
    if (held.x - pending.x <= 0n || held.y - pending.y <= 0n) {
      throw new VenueRuleError('the swap would empty one side of the pool');
    }
    const [nft] = pool.box.assets;
    const prov = s.provisionToken;
    let value: bigint;
    let assets: ErgoTokenAmount[];
    if (s.kind === 'n2t') {
      value = held.x;
      if (value <= this.config.n2tMinSuccessorValue) {
        throw new VenueRuleError(
          `the pool would keep ${value}, not above its storage floor ${this.config.n2tMinSuccessorValue}`,
        );
      }
      assets = [nft, { tokenId: pool.y.tokenId!, amount: held.y }, prov];
    } else {
      value = pool.box.value;
      assets = [nft, { tokenId: pool.x.tokenId!, amount: held.x }, { tokenId: pool.y.tokenId!, amount: held.y }, prov];
    }
    const registers: ErgoRegisters = {
      R4: pool.box.additionalRegisters.R4,
      R5: pool.box.additionalRegisters.R5,
      R7: pool.box.additionalRegisters.R7,
      R8: pool.box.additionalRegisters.R8,
    };
    try {
      registers.R6 = encodeCollLong([pending.x, pending.y]);
      registers[ACC_REGISTER[input]] = encodeBigInt(
        s.acc[input] + accumulatorAdvance(f, this.config.accumulatorScale, s.supply),
      );
    } catch (error) {
      // a pending fee beyond a Long, or an accumulator beyond 256 bits: the contract cannot hold it
      throw new VenueRuleError(
        `the pool's registers cannot hold the state after this swap (${error instanceof Error ? error.message : String(error)})`,
      );
    }
    const spec: ErgoOutputSpec = {
      ergoTree: pool.box.ergoTree,
      value,
      assets: assets.map((a) => ({ tokenId: a.tokenId, amount: a.amount })),
      additionalRegisters: registers,
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
   * The pool contract on the swap path (operation 0), line by line, in bigint: the rules
   * every spend keeps (`poolPreserved`), then the swap rules. Every value the script
   * computes in Long on this path is checked against the Long range, so a successor whose
   * arithmetic would overflow there (the script then fails) fails here too: the two
   * supplies and their difference, the four reserves, the two box changes, the two
   * pending changes, the two reserve changes, the negated output change and the traded
   * amount times the dex fee. What the script computes in BigInt stays unbounded here.
   */
  contractAccepts(pool: VenuePool, candidate: Eip12BoxCandidate, inputs?: ErgoBox[]): boolean {
    const s = lithosOf(pool);
    const self = pool.box;
    const longOk = (...vs: bigint[]) => vs.every((v) => v <= MAX_LONG && v >= MIN_LONG);
    if (inputs) {
      if (inputs[0]?.boxId !== self.boxId) return false; // onlyOne: the pool is INPUTS(0)
      const provIn = inputs
        .flatMap((b) => b.assets)
        .filter((a) => a.tokenId.toLowerCase() === s.provisionToken.tokenId)
        .reduce((n, a) => n + a.amount, 0n);
      if (provIn !== s.provisionToken.amount) return false; // provTokenHeld
    }
    if (candidate.ergoTree.toLowerCase() !== self.ergoTree.toLowerCase()) return false;
    const t1 = candidateAssets(candidate);
    const t0 = self.assets;
    const count = s.kind === 'n2t' ? 3 : 4;
    if (t1.length !== count) return false;
    if (t1[0].tokenId !== t0[0].tokenId.toLowerCase() || t1[0].amount !== t0[0].amount) return false; // pool NFT
    for (let i = 1; i < count; i++) if (t1[i].tokenId !== t0[i].tokenId.toLowerCase()) return false;
    const regs = candidate.additionalRegisters ?? {};
    const liquidity1 = decodeLong(regs.R4);
    const feeParams1 = decodeCollLong(regs.R5);
    const pending1 = decodeCollLong(regs.R6);
    const accX1 = decodeBigInt(regs.R7);
    const accY1 = decodeBigInt(regs.R8);
    if (liquidity1 === null || !feeParams1 || !pending1 || accX1 === null || accY1 === null) return false;
    if (feeParams1.length !== s.feeParams.length || feeParams1.some((v, i) => v !== s.feeParams[i])) return false;
    if (pending1.length !== 2) return false;
    if (s.kind === 't2t' && regs.R9 !== undefined) return false;
    const value1 = toAmount(candidate.value);
    if (s.kind === 'n2t' ? !(value1 > this.config.n2tMinSuccessorValue) : !(value1 >= self.value)) return false;
    const held1 = {
      x: s.kind === 'n2t' ? value1 : t1[1].amount,
      y: s.kind === 'n2t' ? t1[1].amount : t1[2].amount,
    };
    const r0 = { x: pool.x.reserve, y: pool.y.reserve };
    const r1 = { x: held1.x - pending1[0], y: held1.y - pending1[1] };
    const supply1 = this.config.lockedLiquidity - liquidity1;
    // supplyLP0, supplyLP1, deltaSupplyLP and the four reserves, all Long in the script
    if (!longOk(s.supply, supply1, supply1 - s.supply, r0.x, r0.y, r1.x, r1.y)) return false;
    if (!(r1.x > 0n && r1.y > 0n)) return false; // reservesHeld
    // swap
    if (liquidity1 !== s.liquidity) return false; // deltaSupplyLP == 0
    if (t1[count - 1].amount !== s.provisionToken.amount) return false;
    const dPending = { x: pending1[0] - s.pending.x, y: pending1[1] - s.pending.y };
    if (!longOk(dPending.x, dPending.y)) return false; // deltaPendingX, deltaPendingY
    const scale = this.config.accumulatorScale;
    if (accX1 !== s.acc.x + (dPending.x * scale) / s.supply) return false;
    if (accY1 !== s.acc.y + (dPending.y * scale) / s.supply) return false;
    const total = { x: held1.x - s.held.x, y: held1.y - s.held.y };
    if (!longOk(total.x, total.y)) return false; // totalDeltaX, totalDeltaY
    if (total.x === 0n && total.y === 0n) return false;
    const dR = { x: r1.x - r0.x, y: r1.y - r0.y };
    if (!longOk(dR.x, dR.y)) return false; // deltaReservesX, deltaReservesY
    const input: SideName = dR.x > 0n ? 'x' : 'y';
    const out = other(input);
    const f = fees(s, input);
    // in the curve: the negated output change, and the traded amount times the dex fee
    if (!longOk(-dR[out], dR[input] * f.dex)) return false;
    if (!curveAllows(r0[input], r0[out], dR[input], -dR[out], f)) return false;
    // With the reserve rising, a fall in the box amount would need a negative pending change,
    // which never equals the contract's fee on that amount.
    if (total[input] < 0n) return false;
    if (dPending[input] !== sideFee(s.kind, total[input], f)) return false; // feeXAdded / feeYAdded
    return dPending[out] === 0n;
  }
}
