/**
 * Signing, behind one small interface so the library can be replaced without touching
 * callers. Today: ergo-lib-wasm-nodejs 0.28.0. A later sigma-rust release is expected to be
 * needed for ErgoTree version 3 inputs (0.28.0 cannot parse those trees).
 *
 * Nothing here logs, returns or puts into an error any part of a mnemonic or key.
 */
import {
  BlockHeader,
  BlockHeaders,
  DerivationPath,
  ErgoBoxes,
  ErgoStateContext,
  ExtSecretKey,
  Mnemonic,
  Parameters,
  PreHeader,
  SecretKey,
  SecretKeys,
  UnsignedTransaction,
  Wallet,
} from 'ergo-lib-wasm-nodejs';

import { parseNodeJson } from './ergo.json';
import { Eip12DataInput, Eip12UnsignedInput, Eip12UnsignedTransaction, NodeHeaderJson } from './ergo.types';

/** What a signer needs beyond the transaction: the chain's recent headers, from the node. */
export interface ErgoSigningContext {
  /** At least 10 recent headers from the same node that gave the height. Any order. */
  headers: NodeHeaderJson[];
}

export interface SignedErgoTransaction {
  id: string;
  /** Node-format JSON as the signer wrote it; submitted byte for byte. */
  json: string;
  /** The same, parsed bigint-safe, for checks. */
  parsed: {
    id: string;
    inputs: Array<{ boxId: string; spendingProof: { proofBytes: string; extension: Record<string, string> } }>;
    dataInputs: Array<{ boxId: string }>;
    outputs: Array<Record<string, unknown>>;
  };
}

export interface ErgoSigner {
  /** Compressed public keys (hex) this signer can prove for. */
  readonly publicKeys: readonly string[];
  signTransaction(
    unsigned: Eip12UnsignedTransaction,
    inputBoxes: Eip12UnsignedInput[],
    dataInputBoxes: Eip12DataInput[],
    context: ErgoSigningContext,
  ): Promise<SignedErgoTransaction>;
}

export class ErgoSigningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ErgoSigningError';
  }
}

const HEADERS_IN_CONTEXT = 10;

/** BIP-32 path m/44'/429'/0'/0/{index}, the first address of the first account. */
function derivationPath(index: number): DerivationPath {
  return DerivationPath.new(0, new Uint32Array([index]));
}

/**
 * Derive the secret key bytes for m/44'/429'/0'/0/index from a mnemonic (BIP-39 seed with
 * an empty mnemonic password). The caller validates the mnemonic first.
 */
function deriveSecret(mnemonic: string, index: number): { secret: Uint8Array; publicKey: string } {
  const seed = Mnemonic.to_seed(mnemonic, '');
  const master = ExtSecretKey.derive_master(seed);
  // derive() takes ownership of the path, so it is not freed here
  const child = master.derive(derivationPath(index));
  try {
    const secret = child.secret_key_bytes();
    const pub = child.public_key();
    const publicKey = Buffer.from(pub.pub_key_bytes()).toString('hex');
    pub.free();
    return { secret, publicKey };
  } finally {
    child.free();
    master.free();
    seed.fill(0);
  }
}

/** The compressed public key (hex) of m/44'/429'/0'/0/index. */
export function derivePublicKey(mnemonic: string, index = 0): string {
  const { secret, publicKey } = deriveSecret(mnemonic, index);
  secret.fill(0);
  return publicKey;
}

function headersNewestFirst(headers: NodeHeaderJson[]): NodeHeaderJson[] {
  const sorted = [...headers].sort((a, b) => b.height - a.height);
  if (sorted.length < HEADERS_IN_CONTEXT) {
    throw new ErgoSigningError(`Signing needs ${HEADERS_IN_CONTEXT} recent headers, got ${sorted.length}`);
  }
  const top = sorted.slice(0, HEADERS_IN_CONTEXT);
  for (let i = 1; i < top.length; i++) {
    if (top[i - 1].height !== top[i].height + 1 || top[i - 1].parentId !== top[i].id) {
      throw new ErgoSigningError('Headers for the signing context are not one contiguous chain');
    }
  }
  return top;
}

