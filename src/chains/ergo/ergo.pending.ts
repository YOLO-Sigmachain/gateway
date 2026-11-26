/**
 * Boxes our own unconfirmed transactions spend and create.
 *
 * The node's mempool-aware box query (`includeUnconfirmed`, `excludeMempoolSpent`) covers
 * a transaction once the node holds it. This tracker covers the rest: the moment between
 * submit and the node's index catching up, a node restart that forgot the mempool, and a
 * second action built before the first is visible. Without it two actions in a row pick
 * the same boxes and the second is rejected as a double spend.
 *
 * It also keeps the outputs of our pending transactions, so the next transaction can spend
 * the unconfirmed change of the previous one (chained transactions).
 *
 * Entries leave only on evidence: when poll sees the transaction confirmed, or shown to
 * have failed (an input spent by another transaction, or rejected by the node). An Ergo
 * transaction does not expire; one the node dropped can still confirm while its inputs are
 * unspent, so it is never forgotten for its age alone. Once an entry is older than the
 * per-network timeout (pendingTxTimeoutBlocks x blockTimeSeconds) it is due for a check
 * against the node (see `Ergo`), at most once per `recheckMs`.
 *
 * A transaction is recorded before it is posted, so a submit whose answer is lost still
 * hides its inputs. Its signed JSON is kept so poll can post it again if the node drops it.
 * With a file (`ErgoPendingFile`), every change is written to disk and the list is read
 * back at start, so a restart forgets nothing either.
 */
import { logger } from '../../services/logger';

import type { ErgoPendingFile } from './ergo.pending-file';
import { ErgoBox } from './ergo.types';

/** A fixed input (a contract box such as a pool) and the transaction that created it. */
export interface PendingFixedInput {
  boxId: string;
  transactionId: string;
}

export interface PendingTransaction {
  txId: string;
  inputBoxIds: string[];
  /**
   * The inputs the caller fixed (contract boxes), a subset of `inputBoxIds`. They are not
   * at the wallet's address, so the node's wallet listing never shows them either way.
   */
  fixedInputs: PendingFixedInput[];
  outputs: ErgoBox[];
  /** The signed transaction as submitted, for a rebroadcast. */
  json: string;
  submittedAt: number;
}

export interface PendingTrackerOptions {
  /** For this long after recording, outputs are offered even while the node lists every input as unspent. */
  recentMs?: number;
  /** Least time between two checks of the same overdue entry. Default: `recentMs`, or the timeout. */
  recheckMs?: number;
  /** Where the list is kept across restarts. Without one it is kept in memory only. */
  file?: ErgoPendingFile;
}

export class ErgoPendingTracker {
  private readonly txs = new Map<string, PendingTransaction>();
  private readonly spentBy = new Map<string, string>();
  private readonly lastChecked = new Map<string, number>();
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly recentMs: number;
  private readonly recheckMs: number;
  private readonly file?: ErgoPendingFile;

  /**
   * @param timeoutMs After this long an entry is due for a check against the node; it is
   * not released for its age.
   * @param recentMs For this long after recording, a transaction's outputs are offered even
   * while the node still lists all its inputs as unspent (the node has not caught up yet).
   * After that they are offered only when the node shows at least one input as spent.
   */
  constructor(timeoutMs: number, now: () => number = Date.now, recent: number | PendingTrackerOptions = 0) {
    const options = typeof recent === 'number' ? { recentMs: recent } : recent;
    this.timeoutMs = timeoutMs;
    this.now = now;
    this.recentMs = options.recentMs ?? 0;
    this.recheckMs = options.recheckMs ?? (this.recentMs > 0 ? this.recentMs : timeoutMs);
    this.file = options.file;
    for (const tx of this.file?.load() ?? []) this.insert(tx);
  }

  /**
   * Record a transaction about to be submitted, or one the node accepted. With a file, the
   * entry is on disk when this returns; if it cannot be written the entry is dropped again
   * and this throws, so nothing is submitted that a restart would forget. With
   * `mustPersist: false` (a transaction already submitted) a write failure is logged.
   */
  record(
    txId: string,
    inputBoxIds: string[],
    outputs: ErgoBox[],
    json: string,
    fixedInputs: PendingFixedInput[] = [],
    options: { mustPersist?: boolean } = {},
  ): void {
    this.insert({
      txId,
      inputBoxIds: [...inputBoxIds],
      fixedInputs: fixedInputs.map((f) => ({ ...f })),
      outputs: outputs.map((o) => ({ ...o })),
      json,
      submittedAt: this.now(),
    });
    if (options.mustPersist === false) {
      this.persist();
      return;
    }
    try {
      this.file?.save([...this.txs.values()]);
    } catch (error) {
      this.remove(txId);
      throw new Error(
        `Could not write the pending-transaction file ${this.file?.file}: ` +
          `${error instanceof Error ? error.message : String(error)}; nothing was submitted`,
      );
    }
  }

  /** Forget a transaction: confirmed (the node's view now has it) or failed. */
  release(txId: string): void {
    if (this.remove(txId)) this.persist();
  }

  get(txId: string): PendingTransaction | undefined {
    return this.txs.get(txId);
  }

  isSpent(boxId: string): boolean {
    return this.spentBy.has(boxId);
  }

