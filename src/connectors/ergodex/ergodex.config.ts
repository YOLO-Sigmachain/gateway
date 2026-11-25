/**
 * Config for connector `ergodex`: one AMM connector on chain `ergo` holding several venues
 * (Spectrum-style pools now; LithosDex and Dexy later), each a module under `venues/`.
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
}

export interface ErgodexRootConfig {
  /** Default slippage percentage between quote and execute. */
  slippagePct: number;
  /** After a definite rejection because the pool box was already spent: how many times to re-read, re-quote and rebuild. */
  maxRebuilds: number;
}

const DEFAULT_MAX_DISCOVERED_BOXES = 1000;

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

  export const availableNetworks: Array<AvailableNetworks> = [{ chain, networks }];

  export function root(): ErgodexRootConfig {
    const slippage = Number(get('slippagePct') ?? 1);
    const rebuilds = Number(get('maxRebuilds') ?? 2);
    if (!Number.isFinite(slippage) || slippage < 0 || slippage > 100) {
      throw new Error('ergodex.slippagePct must be between 0 and 100');
    }
    if (!Number.isInteger(rebuilds) || rebuilds < 0 || rebuilds > 10) {
      throw new Error('ergodex.maxRebuilds must be an integer from 0 to 10');
    }
    return { slippagePct: slippage, maxRebuilds: rebuilds };
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
    if ((n2tPoolTrees.length > 0 || t2tPoolTrees.length > 0) && feeDenominator <= 0n) {
      throw new Error(`${where}.spectrum.feeDenominator must be set and positive when pool trees are configured`);
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
      maxPoolFeePct: percent(raw.maxPoolFeePct, '100', `${where}.maxPoolFeePct`),
      minPoolNativeReserve: amount(raw.minPoolNativeReserve, 0n, `${where}.minPoolNativeReserve`),
      minPoolTokenReserve: amount(raw.minPoolTokenReserve, 1n, `${where}.minPoolTokenReserve`),
      poolAllowlist: (allowlist as string[]).map((id) => id.toLowerCase()),
      maxDiscoveredBoxes: maxBoxes,
      spectrum: {
        n2tPoolTrees,
        t2tPoolTrees,
        feeDenominator,
        n2tMinSuccessorValue: amount(spectrum.n2tMinSuccessorValue, 0n, `${where}.spectrum.n2tMinSuccessorValue`),
      },
    };
  }
}
