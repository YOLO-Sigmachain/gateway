import { ConfigManagerV2 } from '../../services/config-manager-v2';

import { toAmount } from './ergo.json';
import { getAvailableErgoNetworks } from './ergo.utils';

/**
 * One network's settings. Everything that differs between Ergo mainnet, testnet and any
 * other network running the same protocol (address prefix, native symbol and decimals,
 * fee, block interval) lives here, so one chain class serves them all.
 */
export interface ErgoNetworkConfig {
  nodeURL: string;
  addressPrefix: number;
  nativeCurrencySymbol: string;
  nativeDecimals: number;
  /** In the smallest native unit. */
  minerFee: bigint;
  /** Highest miner fee a transaction may pay, in the smallest native unit. Default 10 x minerFee. */
  maxMinerFee: bigint;
  minerFeeErgoTree: string;
  tokenListSource: string;
  blockTimeSeconds: number;
  pendingTxTimeoutBlocks: number;
  /** Blocks on top of (and including) the one holding a transaction before poll reports it confirmed. */
  confirmations: number;
  /**
   * Blocks on top of (and including) the one holding a different transaction that spent one
   * of a pending transaction's inputs, before that pending transaction is reported failed.
   * Unset: `confirmations`.
   */
  failedAfterConfirmations?: number;
  nodeTimeoutMs: number;
  boxPageSize: number;
  swapProvider?: string;
  /**
   * File that keeps this network's pending transactions across restarts, relative to the
   * Gateway folder (or absolute). Unset: they are kept in memory only.
   */
  pendingStateFile?: string;
  /**
   * What happens to a signed transaction. `send`: it is submitted to the node, which relays
   * it. `check`: it is only checked by the node's /transactions/check endpoint, and nothing
   * is sent or tracked. Unset: `send`.
   */
  submitMode?: ErgoSubmitMode;
}

export const SUBMIT_MODES = ['send', 'check'] as const;
export type ErgoSubmitMode = (typeof SUBMIT_MODES)[number];

/** The submit mode a config value names; unset is `send`, anything else is refused. */
export function parseSubmitMode(value: unknown, key: string): ErgoSubmitMode {
  if (value === undefined || value === null || value === '') return 'send';
  if (typeof value === 'string' && (SUBMIT_MODES as readonly string[]).includes(value)) return value as ErgoSubmitMode;
  throw new Error(`${key} must be one of ${SUBMIT_MODES.join(', ')}; got ${String(value)}`);
}

export interface ErgoChainConfig {
  defaultNetwork: string;
  defaultNetworks?: string[];
  defaultWallet: string;
}

export const networks = getAvailableErgoNetworks();

const DEFAULT_NODE_TIMEOUT_MS = 10000;
const DEFAULT_BOX_PAGE_SIZE = 100;
/** maxMinerFee when the network config leaves it out: a multiple of that network's minerFee. */
const DEFAULT_MAX_FEE_MULTIPLE = 10n;

function required<T>(namespaceId: string, key: string): T {
  const value = ConfigManagerV2.getInstance().get(`${namespaceId}.${key}`);
  if (value === undefined || value === null || value === '') {
    throw new Error(`Missing ${namespaceId}.${key} in the Ergo network config`);
  }
  return value as T;
}

function optional<T>(namespaceId: string, key: string): T | undefined {
  const value = ConfigManagerV2.getInstance().get(`${namespaceId}.${key}`);
  return value === undefined || value === null || value === '' ? undefined : (value as T);
}

export function getErgoNetworkConfig(network: string): ErgoNetworkConfig {
  const namespaceId = `ergo-${network}`;
  const addressPrefix = Number(required<number>(namespaceId, 'addressPrefix'));
  if (!Number.isInteger(addressPrefix) || addressPrefix < 0 || addressPrefix > 240 || addressPrefix % 16 !== 0) {
    throw new Error(`${namespaceId}.addressPrefix must be a multiple of 16 between 0 and 240`);
  }
  const minerFee = toAmount(required(namespaceId, 'minerFee'), `${namespaceId}.minerFee`);
  if (minerFee <= 0n) {
    throw new Error(`${namespaceId}.minerFee must be positive`);
  }
  const configuredMaxFee = optional(namespaceId, 'maxMinerFee');
  const maxMinerFee =
    configuredMaxFee === undefined
      ? DEFAULT_MAX_FEE_MULTIPLE * minerFee
      : toAmount(configuredMaxFee, `${namespaceId}.maxMinerFee`);
  if (maxMinerFee < minerFee) {
    throw new Error(`${namespaceId}.maxMinerFee must be at least minerFee`);
  }
  const confirmations = Number(required<number>(namespaceId, 'confirmations'));
  const failedAfterConfirmations = Number(optional<number>(namespaceId, 'failedAfterConfirmations') ?? confirmations);
  return {
    nodeURL: String(required<string>(namespaceId, 'nodeURL')).trim().replace(/\/+$/, ''),
    addressPrefix,
    nativeCurrencySymbol: required<string>(namespaceId, 'nativeCurrencySymbol'),
    nativeDecimals: Number(required<number>(namespaceId, 'nativeDecimals')),
    minerFee,
    maxMinerFee,
    minerFeeErgoTree: String(required<string>(namespaceId, 'minerFeeErgoTree')).toLowerCase(),
    tokenListSource: required<string>(namespaceId, 'tokenListSource'),
    blockTimeSeconds: Number(required<number>(namespaceId, 'blockTimeSeconds')),
    pendingTxTimeoutBlocks: Number(required<number>(namespaceId, 'pendingTxTimeoutBlocks')),
    confirmations,
    failedAfterConfirmations,
    nodeTimeoutMs: Number(optional<number>(namespaceId, 'nodeTimeoutMs') ?? DEFAULT_NODE_TIMEOUT_MS),
    boxPageSize: Number(optional<number>(namespaceId, 'boxPageSize') ?? DEFAULT_BOX_PAGE_SIZE),
    swapProvider: optional<string>(namespaceId, 'swapProvider'),
    pendingStateFile: optional<string>(namespaceId, 'pendingStateFile'),
    submitMode: parseSubmitMode(optional(namespaceId, 'submitMode'), `${namespaceId}.submitMode`),
  };
}

export function getErgoChainConfig(): ErgoChainConfig {
  return {
    defaultNetwork: ConfigManagerV2.getInstance().get('ergo.defaultNetwork'),
    defaultNetworks: ConfigManagerV2.getInstance().get('ergo.defaultNetworks'),
    defaultWallet: ConfigManagerV2.getInstance().get('ergo.defaultWallet'),
  };
}

/** The address prefixes of every configured Ergo network, skipping any that is misconfigured. */
export function configuredAddressPrefixes(): number[] {
  const prefixes = new Set<number>();
  for (const network of networks) {
    try {
      prefixes.add(getErgoNetworkConfig(network).addressPrefix);
    } catch {
      // a broken network config is reported where that network is used
    }
  }
  return [...prefixes];
}
