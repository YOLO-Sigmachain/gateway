/**
 * Fixtures for the LithosDex tests. Captured from the local mainnet node with read-only
 * GETs on 2026-11-26 (`/blockchain/box/unspent/byTokenId/<id>`, `/blocks/lastHeaders/10`),
 * headers 1,925,096 to 1,925,105:
 * - ERG:LIT pool box ed5f84f830e81063b3748559d2a1636ab606c3b5eb5b09aa710cd74827bf068b
 *   (height 1,925,075), its vault 95bc2e21ccdac56228a7c3dcad0fa663990edf77af39b6a7e5acc8a6bf0cb726
 *   (height 1,924,861);
 * - LIT:RSN pool box 4f13bdf9cca004a3f4c36d1f90c49fa57bc33fd1a047371813cada2a66387ac2
 *   (height 1,924,881), its vault c7d014bf684f0b46c5790c1f9951e831cbd941a1eefb808e72ca79dab3f97e6b
 *   (height 1,924,381);
 * - ERG:BBC pool box 9bd4fcb2d20a33b7e666353ff56a820e192932809735b8dddda9f8d91f57c906
 *   (height 1,891,728, a dust pool), its vault
 *   dec06b8c773bf659fb14f92701de05a2962823e7041f5de017e63d1435bfed49 (height 1,878,171).
 * The LithosDex config is read from the shipped template, so these tests also check it.
 */
import * as fs from 'fs';
import * as path from 'path';

import * as yaml from 'js-yaml';

import { Ergo } from '../../../src/chains/ergo/ergo';
import { FetchLike } from '../../../src/chains/ergo/ergo.node-client';
import { ErgoBox, ErgoTokenInfo, NodeHeaderJson } from '../../../src/chains/ergo/ergo.types';
import { Ergodex } from '../../../src/connectors/ergodex/ergodex';
import { ErgodexConfig, ErgodexNetworkConfig, LithosVenueConfig } from '../../../src/connectors/ergodex/ergodex.config';
import { ConfigManagerV2 } from '../../../src/services/config-manager-v2';
import { testConfig } from '../../chains/ergo/ergo-test-helpers';

import {
  dexConfig,
  fixturePool,
  fixtureText,
  ME,
  ME_TREE,
  NodeState,
  ROOT,
  RSN,
  signer,
  stateNode,
  TOKENS,
} from './ergodex-test-helpers';

export const LIT_POOL = fixturePool('lithos-pool-n2t-erg-lit.json');
export const LIT_VAULT = fixturePool('lithos-vault-n2t-erg-lit.json');
export const LIT_RSN_POOL = fixturePool('lithos-pool-t2t-lit-rsn.json');
export const LIT_RSN_VAULT = fixturePool('lithos-vault-t2t-lit-rsn.json');
export const BBC_POOL = fixturePool('lithos-pool-n2t-erg-bbc.json');
export const BBC_VAULT = fixturePool('lithos-vault-n2t-erg-bbc.json');

export const L_HEADERS: NodeHeaderJson[] = JSON.parse(fixtureText('lithos-last-headers.json'));
export const L_TIP = Math.max(...L_HEADERS.map((h) => h.height));

export const LIT = 'c1980d829988229516430a47a5eca376060b6ce859616db0936e78ab25cb6de7';
export const BBC = 'fffe6122886e3b0ab9b72b401b39bf8d3f13580c1335a41d91d19deb8038ccd4';
export const LIT_NFT = LIT_POOL.assets[0].tokenId;
export const LIT_RSN_NFT = LIT_RSN_POOL.assets[0].tokenId;
export const BBC_NFT = BBC_POOL.assets[0].tokenId;

export const L_TOKENS: ErgoTokenInfo[] = [
  ...TOKENS,
  { address: LIT, symbol: 'LIT', name: 'Lithos', decimals: 9 },
  { address: BBC, symbol: 'BBC', name: 'BBC', decimals: 0 },
];

/** The shipped template, parsed as the config manager would hand it over. */
export function shippedTemplate(): Record<string, unknown> {
  return yaml.load(
    fs.readFileSync(path.join(__dirname, '../../../src/templates/connectors/ergodex.yml'), 'utf8'),
  ) as Record<string, unknown>;
}

/** The mainnet network config as the connector reads it from the shipped template. */
export function shippedMainnet(): ErgodexNetworkConfig {
  const template = shippedTemplate();
  const spy = jest
    .spyOn(ConfigManagerV2, 'getInstance')
    .mockReturnValue({ get: (k: string) => template[k.replace(/^ergodex\./, '')] } as never);
  try {
    return ErgodexConfig.network('mainnet');
  } finally {
    spy.mockRestore();
  }
}

/** The shipped LithosDex config, with an allowlist of choice. */
export function lithosConfig(allow: string[] = []): LithosVenueConfig {
  return { ...shippedMainnet().lithos!, poolAllowlist: allow };
}

/** The Spectrum test config with the LithosDex venue added. */
export function lithosDexConfig(allow: string[], over: Partial<ErgodexNetworkConfig> = {}): ErgodexNetworkConfig {
  return { ...dexConfig(over), lithos: lithosConfig(allow) };
}

/** The stand-in node, answering height and headers from the LithosDex capture. */
export function lithosNode(state: NodeState): FetchLike {
  const inner = stateNode(state);
  return async (input, init) => {
    const url = new URL(input);
    const method = String(init?.method ?? 'GET');
    const reply = (body: unknown) => {
      state.calls.push({ method, path: url.pathname + url.search });
      const text = JSON.stringify(body);
      return { ok: true, status: 200, text: async () => text };
    };
    if (method === 'GET' && url.pathname === '/info') {
      return reply({
        fullHeight: L_TIP,
        headersHeight: L_TIP,
        network: 'mainnet',
        parameters: { minValuePerByte: 360 },
      });
    }
    if (method === 'GET' && url.pathname === '/blocks/lastHeaders/10') return reply(L_HEADERS);
    return inner(input, init);
  };
}

/** Pools and their vaults on the stand-in node, by token id. */
export function putPools(state: NodeState, pairs: Array<[ErgoBox, ErgoBox | ErgoBox[]]>): void {
  for (const [pool, vault] of pairs) {
    state.pools.set(pool.assets[0].tokenId, [pool]);
    const vaults = Array.isArray(vault) ? vault : [vault];
    if (vaults.length > 0) state.pools.set(vaults[0].assets[0].tokenId, vaults);
  }
}

/** A connector on the stand-in node with the LithosDex venue. */
export function makeLithosDex(
  state: NodeState,
  config: ErgodexNetworkConfig = lithosDexConfig([LIT_NFT, LIT_RSN_NFT]),
): Ergodex {
  const ergo = new Ergo('mainnet', { config: testConfig(), fetch: lithosNode(state) });
  jest.spyOn(ergo, 'getTokenList').mockResolvedValue(L_TOKENS);
  jest.spyOn(ergo, 'getWallet').mockResolvedValue({ address: ME, ergoTree: ME_TREE, signer });
  return new Ergodex('mainnet', ergo, config, ROOT);
}

export { RSN };
