import * as fs from 'fs';
import * as path from 'path';
import { isDeepStrictEqual } from 'util';

import Ajv, { ValidateFunction } from 'ajv';
import yaml from 'js-yaml';

import { rootPath } from '../../paths';
import { ConfigManagerV2, ConfigurationNamespace, deepCopy } from '../../services/config-manager-v2';
import { httpErrors } from '../../services/error-handler';

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

/** A key as it is compared: Unicode NFKC normalisation, lower case, letters and digits only. */
const foldKey = (text: string): string =>
  text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '');

/** Whether a folded key is `submitmode` or within two edits of it. */
function nearSubmitMode(folded: string): boolean {
  if (folded === SUBMIT_MODE_FOLDED) return true;
  // more than two characters longer or shorter is more than two edits away
  if (Math.abs(Array.from(folded).length - SUBMIT_MODE_FOLDED.length) > 2) return false;
  return editDistance(folded, SUBMIT_MODE_FOLDED) <= 2;
}

/** Other words a person may write meaning "only check" or "the mode", after folding. */
const SUBMIT_MODE_SYNONYMS = new Set([
  'dryrun',
  'checkonly',
  'checkmode',
  'simulate',
  'simulation',
  'nosend',
  'sendmode',
  'mode',
  'submit',
]);

/**
 * Whether a config key looks like submitMode or like another way of saying it. Folded
 * (Unicode NFKC normalisation, lower case, letters and digits only), it matches when:
 * - the whole key, or one of its parts split on `.`, `/` or `:` (each folded on its own),
 *   is `submitmode` or within two edits of it (`sumbitMode`, `submitMod`, `submit_mode`,
 *   `ergo-mainnet.submitMode`, a lookalike letter from another alphabet, an invisible
 *   character);
 * - the whole key contains `submitmode` (`submitModeOverride`, `mainnetSubmitMode`);
 * - the whole key or its last part is one of dryrun, checkonly, checkmode, simulate,
 *   simulation, nosend, sendmode, mode, submit.
 * The exact key submitMode matches too.
 */
export function isSubmitModeLookalike(key: string): boolean {
  const whole = foldKey(key);
  const parts = key.normalize('NFKC').split(/[./:]/).map(foldKey);
  if (nearSubmitMode(whole) || parts.some(nearSubmitMode)) return true;
  if (whole.includes(SUBMIT_MODE_FOLDED)) return true;
  return SUBMIT_MODE_SYNONYMS.has(whole) || SUBMIT_MODE_SYNONYMS.has(parts[parts.length - 1]);
}

/** How deep, and over how many keys and list entries, a config tree is searched for such a key. */
const LOOKALIKE_MAX_DEPTH = 8;
const LOOKALIKE_MAX_NODES = 5000;

/** A mapping or a list as the YAML parser makes them; a date or binary value is a leaf. */
const isTreeNode = (value: unknown): value is Record<string, unknown> | unknown[] =>
  Array.isArray(value) ||
  (value !== null &&
    typeof value === 'object' &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value) as object | null));

/**
 * The first key in a config tree that looks like submitMode (see isSubmitModeLookalike),
 * at any depth, with whether it is below the top level; `limit` when the tree is nested
 * deeper than 8 levels or holds more than 5,000 keys and list entries, so it was not
 * searched to the end. `exemptTopLevel` is a key not counted at the top level.
 */
