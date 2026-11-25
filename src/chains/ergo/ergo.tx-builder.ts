/**
 * Transaction building for every Ergo venue. Pure: no network, no clock. The chain class
 * feeds it a fresh node height, the node's minimum value per byte and the wallet's boxes.
 *
 * What a connector can rely on:
 * - Inputs: the caller's fixed inputs first, in the caller's order (a contract can demand
 *   "the pool is input 0"), each with an optional context extension; then wallet boxes
 *   chosen here to cover the rest.
 * - Data inputs: in the caller's order, read and never spent.
 * - Outputs: the caller's outputs first, in the caller's order, with registers written
 *   exactly as given; then change; then the miner fee box last.
 * - Change: carries every token not otherwise spent and meets the node's minimum box value.
 * - Fee box: ERG only, never a token or register (T-16).
 * - Creation heights: at or above the highest input creation height, from a fresh height.
 * - `assertTransactionBalanced` runs on the finished transaction and refuses one where
 *   tokens or ERG do not balance.
 *
 * Nothing here knows any venue.
 */
import { ErgoBox as FleetErgoBox, ErgoUnsignedInput, ErgoUnsignedTransaction, OutputBuilder } from '@fleet-sdk/core';

import { toAmount } from './ergo.json';
import {
  Eip12BoxCandidate,
  Eip12UnsignedTransaction,
  ErgoBox,
  ErgoContextExtension,
  ErgoRegisters,
  ErgoTokenAmount,
  REGISTER_IDS,
} from './ergo.types';
import { assertErgoId, isHexBytes } from './ergo.utils';

/** Tokens per change box. Well below the 4096-byte box limit at 32 bytes per token id. */
export const MAX_TOKENS_PER_CHANGE_BOX = 64;

export interface ErgoInputSpec {
  box: ErgoBox;
  /** Context variables for this input: id (0..255) to serialized constant hex. */
  extension?: ErgoContextExtension;
}

export interface ErgoOutputSpec {
  ergoTree: string;
  value: bigint;
  assets?: ErgoTokenAmount[];
  /** Serialized constants (hex), written exactly as given; R4 upward with no gap. */
  additionalRegisters?: ErgoRegisters;
  /** Defaults to the build height. Must not be below the highest input creation height. */
  creationHeight?: number;
}

export interface ErgoBuildParams {
  /** Current height, read from the node just before building. */
  height: number;
  /** The node's `minValuePerByte` parameter. */
  minValuePerByte: bigint;
  fee: bigint;
  feeErgoTree: string;
  changeErgoTree: string;
  /** Inputs the caller fixes, placed first in this order. */
  inputs?: ErgoInputSpec[];
  /** Boxes the builder may add to cover outputs, fee and change. */
  walletBoxes?: ErgoBox[];
  outputs: ErgoOutputSpec[];
  dataInputs?: ErgoBox[];
  /** A token minted by this transaction; its id must be the first input's box id. */
  mint?: ErgoTokenAmount;
  /** Tokens this transaction destroys on purpose. */
  burn?: ErgoTokenAmount[];
  /** Box ids not to select (for example, spent by our own pending transactions). */
  excludeBoxIds?: Iterable<string>;
}

export interface BuiltErgoTransaction {
  unsigned: Eip12UnsignedTransaction;
  inputBoxes: ErgoBox[];
  dataInputBoxes: ErgoBox[];
  fee: bigint;
  feeErgoTree: string;
  changeErgoTree: string;
  /** Indexes in `unsigned.outputs` of the change boxes: right before the fee box. */
  changeOutputIndexes: number[];
  /** How many of `inputBoxes`, from the start, are the caller's fixed inputs; the rest were selected. */
  fixedInputCount: number;
  mint?: ErgoTokenAmount;
  burn: ErgoTokenAmount[];
  minValuePerByte: bigint;
  height: number;
  /**
   * `height + 1`: the height of the block the transaction can first be mined in, and the
   * HEIGHT the signer's context and the node's mempool check both evaluate scripts at. A
   * connector writing a HEIGHT-dependent register (a Dexy free-mint reset, a payout R4, a
   * tracker R7) must compute it for `nextHeight`; it holds only if mined at that height.
   */
  nextHeight: number;
}

