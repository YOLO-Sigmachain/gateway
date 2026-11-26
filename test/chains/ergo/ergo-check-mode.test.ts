/**
 * The network's submitMode: `send` (the default, also when the key is absent) submits a
 * signed transaction; `check` posts it to the node's check endpoint only, keeps nothing,
 * and answers with an error that cannot be read as a submitted transaction. A transaction
 * tracked from an earlier run in `send` mode is never posted again while the mode is
 * `check`: not by poll, not by the overdue check, not as the parent of a chained one. Also
 * the config key, its schema entry and the shipped templates. Built with real fleet, signed
 * with real wasm, posted to a node stand-in.
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
  ErgoTransactionRejectedError,
} from '../../../src/chains/ergo/ergo';
import { getErgoNetworkConfig } from '../../../src/chains/ergo/ergo.config';
import { ErgoSubmitRefusedError } from '../../../src/chains/ergo/ergo.node-client';
import { WasmErgoSigner } from '../../../src/chains/ergo/ergo.signer';
import { addressFromPublicKey, sanitizeNodeText } from '../../../src/chains/ergo/ergo.utils';
import { toHttpError } from '../../../src/chains/ergo/routes/errors';
import { TransactionStatusCode } from '../../../src/schemas/chain-schema';
import { ConfigManagerV2 } from '../../../src/services/config-manager-v2';
import { logger } from '../../../src/services/logger';

import {
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

/** A wallet on a node stand-in; the check endpoint answers with `check`. */
function setup(opts: {
  submitMode?: 'send' | 'check';
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
  const config = testConfig({ pendingStateFile: file, ...(opts.submitMode ? { submitMode: opts.submitMode } : {}) });
  const ergo = new Ergo('mainnet', { config, fetch: node.fetch });
  jest.spyOn(ergo, 'getWallet').mockImplementation(async () => ({
    address: ME,
    ergoTree: ME_TREE,
    signer: WasmErgoSigner.fromMnemonic(MNEMONIC_A),
  }));
  return { ergo, posted, checked, node };
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
  it.each([
    ['the key absent', undefined],
    ['the key send', 'send' as const],
  ])('with %s: submitted to /transactions, tracked, the check path never used', async (_name, submitMode) => {
    const { ergo, posted, checked } = setup({ submitMode });
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
  function restart(submitMode: 'send' | 'check', now?: () => number) {
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
    const ergo = new Ergo('mainnet', {
      config: testConfig({ pendingStateFile: file, submitMode }),
      fetch: node.fetch,
      now,
    });
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

  it('absent is send; send and check are read as they are; any other value is refused', () => {
    expect(getErgoNetworkConfig('mainnet').submitMode).toBe('send');
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

  it('a network states its mode when it starts: an info line in send mode, a warning in check mode', () => {
    const warn = jest.spyOn(logger, 'warn');
    const info = jest.spyOn(logger, 'info');
    const modeLines = (spy: jest.SpyInstance) => spy.mock.calls.filter((c) => String(c[0]).includes('submitMode'));
    new Ergo('mainnet', { config: testConfig({ submitMode: 'send' }) });
    new Ergo('mainnet', { config: testConfig() });
    expect(modeLines(warn)).toHaveLength(0);
    const sendLine = ['ergo-mainnet.submitMode is send: signed transactions are sent to the node'];
    expect(modeLines(info)).toEqual([sendLine, sendLine]);
    new Ergo('mainnet', { config: testConfig({ submitMode: 'check' }) });
    expect(modeLines(warn)).toEqual([
      [
        'ergo-mainnet.submitMode is check: signed transactions are only checked by the node, never sent; no swap ' +
          'or transfer from this network is carried out',
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
});