function findLookalikeKey(
  tree: unknown,
  exemptTopLevel?: string,
): { key: string; nested: boolean } | { limit: true } | undefined {
  let nodes = 0;
  const walk = (value: unknown, depth: number): { key: string; nested: boolean } | { limit: true } | undefined => {
    if (!isTreeNode(value)) return undefined;
    const entries: Array<[string | undefined, unknown]> = Array.isArray(value)
      ? value.map((item) => [undefined, item])
      : Object.entries(value);
    if (entries.length === 0) return undefined;
    if (depth > LOOKALIKE_MAX_DEPTH) return { limit: true };
    for (const [key, inner] of entries) {
      if (++nodes > LOOKALIKE_MAX_NODES) return { limit: true };
      if (key !== undefined && !(depth === 1 && key === exemptTopLevel) && isSubmitModeLookalike(key)) {
        return { key, nested: depth > 1 };
      }
      const found = walk(inner, depth + 1);
      if (found) return found;
    }
    return undefined;
  };
  return walk(tree, 1);
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
 * A key that looks like submitMode (see isSubmitModeLookalike) and is not the one key the
 * mode is read from, in words, or undefined when there is none. Looked for at any depth in
 * the network's config file as read (`fileBody`), in the network's config held in memory,
 * in the chain's config held in memory, and in the chain's config file, read from disk now
 * (in the chain's config no key like it belongs at all). Such a key is not read, so the
 * mode would not be what it seems to say. A chain config file that cannot be read, and a
 * tree too deep or too large to search to the end, are problems too. The words name the
 * key found (quoted, cut and escaped), never a key it is nested under and never a value.
 */
export function findSubmitModeLookalike(namespaceId: string, fileBody: unknown): string | undefined {
  const manager = ConfigManagerV2.getInstance();
  const namespace = manager.getNamespace(namespaceId);
  const file = namespace ? shownConfigPath(namespace.configurationPath) : `the ${namespaceId} config file`;
  const problemIn = (tree: unknown, where: string, exemptTopLevel?: string): string | undefined => {
    const found = findLookalikeKey(tree, exemptTopLevel);
    if (!found) return undefined;
    if ('limit' in found) {
      return (
        `${where} is nested more than ${LOOKALIKE_MAX_DEPTH} levels deep or holds more than ` +
        `${LOOKALIKE_MAX_NODES} keys and list entries, so it was not searched to the end for a key like ` +
        `"${SUBMIT_MODE_KEY}"`
      );
    }
    return (
      `the key ${shownKey(found.key)} ${found.nested ? 'under another key ' : ''}in ${where} is not read: the ` +
      `submit mode is set only by the key "${SUBMIT_MODE_KEY}" at the top level of ${file}`
    );
  };
  const inNetwork =
    (isMapping(fileBody) ? problemIn(fileBody, file, SUBMIT_MODE_KEY) : undefined) ??
    problemIn(namespace?.configuration, `the ${namespaceId} config held in memory`, SUBMIT_MODE_KEY);
  if (inNetwork) return inNetwork;
  const chain = manager.getNamespace('ergo');
  if (!chain) return undefined;
  const chainFile = shownConfigPath(chain.configurationPath);
  const inChainMemory = problemIn(chain.configuration, `the ergo chain config (${chainFile})`);
  if (inChainMemory) return inChainMemory;
  let chainBody: unknown;
  try {
    chainBody = yaml.load(fs.readFileSync(chain.configurationPath, 'utf8'));
  } catch (error) {
    // the error's code or class only: a parser's message quotes lines of the file
    return `the ergo chain config file ${chainFile} cannot be read (${errorKind(error)})`;
  }
  if (!isMapping(chainBody)) return `the ergo chain config file ${chainFile} cannot be read (not a mapping)`;
  return problemIn(chainBody, `the ergo chain config file ${chainFile}`);
}

/** The text the config manager's loader puts in place of an unquoted 0x address before it parses a file. */
const fixUnquotedHexAddresses = (text: string): string =>
  text.replace(/(defaultWallet|walletAddress):\s*(0x[a-fA-F0-9]{40})(?!\s*['"])/g, "$1: '$2'");

const schemaValidators = new Map<string, ValidateFunction>();

/**
 * The config the config manager loads from `text` for this namespace, the way its loader
 * does: parsed, checked against the namespace's JSON schema and, when it does not pass,
 * merged into the namespace's template and checked again. Throws where the loader would.
 */
function configLoadedFrom(namespace: ConfigurationNamespace, text: string): unknown {
  let validate = schemaValidators.get(namespace.schemaPath);
  if (!validate) {
    validate = new Ajv().compile(JSON.parse(fs.readFileSync(namespace.schemaPath, 'utf8')));
    schemaValidators.set(namespace.schemaPath, validate);
  }
  const candidate = yaml.load(fixUnquotedHexAddresses(text));
  if (validate(candidate)) return candidate;
  const merged = yaml.load(fixUnquotedHexAddresses(fs.readFileSync(namespace.templatePath, 'utf8')));
  deepCopy(candidate, merged);
  if (!validate(merged)) throw new Error('the config does not load');
  return merged;
}

/**
 * Per namespace, a config file's text and the config object in memory last seen to agree.
 * The config manager replaces its config object whenever it writes the file, so while the
 * object is the same one, the file must still be that text.
 */
const agreedConfigFiles = new WeakMap<ConfigurationNamespace, { configuration: object; text: string }>();

/**
 * Whether a config file's text is still what the config manager last read from it or wrote
 * to it:
 * - the text the manager writes from the config in memory, byte for byte (after any write
 *   by the manager the file is exactly that);
 * - otherwise, once a text was seen to agree with this same config object, that text, byte
 *   for byte;
 * - otherwise (nothing written since Gateway started and nothing seen yet), a text that
 *   loads, the way the manager loads it, to exactly the config in memory: every key, value
 *   and level the same, nothing added or removed.
 */
function configFileUnchanged(namespace: ConfigurationNamespace, text: string): boolean {
  const memory = namespace.configuration;
  try {
    if (text === yaml.dump(memory)) return true;
  } catch {
    // a config that cannot be written as YAML is compared below
  }
  const agreed = agreedConfigFiles.get(namespace);
  if (agreed) return agreed.configuration === memory && agreed.text === text;
  try {
    return isDeepStrictEqual(configLoadedFrom(namespace, text), memory);
  } catch {
    return false;
  }
}

/**
 * Refuse, with a 409, an update through the config API to the namespace `ergo` or an
 * `ergo-<network>` namespace whose config file on disk is no longer what the config manager
 * last read from it or wrote to it (see configFileUnchanged). The manager writes the whole
 * namespace from memory, so the update would erase a hand edit made while Gateway runs
 * (`submitMode: check`, say). Nothing is written; the file stays as the person edited it.
 * Called just before the update is applied.
 */
export function assertErgoConfigFileUnchanged(namespaceId: string): void {
  const namespace = ConfigManagerV2.getInstance().getNamespace(namespaceId);
  // no such namespace: the update itself answers that
  if (!namespace) return;
  let text: string | undefined;
  try {
    text = fs.readFileSync(namespace.configurationPath, 'utf8');
  } catch {
    text = undefined;
  }
  if (text !== undefined && configFileUnchanged(namespace, text)) {
    agreedConfigFiles.set(namespace, { configuration: namespace.configuration, text });
    return;
  }
  throw httpErrors.createError(
    409,
    `The ${namespaceId} config file ${shownConfigPath(namespace.configurationPath)} was changed on disk while ` +
      'Gateway was running, so this update was not applied. Restart Gateway, which reads the file, before ' +
      'changing the config through the API.',
  );
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
