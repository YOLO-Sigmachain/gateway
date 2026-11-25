/**
 * Boxes our own unconfirmed transactions spend and create (T-5, D12).
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
 * Entries leave when poll sees the transaction confirmed, when it is shown to have failed,
 * or after a per-network timeout (pendingTxTimeoutBlocks x blockTimeSeconds).
 *
 * A transaction is recorded before it is posted, so a submit whose answer is lost still
 * hides its inputs. Its signed JSON is kept so poll can post it again if the node drops it.
 */
import { ErgoBox } from './ergo.types';

export interface PendingTransaction {
  txId: string;
  inputBoxIds: string[];
  outputs: ErgoBox[];
  /** The signed transaction as submitted, for a rebroadcast. */
  json: string;
  submittedAt: number;
}

export class ErgoPendingTracker {
  private readonly txs = new Map<string, PendingTransaction>();
  private readonly spentBy = new Map<string, string>();
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly recentMs: number;

  /**
   * @param recentMs For this long after recording, a transaction's outputs are offered even
   * while the node still lists all its inputs as unspent (the node has not caught up yet).
   * After that they are offered only when the node shows at least one input as spent.
   */
  constructor(timeoutMs: number, now: () => number = Date.now, recentMs = 0) {
    this.timeoutMs = timeoutMs;
    this.now = now;
    this.recentMs = recentMs;
  }

  /** Record a transaction about to be submitted, or one the node accepted. */
  record(txId: string, inputBoxIds: string[], outputs: ErgoBox[], json: string): void {
    this.expire();
    this.txs.set(txId, {
      txId,
      inputBoxIds: [...inputBoxIds],
      outputs: outputs.map((o) => ({ ...o })),
      json,
      submittedAt: this.now(),
    });
    for (const boxId of inputBoxIds) this.spentBy.set(boxId, txId);
  }

  /** Forget a transaction: confirmed (the node's view now has it) or failed. */
  release(txId: string): void {
    const tx = this.txs.get(txId);
    if (!tx) return;
    this.txs.delete(txId);
    for (const boxId of tx.inputBoxIds) {
      if (this.spentBy.get(boxId) === txId) this.spentBy.delete(boxId);
    }
  }

  get(txId: string): PendingTransaction | undefined {
    this.expire();
    return this.txs.get(txId);
  }

  isSpent(boxId: string): boolean {
    this.expire();
    return this.spentBy.has(boxId);
  }

  /** Every box id our pending transactions spend. */
  spentBoxIds(): Set<string> {
    this.expire();
    return new Set(this.spentBy.keys());
  }

  /**
   * The boxes at `ergoTree` that are ours to spend: the node's view minus what our pending
   * transactions spend, plus the unspent outputs of those transactions the node does not
   * list yet. A transaction whose inputs the node still lists, all of them, as unspent is
   * one the node has forgotten (or never took) once `recentMs` has passed: its outputs are
   * not offered, so they cannot become phantom boxes. Its inputs stay hidden either way.
   */
  available(nodeBoxes: ErgoBox[], ergoTree: string): ErgoBox[] {
    this.expire();
    const tree = ergoTree.toLowerCase();
    const result = nodeBoxes.filter((box) => !this.spentBy.has(box.boxId));
    const listed = new Set(nodeBoxes.map((box) => box.boxId));
    const nodeListed = new Set(listed);
    for (const tx of this.txs.values()) {
      const recent = this.now() - tx.submittedAt < this.recentMs;
      const nodeSeesASpend = tx.inputBoxIds.some((boxId) => !nodeListed.has(boxId));
      if (!recent && !nodeSeesASpend) continue;
      for (const output of tx.outputs) {
        if (output.ergoTree.toLowerCase() !== tree) continue;
        if (listed.has(output.boxId) || this.spentBy.has(output.boxId)) continue;
        result.push({ ...output, inclusionHeight: undefined });
        listed.add(output.boxId);
      }
    }
    return result;
  }

  private expire(): void {
    const cutoff = this.now() - this.timeoutMs;
    for (const tx of [...this.txs.values()]) {
      if (tx.submittedAt < cutoff) this.release(tx.txId);
    }
  }
}
