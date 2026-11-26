/**
 * The network's submitMode: `send` submits a signed transaction; `check` posts it to the
 * node's check endpoint only, keeps nothing, and answers with an error that cannot be read
 * as a submitted transaction; not set (no key) refuses every swap and transfer before
 * anything is selected, loaded or signed. A transaction tracked from an earlier run in
 * `send` mode is never posted again while the mode is `check` or not set: not by poll, not
 * by the overdue check, not as the parent of a chained one. Check mode needs a node on this
 * machine unless the config accepts a remote one, and never starts while Node sends fetch
 * requests through a proxy from the environment. The node client refuses any post to the
 * submit endpoint unless the mode is send, and any post to a path it does not use. Also the
 * config key, its schema entry and the
 * shipped templates. Built with real fleet, signed with real wasm, posted to a node stand-in.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import Ajv from 'ajv';
import * as yaml from 'js-yaml';

import {
  Ergo,
  ErgoCheckIncompleteError,
  ErgoCheckOnlyError,
  ErgoCheckRejectedError,
  ErgoSubmitModeNotSetError,
  ErgoTransactionRejectedError,
} from '../../../src/chains/ergo/ergo';
import { getErgoNetworkConfig } from '../../../src/chains/ergo/ergo.config';
import { ErgoSubmitRefusedError } from '../../../src/chains/ergo/ergo.node-client';
import { WasmErgoSigner } from '../../../src/chains/ergo/ergo.signer';
import { addressFromPublicKey, isLoopbackUrl, sanitizeNodeText } from '../../../src/chains/ergo/ergo.utils';
import { toHttpError } from '../../../src/chains/ergo/routes/errors';
import { TransactionStatusCode } from '../../../src/schemas/chain-schema';
import { ConfigManagerV2 } from '../../../src/services/config-manager-v2';
import { logger } from '../../../src/services/logger';

import {
  checkTestConfig,
  fakeNode,
  FakeResponse,
  FEE_TREE,
  GENERATOR_ADDRESSES,
  HEADERS,
  infoBody,
  makeBox,
  MNEMONIC_A,
  nodeBoxJson,
  notFound,
  p2pk,
  testConfig,
  TIP,
  tokenId,
  withoutSubmitMode,
} from './ergo-test-helpers';

const signer = WasmErgoSigner.fromMnemonic(MNEMONIC_A);
const ME_TREE = p2pk(signer.publicKeys[0]);
const ME = addressFromPublicKey(signer.publicKeys[0], 0);
const OTHER = GENERATOR_ADDRESSES[0];
const ERG = 1000000000n;

const big = makeBox({ ergoTree: ME_TREE, value: 5n * ERG, creationHeight: TIP - 30 });

const acceptWithId = (body: string): FakeResponse => ({ body: JSON.stringify(JSON.parse(body).id) });

const errorOf = <T>(p: Promise<T>) =>
  p.then(
    () => null,
    (e) => e,
  );

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ergo-check-'));
  file = path.join(dir, 'mainnet-pending.json');
});

afterEach(() => {
  jest.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

type ModeState = 'send' | 'check' | 'not set';

/** The test network config in one of the three states, with the test's own pending file. */
function modeConfig(mode: ModeState, overrides: Parameters<typeof testConfig>[0] = {}) {
  if (mode === 'check') return checkTestConfig({ pendingStateFile: file, ...overrides });
  const config = testConfig({ pendingStateFile: file, ...overrides });
  return mode === 'send' ? config : withoutSubmitMode(config);
}

/** A wallet on a node stand-in; the check endpoint answers with `check`. */
function setup(opts: {
  submitMode: ModeState;
  check?: (body: string) => FakeResponse | 'throw';
  submit?: (body: string) => FakeResponse;
  info?: () => FakeResponse;
}) {
  const posted: string[] = [];
  const checked: string[] = [];
  const node = fakeNode((method, p, body) => {
    if (method === 'GET' && p === '/info') return opts.info ? opts.info() : { body: infoBody() };
    if (method === 'POST' && p.startsWith('/blockchain/box/unspent/byAddress')) return { body: [nodeBoxJson(big)] };
    if (method === 'GET' && p === '/blocks/lastHeaders/10') return { body: HEADERS };
    if (method === 'POST' && p === '/transactions') {
      posted.push(body!);
      return (opts.submit ?? acceptWithId)(body!);
    }
    if (method === 'POST' && p === '/transactions/check') {
      checked.push(body!);
      const res = (opts.check ?? acceptWithId)(body!);
      if (res === 'throw') throw new Error('socket hang up');
      return res;
    }
    return undefined;
  });
  const ergo = new Ergo('mainnet', { config: modeConfig(opts.submitMode), fetch: node.fetch });
  const getWallet = jest.spyOn(ergo, 'getWallet').mockImplementation(async () => ({
    address: ME,
    ergoTree: ME_TREE,
    signer: WasmErgoSigner.fromMnemonic(MNEMONIC_A),
  }));
  return { ergo, posted, checked, node, getWallet };
}

