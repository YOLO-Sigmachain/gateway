/**
 * Ergo wallets. The keystore field is called `privateKey` upstream, but an Ergo wallet is a
 * BIP-39 mnemonic. It is validated as one, the address is derived from it for the network's
 * prefix, and on every unlock the derived address must equal the address the file is
 * stored under: a wrong key file or a corrupted one is refused, not signed with.
 *
 * No message, log line or error here contains any part of a mnemonic.
 */
import { utils as ethersUtils } from 'ethers';
import { FastifyInstance } from 'fastify';
import fse from 'fs-extra';

import { updateDefaultWallet } from '../../config/utils';
import { ConfigManagerCertPassphrase } from '../../services/config-manager-cert-passphrase';
import { logger } from '../../services/logger';
import { decryptSecret, encryptSecret } from '../../services/secure-keystore';
import { AddWalletRequest, AddWalletResponse } from '../../wallet/schemas';
import { getSafeWalletFilePath, mkdirIfDoesNotExist, sanitizePathComponent, walletPath } from '../../wallet/utils';

import { assertErgoConfigFileUnchanged, getErgoChainConfig, getErgoNetworkConfig } from './ergo.config';
import { derivePublicKey, ErgoSigner, WasmErgoSigner } from './ergo.signer';
import { addressFromPublicKey, decodeErgoAddressForPrefix } from './ergo.utils';

const WORD_COUNTS = new Set([12, 15, 18, 21, 24]);

/** The one message for a secret that is not a usable mnemonic. Names nothing from it. */
export const INVALID_MNEMONIC_MESSAGE =
  'The secret is not a valid BIP-39 mnemonic (12, 15, 18, 21 or 24 English words with a valid checksum)';

/**
 * The canonical phrase (lower-case words, single spaces), which is what every BIP-39 wallet
 * derives the seed from; throws INVALID_MNEMONIC_MESSAGE when it is not BIP-39. Validation
 * ignores case, so the phrase as typed must not reach the seed: 'Abandon ...' would derive
 * a different key from the one Nautilus or the node gives for the same words.
 */
export function normalizeMnemonic(secret: unknown): string {
  if (typeof secret !== 'string') {
    throw new Error(INVALID_MNEMONIC_MESSAGE);
  }
  const words = secret.trim().split(/\s+/);
  const phrase = words.join(' ');
  if (!WORD_COUNTS.has(words.length) || !ethersUtils.isValidMnemonic(phrase)) {
    throw new Error(INVALID_MNEMONIC_MESSAGE);
  }
  return ethersUtils.entropyToMnemonic(ethersUtils.mnemonicToEntropy(phrase));
}

/** The P2PK address of m/44'/429'/0'/0/0 for a network prefix. */
export function deriveErgoAddress(mnemonic: string, addressPrefix: number): string {
  return addressFromPublicKey(derivePublicKey(normalizeMnemonic(mnemonic)), addressPrefix);
}

export interface ErgoWalletAccount {
  address: string;
  ergoTree: string;
  signer: ErgoSigner;
}

/**
 * Unlock a stored wallet for a network. Refuses an address of another network, a file
 * that does not decrypt, a secret that is not a mnemonic, and a mnemonic that does not
 * derive the address.
 */
export async function loadErgoWallet(address: string, addressPrefix: number): Promise<ErgoWalletAccount> {
  const decoded = decodeErgoAddressForPrefix(address, addressPrefix);
  const filePath = getSafeWalletFilePath('ergo', address);

  let encrypted: string;
  try {
    encrypted = await fse.readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`Wallet not found for address: ${address}`);
    }
    throw new Error(`Could not read the wallet file for ${address}`);
  }

  const walletKey = ConfigManagerCertPassphrase.readWalletKey();
  if (!walletKey) {
    throw new Error('missing wallet encryption key');
  }

  let secret: string;
  try {
    secret = decryptSecret(encrypted, walletKey);
  } catch {
    throw new Error(`The wallet file for ${address} does not decrypt with the configured key`);
  }

  let mnemonic: string;
  try {
    mnemonic = normalizeMnemonic(secret);
  } catch {
    throw new Error(`The wallet file for ${address} does not hold a valid mnemonic`);
  }

  const derived = addressFromPublicKey(derivePublicKey(mnemonic), addressPrefix);
  if (derived !== address) {
    throw new Error(`The wallet file for ${address} holds a key for a different address; refusing to use it`);
  }

  return { address, ergoTree: decoded.ergoTree, signer: WasmErgoSigner.fromMnemonic(mnemonic) };
}

/**
 * POST /wallet/add for chain `ergo`. The address is derived for the chain's default
 * network: an Ergo address carries its network prefix, so the same mnemonic has a
 * different address on each network.
 */
export async function addErgoWallet(
  fastify: FastifyInstance,
  req: AddWalletRequest,
  walletKey: string,
): Promise<AddWalletResponse> {
  let mnemonic: string;
  try {
    mnemonic = normalizeMnemonic(req.privateKey);
  } catch {
    throw fastify.httpErrors.badRequest(INVALID_MNEMONIC_MESSAGE);
  }

  const network = getErgoChainConfig().defaultNetwork;
  let address: string;
  try {
    address = addressFromPublicKey(derivePublicKey(mnemonic), getErgoNetworkConfig(network).addressPrefix);
  } catch (error) {
    // Config errors name keys, not secrets; derivation errors are reported without detail.
    logger.error(`Ergo wallet add: could not derive an address for network ${network}`);
    throw fastify.httpErrors.badRequest(`Unable to derive an Ergo address for network ${network}`);
  }

  if (req.setDefault) {
    assertErgoConfigFileUnchanged('ergo');
  }

  const encrypted = encryptSecret(mnemonic, walletKey);
  const dir = `${walletPath}/${sanitizePathComponent('ergo')}`;
  await mkdirIfDoesNotExist(dir);
  const filePath = getSafeWalletFilePath('ergo', address);
  await fse.writeFile(filePath, encrypted, { mode: 0o600 });
  await fse.chmod(filePath, 0o600);

  if (req.setDefault) {
    updateDefaultWallet(fastify, 'ergo', address);
  }
  logger.info(`Added Ergo wallet ${address} (network ${network})`);
  return { address };
}
