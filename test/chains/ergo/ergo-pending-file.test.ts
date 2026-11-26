/**
 * Pending transactions on disk: written atomically on every change, read back at start,
 * and a missing, truncated or foreign file starts an empty list with the bad file kept
 * aside. Every file here is in a fresh temporary directory, never in the repository.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { Ergo } from '../../../src/chains/ergo/ergo';
import { ErgoPendingTracker } from '../../../src/chains/ergo/ergo.pending';
import { ErgoPendingFile } from '../../../src/chains/ergo/ergo.pending-file';
import { TransactionStatusCode } from '../../../src/schemas/chain-schema';

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
    ['another network', (text: string) => text.replace('"network":"mainnet"', '"network":"testnet"')],
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
    }
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
