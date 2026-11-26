/**
 * Config for connector `ergodex`: one AMM connector on chain `ergo` holding several venues
 * (Spectrum-style pools and LithosDex pools now; Dexy later), each a module under `venues/`.
 *
 * Everything that differs between networks (the pool contract trees that identify a
 * venue's pools, fee denominators, storage floors, guards) is read from
 * `ergodex.networks.<network>`. A network with no entry, or with no trees, is valid: the
 * connector loads and answers that no pools are configured there.
 */
import { toAmount } from '../../chains/ergo/ergo.json';
import { getAvailableErgoNetworks, isErgoId, isHexBytes, parseUnits } from '../../chains/ergo/ergo.utils';
import { AvailableNetworks } from '../../services/base';
import { ConfigManagerV2 } from '../../services/config-manager-v2';

import { encodeLong } from './venues/lithos/lithos.math';
import { ergoTreeConstants } from './venues/spectrum/spectrum.math';

/** Spectrum-style pools (ERG/token "n2t" and token/token "t2t") on one network. */
export interface SpectrumVenueConfig {
  /** Exact ErgoTrees (hex) of ERG/token pools. A box is a pool of this kind only at one of these. */
  n2tPoolTrees: string[];
  /** Exact ErgoTrees (hex) of token/token pools. */
  t2tPoolTrees: string[];
  /** The fee denominator the pool contract uses (R4 is the numerator). */
  feeDenominator: bigint;
  /** An ERG/token pool's successor must hold strictly more than this, in the smallest native unit. */
  n2tMinSuccessorValue: bigint;
  /**
   * The contracts' LP constant: the LP supply is this minus the LP tokens the pool holds.
   * Absent: deposits and redeems are not offered on this network (swaps do not need it).
   */
  lockedLiquidity?: bigint;
}

/** The pinned contract templates of one LithosDex pool kind, with sentinel ids in place of a deployment's. */
export interface LithosKindTemplates {
  /** The pool contract (terms: vault NFT, provision guard hash). */
  poolTree: string;
  /** The fee vault contract (terms: pool NFT, provision token). */
  feeVaultTree: string;
  /**
   * The provision logic's expression with its constants written in place (terms: pool
   * NFT, vault NFT): the bytes whose hash the provision guard names.
   */
  provisionLogicValue: string;
}

/** LithosDex pools (ERG/token "n2t" and token/token "t2t") on one network. */
export interface LithosVenueConfig {
  /**
   * Pool NFT ids the operator has checked and chosen. A LithosDex pool is offered (pool info, quote,
   * swap, pool choice) only if it is listed here and passes the deployment check. Empty:
   * no LithosDex pool is offered.
   */
  poolAllowlist: string[];
  /** The pool contracts' fee denominator (R5 holds the numerators). */
  feeDenominator: bigint;
  /** The scale of the fee accumulators (R7, R8). */
  accumulatorScale: bigint;
  /** The liquidity constant; supply is this minus R4. */
  lockedLiquidity: bigint;
  /** An ERG/token pool's successor must hold strictly more than this, in the smallest native unit. */
  n2tMinSuccessorValue: bigint;
  /** The operation byte context variable 0 of the pool input carries for a swap. */
  swapOperation: number;
  /** The 32-byte sentinel (hex) each template term is written as. */
  sentinels: {
    poolNft: string;
    vaultNft: string;
    provisionToken: string;
    provisionLogicHash: string;
    provisionGuardHash: string;
  };
  /** The provision guard contract, shared by both kinds (term: provision logic hash). */
  provisionGuardTree: string;
  n2t: LithosKindTemplates;
  t2t: LithosKindTemplates;
}

export interface ErgodexNetworkConfig {
  /** Build on the newest unconfirmed successor of a pool box in the node's mempool (else: confirmed box only). */
  useMempoolSuccessor: boolean;
  /** Pools charging more than this percentage are refused when named and skipped when choosing. */
  maxPoolFeePct: string;
  /** Pools whose native-coin reserve is below this (smallest unit) are refused or skipped; applies where a reserve is native. */
  minPoolNativeReserve: bigint;
  /** Pools with any token reserve below this (raw units) are refused or skipped. */
  minPoolTokenReserve: bigint;
  /** If not empty, only these pools (by pool NFT id) may be traded. */
  poolAllowlist: string[];
  /** Upper bound on boxes read per pool tree when discovering pools. */
  maxDiscoveredBoxes: number;
  spectrum: SpectrumVenueConfig;
  /** Absent: no LithosDex venue on this network. */
  lithos?: LithosVenueConfig;
}

export interface ErgodexRootConfig {
  /** Default slippage percentage between quote and execute. */
  slippagePct: number;
  /** After a definite rejection because the pool box was already spent: how many times to re-read, re-quote and rebuild. */
  maxRebuilds: number;
  /**
   * When the pool box is spent by one of our own pending transactions: milliseconds to wait
   * before rebuild n (times n), so the node can list that transaction's successor.
   */
  rebuildWaitMs: number;
}

const DEFAULT_MAX_DISCOVERED_BOXES = 5000;