/** ergo-lib-wasm 0.28.0 signer holding one key. */
export class WasmErgoSigner implements ErgoSigner {
  readonly publicKeys: readonly string[];
  #wallet: Wallet;

  private constructor(wallet: Wallet, publicKeys: string[]) {
    this.#wallet = wallet;
    this.publicKeys = Object.freeze([...publicKeys]);
  }

  /** A signer for m/44'/429'/0'/0/index of a mnemonic. The caller validates the mnemonic. */
  static fromMnemonic(mnemonic: string, index = 0): WasmErgoSigner {
    const { secret, publicKey } = deriveSecret(mnemonic, index);
    try {
      return WasmErgoSigner.fromSecretKeyBytes(secret, publicKey);
    } finally {
      secret.fill(0);
    }
  }

  /** A signer for a raw 32-byte secret key; for tests and for keys not from a mnemonic. */
  static fromSecretKeyBytes(secret: Uint8Array, publicKey?: string): WasmErgoSigner {
    const key = SecretKey.dlog_from_bytes(secret);
    const keys = new SecretKeys();
    let pk = publicKey;
    if (!pk) {
      // P2PK tree is 0008cd + compressed key
      const address = key.get_address();
      pk = Buffer.from(address.to_bytes(0)).toString('hex').slice(2, 68);
      address.free();
    }
    keys.add(key);
    const wallet = Wallet.from_secrets(keys);
    keys.free();
    key.free();
    return new WasmErgoSigner(wallet, [pk]);
  }

  async signTransaction(
    unsigned: Eip12UnsignedTransaction,
    inputBoxes: Eip12UnsignedInput[],
    dataInputBoxes: Eip12DataInput[],
    context: ErgoSigningContext,
  ): Promise<SignedErgoTransaction> {
    const headers = headersNewestFirst(context.headers);
    // Only objects wasm did not take ownership of are freed here: from_block_header takes
    // its header, and the state context takes the pre-header, headers and parameters.
    const toFree: Array<{ free(): void }> = [];
    try {
      const blockHeaders = BlockHeaders.from_json(headers);
      // The node checks a transaction against the next block (HEIGHT = tip + 1, parent =
      // tip), so the pre-header is that upcoming block, not the tip itself. The real headers
      // stay as CONTEXT.headers. from_json does not check the id of the synthesized header.
      const tip = headers[0];
      const upcoming = BlockHeader.from_json(
        JSON.stringify({
          ...tip,
          height: tip.height + 1,
          parentId: tip.id,
          timestamp: Math.max(Date.now(), Number(tip.timestamp) + 1),
        }),
      );
      const preHeader = PreHeader.from_block_header(upcoming); // takes ownership of the header
      // Parameters: 0.28.0 offers only the genesis defaults, not the node's current ones.
      // These defaults lack maxBlockCost (max_block_cost() panics inside wasm), so they must
      // never be passed to a validation or cost-counting call; signing does not consult it.
      // When a wasm release exposes parameter construction, build them from node /info.parameters.
      const stateContext = new ErgoStateContext(preHeader, blockHeaders, Parameters.default_parameters());
      toFree.push(stateContext);

      const tx = UnsignedTransaction.from_json(JSON.stringify(unsigned));
      toFree.push(tx);
      const boxes = ErgoBoxes.from_boxes_json(inputBoxes);
      toFree.push(boxes);
      const dataBoxes = dataInputBoxes.length > 0 ? ErgoBoxes.from_boxes_json(dataInputBoxes) : ErgoBoxes.empty();
      toFree.push(dataBoxes);

      const signed = this.#wallet.sign_transaction(stateContext, tx, boxes, dataBoxes);
      toFree.push(signed);
      const txId = signed.id();
      toFree.push(txId);
      const json = signed.to_json();
      return { id: txId.to_str(), json, parsed: parseNodeJson(json) };
    } catch (error) {
      if (error instanceof ErgoSigningError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new ErgoSigningError(`Signing failed: ${message}`);
    } finally {
      for (const item of toFree.reverse()) item.free();
    }
  }
}