export class ErgoBuildError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ErgoBuildError';
  }
}

export class InsufficientErgoFundsError extends ErgoBuildError {
  constructor(message: string) {
    super(message);
    this.name = 'InsufficientErgoFundsError';
  }
}

export class ErgoTransactionAssertionError extends Error {
  constructor(message: string) {
    super(`Refusing to sign: ${message}`);
    this.name = 'ErgoTransactionAssertionError';
  }
}

type TokenTotals = Map<string, bigint>;

function addTokens(totals: TokenTotals, tokens: ErgoTokenAmount[], sign: 1n | -1n = 1n): void {
  for (const t of tokens) {
    const id = t.tokenId.toLowerCase();
    totals.set(id, (totals.get(id) ?? 0n) + sign * t.amount);
  }
}

function boxIdIsValid(box: ErgoBox): boolean {
  try {
    return FleetErgoBox.validate(toFleetBox(box));
  } catch {
    return false;
  }
}

function toFleetBox(box: ErgoBox) {
  return {
    boxId: box.boxId,
    transactionId: box.transactionId,
    index: box.index,
    value: box.value,
    ergoTree: box.ergoTree,
    creationHeight: box.creationHeight,
    assets: box.assets.map((a) => ({ tokenId: a.tokenId, amount: a.amount })),
    additionalRegisters: { ...box.additionalRegisters },
  };
}

function checkRegisters(registers: ErgoRegisters | undefined, where: string): void {
  if (!registers) return;
  let gap = false;
  for (const id of REGISTER_IDS) {
    const value = registers[id];
    if (value === undefined) {
      gap = true;
      continue;
    }
    if (gap) throw new ErgoBuildError(`${where}: registers must be packed from R4 with no gap`);
    if (!isHexBytes(value)) throw new ErgoBuildError(`${where}: register ${id} must be serialized hex`);
  }
  for (const key of Object.keys(registers)) {
    if (!REGISTER_IDS.includes(key as never)) throw new ErgoBuildError(`${where}: unknown register ${key}`);
  }
}

function checkTokens(assets: ErgoTokenAmount[] | undefined, where: string): void {
  const seen = new Set<string>();
  for (const a of assets ?? []) {
    assertErgoId(a.tokenId, `${where} tokenId`);
    if (typeof a.amount !== 'bigint' || a.amount <= 0n) {
      throw new ErgoBuildError(`${where}: token amounts must be positive bigints`);
    }
    const id = a.tokenId.toLowerCase();
    if (seen.has(id)) throw new ErgoBuildError(`${where}: token ${id} appears twice`);
    seen.add(id);
  }
}

/** Minimum value for a box: its serialized size times the per-byte value. */
export function minBoxValue(
  candidate: {
    ergoTree: string;
    value: bigint;
    assets: ErgoTokenAmount[];
    additionalRegisters: ErgoRegisters;
    creationHeight: number;
  },
  minValuePerByte: bigint,
): bigint {
  const builder = new OutputBuilder(
    candidate.value > 0n ? candidate.value : 1n,
    candidate.ergoTree,
    candidate.creationHeight,
  )
    .addTokens(candidate.assets.map((a) => ({ tokenId: a.tokenId, amount: a.amount })))
    .setAdditionalRegisters({ ...candidate.additionalRegisters });
  const size = builder.estimateSize(candidate.value > 0n ? candidate.value : 1n);
  return BigInt(size) * minValuePerByte;
}

/** Smallest value v with v >= minBoxValue(box with value v). */
function selfConsistentMin(base: Omit<Parameters<typeof minBoxValue>[0], 'value'>, perByte: bigint): bigint {
  let value = 1n;
  for (let i = 0; i < 8; i++) {
    const next = minBoxValue({ ...base, value }, perByte);
    if (next <= value) return value;
    value = next;
  }
  return value;
}

function sortCandidates(boxes: ErgoBox[]): ErgoBox[] {
  return [...boxes].sort((a, b) => {
    const ac = a.inclusionHeight !== undefined ? 0 : 1;
    const bc = b.inclusionHeight !== undefined ? 0 : 1;
    if (ac !== bc) return ac - bc; // confirmed first; unconfirmed change only when needed
    if (a.value !== b.value) return a.value > b.value ? -1 : 1;
    return a.boxId < b.boxId ? -1 : 1;
  });
}

