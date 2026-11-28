/**
 * The pending-transaction list on disk, so that a restart does not forget a transaction
 * that was submitted and may still confirm.
 *
 * What is written: per transaction, its id, the ids of the boxes it spends (and, for a
 * fixed contract input, the transaction that created it), its outputs, the signed
 * transaction as it was submitted, when it was recorded, and whether the node refused it
 * the last time it was posted again. Optionally, `failed`: the ids of transactions shown
 * unable to confirm, with the reason and when. A signed transaction is public once
 * submitted; no key, mnemonic or other secret is ever written.
 *
 * One file serves one network in one Gateway process: every write replaces the whole
 * file with this process's list, so two processes sharing a file lose each other's
 * entries. A file of another network stops start-up.
 *
 * The whole list is written on every change, to a temporary file that is then renamed
 * over the old one, and the folder is synced after the rename, so a crash leaves either
 * the old list or the new one, never half of one. A missing file is an empty list. A file
 * whose contents cannot be read (truncated, not JSON, another format) is moved aside under
 * a new name, with a warning, and the list starts empty. A file that exists but cannot be
 * opened, or that belongs to another network, is an error: it may hold live entries. An
 * entry that cannot be read is skipped, with a warning, and a copy of the file is kept
 * aside. A recorded time later than the time of loading is read as the time of loading.
 */
import * as fs from 'fs';
import * as path from 'path';

import { logger } from '../../services/logger';

import { bigintsToStrings } from './ergo.json';
import { normalizeNodeBox } from './ergo.node-client';
import type { FailedTransaction, PendingTransaction } from './ergo.pending';
import { isErgoId } from './ergo.utils';

const FORMAT = 'ergo-pending-transactions';
const VERSION = 1;

export interface PendingFileContents {
  transactions: PendingTransaction[];
  failed: FailedTransaction[];
}

export class ErgoPendingFile {
  readonly file: string;
  readonly network: string;

  constructor(file: string, network: string) {
    this.file = file;
    this.network = network;
  }

  /**
   * The transactions and failed ids in the file; empty if there is none or it cannot be
   * read. `now` is the time of loading.
   */
  load(now: number = Date.now()): PendingFileContents {
    const empty = (): PendingFileContents => ({ transactions: [], failed: [] });
    let text: string;
    try {
      text = fs.readFileSync(this.file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return empty();
      // a file that is there but cannot be opened may hold live entries: do not start without them
      throw new Error(
        `Cannot open the pending-transaction file ${this.file}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      this.setAside('rename', 'it is not valid JSON (truncated or damaged)');
      return empty();
    }
    const top = body as {
      format?: unknown;
      version?: unknown;
      network?: unknown;
      transactions?: unknown;
      failed?: unknown;
    };
    if (!top || typeof top !== 'object' || top.format !== FORMAT || top.version !== VERSION) {
      this.setAside('rename', `it is not a version ${VERSION} ${FORMAT} file`);
      return empty();
    }
    if (top.network !== this.network) {
      // another network's live entries: never moved aside, never overwritten
      throw new Error(
        `The pending-transaction file ${this.file} belongs to network ${String(top.network)}, not ` +
          `${this.network}; give each network its own pendingStateFile`,
      );
    }
    if (!Array.isArray(top.transactions)) {
      this.setAside('rename', 'it has no transaction list');
      return empty();
    }
    const loaded: PendingTransaction[] = [];
    let skipped = 0;
    for (const raw of top.transactions) {
      const tx = readEntry(raw, now);
      if (tx) loaded.push(tx);
      else skipped += 1;
    }
    const failed: FailedTransaction[] = [];
    if (top.failed !== undefined) {
      for (const raw of Array.isArray(top.failed) ? top.failed : [top.failed]) {
        const f = readFailed(raw);
        if (f) failed.push(f);
        else skipped += 1;
      }
    }
    if (skipped > 0) this.setAside('copy', `${skipped} of its entries cannot be read; those are skipped`);
    return { transactions: loaded, failed };
  }

  /** Replace the file's contents with `txs` and `failed`, atomically. Throws if it cannot be written. */
  save(txs: PendingTransaction[], failed: FailedTransaction[] = []): void {
    const body = {
      format: FORMAT,
      version: VERSION,
      network: this.network,
      transactions: txs.map((tx) => bigintsToStrings(tx)),
      ...(failed.length > 0 ? { failed: failed.map((f) => ({ txId: f.txId, reason: f.reason, at: f.at })) } : {}),
    };
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${process.pid}.tmp`;
    const fd = fs.openSync(temporary, 'w', 0o600);
    try {
      fs.writeSync(fd, JSON.stringify(body));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temporary, this.file);
    this.syncFolder();
  }

  /** Make the rename itself durable. Not on Windows, where a folder cannot be opened so. */
  private syncFolder(): void {
    if (process.platform === 'win32') return;
    try {
      const fd = fs.openSync(path.dirname(this.file), 'r');
      try {
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    } catch (error) {
      logger.warn(
        `Ergo ${this.network}: could not sync the folder of ${this.file} after writing it: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private setAside(how: 'rename' | 'copy', why: string): void {
    const aside = `${this.file}.unreadable-${Date.now()}`;
    try {
      if (how === 'rename') fs.renameSync(this.file, aside);
      else fs.copyFileSync(this.file, aside);
      logger.warn(`Ergo ${this.network}: pending-transaction file ${this.file} ${why}; kept as ${aside}`);
    } catch (error) {
      logger.warn(
        `Ergo ${this.network}: pending-transaction file ${this.file} ${why}, and it could not be kept aside: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

function readEntry(raw: unknown, now: number): PendingTransaction | null {
  try {
    const e = raw as Record<string, unknown>;
    const ids = (value: unknown): string[] => {
      if (!Array.isArray(value) || value.some((id) => !isErgoId(id))) throw new Error('bad ids');
      return (value as string[]).map((id) => id.toLowerCase());
    };
    if (!isErgoId(e.txId) || typeof e.json !== 'string' || !Number.isFinite(e.submittedAt)) return null;
    const fixed = e.fixedInputs;
    if (!Array.isArray(fixed)) return null;
    const outputs = e.outputs;
    if (!Array.isArray(outputs)) return null;
    return {
      txId: String(e.txId).toLowerCase(),
      inputBoxIds: ids(e.inputBoxIds),
      fixedInputs: fixed.map((f: Record<string, unknown>) => {
        const [boxId, transactionId] = ids([f?.boxId, f?.transactionId]);
        return { boxId, transactionId };
      }),
      outputs: outputs.map((o: Record<string, unknown>) => ({
        ...normalizeNodeBox(o),
        inclusionHeight: undefined,
      })),
      json: e.json,
      // a time ahead of the clock would make the entry look recent for ever
      submittedAt: Math.min(Number(e.submittedAt), now),
      ...(e.refused === true ? { refused: true } : {}),
      ...(typeof e.walletErgoTree === 'string' && /^([0-9a-fA-F]{2})+$/.test(e.walletErgoTree)
        ? { walletErgoTree: e.walletErgoTree.toLowerCase() }
        : {}),
    };
  } catch {
    return null;
  }
}

function readFailed(raw: unknown): FailedTransaction | null {
  const f = raw as Record<string, unknown> | null;
  if (!f || !isErgoId(f.txId) || typeof f.reason !== 'string' || !Number.isFinite(f.at)) return null;
  return { txId: String(f.txId).toLowerCase(), reason: f.reason, at: Number(f.at) };
}
