/**
 * The second signer: the same signing flow as `WasmErgoSigner`, on
 * ergo-lib-wasm-nodejs 0.29.0-alpha-2f840d3 (installed under the alias
 * `ergo-lib-wasm-nodejs-alpha`, beside 0.28.0). That build is an unreleased alpha of the
 * signing library. It is used only for a transaction that spends or reads a box at an
 * ErgoTree of version 3, which 0.28.0 cannot parse; the chain layer makes that choice.
 *
 * This module is loaded only on that first need (`WasmErgoSigner.forTreeVersion3`); its
 * wasm (about 17 MB) is never loaded by a gateway that signs nothing of version 3.
 *
 * Its signing evaluates every input script: one that reduces to false is refused here
 * ("Script reduced to false"), so a transaction a contract rejects is never signed.
 * Nothing here logs, returns or puts into an error any part of a key.
 */
import {
  BlockHeader,
  BlockHeaders,
  ErgoBoxes,
  ErgoStateContext,
  Parameters,
  PreHeader,
  SecretKey,
  SecretKeys,
  UnsignedTransaction,
  Wallet,
} from 'ergo-lib-wasm-nodejs-alpha';

import { parseNodeJson } from './ergo.json';
import {
  DISPOSED_SIGNER_MESSAGE,
  ErgoSigner,
  ErgoSigningContext,
  ErgoSigningError,
  headersNewestFirst,
  SignedErgoTransaction,
} from './ergo.signer';
import { Eip12DataInput, Eip12UnsignedInput, Eip12UnsignedTransaction } from './ergo.types';

export class AlphaErgoSigner implements ErgoSigner {
  readonly publicKeys: readonly string[];
  #wallet: Wallet;
  #disposed = false;

  private constructor(wallet: Wallet, publicKeys: string[]) {
    this.#wallet = wallet;
    this.publicKeys = Object.freeze([...publicKeys]);
  }

  /**
   * A signer for a raw 32-byte secret key. The public key it reports is always the one
   * this library derives from the secret. When `publicKey` is given (the key the caller
   * expects), a different derived key is refused.
   */
  static fromSecretKeyBytes(secret: Uint8Array, publicKey?: string): AlphaErgoSigner {
    const key = SecretKey.dlog_from_bytes(secret);
    const keys = new SecretKeys();
    // P2PK tree is 0008cd + compressed key
    const address = key.get_address();
    const derived = Buffer.from(address.to_bytes(0)).toString('hex').slice(2, 68);
    address.free();
    if (publicKey !== undefined && derived !== publicKey.toLowerCase()) {
      keys.free();
      key.free();
      throw new ErgoSigningError('the version-3 signing library derives another public key from this key');
    }
    keys.add(key);
    const wallet = Wallet.from_secrets(keys);
    keys.free();
    key.free();
    return new AlphaErgoSigner(wallet, [derived]);
  }

  async forTreeVersion3(): Promise<ErgoSigner> {
    if (this.#disposed) throw new ErgoSigningError(DISPOSED_SIGNER_MESSAGE);
    return this;
  }

  /** Free the wallet holding the key. Signing afterwards throws. Safe to call more than once. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#wallet.free();
  }

  async signTransaction(
    unsigned: Eip12UnsignedTransaction,
    inputBoxes: Eip12UnsignedInput[],
    dataInputBoxes: Eip12DataInput[],
    context: ErgoSigningContext,
  ): Promise<SignedErgoTransaction> {
    if (this.#disposed) throw new ErgoSigningError(DISPOSED_SIGNER_MESSAGE);
    const headers = headersNewestFirst(context.headers);
    const toFree: Array<{ free(): void }> = [];
    try {
      const blockHeaders = BlockHeaders.from_json(headers);
      // As in WasmErgoSigner: the pre-header is the upcoming block (HEIGHT = tip + 1).
      const tip = headers[0];
      const upcoming = BlockHeader.from_json(
        JSON.stringify({
          ...tip,
          height: tip.height + 1,
          parentId: tip.id,
          timestamp: Math.max(Date.now(), Number(tip.timestamp) + 1),
        }),
      );
      const preHeader = PreHeader.from_block_header(upcoming);
      // Genesis default parameters, as with 0.28.0; signing does not consult the block cost limit.
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
      // A refused script comes with the whole decompiled contract; the first part says why.
      throw new ErgoSigningError(`Signing failed: ${message.length > 400 ? message.slice(0, 400) + '...' : message}`);
    } finally {
      for (const item of toFree.reverse()) item.free();
    }
  }
}