interface ChangePlan {
  boxes: Array<{ value: bigint; assets: ErgoTokenAmount[] }>;
}

/** Split change into boxes that each meet the minimum, or return the shortfall. */
function planChange(
  nanoErgs: bigint,
  tokens: ErgoTokenAmount[],
  changeErgoTree: string,
  height: number,
  perByte: bigint,
): ChangePlan | { shortfall: bigint } {
  if (tokens.length === 0 && nanoErgs === 0n) return { boxes: [] };
  const chunks: ErgoTokenAmount[][] = [];
  for (let i = 0; i < tokens.length; i += MAX_TOKENS_PER_CHANGE_BOX) {
    chunks.push(tokens.slice(i, i + MAX_TOKENS_PER_CHANGE_BOX));
  }
  if (chunks.length === 0) chunks.push([]);
  const base = (assets: ErgoTokenAmount[]) => ({
    ergoTree: changeErgoTree,
    assets,
    additionalRegisters: {},
    creationHeight: height,
  });
  // every box after the first gets exactly its own minimum; the first takes the rest
  const restValues = chunks.slice(1).map((assets) => selfConsistentMin(base(assets), perByte));
  const restTotal = restValues.reduce((s, v) => s + v, 0n);
  const firstValue = nanoErgs - restTotal;
  const firstMin =
    firstValue > 0n
      ? minBoxValue({ ...base(chunks[0]), value: firstValue }, perByte)
      : selfConsistentMin(base(chunks[0]), perByte);
  if (firstValue < firstMin) {
    return { shortfall: firstMin - firstValue };
  }
  return {
    boxes: [
      { value: firstValue, assets: chunks[0] },
      ...chunks.slice(1).map((assets, i) => ({ value: restValues[i], assets })),
    ],
  };
}

/**
 * Build an unsigned transaction. Throws ErgoBuildError for a malformed request and
 * InsufficientErgoFundsError when the wallet boxes cannot cover outputs, fee and change.
 */
