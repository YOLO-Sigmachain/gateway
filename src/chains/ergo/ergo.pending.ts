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
 * An Ergo transaction does not expire; one the node dropped can still confirm while its
 * inputs are unspent, so it is never forgotten for its age alone. An entry leaves only:
 * - when it is confirmed;
 * - when it is shown failed: one of its inputs is spent by a different transaction that
 *   has at least the network's `failedAfterConfirmations`, or it spends an output of a transaction
 *   that failed that way. Such ids are remembered (newest 1,000), so poll keeps answering
 *   FAILED for them;
 * - once it is older than the per-network timeout (pendingTxTimeoutBlocks x
 *   blockTimeSeconds), when one of its inputs is known neither to the node's index nor as
 *   an output of a transaction tracked here;
 * - when the node refuses it at its first submit (nothing was taken).
 * A transaction the node refuses when it is posted again is kept, marked refused, and
 * posted again later: the node refuses a valid transaction too (a competing spend in its
 * mempool, a full mempool, one it already holds, a fee below its own minimum). While it is
 * marked refused its outputs are not offered; its inputs stay hidden.
 *
 * Once an entry is older than the timeout it is due for a check against the node (see
 * `Ergo`), at most once per `recheckMs`.
 *
 * A transaction is recorded before it is posted, so a submit whose answer is lost still
 * hides its inputs. Its signed JSON is kept so it can be posted again if the node drops it.
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
  /**
   * The node refused it the last time it was posted again. Its outputs are not offered
   * until a later post is accepted, or it is seen in a mempool or confirmed.
   */
  refused?: boolean;
}

/** A transaction released because it can never confirm, and why. */
export interface FailedTransaction {
  txId: string;
  reason: string;
  /** When it was released (ms). */
  at: number;
}

/** How many failed transaction ids are remembered (the newest). */
export const FAILED_KEPT = 1000;

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
  /** Failed ids, oldest first. */
  private readonly failed = new Map<string, FailedTransaction>();
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
    const stored = this.file?.load(this.now());
    for (const tx of stored?.transactions ?? []) this.insert(tx);
    for (const f of stored?.failed ?? []) this.rememberFailed(f);
  }

  /**
   * Record a transaction about to be submitted, or one the node accepted. With a file, the
   * entry is on disk when this returns; if it cannot be written the entry is dropped again
   * and this throws, so nothing is submitted that a restart would forget. With
   * `mustPersist: false` (a transaction already submitted) a write failure is logged. An
   * id recorded again is taken off the remembered-failed list: it is live again.
   */
  record(
    txId: string,
    inputBoxIds: string[],
    outputs: ErgoBox[],
    json: string,
    fixedInputs: PendingFixedInput[] = [],
    options: { mustPersist?: boolean } = {},
  ): void {
    const wasFailed = this.failed.get(txId);
    this.failed.delete(txId);
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
      this.write();
    } catch (error) {
      this.remove(txId);
      if (wasFailed) this.rememberFailed(wasFailed);
      throw new Error(
        `Could not write the pending-transaction file ${this.file?.file}: ` +
          `${error instanceof Error ? error.message : String(error)}; nothing was submitted`,
      );
    }
  }

  /**
   * Forget a transaction: confirmed (the node's view now has it), or no longer checkable. A
   * file write failure is logged. With `mustPersist: true` (a caller about to answer that the
   * transaction was not taken), a write failure puts the entry back and throws instead, so
   * the caller can tell that a restart would bring the entry back.
   */
  release(txId: string, options: { mustPersist?: boolean } = {}): void {
    const tx = this.txs.get(txId);
    if (!tx) return;
    this.remove(txId);
    if (!options.mustPersist) {
      this.persist();
      return;
    }
    try {
      this.write();
    } catch (error) {
      this.insert(tx);
      throw new Error(
        `Could not write the pending-transaction file ${this.file?.file}: ` +
          `${error instanceof Error ? error.message : String(error)}; transaction ${txId} is still tracked`,
      );
    }
  }

  /**
   * Release a transaction shown to be unable to confirm, and with it every tracked
   * transaction that spends one of its outputs, and theirs in turn: those inputs will never
   * exist. Each id released is remembered with its reason. Returns the ids released.
   */
  releaseFailed(txId: string, reason: string): string[] {
    const released: string[] = [];
    const queue: Array<{ txId: string; reason: string }> = [{ txId, reason }];
    while (queue.length > 0) {
      const next = queue.shift()!;
      const tx = this.txs.get(next.txId);
      if (!tx) continue;
      this.remove(next.txId);
      this.rememberFailed({ txId: next.txId, reason: next.reason, at: this.now() });
      released.push(next.txId);
      const outputs = new Set(tx.outputs.map((o) => o.boxId));
      for (const child of this.txs.values()) {
        const boxId = child.inputBoxIds.find((id) => outputs.has(id));
        if (boxId === undefined || queue.some((q) => q.txId === child.txId)) continue;
        queue.push({
          txId: child.txId,
          reason:
            `Input ${boxId} is an output of transaction ${next.txId}, which can no longer confirm; ` +
            'this transaction can no longer confirm either',
        });
      }
    }
    if (released.length > 0) this.persist();
    return released;
  }

  /** A transaction released by `releaseFailed`, if it is among the ones remembered. */
  failedReason(txId: string): FailedTransaction | undefined {
    return this.failed.get(txId);
  }

  /**
   * Mark or clear "the node refused it when it was posted again". A refused transaction's
   * outputs are not offered; its inputs stay hidden.
   */
  markRefused(txId: string, refused: boolean): void {
    const tx = this.txs.get(txId);
    if (!tx || Boolean(tx.refused) === refused) return;
    if (refused) tx.refused = true;
    else delete tx.refused;
    this.persist();
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
      if (tx.refused) return false; // the node refused it when posted again: no outputs to offer
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

  /** Remember a failed id as the newest, dropping the oldest beyond FAILED_KEPT. */
  private rememberFailed(entry: FailedTransaction): void {
    this.failed.delete(entry.txId);
    this.failed.set(entry.txId, { ...entry });
    while (this.failed.size > FAILED_KEPT) this.failed.delete(this.failed.keys().next().value!);
  }

  /** Write the list and the failed ids; throws if it cannot. */
  private write(): void {
    this.file?.save([...this.txs.values()], [...this.failed.values()]);
  }

  /** Write the list; a failure is logged (memory stays right, the file catches up on the next write). */
  private persist(): void {
    if (!this.file) return;
    try {
      this.write();
    } catch (error) {
      logger.error(
        `Could not write the pending-transaction file ${this.file.file}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
