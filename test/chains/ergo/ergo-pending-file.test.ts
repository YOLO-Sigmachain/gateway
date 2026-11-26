/**
 * Pending transactions on disk: written atomically on every change, read back at start,
 * and a missing, truncated or foreign-format file starts an empty list with the bad file
 * kept aside; another network's file stops start-up. Every file here is in a fresh
 * temporary directory, never in the repository.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { Ergo } from '../../../src/chains/ergo/ergo';
import { ErgoPendingTracker, FAILED_KEPT } from '../../../src/chains/ergo/ergo.pending';
import { ErgoPendingFile } from '../../../src/chains/ergo/ergo.pending-file';
import { TransactionStatusCode } from '../../../src/schemas/chain-schema';
import { logger } from '../../../src/services/logger';

import {
  ABOVE_2_53,
  fakeNode,
  infoBody,
  makeBox,
  MNEMONIC_A,
  nodeBoxJson,
  notFound,
  testConfig,
  TIP,
  tokenId,
} from './ergo-test-helpers';

const ME = '0008cd' + '02'.repeat(33);
const ERG = 1000000000n;
const TX1 = 'a1'.repeat(32);
const TX2 = 'a2'.repeat(32);

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ergo-pending-'));
  file = path.join(dir, 'state', 'mainnet-pending.json');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const tracker = (network = 'mainnet', now: () => number = Date.now) =>
  new ErgoPendingTracker(30 * 60_000, now, { recentMs: 120_000, file: new ErgoPendingFile(file, network) });

const input = makeBox({ ergoTree: ME, value: 5n * ERG });
const pool = makeBox({ ergoTree: '0008cd' + '03'.repeat(33), value: 100n * ERG });
const change = makeBox({
  ergoTree: ME,
  value: 3n * ERG,
  assets: [{ tokenId: tokenId(9), amount: ABOVE_2_53 }],
  transactionId: TX1,
  index: 1,
  inclusionHeight: null,
});
const signedJson = JSON.stringify({ id: TX1, inputs: [], dataInputs: [], outputs: [] });

function recordOne(t: ErgoPendingTracker) {
  t.record(TX1, [pool.boxId, input.boxId], [change], signedJson, [
    { boxId: pool.boxId, transactionId: pool.transactionId },
  ]);
}

describe('pending transactions survive a restart', () => {
  it('a recorded transaction is read back by a new tracker, amounts exact', () => {
    recordOne(tracker());
    const again = tracker();
    const tx = again.get(TX1)!;
    expect(tx).toBeDefined();
    expect(again.isSpent(input.boxId)).toBe(true);
    expect(again.isSpent(pool.boxId)).toBe(true);
    expect(tx.fixedInputs).toEqual([{ boxId: pool.boxId, transactionId: pool.transactionId }]);
    expect(tx.json).toBe(signedJson);
    expect(tx.outputs[0].assets[0].amount).toBe(ABOVE_2_53);
    expect(tx.outputs[0].value).toBe(3n * ERG);
    expect(tx.outputs[0].boxId).toBe(change.boxId);
    // the unconfirmed change is still offered to the next build, as before the restart
    expect(again.available([input], ME).map((b) => b.boxId)).toEqual([change.boxId]);
  });

  it('a release is written too', () => {
    const t = tracker();
    recordOne(t);
    t.release(TX1);
    expect(tracker().get(TX1)).toBeUndefined();
  });

  it('the file holds signed transactions and box ids only', () => {
    recordOne(tracker());
    const body = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(Object.keys(body).sort()).toEqual(['format', 'network', 'transactions', 'version']);
    expect(Object.keys(body.transactions[0]).sort()).toEqual(
      ['fixedInputs', 'inputBoxIds', 'json', 'outputs', 'submittedAt', 'txId'].sort(),
    );
    const text = fs.readFileSync(file, 'utf8');
    for (const word of MNEMONIC_A.split(' ')) expect(text).not.toContain(` ${word} `);
  });

  it('is written to a temporary file and renamed over the old one', () => {
    const renames: Array<[string, string]> = [];
    // the module object itself, which the code under test reads through
    const nodeFs = jest.requireActual<typeof import('fs')>('fs');
    const real = nodeFs.renameSync;
    const spy = jest.spyOn(nodeFs, 'renameSync').mockImplementation((from, to) => {
      renames.push([String(from), String(to)]);
      return real(from, to);
    });
    try {
      recordOne(tracker());
    } finally {
      spy.mockRestore();
    }
    expect(renames).toHaveLength(1);
    expect(renames[0][1]).toBe(file);
    expect(renames[0][0]).not.toBe(file);
    expect(fs.readdirSync(path.dirname(file))).toEqual([path.basename(file)]);
  });

  it('no file: an empty list', () => {
    expect(tracker().spentBoxIds().size).toBe(0);
  });

  it.each([
    ['truncated', (text: string) => text.slice(0, text.length - 7)],
    ['not JSON', () => 'not json at all'],
    ['another format', () => JSON.stringify({ format: 'something-else', version: 1, transactions: [] })],
  ])('%s: starts empty and keeps the bad file aside', (_name, damage) => {
    recordOne(tracker());
    const bad = damage(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, bad);
    const t = tracker();
    expect(t.get(TX1)).toBeUndefined();
    const aside = fs.readdirSync(path.dirname(file)).filter((n) => n.includes('.unreadable-'));
    expect(aside).toHaveLength(1);
    expect(fs.readFileSync(path.join(path.dirname(file), aside[0]), 'utf8')).toBe(bad);
    // and the next record writes a good file again
    t.record(TX2, [input.boxId], [], '{}');
    expect(tracker().get(TX2)).toBeDefined();
  });

  it('an entry that cannot be read is skipped; the others are kept, and a copy of the file is kept aside', () => {
    const t = tracker();
    recordOne(t);
    t.record(TX2, [makeBox({ ergoTree: ME, value: ERG }).boxId], [], '{}');
    const body = JSON.parse(fs.readFileSync(file, 'utf8'));
    body.transactions[1].inputBoxIds = ['not an id'];
    fs.writeFileSync(file, JSON.stringify(body));
    const again = tracker();
    expect(again.get(TX1)).toBeDefined();
    expect(again.get(TX2)).toBeUndefined();
    expect(fs.readdirSync(path.dirname(file)).filter((n) => n.includes('.unreadable-'))).toHaveLength(1);
  });

  it('a record that cannot be written throws and keeps nothing, so nothing is submitted unrecorded', () => {
    const t = tracker();
    fs.writeFileSync(path.join(dir, 'state'), 'a file where the folder should be');
    expect(() => recordOne(t)).toThrow('nothing was submitted');
    expect(t.get(TX1)).toBeUndefined();
    expect(t.isSpent(input.boxId)).toBe(false);
  });

  it('a release that cannot be written is logged and forgotten; one that must be written is kept and throws', () => {
    const t = tracker();
    recordOne(t);
    const save = jest.spyOn(ErgoPendingFile.prototype, 'save').mockImplementation(() => {
      throw new Error('ENOSPC: no space left on device, write');
    });
    const error = jest.spyOn(logger, 'error').mockImplementation(() => logger);
    try {
      expect(() => t.release(TX1, { mustPersist: true })).toThrow('is still tracked');
      expect(t.get(TX1)).toBeDefined();
      expect(t.isSpent(input.boxId)).toBe(true);
      expect(() => t.release(TX1)).not.toThrow();
      expect(t.get(TX1)).toBeUndefined();
      expect(error.mock.calls.some(([m]) => String(m).includes('ENOSPC'))).toBe(true);
    } finally {
      save.mockRestore();
      error.mockRestore();
    }
  });

  it("another network's file stops start-up, and is neither moved aside nor overwritten", () => {
    recordOne(tracker('testnet'));
    const before = fs.readFileSync(file, 'utf8');
    expect(() => tracker('mainnet')).toThrow('belongs to network testnet, not mainnet');
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
    expect(fs.readdirSync(path.dirname(file))).toEqual([path.basename(file)]);
    // its own network still reads it
    expect(tracker('testnet').get(TX1)).toBeDefined();
  });

  it('the folder is synced after the rename, so the rename itself survives a power loss', () => {
    if (process.platform === 'win32') return;
    const nodeFs = jest.requireActual<typeof import('fs')>('fs');
    const order: string[] = [];
    const folders = new Set<number>();
    const realOpen = nodeFs.openSync;
    const realRename = nodeFs.renameSync;
    const realSync = nodeFs.fsyncSync;
    const open = jest.spyOn(nodeFs, 'openSync').mockImplementation(((p: fs.PathLike, ...rest: unknown[]) => {
      const fd = (realOpen as (...a: unknown[]) => number)(p, ...rest);
      if (String(p) === path.dirname(file)) folders.add(fd);
      return fd;
    }) as never);
    const rename = jest.spyOn(nodeFs, 'renameSync').mockImplementation((from, to) => {
      order.push('rename');
      return realRename(from, to);
    });
    const sync = jest.spyOn(nodeFs, 'fsyncSync').mockImplementation((fd) => {
      order.push(folders.has(fd) ? 'sync folder' : 'sync file');
      return realSync(fd);
    });
    try {
      recordOne(tracker());
    } finally {
      open.mockRestore();
      rename.mockRestore();
      sync.mockRestore();
    }
    expect(order).toEqual(['sync file', 'rename', 'sync folder']);
  });

  it('a folder that cannot be synced is logged, not thrown: the write itself succeeded', () => {
    const nodeFs = jest.requireActual<typeof import('fs')>('fs');
    const realOpen = nodeFs.openSync;
    const open = jest.spyOn(nodeFs, 'openSync').mockImplementation(((p: fs.PathLike, ...rest: unknown[]) => {
      if (String(p) === path.dirname(file)) throw Object.assign(new Error('EISDIR: not allowed'), { code: 'EISDIR' });
      return (realOpen as (...a: unknown[]) => number)(p, ...rest);
    }) as never);
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => logger);
    try {
      expect(() => recordOne(tracker())).not.toThrow();
      if (process.platform !== 'win32') {
        expect(warn.mock.calls.some(([m]) => String(m).includes('could not sync the folder'))).toBe(true);
      }
    } finally {
      open.mockRestore();
      warn.mockRestore();
    }
    expect(tracker().get(TX1)).toBeDefined();
  });

  it('a recorded time later than the time of loading is read as the time of loading', () => {
    recordOne(tracker('mainnet', () => 9e15));
    let now = 1_000_000;
    const again = tracker('mainnet', () => now);
    expect(again.get(TX1)!.submittedAt).toBe(now);
    // so it is not offered as recent for ever: one block time later, with the node listing
    // its input as unspent, its outputs are not offered
    now += 120_000;
    expect(again.available([input], ME)).toEqual([]);
  });

  it('a refused mark is kept across a restart, and cleared again', () => {
    const t = tracker();
    recordOne(t);
    t.markRefused(TX1, true);
    const again = tracker();
    expect(again.get(TX1)!.refused).toBe(true);
    // while refused, its outputs are not offered; its inputs stay hidden
    expect(again.available([], ME)).toEqual([]);
    expect(again.isSpent(input.boxId)).toBe(true);
    again.markRefused(TX1, false);
    expect(tracker().get(TX1)!.refused).toBeUndefined();
    expect(
      tracker()
        .available([], ME)
        .map((b) => b.boxId),
    ).toEqual([change.boxId]);
  });

  it('failed ids are kept across a restart with their reason, and only the newest are kept', () => {
    const t = tracker();
    recordOne(t);
    t.releaseFailed(TX1, 'Input x was spent by transaction y');
    const again = tracker();
    expect(again.get(TX1)).toBeUndefined();
    expect(again.failedReason(TX1)!.reason).toBe('Input x was spent by transaction y');

    // a list longer than the bound: the oldest are dropped, and the next write keeps the bound
    const id = (i: number) => i.toString(16).padStart(64, '0');
    const body = JSON.parse(fs.readFileSync(file, 'utf8'));
    body.failed = Array.from({ length: FAILED_KEPT + 1 }, (_, i) => ({ txId: id(i), reason: 'gone', at: i }));
    fs.writeFileSync(file, JSON.stringify(body));
    const long = tracker();
    expect(long.failedReason(id(0))).toBeUndefined();
    expect(long.failedReason(id(1))).toBeDefined();
    expect(long.failedReason(id(FAILED_KEPT))).toBeDefined();
    long.record(TX2, [input.boxId], [], '{}');
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).failed).toHaveLength(FAILED_KEPT);
  });

  it('an id recorded again is taken off the failed list, on disk too', () => {
    const t = tracker();
    recordOne(t);
    t.releaseFailed(TX1, 'Input x was spent by transaction y');
    expect(tracker().failedReason(TX1)).toBeDefined();
    recordOne(t);
    expect(t.failedReason(TX1)).toBeUndefined();
    const again = tracker();
    expect(again.failedReason(TX1)).toBeUndefined();
    expect(again.get(TX1)).toBeDefined();
  });

  it('a file written before failed ids were kept loads as before', () => {
    const at = Date.now();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({
        format: 'ergo-pending-transactions',
        version: 1,
        network: 'mainnet',
        transactions: [
          { txId: TX1, inputBoxIds: [input.boxId], fixedInputs: [], outputs: [], json: signedJson, submittedAt: at },
        ],
      }),
    );
    const t = tracker();
    expect(t.get(TX1)).toBeDefined();
    expect(t.failedReason(TX1)).toBeUndefined();
    expect(fs.readdirSync(path.dirname(file))).toEqual([path.basename(file)]);
  });

  it('a file that is there but cannot be opened stops start-up rather than starting without it', () => {
    fs.mkdirSync(file, { recursive: true }); // a folder where the file should be
    expect(() => tracker()).toThrow('Cannot open the pending-transaction file');
  });

  it('the chain reads pendingStateFile from its network config', () => {
    const config = testConfig({ pendingStateFile: file });
    new Ergo('mainnet', { config }).pending.record(TX1, [input.boxId], [], '{}');
    expect(new Ergo('mainnet', { config }).pending.isSpent(input.boxId)).toBe(true);
    // without the key nothing is written
    new Ergo('mainnet', { config: testConfig() }).pending.record(TX2, [input.boxId], [], '{}');
    expect(new Ergo('mainnet', { config }).pending.get(TX2)).toBeUndefined();
  });

  it('the shipped network templates keep the file under the git-ignored db folder, one per network', () => {
    const ignored = fs.readFileSync(path.join(__dirname, '../../../.gitignore'), 'utf8').split('\n');
    expect(ignored).toContain('/db');
    for (const net of ['mainnet', 'testnet']) {
      const text = fs.readFileSync(path.join(__dirname, '../../../src/templates/chains/ergo', `${net}.yml`), 'utf8');
      expect(text).toMatch(new RegExp(`^pendingStateFile: db/ergo/${net}-pending\\.json$`, 'm'));
      // and say that the file is one network's, in one process
      expect(text).toContain('Each network\n# needs its own file');
      expect(text).toContain('two Gateway\n# processes must not share one');
      // and when an entry leaves, including the one refused when posted again
      expect(text).toContain('one the node refuses\n# when posted again is kept and tried again later');
    }
  });

  it('the shipped compose file keeps the db folder, where the file is, across container upgrades', () => {
    const compose = fs.readFileSync(path.join(__dirname, '../../../docker-compose.yml'), 'utf8');
    const dockerfile = fs.readFileSync(path.join(__dirname, '../../../Dockerfile'), 'utf8');
    expect(dockerfile).toMatch(/^WORKDIR \/home\/gateway$/m); // the folder pendingStateFile is relative to
    expect(compose).toMatch(/^\s+- \.\/db:\/home\/gateway\/db$/m);
  });
});

it('after a restart, poll of a transaction the node dropped posts it again instead of answering not found', async () => {
  const config = testConfig({ pendingStateFile: file });
  const posted: string[] = [];
  const node = fakeNode((method, p, body) => {
    if (method === 'GET' && p === '/info') return { body: infoBody() };
    if (p.startsWith('/transactions/unconfirmed/byTransactionId/') || p.startsWith('/blockchain/transaction/byId/'))
      return notFound();
    if (p === '/blockchain/indexedHeight') return { body: { indexedHeight: TIP, fullHeight: TIP } };
    if (p === `/blockchain/box/byId/${input.boxId}`) return { body: nodeBoxJson(input) };
    if (method === 'POST' && p === '/transactions') {
      posted.push(body!);
      return { body: JSON.stringify(TX1) };
    }
    return undefined;
  });
  new Ergo('mainnet', { config, fetch: node.fetch }).pending.record(TX1, [input.boxId], [], signedJson);
  // a new process: nothing in memory, only the file
  const restarted = new Ergo('mainnet', { config, fetch: node.fetch });
  const r = await restarted.pollTransaction(TX1);
  expect(r.txStatus).toBe(TransactionStatusCode.PENDING);
  expect(posted).toEqual([signedJson]);
});