export function buildUnsignedTransaction(params: ErgoBuildParams): BuiltErgoTransaction {
  const { height, minValuePerByte, fee } = params;
  const feeErgoTree = params.feeErgoTree.toLowerCase();
  const changeErgoTree = params.changeErgoTree.toLowerCase();
  if (!Number.isInteger(height) || height <= 0) throw new ErgoBuildError('height must be a positive integer');
  if (typeof fee !== 'bigint' || fee <= 0n) throw new ErgoBuildError('fee must be a positive bigint');
  if (typeof minValuePerByte !== 'bigint' || minValuePerByte < 0n)
    throw new ErgoBuildError('minValuePerByte must be a bigint');
  if (!isHexBytes(feeErgoTree) || !isHexBytes(changeErgoTree))
    throw new ErgoBuildError('fee and change trees must be hex');
  if (changeErgoTree === feeErgoTree) throw new ErgoBuildError('change cannot go to the fee contract');

  const fixed = params.inputs ?? [];
  const dataInputs = params.dataInputs ?? [];
  const burn = params.burn ?? [];
  checkTokens(burn, 'burn');
  if (params.mint) checkTokens([params.mint], 'mint');

  const fixedIds = new Set<string>();
  for (const spec of fixed) {
    if (fixedIds.has(spec.box.boxId)) throw new ErgoBuildError(`input ${spec.box.boxId} is given twice`);
    fixedIds.add(spec.box.boxId);
    if (!boxIdIsValid(spec.box)) throw new ErgoBuildError(`input ${spec.box.boxId}: box id does not match its content`);
    for (const key of Object.keys(spec.extension ?? {})) {
      const id = Number(key);
      if (!Number.isInteger(id) || id < 0 || id > 255)
        throw new ErgoBuildError(`context variable id ${key} is out of range`);
      if (!isHexBytes((spec.extension as ErgoContextExtension)[id])) {
        throw new ErgoBuildError(`context variable ${key} must be serialized hex`);
      }
    }
  }
  const dataIds = new Set<string>();
  for (const box of dataInputs) {
    if (fixedIds.has(box.boxId)) throw new ErgoBuildError(`box ${box.boxId} cannot be both an input and a data input`);
    if (dataIds.has(box.boxId)) throw new ErgoBuildError(`data input ${box.boxId} is given twice`);
    if (!boxIdIsValid(box)) throw new ErgoBuildError(`data input ${box.boxId}: box id does not match its content`);
    dataIds.add(box.boxId);
  }
  if (params.outputs.length === 0 && fixed.length === 0) throw new ErgoBuildError('a transaction needs outputs');
  params.outputs.forEach((o, i) => {
    if (!isHexBytes(o.ergoTree)) throw new ErgoBuildError(`output ${i}: ergoTree must be hex`);
    if (o.ergoTree.toLowerCase() === feeErgoTree)
      throw new ErgoBuildError(`output ${i}: the fee box is added by the builder`);
    if (typeof o.value !== 'bigint' || o.value <= 0n)
      throw new ErgoBuildError(`output ${i}: value must be a positive bigint`);
    checkTokens(o.assets, `output ${i}`);
    checkRegisters(o.additionalRegisters, `output ${i}`);
  });

  // What the outputs and fee need, net of what the fixed inputs and a mint bring.
  const required: TokenTotals = new Map();
  for (const o of params.outputs) addTokens(required, o.assets ?? []);
  addTokens(required, burn);
  const requiredErg = params.outputs.reduce((s, o) => s + o.value, 0n) + fee;

  const excluded = new Set<string>([...(params.excludeBoxIds ?? []), ...fixedIds, ...dataIds]);
  const seen = new Set<string>();
  const candidates = sortCandidates(
    (params.walletBoxes ?? []).filter(
      (b) => !excluded.has(b.boxId) && (seen.has(b.boxId) ? false : (seen.add(b.boxId), true)),
    ),
  );

  const selected: ErgoBox[] = [];
  const take = (box: ErgoBox) => {
    if (!boxIdIsValid(box)) throw new ErgoBuildError(`wallet box ${box.boxId}: box id does not match its content`);
    // the remainder of every selected box goes to change, so change must be the boxes' owner
    if (box.ergoTree.toLowerCase() !== changeErgoTree) {
      throw new ErgoBuildError(`wallet box ${box.boxId} is not at the change address`);
    }
    selected.push(box);
    candidates.splice(candidates.indexOf(box), 1);
  };
  const totalsIn = () => {
    const tokens: TokenTotals = new Map();
    let erg = 0n;
    for (const b of [...fixed.map((f) => f.box), ...selected]) {
      erg += b.value;
      addTokens(tokens, b.assets);
    }
    return { erg, tokens };
  };

  // A mint's id is the first input's box id, which is fixed only once inputs are known.
  const mintAmount = params.mint?.amount ?? 0n;
  const mintId = params.mint?.tokenId.toLowerCase();

  // 1. tokens the outputs need
  for (const [tokenId, need] of required) {
    if (tokenId === mintId) continue;
    let have = totalsIn().tokens.get(tokenId) ?? 0n;
    while (have < need) {
      const next = candidates
        .filter((b) => b.assets.some((a) => a.tokenId.toLowerCase() === tokenId))
        .sort((a, b) => {
          const aa = a.assets.find((x) => x.tokenId.toLowerCase() === tokenId)!.amount;
          const bb = b.assets.find((x) => x.tokenId.toLowerCase() === tokenId)!.amount;
          return aa === bb ? 0 : aa > bb ? -1 : 1;
        })[0];
      if (!next) {
        throw new InsufficientErgoFundsError(`Not enough of token ${tokenId}: need ${need}, have ${have}`);
      }
      take(next);
      have = totalsIn().tokens.get(tokenId) ?? 0n;
    }
  }

  // 2. ERG for outputs, fee and a change box that meets the minimum
  let plan: ChangePlan;
  let changeHeight = height;
  for (;;) {
    const inTotals = totalsIn();
    const floor = Math.max(0, ...[...fixed.map((f) => f.box), ...selected].map((b) => b.creationHeight));
    changeHeight = Math.max(height, floor);
    const changeTokens: ErgoTokenAmount[] = [];
    const allIds = new Set<string>([...inTotals.tokens.keys(), ...required.keys()]);
    if (mintId) allIds.add(mintId);
    for (const tokenId of allIds) {
      const amount =
        (inTotals.tokens.get(tokenId) ?? 0n) + (tokenId === mintId ? mintAmount : 0n) - (required.get(tokenId) ?? 0n);
      if (amount < 0n) {
        throw new InsufficientErgoFundsError(`Not enough of token ${tokenId}: short by ${-amount}`);
      }
      if (amount > 0n) changeTokens.push({ tokenId, amount });
    }
    const changeErg = inTotals.erg - requiredErg;
    const attempt =
      changeErg < 0n
        ? { shortfall: -changeErg }
        : planChange(changeErg, changeTokens, changeErgoTree, changeHeight, minValuePerByte);
    if ('boxes' in attempt) {
      plan = attempt;
      break;
    }
    const next = candidates[0];
    if (!next) {
      throw new InsufficientErgoFundsError(
        `Not enough ERG: outputs and fee need ${requiredErg}, inputs hold ${inTotals.erg}, ` +
          `and change needs ${attempt.shortfall} more to reach the minimum box value`,
      );
    }
    take(next);
  }

  const inputBoxes = [...fixed.map((f) => f.box), ...selected];
  if (inputBoxes.length === 0) throw new ErgoBuildError('a transaction needs at least one input');
  if (mintId && mintId !== inputBoxes[0].boxId) {
    throw new ErgoBuildError(`a minted token's id must be the first input's box id (${inputBoxes[0].boxId})`);
  }

  // Creation heights: never below the highest input creation height.
  const floor = Math.max(...inputBoxes.map((b) => b.creationHeight));
  const defaultHeight = Math.max(height, floor);
  params.outputs.forEach((o, i) => {
    if (o.creationHeight !== undefined) {
      if (!Number.isInteger(o.creationHeight) || o.creationHeight < floor) {
        throw new ErgoBuildError(
          `output ${i}: creationHeight ${o.creationHeight} is below the highest input creation height ${floor}`,
        );
      }
      if (o.creationHeight > height + 1) {
        throw new ErgoBuildError(
          `output ${i}: creationHeight ${o.creationHeight} is above the next block height ${height + 1}`,
        );
      }
    }
  });

  const fleetInputs = inputBoxes.map((box, i) => {
    const input = new ErgoUnsignedInput(toFleetBox(box));
    const ext = i < fixed.length ? fixed[i].extension : undefined;
    if (ext && Object.keys(ext).length > 0) {
      input.setContextExtension(Object.fromEntries(Object.entries(ext).map(([k, v]) => [k, v.toLowerCase()])));
    }
    return input;
  });
  const fleetDataInputs = dataInputs.map((box) => new ErgoUnsignedInput(toFleetBox(box)));
  const plainInputs = fleetInputs.map((i) => i.toPlainObject('EIP-12'));

  const builders: OutputBuilder[] = params.outputs.map((o) =>
    new OutputBuilder(o.value, o.ergoTree.toLowerCase(), o.creationHeight ?? defaultHeight)
      .addTokens((o.assets ?? []).map((a) => ({ tokenId: a.tokenId.toLowerCase(), amount: a.amount })))
      .setAdditionalRegisters({ ...(o.additionalRegisters ?? {}) }),
  );
  const changeOutputIndexes: number[] = [];
  for (const c of plan.boxes) {
    changeOutputIndexes.push(builders.length);
    builders.push(
      new OutputBuilder(c.value, changeErgoTree, defaultHeight).addTokens(
        c.assets.map((a) => ({ tokenId: a.tokenId, amount: a.amount })),
      ),
    );
  }
  builders.push(new OutputBuilder(fee, feeErgoTree, defaultHeight));

  const candidatesBuilt = builders.map((b) => b.build(plainInputs));
  const unsigned = new ErgoUnsignedTransaction(
    fleetInputs,
    fleetDataInputs,
    candidatesBuilt,
  ).toEIP12Object() as unknown as Eip12UnsignedTransaction;

  const built: BuiltErgoTransaction = {
    unsigned,
    inputBoxes,
    dataInputBoxes: [...dataInputs],
    fee,
    feeErgoTree,
    changeErgoTree,
    changeOutputIndexes,
    fixedInputCount: fixed.length,
    mint: params.mint ? { tokenId: params.mint.tokenId.toLowerCase(), amount: params.mint.amount } : undefined,
    burn: burn.map((b) => ({ tokenId: b.tokenId.toLowerCase(), amount: b.amount })),
    minValuePerByte,
    height,
    nextHeight: height + 1,
  };
  // The caller's outputs must meet the minimum too; the assertion reports which one fails.
  assertTransactionBalanced(built);
  return built;
}

