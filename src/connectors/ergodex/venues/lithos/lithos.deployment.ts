/**
 * The LithosDex deployment check, ported from the Lithos client (`LDDeployments.verify`,
 * `verifyT2T` and `vaultStands`). Every deployment's contracts are the same pinned
 * templates with its own ids written in. A pool box belongs to a deployment only when:
 * - the contracts rebuilt from its own ids (pool NFT at token 0, provision token as its
 *   last token, vault NFT read from the vault-NFT term of its own tree) reproduce its
 *   tree byte for byte; and
 * - exactly one confirmed unspent box carries that vault NFT, and its tree is the vault
 *   contract rebuilt from the pool NFT and the provision token.
 * The pool tree does not name the provision token, so only the vault ties it to the
 * deployment. This does not prove how the pool was minted; that is why an operator
 * allowlist sits on top.
 *
 * Rebuilding is substitution only, no compiling: each term is a 32-byte byte-array
 * constant written in the template as `0e 20 <32 sentinel bytes>`, so a deployment's
 * contract is the template with each sentinel replaced by that deployment's value. The
 * hashes linking the contracts are blake2b256:
 *   logic  = provisionLogicValue(poolNft, vaultNft)
 *   guard  = provisionGuardTree(blake2b256(logic))
 *   pool   = poolTree(vaultNft, blake2b256(guard))
 *   vault  = feeVaultTree(poolNft, provisionToken)
 * The templates and sentinels come from config.
 */
import { ErgoMessage } from '@fleet-sdk/core';

import { LithosKindTemplates, LithosVenueConfig } from '../../ergodex.config';
import { VenueNodeReader } from '../venue';

import { LithosKind } from './lithos.math';

type SentinelName = keyof LithosVenueConfig['sentinels'];

export function blake2b256Hex(hex: string): string {
  return Buffer.from(ErgoMessage.fromData(Uint8Array.from(Buffer.from(hex, 'hex'))).hash).toString('hex');
}

/**
 * A template with named 32-byte terms. Each term must appear in the template exactly
 * once, as a byte-array constant; positions are byte-aligned.
 */
export class TemplateSlots {
  readonly template: string;
  private readonly slots: Array<{ name: SentinelName; at: number }>;

  constructor(template: string, terms: Array<[SentinelName, string]>, where: string) {
    this.template = template.toLowerCase();
    this.slots = terms
      .map(([name, sentinel]) => {
        const marker = '0e20' + sentinel;
        const found: number[] = [];
        for (let i = this.template.indexOf(marker); i >= 0; i = this.template.indexOf(marker, i + 1)) {
          if (i % 2 === 0) found.push(i + 4);
        }
        if (found.length !== 1) {
          throw new Error(`${where}: term ${name} must appear exactly once in the template, found ${found.length}`);
        }
        return { name, at: found[0] };
      })
      .sort((a, b) => a.at - b.at);
  }

  /** The template with each term's value (64 hex) written in. */
  fill(values: Partial<Record<SentinelName, string>>): string {
    let out = '';
    let pos = 0;
    for (const { name, at } of this.slots) {
      const v = values[name];
      if (typeof v !== 'string' || !/^[0-9a-f]{64}$/.test(v)) throw new Error(`term ${name} must be 32 bytes of hex`);
      out += this.template.slice(pos, at) + v;
      pos = at + 64;
    }
    return out + this.template.slice(pos);
  }

  /** The term values when `hex` is this template with any 32 bytes at each term; else null. */
  match(hex: string): Partial<Record<SentinelName, string>> | null {
    const h = hex.toLowerCase();
    if (h.length !== this.template.length) return null;
    const values: Partial<Record<SentinelName, string>> = {};
    let pos = 0;
    for (const { name, at } of this.slots) {
      if (h.slice(pos, at) !== this.template.slice(pos, at)) return null;
      values[name] = h.slice(at, at + 64);
      pos = at + 64;
    }
    return h.slice(pos) === this.template.slice(pos) ? values : null;
  }
}

