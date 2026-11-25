/**
 * A plain transfer of ERG and tokens: the first user of the shared builder. Upstream has no
 * transfer route, so this stays an internal function (see Ergo.transfer).
 */
import { BuiltErgoTransaction, buildUnsignedTransaction, ErgoBuildError, minBoxValue } from './ergo.tx-builder';
import { ErgoBox, ErgoTokenAmount } from './ergo.types';

export interface ErgoTransferParams {
  height: number;
  minValuePerByte: bigint;
  fee: bigint;
  feeErgoTree: string;
  /** The sender's tree: change goes back here. */
  fromErgoTree: string;
  toErgoTree: string;
  /** ERG to send. Omit (or 0n) when sending only tokens: the box then carries its minimum. */
  nanoErgs?: bigint;
  tokens?: ErgoTokenAmount[];
  walletBoxes: ErgoBox[];
  excludeBoxIds?: Iterable<string>;
}

export function buildTransfer(params: ErgoTransferParams): BuiltErgoTransaction {
  const tokens = params.tokens ?? [];
  let value = params.nanoErgs ?? 0n;
  if (value < 0n) throw new ErgoBuildError('nanoErgs cannot be negative');
  if (value === 0n) {
    if (tokens.length === 0) throw new ErgoBuildError('a transfer must send ERG or tokens');
    value = minBoxValue(
      {
        ergoTree: params.toErgoTree,
        value: 1n,
        assets: tokens,
        additionalRegisters: {},
        creationHeight: params.height,
      },
      params.minValuePerByte,
    );
    // the minimum depends on the value's own encoded size; settle on a value that meets it
    value = minBoxValue(
      { ergoTree: params.toErgoTree, value, assets: tokens, additionalRegisters: {}, creationHeight: params.height },
      params.minValuePerByte,
    );
  }
  return buildUnsignedTransaction({
    height: params.height,
    minValuePerByte: params.minValuePerByte,
    fee: params.fee,
    feeErgoTree: params.feeErgoTree,
    changeErgoTree: params.fromErgoTree,
    outputs: [{ ergoTree: params.toErgoTree, value, assets: tokens }],
    walletBoxes: params.walletBoxes,
    excludeBoxIds: params.excludeBoxIds,
  });
}
