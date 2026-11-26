/**
 * The network's submitMode as Gateway reads it from a real config file: through the real
 * config manager and namespace loader, with the shipped schema and the shipped template,
 * on a config folder in a temp dir. A value that is not exactly `send` or `check` stops the
 * namespace from loading, a misspelt key stops the network from starting, and the mode is
 * stated in the log when the network starts. While Gateway runs, every submit decision
 * compares the mode the network started with, the mode in the config held in memory and
 * the mode in the config file: when they do not all agree, nothing is recorded or posted
 * and the answer is a 503 that says to restart.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { Ergo, ErgoCheckOnlyError, ErgoSubmitModeMismatchError } from '../../../src/chains/ergo/ergo';
import { getErgoNetworkConfig } from '../../../src/chains/ergo/ergo.config';
import { ErgoSubmitRefusedError } from '../../../src/chains/ergo/ergo.node-client';
import { WasmErgoSigner } from '../../../src/chains/ergo/ergo.signer';
import { addressFromPublicKey } from '../../../src/chains/ergo/ergo.utils';
import { toHttpError } from '../../../src/chains/ergo/routes/errors';
import { TransactionStatusCode } from '../../../src/schemas/chain-schema';
import { ConfigManagerV2 } from '../../../src/services/config-manager-v2';
import { logger } from '../../../src/services/logger';

import {
  fakeNode,
  GENERATOR_ADDRESSES,
  HEADERS,
  infoBody,
  makeBox,
  MNEMONIC_A,
  nodeBoxJson,
  notFound,
  p2pk,
  TIP,
} from './ergo-test-helpers';

const TEMPLATES = path.join(__dirname, '../../../src/templates');
const SCHEMA = path.join(TEMPLATES, 'namespace/ergo-network-schema.json');
const TEMPLATE = path.join(TEMPLATES, 'chains/ergo/mainnet.yml');

const signer = WasmErgoSigner.fromMnemonic(MNEMONIC_A);
const ME_TREE = p2pk(signer.publicKeys[0]);
const ME = addressFromPublicKey(signer.publicKeys[0], 0);
const OTHER = GENERATOR_ADDRESSES[0];
const ERG = 1000000000n;
const big = makeBox({ ergoTree: ME_TREE, value: 5n * ERG, creationHeight: TIP - 30 });

const errorOf = <T>(p: Promise<T>) =>
  p.then(
    () => null,
    (e) => e,
  );

let dir: string;
let configFile: string;
let pendingFile: string;
let logs: { info: jest.SpyInstance; warn: jest.SpyInstance; error: jest.SpyInstance };

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ergo-submit-mode-'));
  configFile = path.join(dir, 'mainnet.yml');
  pendingFile = path.join(dir, 'mainnet-pending.json');
  // log lines are read from the spies; nothing is written to a log file
  logs = {
    info: jest.spyOn(logger, 'info').mockImplementation(() => logger),
    warn: jest.spyOn(logger, 'warn').mockImplementation(() => logger),
    error: jest.spyOn(logger, 'error').mockImplementation(() => logger),
  };
});

afterEach(() => {
  jest.restoreAllMocks();
  Ergo.clearInstances();
  fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * The shipped mainnet template with `extra` appended in place of any submitMode line it has;
 * the node and the pending file are the test's own.
 */
function configText(extra: string): string {
  return (
    fs
      .readFileSync(TEMPLATE, 'utf8')
      .replace(/^submitMode:.*$/m, '')
      .replace(/^nodeURL: .*$/m, 'nodeURL: http://node.test:9053')
      .replace(/^pendingStateFile: .*$/m, `pendingStateFile: ${JSON.stringify(pendingFile)}`) + `\n${extra}\n`
  );
}

/**
 * Write the config file and load it as Gateway does: a real config manager on a config
 * folder in the temp dir, with ergo-mainnet from the shipped schema and template. The
 * manager is what ConfigManagerV2.getInstance answers from then on.
 */
function load(extra: string): ConfigManagerV2 {
  fs.writeFileSync(path.join(dir, 'root.yml'), 'version: 1\nconfigurations: {}\n');
  fs.writeFileSync(configFile, configText(extra));
  const manager = new ConfigManagerV2(path.join(dir, 'root.yml'));
  manager.addNamespace('ergo-mainnet', SCHEMA, configFile, TEMPLATE);
  jest.spyOn(ConfigManagerV2, 'getInstance').mockReturnValue(manager);
  return manager;
}