const LITHOS_SENTINELS = ['poolNft', 'vaultNft', 'provisionToken', 'provisionLogicHash', 'provisionGuardHash'] as const;
const LITHOS_KIND_TEMPLATES = ['poolTree', 'feeVaultTree', 'provisionLogicValue'] as const;

function get(key: string): unknown {
  return ConfigManagerV2.getInstance().get(`ergodex.${key}`);
}

function trees(value: unknown, where: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error(`${where} must be a list of ErgoTree hex strings`);
  return value.map((t, i) => {
    if (!isHexBytes(t)) throw new Error(`${where}[${i}] is not hex`);
    return t.toLowerCase();
  });
}

function amount(value: unknown, fallback: bigint, where: string): bigint {
  if (value === undefined || value === null || value === '') return fallback;
  const v = toAmount(value, where);
  if (v < 0n) throw new Error(`${where} cannot be negative`);
  return v;
}

function tree(value: unknown, where: string): string {
  if (!isHexBytes(value)) throw new Error(`${where} must be hex`);
  return (value as string).toLowerCase();
}

function poolIds(value: unknown, where: string): string[] {
  const list = value ?? [];
  if (!Array.isArray(list) || list.some((id) => !isErgoId(id))) {
    throw new Error(`${where} must be a list of pool NFT ids (64 hex)`);
  }
  return (list as string[]).map((id) => id.toLowerCase());
}

/** The `lithos` block of a network, or undefined when it has none. Every value must be set. */
function lithos(value: unknown, where: string): LithosVenueConfig | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error(`${where} must be a mapping`);
  const raw = value as Record<string, unknown>;
  const required = (key: string): bigint => {
    if (raw[key] === undefined || raw[key] === null || raw[key] === '') throw new Error(`${where}.${key} must be set`);
    const v = amount(raw[key], 0n, `${where}.${key}`);
    if (v <= 0n) throw new Error(`${where}.${key} must be positive`);
    return v;
  };
  const op = Number(raw.swapOperation);
  if (raw.swapOperation === undefined || !Number.isInteger(op) || op < 0 || op > 127) {
    throw new Error(`${where}.swapOperation must be an integer from 0 to 127`);
  }
  const sentinelsRaw = (raw.sentinels ?? {}) as Record<string, unknown>;
  const sentinels = {} as LithosVenueConfig['sentinels'];
  for (const name of LITHOS_SENTINELS) {
    const v = sentinelsRaw[name];
    if (typeof v !== 'string' || !/^[0-9a-fA-F]{64}$/.test(v)) {
      throw new Error(`${where}.sentinels.${name} must be 32 bytes of hex`);
    }
    sentinels[name] = v.toLowerCase();
  }
  if (new Set(Object.values(sentinels)).size !== LITHOS_SENTINELS.length) {
    throw new Error(`${where}.sentinels must all differ`);
  }
  const kind = (k: 'n2t' | 't2t'): LithosKindTemplates => {
    const block = (raw[k] ?? {}) as Record<string, unknown>;
    const out = {} as LithosKindTemplates;
    for (const name of LITHOS_KIND_TEMPLATES) out[name] = tree(block[name], `${where}.${k}.${name}`);
    return out;
  };
  return {
    poolAllowlist: poolIds(raw.poolAllowlist, `${where}.poolAllowlist`),
    feeDenominator: required('feeDenominator'),
    accumulatorScale: required('accumulatorScale'),
    lockedLiquidity: required('lockedLiquidity'),
    n2tMinSuccessorValue: required('n2tMinSuccessorValue'),
    swapOperation: op,
    sentinels,
    provisionGuardTree: tree(raw.provisionGuardTree, `${where}.provisionGuardTree`),
    n2t: kind('n2t'),
    t2t: kind('t2t'),
  };
}

/**
 * The Spectrum LP constant when set: positive, at most the largest Long, and the value
 * the pool contracts themselves carry. Every configured Spectrum pool tree must hold it
 * as a Long constant: with any other value the connector would price deposits and
 * redeems differently from the contract, and the contract accepts a deposit that pays
 * the depositor fewer LP tokens than it allows.
 */
function spectrumLockedLiquidity(
  value: unknown,
  where: string,
  poolTrees: Record<'n2tPoolTrees' | 't2tPoolTrees', string[]>,
): { lockedLiquidity?: bigint } {
  if (value === undefined || value === null || value === '') return {};
  const v = amount(value, 0n, where);
  if (v <= 0n || v > 2n ** 63n - 1n) throw new Error(`${where} must be positive and at most 9223372036854775807`);
  const encoded = encodeLong(v);
  const spectrum = where.replace(/\.lockedLiquidity$/, '');
  for (const key of ['n2tPoolTrees', 't2tPoolTrees'] as const) {
    poolTrees[key].forEach((tree, i) => {
      if (!(ergoTreeConstants(tree) ?? []).includes(encoded)) {
        throw new Error(
          `${spectrum}.${key}[${i}] does not hold ${where} (${v}) as a Long constant: set the LP constant ` +
            "the pool contract carries, which is not the LP token's emission",
        );
      }
    });
  }
  return { lockedLiquidity: v };
}

