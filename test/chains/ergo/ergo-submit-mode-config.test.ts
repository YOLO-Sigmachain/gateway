/**
 * The network's submitMode as Gateway reads it from a real config file: through the real
 * config manager and namespace loader, with the shipped schema and the shipped template,
 * on a config folder in a temp dir. A network sends only when its file says
 * `submitMode: send`; with no key the mode is not set, and every swap and transfer is
 * refused before anything is loaded or signed. A value that is not exactly `send` or
 * `check` stops the namespace from loading; a key that looks like submitMode in the wrong
 * place or misspelt stops the network from starting; the mode is stated in the log when
 * the network starts. While Gateway runs, every submit decision compares the mode the
 * network started with, the mode in the config held in memory and the mode in the config
 * file, and looks for such keys again: on any doubt nothing is recorded or posted, the
 * answer is a 503 that says to restart, and the network refuses every later submit until
 * it restarts.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import * as yaml from 'js-yaml';

import {
  Ergo,
  ErgoCheckOnlyError,
  ErgoSubmitModeMismatchError,
  ErgoSubmitModeNotSetError,
} from '../../../src/chains/ergo/ergo';
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
const CHAIN_SCHEMA = path.join(TEMPLATES, 'namespace/ergo-chain-schema.json');
const CHAIN_TEMPLATE = path.join(TEMPLATES, 'chains/ergo.yml');

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
let chainFile: string;
let pendingFile: string;
let logs: { info: jest.SpyInstance; warn: jest.SpyInstance; error: jest.SpyInstance };

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ergo-submit-mode-'));
  configFile = path.join(dir, 'mainnet.yml');
  chainFile = path.join(dir, 'ergo.yml');
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
 * the node and the pending file are the test's own. The node stand-in is reached through an
 * injected fetch and keeps the test host, so the file accepts a remote node in check mode
 * unless `remoteOk` is false.
 */
function configText(extra: string, remoteOk = true): string {
  return (
    fs
      .readFileSync(TEMPLATE, 'utf8')
      .replace(/^submitMode:.*$/m, '')
      .replace(/^nodeURL: .*$/m, 'nodeURL: http://node.test:9053')
      .replace(/^pendingStateFile: .*$/m, `pendingStateFile: ${JSON.stringify(pendingFile)}`) +
    (remoteOk ? '\ncheckAllowsRemoteNode: true' : '') +
    `\n${extra}\n`
  );
}

/**
 * Write the config file and load it as Gateway does: a real config manager on a config
 * folder in the temp dir, with ergo-mainnet from the shipped schema and template, and the
 * chain namespace `ergo` from its own (with `chainExtra` appended to the chain file). The
 * manager is what ConfigManagerV2.getInstance answers from then on.
 */
function load(extra: string, options: { chainExtra?: string; remoteOk?: boolean } = {}): ConfigManagerV2 {
  fs.writeFileSync(path.join(dir, 'root.yml'), 'version: 1\nconfigurations: {}\n');
  fs.writeFileSync(configFile, configText(extra, options.remoteOk));
  fs.writeFileSync(chainFile, `${fs.readFileSync(CHAIN_TEMPLATE, 'utf8')}\n${options.chainExtra ?? ''}\n`);
  const manager = new ConfigManagerV2(path.join(dir, 'root.yml'));
  manager.addNamespace('ergo', CHAIN_SCHEMA, chainFile, CHAIN_TEMPLATE);
  manager.addNamespace('ergo-mainnet', SCHEMA, configFile, TEMPLATE);
  jest.spyOn(ConfigManagerV2, 'getInstance').mockReturnValue(manager);
  return manager;
}

/** A hand edit of the config file: `text` appended, nothing else changed. */
function appendToFile(text: string): void {
  fs.appendFileSync(configFile, `\n${text}\n`);
}

const NOT_SET_MESSAGE =
  'ergo-mainnet.submitMode is not set. Add "submitMode: send" to send transactions, or "submitMode: check" to ' +
  "have the node only check them, to the network's config file, then restart Gateway. Nothing was signed or sent.";

/** The tail of every answer once the mode is in doubt. */
const DOUBT_TAIL = '. Nothing was sent, and nothing is sent from this network until Gateway is restarted';

