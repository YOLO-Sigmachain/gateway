/**
 * /wallet/add, /wallet/setDefault and /wallet/remove for chain `ergo`, through Fastify
 * inject, with the real Ergo key derivation and the real keystore. Wallet files are kept
 * in memory (no write into conf/wallets).
 */
import sensible from '@fastify/sensible';
import { FastifyInstance } from 'fastify';

jest.mock('fs-extra', () => require('../wallet-fs-mock').createFsExtraMock());
jest.mock('../../../../src/services/config-manager-cert-passphrase', () => ({
  ConfigManagerCertPassphrase: {
    readWalletKey: () => 'test-wallet-key-not-a-secret',
    readPassphrase: () => 'test-wallet-key-not-a-secret',
  },
}));

jest.mock('../../../../src/services/config-manager-v2', () => ({
  ConfigManagerV2: require('../../../mocks/shared-mocks').mockConfigManagerV2,
}));

import { deriveErgoAddress } from '../../../../src/chains/ergo/ergo.wallet';
import { addWalletRoute } from '../../../../src/wallet/routes/addWallet';
import { removeWalletRoute } from '../../../../src/wallet/routes/removeWallet';
import { setDefaultRoute } from '../../../../src/wallet/routes/setDefault';
import { mockConfigStorage } from '../../../mocks/shared-mocks';
import { fastifyWithTypeProvider } from '../../../utils/testUtils';
import { FEE_TREE, MNEMONIC_A, MNEMONIC_B } from '../ergo-test-helpers';
import { walletFiles } from '../wallet-fs-mock';

const network = (prefix: number) => ({
  nodeURL: 'http://node.test',
  addressPrefix: prefix,
  nativeCurrencySymbol: 'ERG',
  nativeDecimals: 9,
  minerFee: 1100000,
  minerFeeErgoTree: FEE_TREE,
  tokenListSource: 'tokens/ergo/x.json',
  blockTimeSeconds: 120,
  pendingTxTimeoutBlocks: 15,
  confirmations: 1,
});

function setErgoConfig(defaultNetwork: string) {
  mockConfigStorage['ergo.defaultNetwork'] = defaultNetwork;
  mockConfigStorage['ergo.defaultWallet'] = '<ergo-wallet-address>';
  for (const [name, prefix] of [
    ['mainnet', 0],
    ['testnet', 16],
  ] as const) {
    for (const [k, v] of Object.entries(network(prefix))) mockConfigStorage[`ergo-${name}.${k}`] = v;
  }
}

describe('Ergo wallet routes', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    walletFiles.clear();
    setErgoConfig('mainnet');
    app = fastifyWithTypeProvider();
    await app.register(sensible);
    await app.register(addWalletRoute);
    await app.register(removeWalletRoute);
    await app.register(setDefaultRoute);
  });

  afterEach(async () => {
    await app.close();
  });

  it('adds a wallet from a mnemonic, for the default network prefix, and stores it encrypted', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/add',
      payload: { chain: 'ergo', privateKey: MNEMONIC_A, setDefault: true },
    });
    expect(res.statusCode).toBe(200);
    const { address } = JSON.parse(res.body);
    expect(address).toBe(deriveErgoAddress(MNEMONIC_A, 0));
    const stored = walletFiles.get(`conf/wallets/ergo/${address}.json`)!;
    expect(stored).toBeDefined();
    for (const word of new Set(MNEMONIC_A.split(' '))) expect(stored).not.toContain(word);
    expect(JSON.parse(stored).cipher).toBe('aes-256-gcm');
    expect(mockConfigStorage['ergo.defaultWallet']).toBe(address);
  });

  it('derives for the testnet prefix when testnet is the default network', async () => {
    setErgoConfig('testnet');
    const res = await app.inject({ method: 'POST', url: '/add', payload: { chain: 'ergo', privateKey: MNEMONIC_B } });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).address).toBe(deriveErgoAddress(MNEMONIC_B, 16));
  });

  it('refuses a secret that is not a mnemonic, and never echoes it (D18)', async () => {
    const notMnemonic =
      'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon';
    const res = await app.inject({ method: 'POST', url: '/add', payload: { chain: 'ergo', privateKey: notMnemonic } });
    expect(res.statusCode).toBe(400);
    expect(res.body).not.toContain('abandon');
    expect(res.body).not.toContain('aband');
    expect(walletFiles.size).toBe(0);
  });

  it('refuses a hex private key for ergo without echoing its first characters', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/add',
      payload: { chain: 'ergo', privateKey: 'deadbeefcafe'.repeat(5) },
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).not.toContain('deadb');
  });

  it('sets an added wallet as default, and 404s one never added', async () => {
    const added = JSON.parse(
      (await app.inject({ method: 'POST', url: '/add', payload: { chain: 'ergo', privateKey: MNEMONIC_A } })).body,
    ).address;
    let res = await app.inject({ method: 'POST', url: '/setDefault', payload: { chain: 'ergo', address: added } });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ chain: 'ergo', address: added });
    res = await app.inject({
      method: 'POST',
      url: '/setDefault',
      payload: { chain: 'ergo', address: deriveErgoAddress(MNEMONIC_B, 0) },
    });
    expect(res.statusCode).toBe(404);
  });

  it('refuses a malformed address for setDefault with 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/setDefault',
      payload: { chain: 'ergo', address: 'not-an-address' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('removes a wallet, and clears the default when it was the default', async () => {
    const added = JSON.parse(
      (
        await app.inject({
          method: 'POST',
          url: '/add',
          payload: { chain: 'ergo', privateKey: MNEMONIC_A, setDefault: true },
        })
      ).body,
    ).address;
    const res = await app.inject({ method: 'DELETE', url: '/remove', payload: { chain: 'ergo', address: added } });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).message).toContain(added);
    expect(walletFiles.has(`conf/wallets/ergo/${added}.json`)).toBe(false);
    expect(mockConfigStorage['ergo.defaultWallet']).toBe('');
  });

  it('refuses to remove an address no configured Ergo network uses', async () => {
    const yolo = deriveErgoAddress(MNEMONIC_A, 32);
    const res = await app.inject({ method: 'DELETE', url: '/remove', payload: { chain: 'ergo', address: yolo } });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).message).toContain('no configured Ergo network uses');
  });
});
