/**
 * Wallet default-address mutations on Ergo (updateDefaultWallet, POST /setDefault,
 * addErgoWallet with setDefault, removeWallet and DELETE /remove for hardware wallets)
 * must enforce assertErgoConfigFileUnchanged('ergo') before mutating conf/chains/ergo.yml
 * or touching wallet files, and must propagate HTTP 409 instead of wrapping it into 500.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

jest.mock('fs-extra', () => require('./wallet-fs-mock').createFsExtraMock());

import sensible from '@fastify/sensible';
import { FastifyInstance } from 'fastify';

import * as ergoConfig from '../../../src/chains/ergo/ergo.config';
import { derivePublicKey } from '../../../src/chains/ergo/ergo.signer';
import { addressFromPublicKey } from '../../../src/chains/ergo/ergo.utils';
import { addErgoWallet } from '../../../src/chains/ergo/ergo.wallet';
import { updateDefaultWallet } from '../../../src/config/utils';
import { ConfigManagerV2 } from '../../../src/services/config-manager-v2';
import { httpErrors } from '../../../src/services/error-handler';
import { logger } from '../../../src/services/logger';
import { removeWalletRoute } from '../../../src/wallet/routes/removeWallet';
import { setDefaultRoute } from '../../../src/wallet/routes/setDefault';
import { removeWallet, saveHardwareWallets } from '../../../src/wallet/utils';
import { fastifyWithTypeProvider } from '../../utils/testUtils';

import { GENERATOR_ADDRESSES, MNEMONIC_A } from './ergo-test-helpers';
import { walletFiles } from './wallet-fs-mock';

const TEMPLATES = path.join(__dirname, '../../../src/templates');
const CHAIN_SCHEMA = path.join(TEMPLATES, 'namespace/ergo-chain-schema.json');
const CHAIN_TEMPLATE = path.join(TEMPLATES, 'chains/ergo.yml');
const NETWORK_SCHEMA = path.join(TEMPLATES, 'namespace/ergo-network-schema.json');
const NETWORK_TEMPLATE = path.join(TEMPLATES, 'chains/ergo/mainnet.yml');

const ADDR_A = addressFromPublicKey(derivePublicKey(MNEMONIC_A), 0);
const ADDR_B = GENERATOR_ADDRESSES[0];
const WALLET_A_PATH = `conf/wallets/ergo/${ADDR_A}.json`;
const WALLET_B_PATH = `conf/wallets/ergo/${ADDR_B}.json`;
const HARDWARE_PATH = 'conf/wallets/ergo/hardware-wallets.json';
const CIPHER_FIXTURE = 'ergo-config-guard-test-fixture';

const fakeFastify = { httpErrors } as unknown as FastifyInstance;

let dir: string;
let chainFile: string;
let networkFile: string;

function loadConfig(defaultWallet = ADDR_A): ConfigManagerV2 {
  fs.writeFileSync(path.join(dir, 'root.yml'), 'version: 1\nconfigurations: {}\n');
  const chainText = fs
    .readFileSync(CHAIN_TEMPLATE, 'utf8')
    .replace(/^defaultWallet:.*$/m, `defaultWallet: ${defaultWallet}`);
  fs.writeFileSync(chainFile, chainText);
  const networkText = `${fs.readFileSync(NETWORK_TEMPLATE, 'utf8').replace(/^submitMode:.*$/m, '')}\nsubmitMode: send\n`;
  fs.writeFileSync(networkFile, networkText);

  const manager = new ConfigManagerV2(path.join(dir, 'root.yml'));
  manager.addNamespace('ergo', CHAIN_SCHEMA, chainFile, CHAIN_TEMPLATE);
  manager.addNamespace('ergo-mainnet', NETWORK_SCHEMA, networkFile, NETWORK_TEMPLATE);
  jest.spyOn(ConfigManagerV2, 'getInstance').mockReturnValue(manager);
  return manager;
}

function handEditChainFile(transform?: (text: string) => string): string {
  const original = fs.readFileSync(chainFile, 'utf8');
  const edited = transform
    ? transform(original)
    : original.replace(/^defaultNetwork: mainnet$/m, 'defaultNetwork: testnet');
  fs.writeFileSync(chainFile, edited);
  return edited;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ergo-wallet-config-guard-'));
  chainFile = path.join(dir, 'ergo.yml');
  networkFile = path.join(dir, 'mainnet.yml');
  walletFiles.clear();
  jest.spyOn(logger, 'info').mockImplementation(() => logger);
  jest.spyOn(logger, 'warn').mockImplementation(() => logger);
  jest.spyOn(logger, 'error').mockImplementation(() => logger);
});

afterEach(() => {
  jest.restoreAllMocks();
  walletFiles.clear();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('Ergo config file guard on wallet default mutations', () => {
  it('updateDefaultWallet refuses with 409 when conf/chains/ergo.yml was hand-edited and preserves the file', () => {
    const manager = loadConfig(ADDR_A);
    const edited = handEditChainFile((text) => `${text}\nsubmitMode: check\n`);

    let caught: (Error & { statusCode?: number }) | undefined;
    try {
      updateDefaultWallet(fakeFastify, 'ergo', ADDR_B);
    } catch (error) {
      caught = error as Error & { statusCode?: number };
    }

    expect(caught?.statusCode).toBe(409);
    expect(fs.readFileSync(chainFile, 'utf8')).toBe(edited);
    expect(manager.get('ergo.defaultWallet')).toBe(ADDR_A);
  });

  it('updateDefaultWallet skips the Ergo guard for non-Ergo chains', () => {
    const check = jest.spyOn(ergoConfig, 'assertErgoConfigFileUnchanged');
    const manager = loadConfig(ADDR_A);
    const solTemplate = path.join(TEMPLATES, 'chains/solana.yml');
    const solSchema = path.join(TEMPLATES, 'namespace/solana-chain-schema.json');
    const solFile = path.join(dir, 'solana.yml');
    fs.writeFileSync(solFile, fs.readFileSync(solTemplate, 'utf8'));
    manager.addNamespace('solana', solSchema, solFile, solTemplate);
    fs.appendFileSync(solFile, '\n# hand edit\n');

    updateDefaultWallet(fakeFastify, 'solana', 'HN7cABqLq46Es1jh92dQQisAq662SmxELLLsHHe4YWrH');
    expect(check).not.toHaveBeenCalled();
  });

  it('POST /setDefault returns HTTP 409 (not 500) when conf/chains/ergo.yml was hand-edited', async () => {
    const manager = loadConfig(ADDR_A);
    walletFiles.set(WALLET_B_PATH, '{}');
    const edited = handEditChainFile();

    const app = fastifyWithTypeProvider();
    await app.register(sensible);
    await app.register(setDefaultRoute);
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/setDefault',
        body: { chain: 'ergo', address: ADDR_B },
      });

      expect(response.statusCode).toBe(409);
      expect(fs.readFileSync(chainFile, 'utf8')).toBe(edited);
      expect(manager.get('ergo.defaultWallet')).toBe(ADDR_A);
    } finally {
      await app.close();
    }
  });

  it('POST /setDefault succeeds with HTTP 200 when conf/chains/ergo.yml is unchanged', async () => {
    const manager = loadConfig(ADDR_A);
    walletFiles.set(WALLET_B_PATH, '{}');

    const app = fastifyWithTypeProvider();
    await app.register(sensible);
    await app.register(setDefaultRoute);
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/setDefault',
        body: { chain: 'ergo', address: ADDR_B },
      });

      expect(response.statusCode).toBe(200);
      expect(manager.get('ergo.defaultWallet')).toBe(ADDR_B);
    } finally {
      await app.close();
    }
  });

  it('addErgoWallet with setDefault refuses with 409 before writing any wallet file', async () => {
    const manager = loadConfig(ADDR_B);
    const edited = handEditChainFile();

    let caught: (Error & { statusCode?: number }) | undefined;
    try {
      await addErgoWallet(fakeFastify, { chain: 'ergo', privateKey: MNEMONIC_A, setDefault: true }, CIPHER_FIXTURE);
    } catch (error) {
      caught = error as Error & { statusCode?: number };
    }

    expect(caught?.statusCode).toBe(409);
    expect(walletFiles.has(WALLET_A_PATH)).toBe(false);
    expect(fs.readFileSync(chainFile, 'utf8')).toBe(edited);
    expect(manager.get('ergo.defaultWallet')).toBe(ADDR_B);
  });

  it('addErgoWallet without setDefault succeeds without modifying a hand-edited ergo.yml', async () => {
    loadConfig(ADDR_B);
    const edited = handEditChainFile();

    const res = await addErgoWallet(
      fakeFastify,
      { chain: 'ergo', privateKey: MNEMONIC_A, setDefault: false },
      CIPHER_FIXTURE,
    );

    expect(res.address).toBe(ADDR_A);
    expect(walletFiles.has(WALLET_A_PATH)).toBe(true);
    expect(fs.readFileSync(chainFile, 'utf8')).toBe(edited);
  });

  it('removeWallet refuses with 409 before deleting the default Ergo keystore when ergo.yml was hand-edited', async () => {
    const manager = loadConfig(ADDR_A);
    walletFiles.set(WALLET_A_PATH, '{"encrypted":true}');
    walletFiles.set(WALLET_B_PATH, '{"encrypted":true}');
    const edited = handEditChainFile();

    let caught: (Error & { statusCode?: number }) | undefined;
    try {
      await removeWallet(fakeFastify, { chain: 'ergo', address: ADDR_A });
    } catch (error) {
      caught = error as Error & { statusCode?: number };
    }

    expect(caught?.statusCode).toBe(409);
    expect(walletFiles.has(WALLET_A_PATH)).toBe(true);
    expect(fs.readFileSync(chainFile, 'utf8')).toBe(edited);
    expect(manager.get('ergo.defaultWallet')).toBe(ADDR_A);
  });

  it('removeWallet still removes a non-default Ergo wallet without modifying a hand-edited ergo.yml', async () => {
    const manager = loadConfig(ADDR_A);
    walletFiles.set(WALLET_A_PATH, '{"encrypted":true}');
    walletFiles.set(WALLET_B_PATH, '{"encrypted":true}');
    const edited = handEditChainFile();

    await removeWallet(fakeFastify, { chain: 'ergo', address: ADDR_B });

    expect(walletFiles.has(WALLET_B_PATH)).toBe(false);
    expect(walletFiles.has(WALLET_A_PATH)).toBe(true);
    expect(fs.readFileSync(chainFile, 'utf8')).toBe(edited);
    expect(manager.get('ergo.defaultWallet')).toBe(ADDR_A);
  });

  it('DELETE /remove returns 409 before deleting a default Ergo hardware wallet when ergo.yml was hand-edited', async () => {
    const manager = loadConfig(ADDR_A);
    await saveHardwareWallets('ergo', [
      { address: ADDR_A, publicKey: 'pk-a', derivationPath: "m/44'/429'/0'/0/0", addedAt: '2026-01-01T00:00:00Z' },
      { address: ADDR_B, publicKey: 'pk-b', derivationPath: "m/44'/429'/0'/0/1", addedAt: '2026-01-01T00:00:00Z' },
    ]);
    const edited = handEditChainFile();

    const app = fastifyWithTypeProvider();
    await app.register(removeWalletRoute);
    try {
      const response = await app.inject({
        method: 'DELETE',
        url: '/remove',
        body: { chain: 'ergo', address: ADDR_A },
      });

      expect(response.statusCode).toBe(409);
      expect(JSON.parse(walletFiles.get(HARDWARE_PATH) || '{}').wallets).toHaveLength(2);
      expect(fs.readFileSync(chainFile, 'utf8')).toBe(edited);
      expect(manager.get('ergo.defaultWallet')).toBe(ADDR_A);
    } finally {
      await app.close();
    }
  });
});