/** What the error names for a key that looks like submitMode. */
const lookalikeText = (shown: string, where: string) =>
  `the key ${shown} ${where} is not read: the submit mode is set only by the key "submitMode" at the top level ` +
  `of ${configFile}`;

/** A hand edit of the config file: the submitMode line set to `line`, nothing else changed. */
function editFile(line: string): void {
  const text = fs.readFileSync(configFile, 'utf8').replace(/^submitMode:.*$/m, '');
  fs.writeFileSync(configFile, `${text}\n${line}\n`);
}

describe('submitMode in a real config file, at load', () => {
  it('check loads as check, send as send, and no key as not set', () => {
    load('submitMode: check');
    expect(getErgoNetworkConfig('mainnet').submitMode).toBe('check');
    load('submitMode: send');
    expect(getErgoNetworkConfig('mainnet').submitMode).toBe('send');
    load('');
    expect(getErgoNetworkConfig('mainnet').submitMode).toBeUndefined();
  });

  it('check with a remote node and no checkAllowsRemoteNode: the network does not start', async () => {
    load('submitMode: check', { remoteOk: false });
    await expect(Ergo.getInstance('mainnet')).rejects.toThrow(
      'ergo-mainnet.submitMode is check and nodeURL names the host node.test, which is not this machine',
    );
    load('submitMode: check');
    expect(getErgoNetworkConfig('mainnet').checkAllowsRemoteNode).toBe(true);
    await expect(Ergo.getInstance('mainnet')).resolves.toBeInstanceOf(Ergo);
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

/**
 * Keys that look like submitMode, as written in the file, with how the error shows them and
 * where it says they are.
 */
const LOOKALIKES: Array<[name: string, text: string, shown: string, where: () => string]> = [
  ['submitmode', 'submitmode: check', '"submitmode"', () => `in ${configFile}`],
  ['submit_mode', 'submit_mode: check', '"submit_mode"', () => `in ${configFile}`],
  ['SubmitMode', 'SubmitMode: check', '"SubmitMode"', () => `in ${configFile}`],
  ['submit-mode', 'submit-mode: check', '"submit-mode"', () => `in ${configFile}`],
  ['submit mode', 'submit mode: check', '"submit mode"', () => `in ${configFile}`],
  ['SUBMIT_MODE', 'SUBMIT_MODE: check', '"SUBMIT_MODE"', () => `in ${configFile}`],
  ['sumbitMode', 'sumbitMode: check', '"sumbitMode"', () => `in ${configFile}`],
  ['submitMod', 'submitMod: check', '"submitMod"', () => `in ${configFile}`],
  ['submitModes', 'submitModes: check', '"submitModes"', () => `in ${configFile}`],
  ['submtMode', 'submtMode: check', '"submtMode"', () => `in ${configFile}`],
  ['a dotted key', 'submit.mode: check', '"submit.mode"', () => `in ${configFile}`],
  ['a Cyrillic o', 'submitM\u043ede: check', '"submitM\\u{43e}de"', () => `in ${configFile}`],
  ['a zero-width space', 'submit\u200bMode: check', '"submit\\u{200b}Mode"', () => `in ${configFile}`],
  [
    'full-width letters',
    '\uff53\uff55\uff42\uff4d\uff49\uff54Mode: check',
    '"\\u{ff53}\\u{ff55}\\u{ff42}\\u{ff4d}\\u{ff49}\\u{ff54}Mode"',
    () => `in ${configFile}`,
  ],
  ['a nested key', 'mainnet:\n  submitMode: check', '"submitMode"', () => `under "mainnet" in ${configFile}`],
  [
    'a nested misspelt key',
    'networks:\n  sumbitMode: check',
    '"sumbitMode"',
    () => `under "networks" in ${configFile}`,
  ],
];

describe('a key that looks like submitMode in a real config file, at start', () => {
  it.each(LOOKALIKES)(
    '%s: the network does not start, and the error names the key, where it is, and the right key and file',
    async (_name, text, shown, where) => {
      load(text);
      const expected = `ergo-mainnet: ${lookalikeText(shown, where())}. Correct it; this network does not start until then`;
      expect(() => getErgoNetworkConfig('mainnet')).toThrow(expected);
      await expect(Ergo.getInstance('mainnet')).rejects.toThrow(expected);
    },
  );

  it('next to a correct submitMode: send, a lookalike still stops the network', async () => {
    load('submitMode: send\nsumbitMode: check');
    await expect(Ergo.getInstance('mainnet')).rejects.toThrow('the key "sumbitMode" in');
  });

  it('submitMode in the chain file conf/chains/ergo.yml: the network does not start', async () => {
    load('submitMode: send', { chainExtra: 'submitMode: check' });
    const expected =
      `ergo-mainnet: the key "submitMode" in the ergo chain config (${chainFile}) is not read: the submit mode is ` +
      `set only by the key "submitMode" at the top level of ${configFile}. Correct it; this network does not start ` +
      'until then';
    await expect(Ergo.getInstance('mainnet')).rejects.toThrow(expected);
  });

  it('keys that only share a part of the name are not refused', async () => {
    load('submitMode: send\ncheckAllowsRemoteNode: false\nmodeOfSubmit: x', { remoteOk: false });
    await expect(Ergo.getInstance('mainnet')).resolves.toBeInstanceOf(Ergo);
  });

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

  it('no key: one warning that says nothing is carried out until it is set', async () => {
    load('');
    await Ergo.getInstance('mainnet');
    expect(modeLines(logs.warn)).toEqual([
      'ergo-mainnet.submitMode is not set: no swap or transfer is carried out until it is set; nothing is signed, ' +
        'sent or checked. Add "submitMode: send" or "submitMode: check" to the network\'s config file, then ' +
        'restart Gateway',
    ]);
    expect(modeLines(logs.info)).toEqual([]);
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
    const getWallet = jest.spyOn(ergo, 'getWallet').mockImplementation(async () => ({
      address: ME,
      ergoTree: ME_TREE,
      signer: WasmErgoSigner.fromMnemonic(MNEMONIC_A),
    }));
    return { ergo, posted, checked, calls: node.calls, getWallet };
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
        `The mode changed while Gateway was running; restart Gateway to use the mode in its config${DOUBT_TAIL}`,
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

  it('no key anywhere: not set in all three, so a transfer answers the 503 before any key is loaded', async () => {
    load('');
    const run = live();
    const sign = jest.spyOn(run.ergo, 'signTransaction');
    const error = await errorOf(run.ergo.transfer(ME, OTHER, ERG));
    expect(error).toBeInstanceOf(ErgoSubmitModeNotSetError);
    expect(error.message).toBe(NOT_SET_MESSAGE);
    const http = toHttpError(error, 'Failed to transfer') as Error & { statusCode: number };
    expect(http.statusCode).toBe(503);
    expect(run.calls).toEqual([]);
    expect(run.getWallet).not.toHaveBeenCalled();
    expect(sign).not.toHaveBeenCalled();
    expect(run.posted).toEqual([]);
    expect(run.checked).toEqual([]);
    expect(fs.existsSync(pendingFile)).toBe(false);
  });

  it('not set at start, then send set by hand or through the config manager: still not sent', async () => {
    const manager = load('');
    const run = live();
    editFile('submitMode: send');
    manager.set('ergo-mainnet.submitMode', 'send');
    await expect(run.ergo.transfer(ME, OTHER, ERG)).rejects.toThrow(NOT_SET_MESSAGE);
    // a direct submit decision sees the three values differ
    await expect(run.ergo.node.submitTransaction('{}')).rejects.toBeInstanceOf(ErgoSubmitRefusedError);
    expect(run.posted).toEqual([]);
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

  it('the key removed from the file by hand while the network runs in check: not set differs, so a 503', async () => {
    load('submitMode: check');
    const run = live();
    editFile('');
    await expectNothingSent(run, { running: 'check', inMemory: 'check', inFile: 'not set' });
  });

  it('the key removed from the file by hand while the network runs in send: not set is not send, so a 503', async () => {
    load('submitMode: send');
    const run = live();
    editFile('');
    await expectNothingSent(run, { running: 'send', inMemory: 'send', inFile: 'not set' });
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
    expect(error.message).toContain('running send, config in memory send, config file unreadable (ENOENT).');
    expect(run.posted).toEqual([]);
  });

  it('a config file that cannot be parsed: the answer and the log name the error class only, never a line of the file', async () => {
    load('submitMode: send');
    const run = live();
    // a broken line next to a node URL with credentials in it; the parser's own message quotes both
    const broken = configText('submitMode: send').replace(
      /^nodeURL: .*$/m,
      'nodeURL: http://gateway:s3cretpass@127.0.0.1:9053\n  unclosed: indented',
    );
    expect(() => yaml.load(broken)).toThrow(/s3cretpass/);
    fs.writeFileSync(configFile, broken);
    const error = await errorOf(run.ergo.transfer(ME, OTHER, ERG));
    expect(error).toBeInstanceOf(ErgoSubmitModeMismatchError);
    expect(error.message).toContain('running send, config in memory send, config file unreadable (YAMLException).');
    const http = toHttpError(error, 'Failed to transfer') as Error & { statusCode: number };
    expect(http.statusCode).toBe(503);
    const logged = [logs.info, logs.warn, logs.error].flatMap((spy) =>
      spy.mock.calls.map((c) => c.map(String).join(' ')),
    );
    for (const text of [error.message, http.message, ...logged]) {
      expect(text).not.toContain('s3cretpass');
      expect(text).not.toContain('unclosed');
      expect(text).not.toContain('nodeURL');
    }
    expect(run.posted).toEqual([]);
  });

  it("the node client's own submit refuses too while the mode is in doubt", async () => {
    load('submitMode: send');
    const run = live();
    editFile('submitMode: check');
    await expect(run.ergo.node.submitTransaction('{}')).rejects.toBeInstanceOf(ErgoSubmitRefusedError);
    await expect(run.ergo.node.request('POST', '/transactions', { body: '{}' })).rejects.toBeInstanceOf(
      ErgoSubmitRefusedError,
    );
    expect(run.posted).toEqual([]);
  });
});

describe('a doubt about the mode is kept until Gateway restarts', () => {
  function live() {
    const posted: string[] = [];
    const node = fakeNode((method, p, body) => {
      if (method === 'GET' && p === '/info') return { body: infoBody() };
      if (method === 'POST' && p.startsWith('/blockchain/box/unspent/byAddress')) return { body: [nodeBoxJson(big)] };
      if (method === 'GET' && p === '/blocks/lastHeaders/10') return { body: HEADERS };
      if (method === 'POST' && p.startsWith('/transactions')) {
        posted.push(body!);
        return { body: JSON.stringify(JSON.parse(body!).id) };
      }
      return undefined;
    });
    const ergo = new Ergo('mainnet', { fetch: node.fetch });
    const getWallet = jest.spyOn(ergo, 'getWallet').mockImplementation(async () => ({
      address: ME,
      ergoTree: ME_TREE,
      signer: WasmErgoSigner.fromMnemonic(MNEMONIC_A),
    }));
    return { ergo, posted, getWallet };
  }

  it('a hand edit to check, then the edit undone: the values agree again, and still nothing is sent', async () => {
    load('submitMode: send');
    const run = live();
    editFile('submitMode: check');
    const first = await errorOf(run.ergo.transfer(ME, OTHER, ERG));
    expect(first).toBeInstanceOf(ErgoSubmitModeMismatchError);
    editFile('submitMode: send');
    run.getWallet.mockClear();
    const second = await errorOf(run.ergo.transfer(ME, OTHER, ERG));
    expect(second).toBe(first);
    expect(second.message).toContain('The mode changed while Gateway was running; restart Gateway');
    // refused at the start: no key loaded for it
    expect(run.getWallet).not.toHaveBeenCalled();
    await expect(run.ergo.node.request('POST', '/transactions', { body: '{}' })).rejects.toBeInstanceOf(
      ErgoSubmitRefusedError,
    );
    expect(run.posted).toEqual([]);
  });

  it('a hand edit to check erased by an update of another key through the config manager: still nothing is sent', async () => {
    const manager = load('submitMode: send');
    const run = live();
    editFile('submitMode: check');
    await expect(run.ergo.transfer(ME, OTHER, ERG)).rejects.toBeInstanceOf(ErgoSubmitModeMismatchError);
    // the update writes the whole config from memory over the file: the hand edit is gone
    manager.set('ergo-mainnet.nodeTimeoutMs', 20000);
    expect(fs.readFileSync(configFile, 'utf8')).not.toContain('submitMode: check');
    await expect(run.ergo.transfer(ME, OTHER, ERG)).rejects.toBeInstanceOf(ErgoSubmitModeMismatchError);
    expect(run.posted).toEqual([]);
  });

  it('in check mode, a doubt stops the checks too', async () => {
    load('submitMode: check');
    const run = live();
    editFile('submitMode: send');
    await expect(run.ergo.transfer(ME, OTHER, ERG)).rejects.toBeInstanceOf(ErgoSubmitModeMismatchError);
    editFile('submitMode: check');
    await expect(run.ergo.transfer(ME, OTHER, ERG)).rejects.toBeInstanceOf(ErgoSubmitModeMismatchError);
    expect(run.posted).toEqual([]);
  });
});

describe('a key that looks like submitMode added while the network runs', () => {
  function live() {
    const posted: string[] = [];
    const node = fakeNode((method, p, body) => {
      if (method === 'GET' && p === '/info') return { body: infoBody() };
      if (method === 'POST' && p.startsWith('/blockchain/box/unspent/byAddress')) return { body: [nodeBoxJson(big)] };
      if (method === 'GET' && p === '/blocks/lastHeaders/10') return { body: HEADERS };
      if (method === 'POST' && p.startsWith('/transactions')) {
        posted.push(body!);
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
    return { ergo, posted };
  }

  it.each(LOOKALIKES)(
    '%s appended to the file: the next submit decision refuses with a 503 that names it, and the refusal is kept',
    async (_name, text, shown, where) => {
      load('submitMode: send');
      const run = live();
      appendToFile(text);
      const error = await errorOf(run.ergo.transfer(ME, OTHER, ERG));
      expect(error).toBeInstanceOf(ErgoSubmitModeMismatchError);
      expect(error.message).toBe(
        `The submit mode for ergo-mainnet is in doubt: ${lookalikeText(shown, where())}. The mode changed while ` +
          `Gateway was running; correct the config, then restart Gateway${DOUBT_TAIL}`,
      );
      expect((toHttpError(error, 'Failed to transfer') as Error & { statusCode: number }).statusCode).toBe(503);
      expect(run.posted).toEqual([]);
      // the key removed again: still refused until a restart
      fs.writeFileSync(configFile, configText('submitMode: send'));
      await expect(run.ergo.transfer(ME, OTHER, ERG)).rejects.toBe(error);
      expect(run.posted).toEqual([]);
    },
  );

  it('a lookalike set through the config manager, in memory and in the file: refused', async () => {
    const manager = load('submitMode: send');
    const run = live();
    manager.set('ergo-mainnet.submit_mode', 'check');
    await expect(run.ergo.transfer(ME, OTHER, ERG)).rejects.toThrow('the key "submit_mode" in');
    expect(run.posted).toEqual([]);
  });

  it('submitMode set in the chain namespace through the config manager: refused', async () => {
    const manager = load('submitMode: send');
    const run = live();
    manager.set('ergo.submitMode', 'check');
    await expect(run.ergo.transfer(ME, OTHER, ERG)).rejects.toThrow(
      `the key "submitMode" in the ergo chain config (${chainFile}) is not read`,
    );
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

  it('restarted with no key in the file: poll does not post it again, and says why', async () => {
    trackInSendMode();
    load('');
    const { ergo, posted } = restarted();
    const r = await ergo.pollTransaction(TX1);
    expect(r.txStatus).toBe(TransactionStatusCode.NOT_FOUND);
    expect(String(r.txData?.note)).toContain('it is kept, and not posted again while submitMode is not set');
    expect(posted).toEqual([]);
    expect(ergo.pending.isSpent(input.boxId)).toBe(true);
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