/** A hand edit of the config file: the submitMode line set to `line`, nothing else changed. */
function editFile(line: string): void {
  const text = fs.readFileSync(configFile, 'utf8').replace(/^submitMode:.*$/m, '');
  fs.writeFileSync(configFile, `${text}\n${line}\n`);
}

describe('submitMode in a real config file, at load', () => {
  it('check loads as check, send as send, and no key as send', () => {
    load('submitMode: check');
    expect(getErgoNetworkConfig('mainnet').submitMode).toBe('check');
    load('submitMode: send');
    expect(getErgoNetworkConfig('mainnet').submitMode).toBe('send');
    load('');
    expect(getErgoNetworkConfig('mainnet').submitMode).toBe('send');
  });

  it.each([
    ['true', 'submitMode: true', 'must be string'],
    ['1', 'submitMode: 1', 'must be string'],
    ['Check', 'submitMode: Check', 'must be equal to one of the allowed values'],
    ['CHECK', 'submitMode: CHECK', 'must be equal to one of the allowed values'],
    ['check with a trailing space inside quotes', "submitMode: 'check '", 'must be equal to one of the allowed values'],
    ['dry-run', 'submitMode: dry-run', 'must be equal to one of the allowed values'],
    ['an empty string', "submitMode: ''", 'must be equal to one of the allowed values'],
    ['an empty value', 'submitMode:', 'must be string'],
  ])('%s is refused: the namespace does not load, so Gateway does not start; never send', (_name, line, why) => {
    let error: unknown;
    try {
      load(line);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      'Failed to load configuration for ergo-mainnet: Failed to validate or merge with template: ergo-mainnet ' +
        `config file seems to be outdated/broken due to "${why === 'must be string' ? 'type' : 'enum'}" in ` +
        `"/submitMode" - ${why}. Kindly fix manually.`,
    );
  });
});

describe('a misspelt submitMode key in a real config file', () => {
  it.each(['submitmode', 'submit_mode', 'SubmitMode', 'submit-mode', 'submit mode', 'SUBMIT_MODE'])(
    '%s: the network does not start, and the error names the key and the right spelling',
    async (key) => {
      load(`${key}: check`);
      const expected =
        `ergo-mainnet has the key "${key}", which is not read: the key is spelled submitMode. ` +
        'Correct it in the config file; this network does not start until then';
      expect(() => getErgoNetworkConfig('mainnet')).toThrow(expected);
      await expect(Ergo.getInstance('mainnet')).rejects.toThrow(expected);
    },
  );

  it('the right spelling next to nothing else loads, and the network starts', async () => {
    load('submitMode: check');
    await expect(Ergo.getInstance('mainnet')).resolves.toBeInstanceOf(Ergo);
  });
});

describe('the mode in the log when the network starts', () => {
  const modeLines = (spy: jest.SpyInstance) =>
    spy.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('submitMode'));

  it('send: one info line that says signed transactions are sent', async () => {
    load('submitMode: send');
    await Ergo.getInstance('mainnet');
    expect(modeLines(logs.info)).toEqual(['ergo-mainnet.submitMode is send: signed transactions are sent to the node']);
    expect(modeLines(logs.warn)).toEqual([]);
  });

  it('no key: the same info line', async () => {
    load('');
    await Ergo.getInstance('mainnet');
    expect(modeLines(logs.info)).toEqual(['ergo-mainnet.submitMode is send: signed transactions are sent to the node']);
  });

  it('check: one warning that says nothing is sent', async () => {
    load('submitMode: check');
    await Ergo.getInstance('mainnet');
    expect(modeLines(logs.warn)).toEqual([
      'ergo-mainnet.submitMode is check: signed transactions are only checked by the node, never sent; no swap ' +
        'or transfer from this network is carried out',
    ]);
    expect(modeLines(logs.info)).toEqual([]);
  });
});

