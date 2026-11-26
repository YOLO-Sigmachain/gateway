import * as fs from 'fs';
import * as path from 'path';

import yaml from 'js-yaml';

import { rootPath } from '../../paths';
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
   * is sent or tracked. Unset: nothing is signed, sent or checked; every swap and transfer
   * is refused until it is set.
   */
  submitMode?: ErgoSubmitMode;
  /**
   * In check mode the node at nodeURL receives every signed transaction in full, so a
   * network in check mode starts only when nodeURL is on this machine, unless this is true.
   */
  checkAllowsRemoteNode?: boolean;
}

export const SUBMIT_MODES = ['send', 'check'] as const;
export type ErgoSubmitMode = (typeof SUBMIT_MODES)[number];

/** The submit mode a config value names; unset is undefined (not set), anything else is refused. */
export function parseSubmitMode(value: unknown, key: string): ErgoSubmitMode | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'string' && (SUBMIT_MODES as readonly string[]).includes(value)) return value as ErgoSubmitMode;
  throw new Error(`${key} must be one of ${SUBMIT_MODES.join(', ')}; got ${String(value)}`);
}

/** The one key the submit mode is read from, at the top level of the network's config file. */
export const SUBMIT_MODE_KEY = 'submitMode';
const SUBMIT_MODE_FOLDED = 'submitmode';

/** Edit distance (insertions, deletions, substitutions) between two strings, by code point. */
function editDistance(a: string, b: string): number {
  const x = Array.from(a);
  const y = Array.from(b);
  let previous = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    const current = [i];
    for (let j = 1; j <= y.length; j++) {
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
    }
    previous = current;
  }
  return previous[y.length];
}

/**
 * Whether a config key looks like submitMode: after Unicode NFKC normalisation, lower-casing
 * and removing every character that is not a letter or a digit, it is `submitmode` or within
 * two edits of it (`sumbitMode`, `submitMod`, `submit_mode`, `submit.mode`, a lookalike
 * letter from another alphabet, an invisible character). The exact key matches too.
 */
export function isSubmitModeLookalike(key: string): boolean {
  const folded = key
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '');
  return folded === SUBMIT_MODE_FOLDED || editDistance(folded, SUBMIT_MODE_FOLDED) <= 2;
}

/** A key as it is shown in a message: quoted, cut at 60 characters, with every character outside printable ASCII escaped. */
function shownKey(key: string): string {
  const chars = Array.from(key);
  const cut = chars.slice(0, 60).join('');
  const escaped = cut.replace(/[^\x20-\x7e]|["\\]/gu, (c) =>
    c === '"' || c === '\\'
      ? `\\${c}`
      : Array.from(c)
          .map((p) => `\\u{${p.codePointAt(0)!.toString(16)}}`)
          .join(''),
  );
  return `"${escaped}"${chars.length > 60 ? '…' : ''}`;
}

/** A config file's path as it is shown in a message: relative to the Gateway folder when it is inside it. */
export function shownConfigPath(file: string): string {
  const relative = path.relative(rootPath(), file);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative) ? relative : file;
}

/** What an error that stopped a read is, by its code or its class; never its message, which may quote the file. */
export function errorKind(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && /^[A-Z0-9_]{1,40}$/.test(code)) return code;
  return error instanceof Error ? error.name : typeof error;
}

const isMapping = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * A key that looks like submitMode and is not the one key the mode is read from, in words,
 * or undefined when there is none. Looked for in the network's config file as read
 * (`fileBody`: its top-level keys, and the keys of each mapping one level down), in the
 * network's config held in memory, and in the chain's config held in memory (where no key
 * like it belongs at all). Such a key is not read, so the mode would not be what it seems
 * to say.
 */
export function findSubmitModeLookalike(namespaceId: string, fileBody: unknown): string | undefined {
  const manager = ConfigManagerV2.getInstance();
  const namespace = manager.getNamespace(namespaceId);
  const file = namespace ? shownConfigPath(namespace.configurationPath) : `the ${namespaceId} config file`;
  const found = (key: string, where: string) =>
    `the key ${shownKey(key)} ${where} is not read: the submit mode is set only by the key "${SUBMIT_MODE_KEY}" ` +
    `at the top level of ${file}`;
  if (isMapping(fileBody)) {
    for (const [key, value] of Object.entries(fileBody)) {
      if (key !== SUBMIT_MODE_KEY && isSubmitModeLookalike(key)) return found(key, `in ${file}`);
      if (!isMapping(value)) continue;
      for (const inner of Object.keys(value)) {
        if (isSubmitModeLookalike(inner)) return found(inner, `under ${shownKey(key)} in ${file}`);
      }
    }
  }
  for (const key of Object.keys(namespace?.configuration ?? {})) {
    if (key !== SUBMIT_MODE_KEY && isSubmitModeLookalike(key)) {
      return found(key, `in the ${namespaceId} config held in memory`);
    }
  }
  const chain = manager.getNamespace('ergo');
  for (const key of Object.keys(chain?.configuration ?? {})) {
    if (isSubmitModeLookalike(key)) {
      return found(key, `in the ergo chain config${chain ? ` (${shownConfigPath(chain.configurationPath)})` : ''}`);
    }
  }
  return undefined;
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

/**
 * Refuse to start a network whose config has a key that looks like submitMode but is not
 * the one key read (see findSubmitModeLookalike): the mode would not be what the file seems
 * to say. The network's config file is read from disk for this; a file that cannot be read
 * stops the network too.
 */
function refuseSubmitModeLookalikes(namespaceId: string): void {
  const namespace = ConfigManagerV2.getInstance().getNamespace(namespaceId);
  let fileBody: unknown;
  if (namespace) {
    try {
      fileBody = yaml.load(fs.readFileSync(namespace.configurationPath, 'utf8'));
    } catch (error) {
      throw new Error(
        `${namespaceId}: the config file ${shownConfigPath(namespace.configurationPath)} cannot be read ` +
          `(${errorKind(error)}); this network does not start until it can`,
      );
    }
  }
  const problem = findSubmitModeLookalike(namespaceId, fileBody);
  if (problem) {
    throw new Error(`${namespaceId}: ${problem}. Correct it; this network does not start until then`);
  }
}

export function getErgoNetworkConfig(network: string): ErgoNetworkConfig {
  const namespaceId = `ergo-${network}`;
  refuseSubmitModeLookalikes(namespaceId);
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
    ...(optional(namespaceId, 'checkAllowsRemoteNode') === true ? { checkAllowsRemoteNode: true } : {}),
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
