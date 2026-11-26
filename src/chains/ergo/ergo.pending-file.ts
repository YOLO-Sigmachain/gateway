/**
 * The pending-transaction list on disk, so that a restart does not forget a transaction
 * that was submitted and may still confirm.
 *
 * What is written: per transaction, its id, the ids of the boxes it spends (and, for a
 * fixed contract input, the transaction that created it), its outputs, the signed
 * transaction as it was submitted, and when it was recorded. A signed transaction is
 * public once submitted; no key, mnemonic or other secret is ever written.
 *
 * The whole list is written on every change, to a temporary file that is then renamed
 * over the old one, so a crash leaves either the old list or the new one, never half of
 * one. A missing file is an empty list. A file whose contents cannot be read (truncated,
 * not JSON, another format, another network) is moved aside under a new name, with a
 * warning, and the list starts empty. A file that exists but cannot be opened is an error:
 * it may hold live entries. An entry that cannot be read is skipped, with a warning, and a
 * copy of the file is kept aside.
 */
import * as fs from 'fs';
import * as path from 'path';

import { logger } from '../../services/logger';

import { bigintsToStrings } from './ergo.json';
import { normalizeNodeBox } from './ergo.node-client';
import type { PendingTransaction } from './ergo.pending';
import { isErgoId } from './ergo.utils';

const FORMAT = 'ergo-pending-transactions';
const VERSION = 1;

export class ErgoPendingFile {
  readonly file: string;
  readonly network: string;

  constructor(file: string, network: string) {
    this.file = file;
    this.network = network;
  }

  /** The transactions in the file; empty if there is none or it cannot be read. */
  load(): PendingTransaction[] {
    let text: string;
    try {
      text = fs.readFileSync(this.file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
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
      return [];
    }
    const top = body as { format?: unknown; version?: unknown; network?: unknown; transactions?: unknown };
    if (!top || typeof top !== 'object' || top.format !== FORMAT || top.version !== VERSION) {
      this.setAside('rename', `it is not a version ${VERSION} ${FORMAT} file`);
      return [];
    }
    if (top.network !== this.network) {
      this.setAside('rename', `it belongs to network ${String(top.network)}, not ${this.network}`);
      return [];
    }
    if (!Array.isArray(top.transactions)) {
      this.setAside('rename', 'it has no transaction list');
      return [];
    }
    const loaded: PendingTransaction[] = [];
    let skipped = 0;
    for (const raw of top.transactions) {
      const tx = readEntry(raw);
      if (tx) loaded.push(tx);
      else skipped += 1;
    }
    if (skipped > 0) this.setAside('copy', `${skipped} of its entries cannot be read; those are skipped`);
    return loaded;
  }

  /** Replace the file's contents with `txs`, atomically. Throws if it cannot be written. */
  save(txs: PendingTransaction[]): void {
    const body = {
      format: FORMAT,
      version: VERSION,
      network: this.network,
      transactions: txs.map((tx) => bigintsToStrings(tx)),
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

function readEntry(raw: unknown): PendingTransaction | null {
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
      submittedAt: Number(e.submittedAt),
    };
  } catch {
    return null;
  }
}