interface KindSlots {
  pool: TemplateSlots;
  vault: TemplateSlots;
  logic: TemplateSlots;
}

export interface LithosDeploymentIds {
  kind: LithosKind;
  poolNft: string;
  vaultNft: string;
  provisionToken: string;
}

/** The rebuilt contracts of one deployment. */
export interface LithosDeploymentTrees {
  poolTree: string;
  feeVaultTree: string;
  provisionGuardTree: string;
}

export class LithosDeployments {
  private readonly guard: TemplateSlots;
  private readonly kinds: Record<LithosKind, KindSlots>;

  constructor(config: LithosVenueConfig) {
    const s = config.sentinels;
    this.guard = new TemplateSlots(
      config.provisionGuardTree,
      [['provisionLogicHash', s.provisionLogicHash]],
      'lithos.provisionGuardTree',
    );
    const slots = (k: LithosKind, t: LithosKindTemplates): KindSlots => ({
      pool: new TemplateSlots(
        t.poolTree,
        [
          ['vaultNft', s.vaultNft],
          ['provisionGuardHash', s.provisionGuardHash],
        ],
        `lithos.${k}.poolTree`,
      ),
      vault: new TemplateSlots(
        t.feeVaultTree,
        [
          ['poolNft', s.poolNft],
          ['provisionToken', s.provisionToken],
        ],
        `lithos.${k}.feeVaultTree`,
      ),
      logic: new TemplateSlots(
        t.provisionLogicValue,
        [
          ['poolNft', s.poolNft],
          ['vaultNft', s.vaultNft],
        ],
        `lithos.${k}.provisionLogicValue`,
      ),
    });
    this.kinds = { n2t: slots('n2t', config.n2t), t2t: slots('t2t', config.t2t) };
  }

  /** The pool kind and vault NFT when `ergoTree` has the shape of a pool template; else null. */
  poolTemplateOf(ergoTree: string): { kind: LithosKind; vaultNft: string } | null {
    for (const kind of ['n2t', 't2t'] as const) {
      const m = this.kinds[kind].pool.match(ergoTree);
      if (m) return { kind, vaultNft: m.vaultNft! };
    }
    return null;
  }

  /** Every contract of the deployment these ids name, rebuilt from the templates. */
  rebuild(ids: LithosDeploymentIds): LithosDeploymentTrees {
    const k = this.kinds[ids.kind];
    const logic = k.logic.fill({ poolNft: ids.poolNft, vaultNft: ids.vaultNft });
    const provisionGuardTree = this.guard.fill({ provisionLogicHash: blake2b256Hex(logic) });
    const poolTree = k.pool.fill({ vaultNft: ids.vaultNft, provisionGuardHash: blake2b256Hex(provisionGuardTree) });
    const feeVaultTree = k.vault.fill({ poolNft: ids.poolNft, provisionToken: ids.provisionToken });
    return { poolTree, feeVaultTree, provisionGuardTree };
  }

  /**
   * The deployment check on a pool box's tree and ids, reading the vault from the node:
   * null when the pool belongs to the deployment its ids name, else the reason.
   */
  async check(ergoTree: string, ids: LithosDeploymentIds, node: VenueNodeReader): Promise<string | null> {
    const trees = this.rebuild(ids);
    if (trees.poolTree !== ergoTree.toLowerCase()) {
      return 'its tree is not the pool contract rebuilt from its own ids';
    }
    const vaults = await node.getUnspentBoxesByTokenId(ids.vaultNft, {
      limit: 2,
      includeUnconfirmed: false,
      excludeMempoolSpent: false,
    });
    if (vaults.length !== 1) {
      return `${vaults.length} confirmed unspent boxes carry its vault NFT ${ids.vaultNft}, not exactly one`;
    }
    if (vaults[0].ergoTree.toLowerCase() !== trees.feeVaultTree) {
      return `the box carrying its vault NFT ${ids.vaultNft} is not at the vault contract rebuilt from its ids`;
    }
    return null;
  }
}
