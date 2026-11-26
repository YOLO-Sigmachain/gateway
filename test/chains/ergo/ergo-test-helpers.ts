/**
 * Fixtures for the Ergo tests. Boxes are built in the test with real fleet-sdk, so their
 * ids are the true hashes of their content; the signer and the builder both check that.
 * Mnemonics are published BIP-39 test vectors, never a real wallet.
 */
import * as fs from 'fs';
import * as path from 'path';

import { ErgoBox as FleetErgoBox, FEE_CONTRACT } from '@fleet-sdk/core';

import { ErgoNetworkConfig } from '../../../src/chains/ergo/ergo.config';
import { stringifyWithBigInt } from '../../../src/chains/ergo/ergo.json';
import { FetchLike } from '../../../src/chains/ergo/ergo.node-client';
import { ErgoBox, ErgoRegisters, ErgoTokenAmount, NodeHeaderJson } from '../../../src/chains/ergo/ergo.types';

/** BIP-39 English test vector (entropy 0x00 x 16). */
export const MNEMONIC_A =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
/** BIP-39 English test vector (entropy 0x7f x 16). */
export const MNEMONIC_B = 'legal winner thank year wave sausage worth useful legal winner thank yellow';

/** The secp256k1 generator: the public key of secret key 1. */
export const GENERATOR_PK = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';
/** Published fixtures for that key (Nautilus yolo branch, tests/unit/yoloChain.spec.ts). */
export const GENERATOR_ADDRESSES: Record<number, string> = {
  0: '9fSgJ7BmUxBQJ454prQDQ7fQMBkXPLaAmDnimgTtjym6FYPHjAV',
  16: '3WwXpssaZwcNzaGMv3AgxBdTPJQBt5gCmqBsg3DykQ39bYdhJBsN',
  32: '5tDcyTdyNQGaarUemFUygy9FNFcdEn1qNu9xdJmVc46Y6qrKyXV1',
};

export const FEE_TREE = FEE_CONTRACT;
export const MAX_LONG = 9223372036854775807n;
export const ABOVE_2_53 = 9007199254740993n; // 2^53 + 1

export const p2pk = (publicKeyHex: string): string => `0008cd${publicKeyHex}`;

export const tokenId = (n: number): string => n.toString(16).padStart(2, '0').repeat(32);

let txCounter = 1;

export function makeBox(params: {
  ergoTree: string;
  value: bigint;
  assets?: ErgoTokenAmount[];
  registers?: ErgoRegisters;
  creationHeight?: number;
  transactionId?: string;
  index?: number;
  inclusionHeight?: number | null;
}): ErgoBox {
  const transactionId = params.transactionId ?? (txCounter++).toString(16).padStart(64, 'a');
  const index = params.index ?? 0;
  const creationHeight = params.creationHeight ?? 1000;
  const candidate = {
    value: params.value,
    ergoTree: params.ergoTree,
    creationHeight,
    assets: (params.assets ?? []).map((a) => ({ tokenId: a.tokenId, amount: a.amount })),
    additionalRegisters: { ...(params.registers ?? {}) },
  };
  const boxId = new FleetErgoBox(candidate, transactionId, index).boxId;
  return {
    boxId,
    transactionId,
    index,
    value: params.value,
    ergoTree: params.ergoTree,
    creationHeight,
    assets: (params.assets ?? []).map((a) => ({ ...a })),
    additionalRegisters: { ...(params.registers ?? {}) },
    inclusionHeight: params.inclusionHeight === null ? undefined : (params.inclusionHeight ?? creationHeight),
  };
}

/** A box as the node's indexer writes it: amounts as raw JSON integers. */
export function nodeBoxJson(box: ErgoBox, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    boxId: box.boxId,
    transactionId: box.transactionId,
    index: box.index,
    value: box.value,
    ergoTree: box.ergoTree,
    creationHeight: box.creationHeight,
    assets: box.assets.map((a) => ({ tokenId: a.tokenId, amount: a.amount })),
    additionalRegisters: box.additionalRegisters,
    inclusionHeight: box.inclusionHeight ?? 0,
    globalIndex: 1,
    spentTransactionId: null,
    ...extra,
  };
}

const FIXTURES = path.join(__dirname, 'fixtures');

export function loadHeaders(): NodeHeaderJson[] {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, 'mainnet-last-headers.json'), 'utf8'));
}

export function fixtureText(name: string): string {
  return fs.readFileSync(path.join(FIXTURES, name), 'utf8');
}

export const HEADERS = loadHeaders();
export const TIP = Math.max(...HEADERS.map((h) => h.height));

/**
 * A network config for tests. It says `submitMode: send`: a network sends only when its
 * config says so. A test of check mode overrides it, and a test of the mode not set leaves
 * the key out (see withoutSubmitMode).
 */
export function testConfig(overrides: Partial<ErgoNetworkConfig> = {}): ErgoNetworkConfig {
  return {
    submitMode: 'send',
    nodeURL: 'http://node.test:9053',
    addressPrefix: 0,
    nativeCurrencySymbol: 'ERG',
    nativeDecimals: 9,
    minerFee: 1100000n,
    maxMinerFee: 11000000n,
    minerFeeErgoTree: FEE_TREE,
    tokenListSource: 'tokens/ergo/mainnet.json',
    blockTimeSeconds: 120,
    pendingTxTimeoutBlocks: 15,
    confirmations: 1,
    nodeTimeoutMs: 1000,
    boxPageSize: 100,
    ...overrides,
  };
}

/** The same config with no submitMode key at all: the mode not set. */
export function withoutSubmitMode(config: ErgoNetworkConfig): ErgoNetworkConfig {
  const { submitMode: _left, ...rest } = config;
  return rest;
}

/**
 * A check-mode network config for tests. Its node stand-in is reached through an injected
 * fetch, never over the network; nodeURL keeps the test host, so the config says
 * checkAllowsRemoteNode (check mode otherwise needs a node on this machine).
 */
export function checkTestConfig(overrides: Partial<ErgoNetworkConfig> = {}): ErgoNetworkConfig {
  return testConfig({ submitMode: 'check', checkAllowsRemoteNode: true, ...overrides });
}

export interface FakeResponse {
  status?: number;
  body: unknown;
}

export type FakeRoute = (method: string, urlPath: string, body?: string) => FakeResponse | undefined;

/**
 * A node stand-in: routes return objects that are written as node JSON (bigints as raw
 * integers). An unrouted request fails the test loudly.
 */
export function fakeNode(route: FakeRoute) {
  const calls: Array<{ method: string; path: string; body?: string }> = [];
  const fetch: FetchLike = async (input, init) => {
    const url = new URL(input);
    const method = String(init?.method ?? 'GET');
    const body = init?.body as string | undefined;
    const urlPath = url.pathname + url.search;
    calls.push({ method, path: urlPath, body });
    const res = route(method, urlPath, body);
    if (!res) throw new Error(`unrouted fake node request: ${method} ${urlPath}`);
    const status = res.status ?? 200;
    const text = typeof res.body === 'string' ? res.body : stringifyWithBigInt(res.body);
    return { ok: status >= 200 && status < 300, status, text: async () => text };
  };
  return { fetch, calls };
}

export const notFound = (): FakeResponse => ({ status: 404, body: { error: 404, reason: 'not-found', detail: null } });

/** A node's /info; `stateType` utxo, as a node that keeps the UTXO set (and so runs scripts) answers. */
export function infoBody(height = TIP, minValuePerByte = 360, stateType = 'utxo') {
  return { fullHeight: height, headersHeight: height, network: 'mainnet', stateType, parameters: { minValuePerByte } };
}