function candidateTokens(c: Eip12BoxCandidate, where: string): ErgoTokenAmount[] {
  return (c.assets ?? []).map((a) => ({
    tokenId: a.tokenId.toLowerCase(),
    amount: toAmount(a.amount, `${where} token amount`),
  }));
}

/** The EIP-12 box's id matches its own content (value, tree, height, tokens, registers). */
function eip12BoxIdIsValid(
  eip12: Eip12BoxCandidate & { boxId: string; transactionId: string; index: number },
): boolean {
  try {
    return FleetErgoBox.validate({
      boxId: eip12.boxId,
      transactionId: eip12.transactionId,
      index: eip12.index,
      value: toAmount(eip12.value),
      ergoTree: eip12.ergoTree,
      creationHeight: eip12.creationHeight,
      assets: (eip12.assets ?? []).map((a) => ({ tokenId: a.tokenId, amount: toAmount(a.amount) })),
      additionalRegisters: { ...(eip12.additionalRegisters ?? {}) },
    });
  } catch {
    return false;
  }
}

function sameBox(eip12: Eip12BoxCandidate & { boxId: string }, box: ErgoBox): boolean {
  if (eip12.boxId !== box.boxId) return false;
  if (toAmount(eip12.value) !== box.value || eip12.ergoTree.toLowerCase() !== box.ergoTree.toLowerCase()) return false;
  if (eip12.creationHeight !== box.creationHeight) return false;
  const a = candidateTokens(eip12, 'input');
  if (a.length !== box.assets.length) return false;
  return a.every((t, i) => t.tokenId === box.assets[i].tokenId.toLowerCase() && t.amount === box.assets[i].amount);
}

