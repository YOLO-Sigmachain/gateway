/**
 * Mnemonic validation, key derivation for prefixes 0, 16 and 32, and the refusal of a key
 * file whose mnemonic does not derive its address. Real ergo-lib-wasm and real fleet-sdk.
 */
import { DerivationPath, ExtSecretKey, Mnemonic, SecretKey } from 'ergo-lib-wasm-nodejs';
import { utils as ethersUtils } from 'ethers';

jest.mock('fs-extra', () => require('./wallet-fs-mock').createFsExtraMock());
jest.mock('../../../src/services/config-manager-cert-passphrase', () => ({
  ConfigManagerCertPassphrase: {
    readWalletKey: () => 'test-wallet-key-not-a-secret',
    readPassphrase: () => 'test-wallet-key-not-a-secret',
  },
}));

const WALLET_KEY = 'test-wallet-key-not-a-secret';

import { WasmErgoSigner, derivePublicKey } from '../../../src/chains/ergo/ergo.signer';
import { addressFromPublicKey, decodeErgoAddress } from '../../../src/chains/ergo/ergo.utils';
import {
  deriveErgoAddress,
  INVALID_MNEMONIC_MESSAGE,
  loadErgoWallet,
  normalizeMnemonic,
} from '../../../src/chains/ergo/ergo.wallet';
import { encryptSecret } from '../../../src/services/secure-keystore';

import { GENERATOR_ADDRESSES, GENERATOR_PK, MNEMONIC_A, MNEMONIC_B } from './ergo-test-helpers';
import { walletFiles as files } from './wallet-fs-mock';

const walletFile = (address: string) => `conf/wallets/ergo/${address}.json`;

/** No error may carry any word of the mnemonic it was about. */
function expectNoSecretIn(text: string, mnemonic: string) {
  for (const word of new Set(mnemonic.split(' '))) {
    expect(text.toLowerCase()).not.toContain(word);
  }
}

describe('mnemonic validation', () => {
  it('accepts BIP-39 test vectors and normalizes whitespace', () => {
    expect(normalizeMnemonic(MNEMONIC_A)).toBe(MNEMONIC_A);
    expect(normalizeMnemonic(`  ${MNEMONIC_B.split(' ').join('   \n ')}  `)).toBe(MNEMONIC_B);
  });

  it.each([
    ['bad checksum', 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon'],
    ['wrong word count', 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'],
    ['not a word', 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon zzzzz'],
    ['hex private key', 'a'.repeat(64)],
    ['empty', ''],
  ])('refuses %s, naming none of it', (_label, secret) => {
    let message = '';
    try {
      normalizeMnemonic(secret);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toBe(INVALID_MNEMONIC_MESSAGE);
    expectNoSecretIn(message, secret || 'x');
  });
});

describe('address derivation', () => {
  it("matches an independent BIP-32 derivation (ethers) of m/44'/429'/0'/0/0", () => {
    const fromWasm = derivePublicKey(MNEMONIC_A);
    const fromEthers = ethersUtils.HDNode.fromMnemonic(MNEMONIC_A).derivePath("m/44'/429'/0'/0/0").publicKey;
    expect(`0x${fromWasm}`).toBe(fromEthers);
  });

  it.each([0, 16])('fleet encoding of the derived key equals ergo-lib encoding for prefix %p', (prefix) => {
    expect(WasmErgoSigner.fromMnemonic(MNEMONIC_B).publicKeys[0]).toBe(derivePublicKey(MNEMONIC_B));
    // ergo-lib's own derivation and encoding, for the two prefixes it knows
    const child = ExtSecretKey.derive_master(Mnemonic.to_seed(MNEMONIC_B, '')).derive(
      DerivationPath.new(0, new Uint32Array([0])),
    );
    const libAddress = SecretKey.dlog_from_bytes(child.secret_key_bytes()).get_address().to_base58(prefix);
    expect(deriveErgoAddress(MNEMONIC_B, prefix)).toBe(libAddress);
  });

  it.each([0, 16, 32])('derives the published address of the generator key for prefix %p', (prefix) => {
    const secretOne = new Uint8Array(32);
    secretOne[31] = 1;
    const signer = WasmErgoSigner.fromSecretKeyBytes(secretOne);
    expect(signer.publicKeys[0]).toBe(GENERATOR_PK);
    const address = addressFromPublicKey(signer.publicKeys[0], prefix);
    expect(address).toBe(GENERATOR_ADDRESSES[prefix]);
    expect(decodeErgoAddress(address).prefix).toBe(prefix);
  });

  it('one mnemonic gives a different address on each prefix, all for the same key', () => {
    const a0 = deriveErgoAddress(MNEMONIC_A, 0);
    const a16 = deriveErgoAddress(MNEMONIC_A, 16);
    const a32 = deriveErgoAddress(MNEMONIC_A, 32);
    expect(new Set([a0, a16, a32]).size).toBe(3);
    expect(a0.startsWith('9')).toBe(true);
    expect(a16.startsWith('3')).toBe(true);
    expect(a32.startsWith('5')).toBe(true);
    const trees = [a0, a16, a32].map((a) => decodeErgoAddress(a).ergoTree);
    expect(new Set(trees).size).toBe(1);
  });
});

describe('loadErgoWallet', () => {
  beforeEach(() => files.clear());

  it('unlocks a file whose mnemonic derives its address', async () => {
    const address = deriveErgoAddress(MNEMONIC_A, 0);
    files.set(walletFile(address), encryptSecret(MNEMONIC_A, WALLET_KEY));
    const account = await loadErgoWallet(address, 0);
    expect(account.address).toBe(address);
    expect(account.signer.publicKeys[0]).toBe(derivePublicKey(MNEMONIC_A));
  });

  it('refuses a file holding the key of another address, without naming the secret', async () => {
    const address = deriveErgoAddress(MNEMONIC_A, 0);
    files.set(walletFile(address), encryptSecret(MNEMONIC_B, WALLET_KEY));
    const error = await loadErgoWallet(address, 0).then(
      () => new Error('expected a refusal'),
      (e: Error) => e,
    );
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain('holds a key for a different address');
    expectNoSecretIn(error.message, MNEMONIC_B);
  });

  it('refuses a file whose secret is not a mnemonic', async () => {
    const address = deriveErgoAddress(MNEMONIC_A, 0);
    const notMnemonic = 'deadbeef'.repeat(8);
    files.set(walletFile(address), encryptSecret(notMnemonic, WALLET_KEY));
    const error = await loadErgoWallet(address, 0).then(
      () => new Error('expected a refusal'),
      (e: Error) => e,
    );
    expect(error.message).toContain('does not hold a valid mnemonic');
    expect(error.message).not.toContain('deadbeef');
  });

  it('refuses a file encrypted under another key', async () => {
    const address = deriveErgoAddress(MNEMONIC_A, 0);
    files.set(walletFile(address), encryptSecret(MNEMONIC_A, 'some-other-key'));
    const error = await loadErgoWallet(address, 0).then(
      () => new Error('expected a refusal'),
      (e: Error) => e,
    );
    expect(error.message).toContain('does not decrypt');
    expectNoSecretIn(error.message, MNEMONIC_A);
  });

  it('refuses an address of another network before reading any file', async () => {
    const testnetAddress = deriveErgoAddress(MNEMONIC_A, 16);
    await expect(loadErgoWallet(testnetAddress, 0)).rejects.toThrow('network prefix 16');
  });

  it('reports a missing wallet', async () => {
    await expect(loadErgoWallet(deriveErgoAddress(MNEMONIC_B, 0), 0)).rejects.toThrow('Wallet not found');
  });
});