  /** Every box id our pending transactions spend. */
  spentBoxIds(): Set<string> {
    return new Set(this.spentBy.keys());
  }

  /** The tracked transaction that creates this box, if any. */
  producerOf(boxId: string): string | undefined {
    for (const tx of this.txs.values()) if (tx.outputs.some((o) => o.boxId === boxId)) return tx.txId;
    return undefined;
  }

  /**
   * Entries older than the timeout that have not been checked for `recheckMs`. Each one
   * returned is marked as checked now.
   */
  takeDueForCheck(): PendingTransaction[] {
    const now = this.now();
    const due: PendingTransaction[] = [];
    for (const tx of this.txs.values()) {
      if (now - tx.submittedAt < this.timeoutMs) continue;
      const last = this.lastChecked.get(tx.txId);
      if (last !== undefined && now - last < this.recheckMs) continue;
      this.lastChecked.set(tx.txId, now);
      due.push(tx);
    }
    return due;
  }

  /**
   * The boxes at `ergoTree` that are ours to spend: the node's view minus what our pending
   * transactions spend, plus the unspent outputs of those transactions the node does not
   * list yet. A transaction whose inputs the node still lists, all of them, as unspent is
   * one the node has forgotten (or never took) once `recentMs` has passed: its outputs are
   * not offered, so they cannot become phantom boxes. Its inputs stay hidden either way.
   */
  available(nodeBoxes: ErgoBox[], ergoTree: string): ErgoBox[] {
    const tree = ergoTree.toLowerCase();
    const result = nodeBoxes.filter((box) => !this.spentBy.has(box.boxId));
    const listed = new Set(nodeBoxes.map((box) => box.boxId));
    const offered = this.offeredTransactions(new Set(listed));
    for (const tx of this.txs.values()) {
      if (!offered.has(tx.txId)) continue;
      for (const output of tx.outputs) {
        if (output.ergoTree.toLowerCase() !== tree) continue;
        if (listed.has(output.boxId) || this.spentBy.has(output.boxId)) continue;
        result.push({ ...output, inclusionHeight: undefined });
        listed.add(output.boxId);
      }
    }
    return result;
  }

  /**
   * The pending transactions whose outputs may be offered. A transaction is offered when
   * every tracked transaction it spends from (its parents, for chained transactions) is
   * offered, and either it was recorded less than `recentMs` ago or the node shows one of
   * its inputs as spent. An input that is the output of a tracked parent never counts as
   * "the node shows it spent" on its own: the node never listed it, so its absence says
   * nothing. So when the node has forgotten a chain of our transactions, none of the
   * chain's outputs is offered, not only the first transaction's. A fixed input (a
   * contract box) never counts either: `nodeListed` is the wallet's own listing, which
   * never holds a contract box, so its absence there says nothing.
   */
  private offeredTransactions(nodeListed: Set<string>): Set<string> {
    const producer = new Map<string, string>();
    for (const tx of this.txs.values()) for (const o of tx.outputs) producer.set(o.boxId, tx.txId);
    const memo = new Map<string, boolean>();
    const visit = (txId: string, depth: number): boolean => {
      const known = memo.get(txId);
      if (known !== undefined) return known;
      const tx = this.txs.get(txId);
      if (!tx || depth > this.txs.size) return false;
      memo.set(txId, false); // a cycle cannot happen (ids are hashes); guard anyway
      let ok = true;
      let nodeSeesASpend = false;
      const fixed = new Set(tx.fixedInputs.map((f) => f.boxId));
      for (const boxId of tx.inputBoxIds) {
        const parent = producer.get(boxId);
        if (parent !== undefined && parent !== txId) {
          if (!visit(parent, depth + 1)) ok = false;
        } else if (!fixed.has(boxId) && !nodeListed.has(boxId)) {
          nodeSeesASpend = true;
        }
      }
      // a spent parent output the node does not list is consistent with our chain having
      // reached the node, once the parent itself is offered
      if (ok && !nodeSeesASpend) {
        nodeSeesASpend = tx.inputBoxIds.some((boxId) => producer.has(boxId) && !nodeListed.has(boxId));
      }
      const recent = this.now() - tx.submittedAt < this.recentMs;
      const result = ok && (recent || nodeSeesASpend);
      memo.set(txId, result);
      return result;
    };
    const offered = new Set<string>();
    for (const txId of this.txs.keys()) if (visit(txId, 0)) offered.add(txId);
    return offered;
  }

  private insert(tx: PendingTransaction): void {
    this.txs.set(tx.txId, tx);
    for (const boxId of tx.inputBoxIds) this.spentBy.set(boxId, tx.txId);
  }

  private remove(txId: string): boolean {
    const tx = this.txs.get(txId);
    if (!tx) return false;
    this.txs.delete(txId);
    this.lastChecked.delete(txId);
    for (const boxId of tx.inputBoxIds) {
      if (this.spentBy.get(boxId) === txId) this.spentBy.delete(boxId);
    }
    return true;
  }

  /** Write the list; a failure is logged (memory stays right, the file catches up on the next write). */
  private persist(): void {
    if (!this.file) return;
    try {
      this.file.save([...this.txs.values()]);
    } catch (error) {
      logger.error(
        `Could not write the pending-transaction file ${this.file.file}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