/**
 * The check that runs on every transaction before it is signed. Refuses unless:
 * inputs and data inputs are exactly the given boxes, in order, with valid box ids; ERG in
 * equals ERG out, with exactly one fee box, last, holding exactly the fee and nothing else;
 * for every token, in plus declared mint equals out plus declared burn; every output meets
 * the minimum box value; every output's creation height is at or above every input's;
 * the change outputs are the boxes right before the fee box and sit at the change tree,
 * and every selected (not fixed) input sits at the change tree too. The last two read the
 * outputs and inputs themselves, so a signer-ownership check of the change tree holds for
 * the boxes that are actually created.
 */
export function assertTransactionBalanced(built: BuiltErgoTransaction): void {
  const { unsigned, inputBoxes, dataInputBoxes, fee, feeErgoTree, minValuePerByte } = built;
  const fail = (message: string): never => {
    throw new ErgoTransactionAssertionError(message);
  };

  if (unsigned.inputs.length === 0) fail('no inputs');
  if (unsigned.inputs.length !== inputBoxes.length) fail('inputs differ from the selected boxes');
  const inputIds = new Set<string>();
  unsigned.inputs.forEach((input, i) => {
    if (inputIds.has(input.boxId)) fail(`input ${input.boxId} appears twice`);
    inputIds.add(input.boxId);
    if (!sameBox(input, inputBoxes[i])) fail(`input ${i} is not box ${inputBoxes[i].boxId} as read from the node`);
    if (!eip12BoxIdIsValid(input)) fail(`input ${i}: box id does not match its content`);
  });
  if ((unsigned.dataInputs ?? []).length !== dataInputBoxes.length) fail('data inputs differ from the given boxes');
  (unsigned.dataInputs ?? []).forEach((d, i) => {
    if (inputIds.has(d.boxId)) fail(`box ${d.boxId} is both spent and read`);
    if (d.boxId !== dataInputBoxes[i].boxId) fail(`data input ${i} is not box ${dataInputBoxes[i].boxId}`);
    if (!eip12BoxIdIsValid(d)) fail(`data input ${i}: box id does not match its content`);
  });

  const outputs = unsigned.outputs;
  if (outputs.length === 0) fail('no outputs');
  const feeIndexes = outputs.map((o, i) => (o.ergoTree.toLowerCase() === feeErgoTree ? i : -1)).filter((i) => i >= 0);
  if (feeIndexes.length !== 1 || feeIndexes[0] !== outputs.length - 1)
    fail('there must be exactly one fee box, and it must be last');
  const feeBox = outputs[outputs.length - 1];
  if (toAmount(feeBox.value) !== fee) fail(`fee box holds ${feeBox.value}, expected ${fee}`);
  if ((feeBox.assets ?? []).length > 0) fail('the fee box holds tokens');
  if (Object.keys(feeBox.additionalRegisters ?? {}).length > 0) fail('the fee box has registers');

  // Change: the outputs the indexes name must be the ones right before the fee box, at
  // the change tree, holding no registers. Selected inputs must be at the change tree.
  const changeTree = built.changeErgoTree.toLowerCase();
  const changeIndexes = built.changeOutputIndexes;
  changeIndexes.forEach((index, k) => {
    if (!Number.isInteger(index) || index !== outputs.length - 1 - changeIndexes.length + k)
      fail('change outputs must be the boxes right before the fee box');
    const box = outputs[index];
    if (box.ergoTree.toLowerCase() !== changeTree) fail(`change output ${index} is not at the change address`);
    if (Object.keys(box.additionalRegisters ?? {}).length > 0) fail(`change output ${index} has registers`);
  });
  const fixedCount = built.fixedInputCount;
  if (!Number.isInteger(fixedCount) || fixedCount < 0 || fixedCount > inputBoxes.length)
    fail('fixed input count is out of range');
  inputBoxes.slice(fixedCount).forEach((box, k) => {
    if (box.ergoTree.toLowerCase() !== changeTree)
      fail(`selected input ${fixedCount + k} is not at the change address`);
  });

  const ergIn = inputBoxes.reduce((s, b) => s + b.value, 0n);
  const ergOut = outputs.reduce((s, o) => s + toAmount(o.value, 'output value'), 0n);
  if (ergIn !== ergOut) fail(`ERG in (${ergIn}) differs from ERG out including fee (${ergOut})`);

  const tokensIn: TokenTotals = new Map();
  for (const b of inputBoxes) addTokens(tokensIn, b.assets);
  if (built.mint) {
    if (built.mint.tokenId !== inputBoxes[0].boxId.toLowerCase())
      fail('a minted token id must equal the first input box id');
    if (tokensIn.has(built.mint.tokenId)) fail('a minted token cannot already exist in the inputs');
    addTokens(tokensIn, [built.mint]);
  }
  const tokensOut: TokenTotals = new Map();
  addTokens(tokensOut, built.burn);
  const floor = Math.max(...inputBoxes.map((b) => b.creationHeight));
  outputs.forEach((o, i) => {
    const assets = candidateTokens(o, `output ${i}`);
    const seen = new Set<string>();
    for (const a of assets) {
      if (a.amount <= 0n) fail(`output ${i} holds a non-positive amount of ${a.tokenId}`);
      if (seen.has(a.tokenId)) fail(`output ${i} lists token ${a.tokenId} twice`);
      seen.add(a.tokenId);
    }
    addTokens(tokensOut, assets);
    if (o.creationHeight < floor)
      fail(`output ${i} creation height ${o.creationHeight} is below input height ${floor}`);
    const value = toAmount(o.value, `output ${i} value`);
    const min = minBoxValue(
      {
        ergoTree: o.ergoTree,
        value,
        assets,
        additionalRegisters: o.additionalRegisters ?? {},
        creationHeight: o.creationHeight,
      },
      minValuePerByte,
    );
    if (value < min) fail(`output ${i} value ${value} is below the minimum box value ${min}`);
  });
  for (const id of new Set([...tokensIn.keys(), ...tokensOut.keys()])) {
    const inAmount = tokensIn.get(id) ?? 0n;
    const outAmount = tokensOut.get(id) ?? 0n;
    if (inAmount !== outAmount) {
      fail(`token ${id}: in plus mint is ${inAmount}, out plus burn is ${outAmount}`);
    }
  }
}