/** A percentage as given (number or string), checked to be a plain decimal; kept as text for exact math. */
function percent(value: unknown, fallback: string, where: string): string {
  if (value === undefined || value === null || value === '') return fallback;
  const text = String(value);
  try {
    parseUnits(text, 8);
  } catch {
    throw new Error(`${where} must be a plain decimal percentage with at most 8 decimal places`);
  }
  return text;
}

export namespace ErgodexConfig {
  export const chain = 'ergo';
  export const networks = getAvailableErgoNetworks();
  export const tradingTypes = ['amm'] as const;
  /** Execute-swap refuses, with nothing sent, a swap outside the caller's minAmountOut or maxAmountIn. */
  export const bindsPriceLimit = true;

  export const availableNetworks: Array<AvailableNetworks> = [{ chain, networks }];

  export function root(): ErgodexRootConfig {
    const slippage = Number(get('slippagePct') ?? 1);
    const rebuilds = Number(get('maxRebuilds') ?? 2);
    const waitMs = Number(get('rebuildWaitMs') ?? 500);
    if (!Number.isFinite(slippage) || slippage < 0 || slippage > 100) {
      throw new Error('ergodex.slippagePct must be between 0 and 100');
    }
    if (!Number.isInteger(rebuilds) || rebuilds < 0 || rebuilds > 10) {
      throw new Error('ergodex.maxRebuilds must be an integer from 0 to 10');
    }
    if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > 10000) {
      throw new Error('ergodex.rebuildWaitMs must be an integer from 0 to 10000');
    }
    return { slippagePct: slippage, maxRebuilds: rebuilds, rebuildWaitMs: waitMs };
  }

  /** The network's settings; an absent network entry gives a config with no pool trees. */
  export function network(network: string): ErgodexNetworkConfig {
    const all = (get('networks') ?? {}) as Record<string, Record<string, unknown> | undefined>;
    const raw = (all && typeof all === 'object' ? all[network] : undefined) ?? {};
    const where = `ergodex.networks.${network}`;
    const spectrum = (raw.spectrum ?? {}) as Record<string, unknown>;
    const feeDenominator = amount(spectrum.feeDenominator, 0n, `${where}.spectrum.feeDenominator`);
    const n2tPoolTrees = trees(spectrum.n2tPoolTrees, `${where}.spectrum.n2tPoolTrees`);
    const t2tPoolTrees = trees(spectrum.t2tPoolTrees, `${where}.spectrum.t2tPoolTrees`);
    const lithosConfig = lithos(raw.lithos, `${where}.lithos`);
    const hasTrees = n2tPoolTrees.length > 0 || t2tPoolTrees.length > 0 || lithosConfig !== undefined;
    if ((n2tPoolTrees.length > 0 || t2tPoolTrees.length > 0) && feeDenominator <= 0n) {
      throw new Error(`${where}.spectrum.feeDenominator must be set and positive when pool trees are configured`);
    }
    // The guards fail closed: a network that can trade must state its fee ceiling and size floor.
    const unset = (v: unknown) => v === undefined || v === null || v === '';
    if (hasTrees && (unset(raw.maxPoolFeePct) || unset(raw.minPoolNativeReserve))) {
      throw new Error(`${where}.maxPoolFeePct and minPoolNativeReserve must be set when pool trees are configured`);
    }
    const allowlist = raw.poolAllowlist ?? [];
    if (!Array.isArray(allowlist) || allowlist.some((id) => !isErgoId(id))) {
      throw new Error(`${where}.poolAllowlist must be a list of pool NFT ids (64 hex)`);
    }
    const maxBoxes = Number(raw.maxDiscoveredBoxes ?? DEFAULT_MAX_DISCOVERED_BOXES);
    if (!Number.isInteger(maxBoxes) || maxBoxes < 1)
      throw new Error(`${where}.maxDiscoveredBoxes must be a positive integer`);
    return {
      useMempoolSuccessor: raw.useMempoolSuccessor === undefined ? true : raw.useMempoolSuccessor === true,
      maxPoolFeePct: percent(raw.maxPoolFeePct, '3', `${where}.maxPoolFeePct`),
      minPoolNativeReserve: amount(raw.minPoolNativeReserve, 0n, `${where}.minPoolNativeReserve`),
      minPoolTokenReserve: amount(raw.minPoolTokenReserve, 1n, `${where}.minPoolTokenReserve`),
      poolAllowlist: (allowlist as string[]).map((id) => id.toLowerCase()),
      maxDiscoveredBoxes: maxBoxes,
      spectrum: {
        n2tPoolTrees,
        t2tPoolTrees,
        feeDenominator,
        n2tMinSuccessorValue: amount(spectrum.n2tMinSuccessorValue, 0n, `${where}.spectrum.n2tMinSuccessorValue`),
        ...spectrumLockedLiquidity(spectrum.lockedLiquidity, `${where}.spectrum.lockedLiquidity`, {
          n2tPoolTrees,
          t2tPoolTrees,
        }),
      },
      ...(lithosConfig ? { lithos: lithosConfig } : {}),
    };
  }
}