describe('Ergo.transfer with submitMode check', () => {
  it('the node accepts it: ErgoCheckOnlyError with the id and amounts; one POST, to the check path; nothing kept', async () => {
    const info = jest.spyOn(logger, 'info');
    const { ergo, posted, checked, node } = setup({ submitMode: 'check' });
    const sign = jest.spyOn(ergo, 'signTransaction');
    const error = await errorOf(ergo.transfer(ME, OTHER, ERG));
    expect(error).toBeInstanceOf(ErgoCheckOnlyError);
    const signed = await sign.mock.results[0].value;
    expect(error.txId).toBe(signed.id);
    expect(error.message).toBe(
      `Check only: the node accepted transaction ${signed.id} as valid; nothing was sent. If it were sent, it ` +
        `would move 1 ERG to ${OTHER}, miner fee 0.0011 ERG`,
    );
    expect(checked).toEqual([signed.json]);
    expect(posted).toEqual([]);
    expect(node.calls.filter((c) => c.method === 'POST' && c.path.startsWith('/transactions'))).toHaveLength(1);
    expect(ergo.pending.get(signed.id)).toBeUndefined();
    expect(ergo.pending.spentBoxIds().size).toBe(0);
    expect(fs.existsSync(file)).toBe(false);
    // one info line for the checked transaction, with its id and the verdict
    const lines = info.mock.calls.map((c) => String(c[0])).filter((l) => l.includes(signed.id));
    expect(lines).toEqual([
      `Ergo mainnet: check only: the node accepted transaction ${signed.id} as valid; nothing was sent`,
    ]);
    // the answer a client gets: 409, never a signature or a pending status
    const http = toHttpError(error, 'Failed to transfer') as Error & { statusCode: number };
    expect(http.statusCode).toBe(409);
    expect(http.message).toBe(error.message);
  });

  it('the same boxes are selected again by an immediate second transfer', async () => {
    const { ergo, checked } = setup({ submitMode: 'check' });
    await errorOf(ergo.transfer(ME, OTHER, ERG));
    await errorOf(ergo.transfer(ME, OTHER, ERG));
    const inputs = (json: string) => JSON.parse(json).inputs.map((i: { boxId: string }) => i.boxId);
    expect(checked).toHaveLength(2);
    expect(inputs(checked[0])).toEqual([big.boxId]);
    expect(inputs(checked[1])).toEqual([big.boxId]);
  });

  it("the node refuses it: a rejection (400) with the node's text, said to be a check; nothing kept", async () => {
    const { ergo, posted } = setup({
      submitMode: 'check',
      check: () => ({
        status: 400,
        body: { error: 400, reason: 'bad.request', detail: 'Malformed transaction: nope' },
      }),
    });
    const error = await errorOf(ergo.transfer(ME, OTHER, ERG));
    expect(error).toBeInstanceOf(ErgoCheckRejectedError);
    expect(error).toBeInstanceOf(ErgoTransactionRejectedError);
    expect(error.message).toBe(
      'Check only, nothing was sent: Ergo node rejected POST /transactions/check: bad.request: Malformed transaction: nope',
    );
    const http = toHttpError(error, 'Failed to transfer') as Error & { statusCode: number };
    expect(http.statusCode).toBe(400);
    expect(http.message).toBe(`Failed to transfer: ${error.message}`);
    expect(posted).toEqual([]);
    expect(ergo.pending.spentBoxIds().size).toBe(0);
    expect(fs.existsSync(file)).toBe(false);
  });

  it.each([
    ['a lost connection', () => 'throw' as const],
    ['a 5xx', () => ({ status: 502, body: { error: 502, reason: 'bad gateway', detail: null } })],
    ['another id', () => ({ body: JSON.stringify('ab'.repeat(32)) })],
  ])('the check gives no verdict (%s): ErgoCheckIncompleteError, a 503; nothing kept', async (_name, check) => {
    const { ergo, posted } = setup({ submitMode: 'check', check: check as () => FakeResponse });
    const error = await errorOf(ergo.transfer(ME, OTHER, ERG));
    expect(error).toBeInstanceOf(ErgoCheckIncompleteError);
    expect(error.message).toContain('nothing was sent');
    const http = toHttpError(error, 'Failed to transfer') as Error & { statusCode: number };
    expect(http.statusCode).toBe(503);
    expect(posted).toEqual([]);
    expect(ergo.pending.spentBoxIds().size).toBe(0);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('submitTransaction, the connectors entry point, checks too', async () => {
    const { ergo, posted, checked } = setup({ submitMode: 'check' });
    const built = await ergo.buildTransfer(ME, OTHER, ERG);
    const signed = await ergo.signTransaction(built, signer);
    await expect(ergo.submitTransaction(signed, built)).rejects.toBeInstanceOf(ErgoCheckOnlyError);
    expect(checked).toEqual([signed.json]);
    expect(posted).toEqual([]);
  });
});

describe('a node that keeps no UTXO state cannot validate scripts: nothing is checked there', () => {
  it.each([
    ['digest', { body: infoBody(TIP, 360, 'digest') }, '"digest"'],
    ['no stateType at all', { body: { fullHeight: TIP, parameters: { minValuePerByte: 360 } } }, 'null'],
  ])('%s: the check could not be completed (a 503); nothing was posted to any endpoint', async (_name, info, shown) => {
    let calls = 0;
    // the build reads /info first with the real answer; the read before the check gets `info`
    const { ergo, posted, checked } = setup({
      submitMode: 'check',
      info: () => (++calls === 1 ? { body: infoBody() } : (info as FakeResponse)),
    });
    const error = await errorOf(ergo.transfer(ME, OTHER, ERG));
    expect(error).toBeInstanceOf(ErgoCheckIncompleteError);
    expect(error.message).toContain(
      `could not be completed (this node keeps no UTXO state, its stateType is ${shown}, so it cannot validate ` +
        'scripts); nothing was sent',
    );
    expect((toHttpError(error, 'Failed to transfer') as Error & { statusCode: number }).statusCode).toBe(503);
    expect(checked).toEqual([]);
    expect(posted).toEqual([]);
  });

  it('utxo: the check is posted', async () => {
    const { ergo, checked } = setup({ submitMode: 'check' });
    await expect(ergo.transfer(ME, OTHER, ERG)).rejects.toBeInstanceOf(ErgoCheckOnlyError);
    expect(checked).toHaveLength(1);
  });
});

describe("the node client's own submit, called directly", () => {
  it('on a check-mode network throws and posts nothing', async () => {
    const { ergo, posted, node } = setup({ submitMode: 'check' });
    const built = await ergo.buildTransfer(ME, OTHER, ERG);
    const signed = await ergo.signTransaction(built, signer);
    await expect(ergo.node.submitTransaction(signed.json)).rejects.toBeInstanceOf(ErgoSubmitRefusedError);
    expect(posted).toEqual([]);
    expect(node.calls.filter((c) => c.method === 'POST' && c.path.startsWith('/transactions'))).toEqual([]);
  });

  it('on a send-mode network posts', async () => {
    const { ergo, posted } = setup({ submitMode: 'send' });
    const built = await ergo.buildTransfer(ME, OTHER, ERG);
    const signed = await ergo.signTransaction(built, signer);
    await expect(ergo.node.submitTransaction(signed.json)).resolves.toBe(signed.id);
    expect(posted).toEqual([signed.json]);
  });
});

/**
 * A node refusal shaped like the node's own for a transaction above the cost limit: the
 * text repeats the transaction, its inputs with their spending proofs and its outputs.
 */
function costRefusal(body: string): FakeResponse {
  const tx = JSON.parse(body);
  const printed =
    `ErgoTransaction(id: ${tx.id}, inputs: [${tx.inputs.map((i: unknown) => JSON.stringify(i)).join(',')}], ` +
    `dataInputs: [], outputs: [${tx.outputs.map((o: unknown) => JSON.stringify(o)).join(',')}], size: 400)`;
  return {
    status: 400,
    body: {
      error: 400,
      reason: 'bad.request',
      detail: `Malformed transaction: Transaction ${printed} has too high cost 1000001 (limit 1000000)`,
    },
  };
}

describe('a node refusal that repeats the signed transaction: no signature reaches an answer or a log', () => {
  const proofsOf = (json: string): string[] =>
    JSON.parse(json).inputs.map((i: { spendingProof: { proofBytes: string } }) => i.spendingProof.proofBytes);
  const logged = (spies: jest.SpyInstance[]) => spies.flatMap((s) => s.mock.calls.map((c) => c.map(String).join(' ')));

  it.each([['check' as const], ['send' as const]])('in %s mode', async (submitMode) => {
    const spies = [jest.spyOn(logger, 'info'), jest.spyOn(logger, 'warn'), jest.spyOn(logger, 'error')];
    const sign = jest.spyOn(Ergo.prototype, 'signTransaction');
    const { ergo, posted, checked } = setup({ submitMode, check: costRefusal, submit: costRefusal });
    const error = await errorOf(ergo.transfer(ME, OTHER, ERG));
    const signed = await sign.mock.results[0].value;
    expect(submitMode === 'check' ? checked : posted).toEqual([signed.json]);
    expect(error).toBeInstanceOf(submitMode === 'check' ? ErgoCheckRejectedError : ErgoTransactionRejectedError);
    const http = toHttpError(error, 'Failed to transfer') as Error & { statusCode: number };
    expect(http.statusCode).toBe(400);
    const proofs = proofsOf(signed.json);
    expect(proofs[0].length).toBeGreaterThan(64);
    const texts = [http.message, error.message, String(error.detail), String(error.reason), ...logged(spies)];
    for (const text of texts) {
      for (const proof of proofs) expect(text).not.toContain(proof);
      expect(text).not.toMatch(/proofBytes"\s*:\s*"[0-9a-f]/i);
      expect(text.length).toBeLessThan(800);
    }
    // the transaction's own id and its input box ids stay readable, and the node's words are kept
    expect(http.message).toContain(`Malformed transaction: Transaction ErgoTransaction(id: ${signed.id}`);
    expect(http.message).toContain(big.boxId);
    expect(http.message).toContain('"spendingProof":<redacted>');
  });
});

describe('the text of a node refusal, as placed in a message or a log line', () => {
  const ID = 'ab'.repeat(32);

  it('an ordinary short refusal is unchanged', () => {
    for (const text of ['Malformed transaction: nope', 'Double spending attempt', `Input ${ID} not found`]) {
      expect(sanitizeNodeText(text, [ID])).toBe(text);
    }
  });

  it('a 64-hex run is kept only when it is one of the given ids; a longer run never', () => {
    const other = 'cd'.repeat(32);
    expect(sanitizeNodeText(`${ID} ${other} ${'ef'.repeat(40)}`, [ID])).toBe(`${ID} <redacted> <redacted>`);
  });

  it('the value after a proof key is withheld, whatever its shape', () => {
    expect(sanitizeNodeText('{"spendingProof":{"proofBytes":"00ff","extension":{"1":"04"}},"x":1}')).toBe(
      '{"spendingProof":<redacted>,"x":1}',
    );
    expect(sanitizeNodeText('proofBytes=00ff, next')).toBe('proofBytes=<redacted>, next');
    expect(sanitizeNodeText("'proof_bytes': 'a1b2'")).toBe("'proof_bytes': <redacted>");
  });

  it('a long text is cut at 600 characters, with an ellipsis', () => {
    const cut = sanitizeNodeText('x'.repeat(700));
    expect(cut).toBe(`${'x'.repeat(600)}…`);
  });
});

describe('Ergo.transfer with submitMode send', () => {
  it('submitted to /transactions, tracked, the check path never used', async () => {
    const { ergo, posted, checked } = setup({ submitMode: 'send' });
    expect(ergo.submitMode).toBe('send');
    const txId = await ergo.transfer(ME, OTHER, ERG);
    expect(posted).toHaveLength(1);
    expect(JSON.parse(posted[0]).id).toBe(txId);
    expect(checked).toEqual([]);
    expect(ergo.pending.get(txId)).toBeDefined();
    expect(fs.existsSync(file)).toBe(true);
  });
});

describe('a transaction tracked from an earlier run in send mode, read from the pending file', () => {
  const input = makeBox({ ergoTree: ME_TREE, value: 5n * ERG, creationHeight: TIP - 30 });
  const TX1 = 'a1'.repeat(32);
  const TX2 = 'a2'.repeat(32);
  const change = makeBox({ ergoTree: ME_TREE, value: 3n * ERG, transactionId: TX1, index: 0, inclusionHeight: null });
  const json1 = JSON.stringify({ id: TX1, inputs: [{ boxId: input.boxId }], dataInputs: [], outputs: [] });
  const json2 = JSON.stringify({ id: TX2, inputs: [{ boxId: change.boxId }], dataInputs: [], outputs: [] });

  /** The node holds neither transaction anywhere; `input` is indexed and unspent. */
  function restart(submitMode: ModeState, now?: () => number) {
    const posted: string[] = [];
    const node = fakeNode((method, p, body) => {
      if (method === 'GET' && p === '/info') return { body: infoBody() };
      if (p.startsWith('/transactions/unconfirmed/byTransactionId/') || p.startsWith('/blockchain/transaction/byId/'))
        return notFound();
      if (p === '/blockchain/indexedHeight') return { body: { indexedHeight: TIP, fullHeight: TIP } };
      if (p === `/blockchain/box/byId/${input.boxId}`) return { body: nodeBoxJson(input) };
      if (p === `/blockchain/box/byId/${change.boxId}`) return notFound();
      if (method === 'POST' && p.startsWith('/blockchain/box/unspent/byAddress')) return { body: [] };
      if (method === 'POST' && p.startsWith('/transactions')) {
        posted.push(body!);
        return { body: JSON.stringify(JSON.parse(body!).id) };
      }
      return undefined;
    });
    const ergo = new Ergo('mainnet', { config: modeConfig(submitMode), fetch: node.fetch, now });
    return { ergo, posted };
  }

  function recordInSendMode(withChild = false) {
    const { ergo } = restart('send');
    ergo.pending.record(TX1, [input.boxId], [change], json1);
    if (withChild) ergo.pending.record(TX2, [change.boxId], [], json2);
  }

  it('poll does not post it again: NOT_FOUND, kept, with a note that says why', async () => {
    recordInSendMode();
    // send mode posts it again, as before
    const send = restart('send');
    expect((await send.ergo.pollTransaction(TX1)).txStatus).toBe(TransactionStatusCode.PENDING);
    expect(send.posted).toEqual([json1]);

    const { ergo, posted } = restart('check');
    const r = await ergo.pollTransaction(TX1);
    expect(r.txStatus).toBe(TransactionStatusCode.NOT_FOUND);
    expect(r.txData).toEqual({
      note:
        'the node holds it nowhere and its inputs are unspent; it is kept, and not posted again while ' +
        'submitMode is check',
    });
    expect(posted).toEqual([]);
    expect(ergo.pending.isSpent(input.boxId)).toBe(true);
  });

  it('poll of a chained transaction does not post its parent again; the answer stays PENDING', async () => {
    recordInSendMode(true);
    const send = restart('send');
    expect((await send.ergo.pollTransaction(TX2)).txStatus).toBe(TransactionStatusCode.PENDING);
    expect(send.posted).toEqual([json1]);

    const warn = jest.spyOn(logger, 'warn');
    const { ergo, posted } = restart('check');
    const r = await ergo.pollTransaction(TX2);
    expect(r.txStatus).toBe(TransactionStatusCode.PENDING);
    expect(r.txData).toEqual({ note: `waits for transaction ${TX1}, which creates its inputs and is still pending` });
    expect(posted).toEqual([]);
    // the parent is not even tried: no post refused by the last line of defence
    expect(warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('could not check'))).toEqual([]);
  });

  it('the one path to the submit endpoint refuses to post in check mode, if anything ever reached it', async () => {
    recordInSendMode();
    const { ergo, posted } = restart('check');
    const postAgain = (ergo as unknown as { postAgain: (tx: unknown) => Promise<unknown> }).postAgain.bind(ergo);
    await expect(postAgain(ergo.pending.get(TX1))).rejects.toThrow(
      'ergo-mainnet.submitMode is check: nothing is sent to the node',
    );
    expect(posted).toEqual([]);
  });

  it('the overdue check does not post it again; it is kept, and a warning says so', async () => {
    recordInSendMode();
    const later = () => Date.now() + 16 * 120 * 1000; // past pendingTxTimeoutBlocks x blockTimeSeconds
    const send = restart('send', later);
    await send.ergo.getSpendableBoxes(ME);
    expect(send.posted).toEqual([json1]);

    const warn = jest.spyOn(logger, 'warn');
    const { ergo, posted } = restart('check', later);
    await ergo.getSpendableBoxes(ME);
    expect(posted).toEqual([]);
    expect(ergo.pending.get(TX1)).toBeDefined();
    expect(warn.mock.calls.map((c) => String(c[0]))).toContain(
      `Ergo mainnet: pending transaction ${TX1} is held nowhere by the node and its inputs are unspent; it is ` +
        'kept, and not posted again while submitMode is check',
    );
  });

  describe('with submitMode not set', () => {
    it('poll does not post it again: NOT_FOUND, kept, with a note that says why', async () => {
      recordInSendMode();
      const { ergo, posted } = restart('not set');
      const r = await ergo.pollTransaction(TX1);
      expect(r.txStatus).toBe(TransactionStatusCode.NOT_FOUND);
      expect(r.txData).toEqual({
        note:
          'the node holds it nowhere and its inputs are unspent; it is kept, and not posted again while ' +
          'submitMode is not set',
      });
      expect(posted).toEqual([]);
      expect(ergo.pending.isSpent(input.boxId)).toBe(true);
    });

    it('poll of a chained transaction does not post its parent again; the answer stays PENDING', async () => {
      recordInSendMode(true);
      const { ergo, posted } = restart('not set');
      const r = await ergo.pollTransaction(TX2);
      expect(r.txStatus).toBe(TransactionStatusCode.PENDING);
      expect(posted).toEqual([]);
    });

    it('the overdue check does not post it again; it is kept, and a warning says so', async () => {
      recordInSendMode();
      const later = () => Date.now() + 16 * 120 * 1000;
      const warn = jest.spyOn(logger, 'warn');
      const { ergo, posted } = restart('not set', later);
      await ergo.getSpendableBoxes(ME);
      expect(posted).toEqual([]);
      expect(ergo.pending.get(TX1)).toBeDefined();
      expect(warn.mock.calls.map((c) => String(c[0]))).toContain(
        `Ergo mainnet: pending transaction ${TX1} is held nowhere by the node and its inputs are unspent; it is ` +
          'kept, and not posted again while submitMode is not set',
      );
    });

    it('the one path to the submit endpoint refuses to post, if anything ever reached it', async () => {
      recordInSendMode();
      const { ergo, posted } = restart('not set');
      const postAgain = (ergo as unknown as { postAgain: (tx: unknown) => Promise<unknown> }).postAgain.bind(ergo);
      await expect(postAgain(ergo.pending.get(TX1))).rejects.toThrow(
        'ergo-mainnet.submitMode is not set: nothing is sent to the node',
      );
      expect(posted).toEqual([]);
    });
  });
});

describe('the submitMode config key', () => {
  let mockConfigStorage: Record<string, unknown>;

  beforeEach(() => {
    mockConfigStorage = {
      'ergo-mainnet.nodeURL': 'http://node.test:9053',
      'ergo-mainnet.addressPrefix': 0,
      'ergo-mainnet.nativeCurrencySymbol': 'ERG',
      'ergo-mainnet.nativeDecimals': 9,
      'ergo-mainnet.minerFee': 1100000,
      'ergo-mainnet.minerFeeErgoTree': FEE_TREE,
      'ergo-mainnet.tokenListSource': 'tokens/ergo/mainnet.json',
      'ergo-mainnet.blockTimeSeconds': 120,
      'ergo-mainnet.pendingTxTimeoutBlocks': 15,
      'ergo-mainnet.confirmations': 1,
    };
    jest.spyOn(ConfigManagerV2, 'getInstance').mockReturnValue({
      get: (k: string) => mockConfigStorage[k],
      getNamespace: () => undefined,
    } as unknown as ConfigManagerV2);
  });

  it('absent is not set; send and check are read as they are; any other value is refused', () => {
    expect(getErgoNetworkConfig('mainnet').submitMode).toBeUndefined();
    mockConfigStorage['ergo-mainnet.submitMode'] = 'send';
    expect(getErgoNetworkConfig('mainnet').submitMode).toBe('send');
    mockConfigStorage['ergo-mainnet.submitMode'] = 'check';
    expect(getErgoNetworkConfig('mainnet').submitMode).toBe('check');
    for (const bad of ['Check', 'dry-run', true]) {
      mockConfigStorage['ergo-mainnet.submitMode'] = bad;
      expect(() => getErgoNetworkConfig('mainnet')).toThrow('ergo-mainnet.submitMode must be one of send, check');
    }
  });

  it('a chain built on a config with another value is refused too', () => {
    expect(() => new Ergo('mainnet', { config: testConfig({ submitMode: 'dry' as never }) })).toThrow(
      'ergo-mainnet.submitMode must be one of send, check',
    );
  });

  it('a network states its mode when it starts: an info line in send mode, a warning in check mode and when not set', () => {
    const warn = jest.spyOn(logger, 'warn');
    const info = jest.spyOn(logger, 'info');
    const modeLines = (spy: jest.SpyInstance) => spy.mock.calls.filter((c) => String(c[0]).includes('submitMode'));
    new Ergo('mainnet', { config: testConfig({ submitMode: 'send' }) });
    new Ergo('mainnet', { config: testConfig() });
    expect(modeLines(warn)).toHaveLength(0);
    const sendLine = ['ergo-mainnet.submitMode is send: signed transactions are sent to the node'];
    expect(modeLines(info)).toEqual([sendLine, sendLine]);
    new Ergo('mainnet', { config: checkTestConfig() });
    new Ergo('mainnet', { config: withoutSubmitMode(testConfig()) });
    expect(modeLines(warn)).toEqual([
      [
        'ergo-mainnet.submitMode is check: signed transactions are only checked by the node, never sent; no swap ' +
          'or transfer from this network is carried out',
      ],
      [
        'ergo-mainnet.submitMode is not set: no swap or transfer is carried out until it is set; nothing is ' +
          'signed, sent or checked. Add "submitMode: send" or "submitMode: check" to the network\'s config file, ' +
          'then restart Gateway',
      ],
    ]);
    expect(modeLines(info)).toHaveLength(2);
  });
});

describe('submitMode in the schema and the shipped templates', () => {
  const templates = path.join(__dirname, '../../../src/templates');
  const schema = JSON.parse(fs.readFileSync(path.join(templates, 'namespace/ergo-network-schema.json'), 'utf8'));
  const text = (net: string) => fs.readFileSync(path.join(templates, 'chains/ergo', `${net}.yml`), 'utf8');
  const load = (net: string) => yaml.load(text(net)) as Record<string, unknown>;

  it.each(['mainnet', 'testnet'])(
    '%s ships no submitMode value, only a commented example; only send and check are taken',
    (net) => {
      const validate = new Ajv({ strict: false }).compile(schema);
      // no value in the template: the loader would keep it over a value of another type
      expect(load(net)).not.toHaveProperty('submitMode');
      expect(text(net)).not.toMatch(/^submitMode:/m);
      expect(text(net)).toMatch(/^# submitMode: check {4}# or: submitMode: send$/m);
      expect(validate(load(net))).toBe(true);
      expect(validate({ ...load(net), submitMode: 'check' })).toBe(true);
      const { submitMode: _left, ...without } = load(net);
      expect(validate(without)).toBe(true);
      for (const bad of ['Check', 'dry-run', '', true, 1])
        expect(validate({ ...load(net), submitMode: bad })).toBe(false);
      expect(schema.required).not.toContain('submitMode');
    },
  );

  it.each(['mainnet', 'testnet'])(
    '%s explains the three states, and that a fresh config sends nothing until the key is set',
    (net) => {
      const comment = text(net).replace(/\n# ?/g, ' ').replace(/ +/g, ' ');
      expect(comment).toContain('Three states:');
      expect(comment).toContain('- submitMode: send.');
      expect(comment).toContain('- submitMode: check.');
      expect(comment).toContain('- not set (no submitMode line). Nothing is signed, sent or checked');
      expect(comment).toContain('A fresh config sends nothing until this key is set.');
    },
  );

  it.each(['mainnet', 'testnet'])(
    '%s ships checkAllowsRemoteNode only as a commented line with its reason; the schema takes a boolean',
    (net) => {
      const validate = new Ajv({ strict: false }).compile(schema);
      expect(load(net)).not.toHaveProperty('checkAllowsRemoteNode');
      expect(text(net)).toMatch(/^# checkAllowsRemoteNode: true$/m);
      expect(text(net)).toContain('whoever runs or can watch a remote node could broadcast');
      expect(schema.properties.checkAllowsRemoteNode.type).toBe('boolean');
      expect(schema.required).not.toContain('checkAllowsRemoteNode');
      expect(validate({ ...load(net), checkAllowsRemoteNode: true })).toBe(true);
      expect(validate({ ...load(net), checkAllowsRemoteNode: 'true' })).toBe(false);
    },
  );
});

const NOT_SET_MESSAGE =
  'ergo-mainnet.submitMode is not set. Add "submitMode: send" to send transactions, or "submitMode: check" to ' +
  "have the node only check them, to the network's config file, then restart Gateway. Nothing was signed or sent.";

describe('with submitMode not set: nothing is selected, loaded, signed, checked or sent', () => {
  const transactionPosts = (calls: Array<{ method: string; path: string }>) =>
    calls.filter((c) => c.method === 'POST' && c.path.startsWith('/transactions'));

  it('transfer answers the 503 at once: no node request, no key loaded, nothing signed', async () => {
    const { ergo, posted, checked, node, getWallet } = setup({ submitMode: 'not set' });
    const sign = jest.spyOn(ergo, 'signTransaction');
    expect(ergo.submitMode).toBeUndefined();
    const error = await errorOf(ergo.transfer(ME, OTHER, ERG));
    expect(error).toBeInstanceOf(ErgoSubmitModeNotSetError);
    expect(error.message).toBe(NOT_SET_MESSAGE);
    const http = toHttpError(error, 'Failed to transfer') as Error & { statusCode: number };
    expect(http.statusCode).toBe(503);
    expect(http.message).toBe(`Failed to transfer: ${NOT_SET_MESSAGE}`);
    expect(node.calls).toEqual([]);
    expect(getWallet).not.toHaveBeenCalled();
    expect(sign).not.toHaveBeenCalled();
    expect(posted).toEqual([]);
    expect(checked).toEqual([]);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('sendTransaction answers the same before any box is selected or anything signed', async () => {
    const { ergo, node } = setup({ submitMode: 'not set' });
    const used = WasmErgoSigner.fromMnemonic(MNEMONIC_A);
    const signerSign = jest.spyOn(used, 'signTransaction');
    const build = jest.spyOn(ergo, 'buildTransaction');
    const error = await errorOf(ergo.sendTransaction({ changeAddress: ME, outputs: [] }, used));
    expect(error).toBeInstanceOf(ErgoSubmitModeNotSetError);
    expect(build).not.toHaveBeenCalled();
    expect(signerSign).not.toHaveBeenCalled();
    expect(node.calls).toEqual([]);
  });

  it('submitTransaction of a transaction signed elsewhere answers the same; nothing is posted', async () => {
    const { ergo, node } = setup({ submitMode: 'not set' });
    const built = await ergo.buildTransfer(ME, OTHER, ERG);
    const signed = await ergo.signTransaction(built, signer);
    await expect(ergo.submitTransaction(signed, built)).rejects.toThrow(NOT_SET_MESSAGE);
    expect(transactionPosts(node.calls)).toEqual([]);
    expect(ergo.pending.spentBoxIds().size).toBe(0);
  });

  it('balances are read as before', async () => {
    const { ergo } = setup({ submitMode: 'not set' });
    jest.spyOn(ergo, 'getTokenList').mockResolvedValue([]);
    const balances = await ergo.getBalances(ME);
    expect(balances).toEqual([{ key: 'ERG', symbol: 'ERG', address: null, balance: 5 }]);
  });
});

describe('check mode needs the node on this machine, unless the config accepts a remote one', () => {
  const build = (nodeURL: string, more: Parameters<typeof testConfig>[0] = {}) =>
    new Ergo('mainnet', { config: testConfig({ submitMode: 'check', nodeURL, ...more }) });

  it.each([
    'http://localhost:9053',
    'http://LOCALHOST:9053',
    'http://127.0.0.1:9053',
    'http://127.1.2.3:9053',
    'http://127.1:9053',
    'http://[::1]:9053',
    'http://[0:0:0:0:0:0:0:1]:9053',
    'https://user:pass@127.0.0.1/node',
  ])('%s: the network starts in check mode', (nodeURL) => {
    expect(isLoopbackUrl(nodeURL)).toBe(true);
    expect(build(nodeURL).submitMode).toBe('check');
  });

  it.each([
    ['http://node.test:9053', 'node.test'],
    ['http://192.168.1.5:9053', '192.168.1.5'],
    ['http://localhost.example.com:9053', 'localhost.example.com'],
    ['http://128.0.0.1:9053', '128.0.0.1'],
    ['http://[::ffff:127.0.0.1]:9053', '[::ffff:7f00:1]'],
    ['http://user:secret@node.example:9053', 'node.example'],
  ])('%s: the network does not start, and the error says why', (nodeURL, host) => {
    expect(isLoopbackUrl(nodeURL)).toBe(false);
    let error: unknown;
    try {
      build(nodeURL);
    } catch (e) {
      error = e;
    }
    expect((error as Error).message).toBe(
      `ergo-mainnet.submitMode is check and nodeURL names the host ${host}, which is not this machine. In check ` +
        'mode the node receives every signed transaction in full, and whoever runs or can watch that node could ' +
        'broadcast it. Point nodeURL at a node on this machine (localhost, 127.0.0.0/8 or ::1), or set ' +
        'ergo-mainnet.checkAllowsRemoteNode: true to accept that; this network does not start until then',
    );
    expect((error as Error).message).not.toContain('secret');
  });

  it('a remote node with checkAllowsRemoteNode true: the network starts in check mode', () => {
    expect(build('http://node.test:9053', { checkAllowsRemoteNode: true }).submitMode).toBe('check');
  });

  it('a remote node in send mode or with the mode not set starts as before', () => {
    expect(new Ergo('mainnet', { config: testConfig({ nodeURL: 'http://node.test:9053' }) }).submitMode).toBe('send');
    expect(new Ergo('mainnet', { config: withoutSubmitMode(testConfig()) }).submitMode).toBeUndefined();
  });
});

describe("the node client's general request method refuses a post to the submit endpoint", () => {
  it.each([['check' as const], ['not set' as const]])(
    'with the mode %s: every spelling of the submit path throws and nothing is posted',
    async (mode) => {
      const { ergo, node } = setup({ submitMode: mode });
      for (const p of [
        '/transactions',
        '/transactions/',
        '/transactions?x=1',
        '//transactions',
        '/%74ransactions',
        '/Transactions',
        '/transactions/check/..',
      ]) {
        await expect(ergo.node.request('POST', p, { body: '{}' })).rejects.toBeInstanceOf(ErgoSubmitRefusedError);
      }
      expect(node.calls).toEqual([]);
    },
  );

  it('with the mode check, the check path and other posts are not refused', async () => {
    const { ergo, checked } = setup({ submitMode: 'check' });
    await expect(
      ergo.node.request('POST', '/transactions/check', {
        body: JSON.stringify({ id: 'ab'.repeat(32) }),
        plainTextOk: true,
      }),
    ).resolves.toBe('ab'.repeat(32));
    expect(checked).toHaveLength(1);
  });

  it('with the mode send, it posts as before', async () => {
    const { ergo, posted } = setup({ submitMode: 'send' });
    await ergo.node.request('POST', '/transactions', {
      body: JSON.stringify({ id: 'ab'.repeat(32) }),
      plainTextOk: true,
    });
    expect(posted).toHaveLength(1);
  });
});

describe('the node client posts only to the paths it uses', () => {
  /** A node stand-in that answers every post, so any refusal is the client's own. */
  function anyPost(mode: ModeState) {
    const node = fakeNode((method) => (method === 'POST' ? { body: JSON.stringify('ab'.repeat(32)) } : undefined));
    const ergo = new Ergo('mainnet', { config: modeConfig(mode), fetch: node.fetch });
    return { ergo, node };
  }

  it.each([['send' as const], ['check' as const], ['not set' as const]])(
    "with the mode %s: a post to the node's other submit endpoint or to any other path is refused, and nothing is posted",
    async (mode) => {
      const { ergo, node } = anyPost(mode);
      for (const p of [
        '/transactions/bytes',
        '/transactions/bytes/',
        '//transactions/bytes',
        '/Transactions/Bytes',
        '/%74ransactions/bytes',
        '/transactions%2Fbytes',
        '/transactions/check/../bytes',
        '/transactions/checkBytes',
        '/wallet/transaction/send',
        '/wallet/payment/send',
        '/blockchain/box/unspent/byAddress/extra',
        '/info',
        '/unknown',
      ]) {
        const error = await errorOf(ergo.node.request('POST', p, { body: '{}', plainTextOk: true }));
        expect(error).toBeInstanceOf(ErgoSubmitRefusedError);
        expect(error.message).toBe(
          'The node client posts only to its submit, check and unspent-box paths: nothing was posted to the node, ' +
            'and nothing was sent',
        );
      }
      expect(node.calls).toEqual([]);
    },
  );

  it('with the mode send, every post the client makes still reaches the node', async () => {
    const { ergo, node } = anyPost('send');
    for (const p of [
      '/transactions',
      '/transactions/check',
      '/blockchain/box/unspent/byAddress?offset=0&limit=100',
      '/blockchain/box/unspent/byErgoTree?offset=0&limit=100',
    ]) {
      await ergo.node.request('POST', p, { body: '{}', plainTextOk: true });
    }
    expect(node.calls.map((c) => [c.method, c.path])).toEqual([
      ['POST', '/transactions'],
      ['POST', '/transactions/check'],
      ['POST', '/blockchain/box/unspent/byAddress?offset=0&limit=100'],
      ['POST', '/blockchain/box/unspent/byErgoTree?offset=0&limit=100'],
    ]);
  });

  it.each([['check' as const], ['not set' as const]])(
    'with the mode %s, the check and unspent-box posts reach the node and the submit post does not',
    async (mode) => {
      const { ergo, node } = anyPost(mode);
      for (const p of [
        '/transactions/check',
        '/blockchain/box/unspent/byAddress?offset=0&limit=100',
        '/blockchain/box/unspent/byErgoTree?offset=0&limit=100',
      ]) {
        await ergo.node.request('POST', p, { body: '{}', plainTextOk: true });
      }
      await expect(ergo.node.request('POST', '/transactions', { body: '{}' })).rejects.toBeInstanceOf(
        ErgoSubmitRefusedError,
      );
      expect(node.calls.map((c) => c.path)).toEqual([
        '/transactions/check',
        '/blockchain/box/unspent/byAddress?offset=0&limit=100',
        '/blockchain/box/unspent/byErgoTree?offset=0&limit=100',
      ]);
    },
  );

  it('the box reads that post go through the client as before', async () => {
    const node = fakeNode((method, p) => {
      if (method === 'POST' && p.startsWith('/blockchain/box/unspent/byAddress')) return { body: [nodeBoxJson(big)] };
      if (method === 'POST' && p.startsWith('/blockchain/box/unspent/byErgoTree')) return { body: [nodeBoxJson(big)] };
      return undefined;
    });
    const ergo = new Ergo('mainnet', { config: modeConfig('check'), fetch: node.fetch });
    const query = { includeUnconfirmed: false, excludeMempoolSpent: false };
    expect((await ergo.node.getUnspentBoxesByAddress(ME, query)).map((b) => b.boxId)).toEqual([big.boxId]);
    expect((await ergo.node.getUnspentBoxesByErgoTree(ME_TREE, 1000)).map((b) => b.boxId)).toEqual([big.boxId]);
  });
});

describe('check mode is refused when Node sends fetch requests through a proxy from the environment', () => {
  const PROXY_VARS = ['NODE_USE_ENV_PROXY', 'NODE_OPTIONS', 'HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy'];
  let saved: Record<string, string | undefined>;
  let savedArgv: string[];

  beforeEach(() => {
    saved = Object.fromEntries(PROXY_VARS.map((name) => [name, process.env[name]]));
    savedArgv = [...process.execArgv];
    for (const name of PROXY_VARS) delete process.env[name];
  });

  afterEach(() => {
    for (const name of PROXY_VARS) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
    process.execArgv.splice(0, process.execArgv.length, ...savedArgv);
  });

  const PROXY_MESSAGE =
    'ergo-mainnet.submitMode is check and Node is set to send fetch requests through a proxy from the environment ' +
    '(NODE_USE_ENV_PROXY or --use-env-proxy, with HTTP_PROXY or HTTPS_PROXY set). In check mode every signed ' +
    'transaction is posted in full to the node, and the proxy would receive it and could broadcast it. Start ' +
    'Gateway without the environment proxy; this network does not start until then';
  const local = (mode: ModeState) => modeConfig(mode, { nodeURL: 'http://127.0.0.1:9053' });

  it.each([
    ['NODE_USE_ENV_PROXY=1 and HTTP_PROXY', { NODE_USE_ENV_PROXY: '1', HTTP_PROXY: 'http://proxy.test:3128' }, []],
    ['NODE_USE_ENV_PROXY=true and HTTPS_PROXY', { NODE_USE_ENV_PROXY: 'true', HTTPS_PROXY: 'http://p.test:1' }, []],
    ['NODE_USE_ENV_PROXY=1 and http_proxy', { NODE_USE_ENV_PROXY: '1', http_proxy: 'http://p.test:1' }, []],
    ['NODE_USE_ENV_PROXY=1 and https_proxy', { NODE_USE_ENV_PROXY: '1', https_proxy: 'http://p.test:1' }, []],
    [
      '--use-env-proxy in NODE_OPTIONS',
      { NODE_OPTIONS: '--max-old-space-size=2048 --use-env-proxy', HTTP_PROXY: 'x' },
      [],
    ],
    ['--use-env-proxy among the process flags', { HTTPS_PROXY: 'http://p.test:1' }, ['--use-env-proxy']],
  ] as Array<[string, Record<string, string>, string[]]>)(
    '%s: the network does not start in check mode, and the error says why',
    (_name, env, argv) => {
      Object.assign(process.env, env);
      process.execArgv.push(...argv);
      expect(() => new Ergo('mainnet', { config: local('check') })).toThrow(PROXY_MESSAGE);
      // a remote node accepted for check mode does not make the proxy acceptable
      expect(modeConfig('check').checkAllowsRemoteNode).toBe(true);
      expect(() => new Ergo('mainnet', { config: modeConfig('check') })).toThrow(PROXY_MESSAGE);
    },
  );

  it.each([
    ['the proxy turned on with no proxy named', { NODE_USE_ENV_PROXY: '1' }],
    ['a proxy named with proxying not turned on', { HTTP_PROXY: 'http://p.test:1', HTTPS_PROXY: 'http://p.test:1' }],
    ['NODE_USE_ENV_PROXY=0', { NODE_USE_ENV_PROXY: '0', HTTP_PROXY: 'http://p.test:1' }],
    ['NODE_USE_ENV_PROXY empty', { NODE_USE_ENV_PROXY: '', HTTP_PROXY: 'http://p.test:1' }],
    ['an empty HTTP_PROXY', { NODE_USE_ENV_PROXY: '1', HTTP_PROXY: '' }],
  ] as Array<[string, Record<string, string>]>)('%s: check mode starts', (_name, env) => {
    Object.assign(process.env, env);
    expect(new Ergo('mainnet', { config: local('check') }).submitMode).toBe('check');
  });

  it('send mode and the mode not set start as before through the proxy', () => {
    Object.assign(process.env, { NODE_USE_ENV_PROXY: '1', HTTP_PROXY: 'http://p.test:1' });
    expect(new Ergo('mainnet', { config: local('send') }).submitMode).toBe('send');
    expect(new Ergo('mainnet', { config: local('not set') }).submitMode).toBeUndefined();
  });
});

describe('a checked transfer names each token by its symbol and the start of its id', () => {
  it('a listed token and an unlisted one whose on-chain name is the same symbol are told apart', async () => {
    const LISTED = tokenId(0x31);
    const UNLISTED = tokenId(0x32);
    const withTokens = makeBox({
      ergoTree: ME_TREE,
      value: 5n * ERG,
      creationHeight: TIP - 30,
      assets: [
        { tokenId: LISTED, amount: 1000n },
        { tokenId: UNLISTED, amount: 1000n },
      ],
    });
    const checked: string[] = [];
    const node = fakeNode((method, p, body) => {
      if (method === 'GET' && p === '/info') return { body: infoBody() };
      if (method === 'POST' && p.startsWith('/blockchain/box/unspent/byAddress'))
        return { body: [nodeBoxJson(withTokens)] };
      if (method === 'GET' && p === '/blocks/lastHeaders/10') return { body: HEADERS };
      if (method === 'GET' && p === `/blockchain/token/byId/${UNLISTED}`) {
        return { body: { id: UNLISTED, name: 'SigUSD', decimals: 2, emissionAmount: 100000 } };
      }
      if (method === 'POST' && p === '/transactions/check') {
        checked.push(body!);
        return acceptWithId(body!);
      }
      return undefined;
    });
    const ergo = new Ergo('mainnet', { config: checkTestConfig({ pendingStateFile: file }), fetch: node.fetch });
    jest
      .spyOn(ergo, 'getTokenList')
      .mockResolvedValue([{ address: LISTED, symbol: 'SigUSD', name: 'SigUSD', decimals: 2 }]);
    jest.spyOn(ergo, 'getWallet').mockImplementation(async () => ({
      address: ME,
      ergoTree: ME_TREE,
      signer: WasmErgoSigner.fromMnemonic(MNEMONIC_A),
    }));
    const error = await errorOf(
      ergo.transfer(ME, OTHER, ERG, [
        { tokenId: LISTED, amount: 5n },
        { tokenId: UNLISTED, amount: 7n },
      ]),
    );
    expect(error).toBeInstanceOf(ErgoCheckOnlyError);
    expect(error.message).toContain(
      `would move 1 ERG, 5 of SigUSD (${LISTED.slice(0, 8)}…) (in its smallest unit), 7 of SigUSD ` +
        `(${UNLISTED.slice(0, 8)}…) (in its smallest unit) to ${OTHER}`,
    );
    expect(checked).toHaveLength(1);
  });
});