describe('the mode compared at each submit decision while Gateway runs', () => {
  /** A network built the way getInstance builds it (config from the manager), on a node stand-in. */
  function live() {
    const posted: string[] = [];
    const checked: string[] = [];
    const node = fakeNode((method, p, body) => {
      if (method === 'GET' && p === '/info') return { body: infoBody() };
      if (method === 'POST' && p.startsWith('/blockchain/box/unspent/byAddress')) return { body: [nodeBoxJson(big)] };
      if (method === 'GET' && p === '/blocks/lastHeaders/10') return { body: HEADERS };
      if (method === 'POST' && p === '/transactions') {
        posted.push(body!);
        return { body: JSON.stringify(JSON.parse(body!).id) };
      }
      if (method === 'POST' && p === '/transactions/check') {
        checked.push(body!);
        return { body: JSON.stringify(JSON.parse(body!).id) };
      }
      return undefined;
    });
    const ergo = new Ergo('mainnet', { fetch: node.fetch });
    jest.spyOn(ergo, 'getWallet').mockImplementation(async () => ({
      address: ME,
      ergoTree: ME_TREE,
      signer: WasmErgoSigner.fromMnemonic(MNEMONIC_A),
    }));
    return { ergo, posted, checked };
  }

  /** The answer is the 503 that names the three values; nothing was checked, posted, recorded or written. */
  async function expectNothingSent(
    run: ReturnType<typeof live>,
    values: { running: string; inMemory: string; inFile: string },
  ) {
    const error = await errorOf(run.ergo.transfer(ME, OTHER, ERG));
    expect(error).toBeInstanceOf(ErgoSubmitModeMismatchError);
    expect(error.message).toBe(
      'The submit mode differs between the running Gateway and its config for ergo-mainnet: ' +
        `running ${values.running}, config in memory ${values.inMemory}, config file ${values.inFile}. ` +
        'Nothing was sent. Restart Gateway to use the mode in its config',
    );
    const http = toHttpError(error, 'Failed to transfer') as Error & { statusCode: number };
    expect(http.statusCode).toBe(503);
    expect(http.message).toBe(`Failed to transfer: ${error.message}`);
    expect(run.posted).toEqual([]);
    expect(run.checked).toEqual([]);
    expect(run.ergo.pending.spentBoxIds().size).toBe(0);
    expect(fs.existsSync(pendingFile)).toBe(false);
  }

  it('all three send: sent, as before', async () => {
    load('submitMode: send');
    const run = live();
    const txId = await run.ergo.transfer(ME, OTHER, ERG);
    expect(run.posted).toHaveLength(1);
    expect(JSON.parse(run.posted[0]).id).toBe(txId);
    expect(run.checked).toEqual([]);
  });

  it('no key anywhere counts as send in all three: sent, as before', async () => {
    load('');
    const run = live();
    await run.ergo.transfer(ME, OTHER, ERG);
    expect(run.posted).toHaveLength(1);
  });

  it('all three check: checked only, as before', async () => {
    load('submitMode: check');
    const run = live();
    await expect(run.ergo.transfer(ME, OTHER, ERG)).rejects.toBeInstanceOf(ErgoCheckOnlyError);
    expect(run.checked).toHaveLength(1);
    expect(run.posted).toEqual([]);
  });

  it('send changed to check through the config manager (as /config/update does): nothing sent, a 503', async () => {
    const manager = load('submitMode: send');
    const run = live();
    manager.set('ergo-mainnet.submitMode', 'check');
    await expectNothingSent(run, { running: 'send', inMemory: 'check', inFile: 'check' });
  });

  it('check changed to send through the config manager: still nothing sent, a 503', async () => {
    const manager = load('submitMode: check');
    const run = live();
    manager.set('ergo-mainnet.submitMode', 'send');
    await expectNothingSent(run, { running: 'check', inMemory: 'send', inFile: 'send' });
  });

  it('send changed to check by a hand edit of the file, no restart: nothing sent, a 503', async () => {
    load('submitMode: send');
    const run = live();
    editFile('submitMode: check');
    await expectNothingSent(run, { running: 'send', inMemory: 'send', inFile: 'check' });
  });

  it('check changed to send by a hand edit of the file, no restart: nothing sent, a 503', async () => {
    load('submitMode: check');
    const run = live();
    editFile('submitMode: send');
    await expectNothingSent(run, { running: 'check', inMemory: 'check', inFile: 'send' });
  });

  it('the key removed from the file by hand while the network runs in check: absent is send, so a 503', async () => {
    load('submitMode: check');
    const run = live();
    editFile('');
    await expectNothingSent(run, { running: 'check', inMemory: 'check', inFile: 'send (not set)' });
  });

  it('a file edited to a value that is neither send nor check: nothing sent, a 503', async () => {
    load('submitMode: send');
    const run = live();
    editFile('submitMode: true');
    await expectNothingSent(run, { running: 'send', inMemory: 'send', inFile: 'true (neither send nor check)' });
  });

  it('a config file that cannot be read: nothing sent, a 503', async () => {
    load('submitMode: send');
    const run = live();
    fs.rmSync(configFile);
    const error = await errorOf(run.ergo.transfer(ME, OTHER, ERG));
    expect(error).toBeInstanceOf(ErgoSubmitModeMismatchError);
    expect(error.message).toMatch(/running send, config in memory send, config file unreadable \((Error: )?ENOENT/);
    expect(run.posted).toEqual([]);
  });

  it("the node client's own submit refuses too while the mode is in doubt", async () => {
    load('submitMode: send');
    const run = live();
    editFile('submitMode: check');
    await expect(run.ergo.node.submitTransaction('{}')).rejects.toBeInstanceOf(ErgoSubmitRefusedError);
    expect(run.posted).toEqual([]);
  });
});

describe('a transaction tracked from an earlier run, while the mode is in doubt', () => {
  const input = makeBox({ ergoTree: ME_TREE, value: 5n * ERG, creationHeight: TIP - 30 });
  const TX1 = 'b1'.repeat(32);
  const TX2 = 'b2'.repeat(32);
  const change = makeBox({ ergoTree: ME_TREE, value: 3n * ERG, transactionId: TX1, index: 0, inclusionHeight: null });
  const json1 = JSON.stringify({ id: TX1, inputs: [{ boxId: input.boxId }], dataInputs: [], outputs: [] });
  const json2 = JSON.stringify({ id: TX2, inputs: [{ boxId: change.boxId }], dataInputs: [], outputs: [] });

  /** The node holds neither transaction anywhere; `input` is indexed and unspent. */
  function restarted(now?: () => number) {
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
    const ergo = new Ergo('mainnet', { fetch: node.fetch, now });
    return { ergo, posted };
  }

  function trackInSendMode(withChild = false) {
    load('submitMode: send');
    const { ergo } = restarted();
    ergo.pending.record(TX1, [input.boxId], [change], json1);
    if (withChild) ergo.pending.record(TX2, [change.boxId], [], json2);
  }

  it('all agreeing on send, poll posts it again as before', async () => {
    trackInSendMode();
    const { ergo, posted } = restarted();
    expect((await ergo.pollTransaction(TX1)).txStatus).toBe(TransactionStatusCode.PENDING);
    expect(posted).toEqual([json1]);
  });

  it('poll does not post it again: NOT_FOUND, kept, with a note that says why', async () => {
    trackInSendMode();
    const { ergo, posted } = restarted();
    editFile('submitMode: check');
    const r = await ergo.pollTransaction(TX1);
    expect(r.txStatus).toBe(TransactionStatusCode.NOT_FOUND);
    expect(String(r.txData?.note)).toContain('it is kept, and not posted again: The submit mode differs');
    expect(posted).toEqual([]);
    expect(ergo.pending.isSpent(input.boxId)).toBe(true);
  });

  it('poll of a chained transaction does not post its parent again', async () => {
    trackInSendMode(true);
    const { ergo, posted } = restarted();
    editFile('submitMode: check');
    const r = await ergo.pollTransaction(TX2);
    expect(r.txStatus).toBe(TransactionStatusCode.PENDING);
    expect(posted).toEqual([]);
  });

  it('the overdue check does not post it again; it is kept, and a warning says why', async () => {
    trackInSendMode();
    const later = () => Date.now() + 16 * 120 * 1000; // past pendingTxTimeoutBlocks x blockTimeSeconds
    const { ergo, posted } = restarted(later);
    editFile('submitMode: check');
    await ergo.getSpendableBoxes(ME);
    expect(posted).toEqual([]);
    expect(ergo.pending.get(TX1)).toBeDefined();
    expect(
      logs.warn.mock.calls
        .map((c) => String(c[0]))
        .some((l) => l.includes('not posted again: The submit mode differs')),
    ).toBe(true);
  });
});
