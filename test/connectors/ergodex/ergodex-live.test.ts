/**
 * Live, read-only check against the local mainnet node. Skipped unless ERGO_LIVE_NODE=1.
 *
 * Discovers pools by exact tree, reads pool info and quotes for the three deep ERG pairs,
 * and builds a swap against the live pool box with a synthetic wallet box of a test key.
 * The build is signed locally with that test key so the real wasm reduces the live pool
 * script; nothing is sent: any POST to /transactions fails the test. Reads are GETs plus
 * the node's read-only box query by ErgoTree, one at a time, pages of 100.
 */
import { Ergo } from '../../../src/chains/ergo/ergo';
import { FetchLike } from '../../../src/chains/ergo/ergo.node-client';
import { verifySwapTransaction } from '../../../src/connectors/ergodex/amm-routes/executeSwap';
import { quoteResponse } from '../../../src/connectors/ergodex/amm-routes/quoteSwap';
import { Ergodex } from '../../../src/connectors/ergodex/ergodex';

import { dexConfig, ERG, ME, ROOT, signer, testConfig, TOKENS, walletBox } from './ergodex-test-helpers';

const LIVE = process.env.ERGO_LIVE_NODE === '1';
const NODE = 'http://127.0.0.1:9053';
const describeLive = LIVE ? describe : describe.skip;

const PAIRS = [
  { name: 'ERG/RSN', nft: 'cadac6db847a715e3577d8f2fbb2edfb2280f20924abf51bf83704a9ddc511b2', token: 'RSN' },
  { name: 'ERG/SigUSD', nft: '9916d75132593c8b07fe18bd8d583bda1652eed7565cf41a4738ddd90fc992ec', token: 'SigUSD' },
  { name: 'ERG/rsBTC', nft: '47a811c68e49f6bfa6629602037ee65f8d175ddbc7b64bdb65ad40599b812fd0', token: 'rsBTC' },
];

describeLive('live node, read-only', () => {
  const requests: string[] = [];
  const readOnly: FetchLike = async (input, init) => {
    const method = String(init?.method ?? 'GET');
    const path = new URL(input).pathname;
    requests.push(`${method} ${path}`);
    if (method !== 'GET' && !(method === 'POST' && path === '/blockchain/box/unspent/byErgoTree')) {
      throw new Error(`live test refuses ${method} ${path}`);
    }
    return (globalThis.fetch as unknown as FetchLike)(input, { ...init, headers: { ...(init?.headers as object) } });
  };
  const ergo = new Ergo('mainnet', {
    config: testConfig({ nodeURL: NODE, boxPageSize: 100, nodeTimeoutMs: 20000 }),
    fetch: readOnly,
  });
  jest.spyOn(ergo, 'getTokenList').mockResolvedValue(TOKENS);
  const dex = new Ergodex(
    'mainnet',
    ergo,
    dexConfig({ maxPoolFeePct: '3', minPoolNativeReserve: 100n * ERG, useMempoolSuccessor: true }),
    ROOT,
  );

  it('discovers pools by exact tree, skipping non-pools', async () => {
    const found = await dex.discoverPools();
    const n2t = found.filter((f) => f.pool.kind === 'n2t').length;
    const t2t = found.filter((f) => f.pool.kind === 't2t').length;
    const allowed = found.filter((f) => dex.guardFailure(f.pool) === null).length;
    console.log(`[live] pools: n2t ${n2t}, t2t ${t2t}, passing the mainnet guards ${allowed}`);
    expect(n2t).toBeGreaterThan(200);
    expect(t2t).toBeGreaterThan(200);
    for (const p of PAIRS) expect(found.some((f) => f.pool.poolId === p.nft)).toBe(true);
  }, 120000);

  it.each(PAIRS)(
    '$name: pool info, quotes both ways, and a swap built on the live box',
    async (p) => {
      const fresh = await dex.getFreshPool(p.nft);
      const { pool } = fresh;
      expect(dex.guardFailure(pool)).toBeNull();
      const erg = await dex.resolveToken('ERG');
      const token = await dex.resolveToken(p.token);
      const sell = dex.plan(fresh, erg, token, 'SELL', ERG);
      const back = dex.plan(fresh, token, erg, 'SELL', sell.swap.amountOut);
      const qSell = quoteResponse(sell, 1);
      const qBack = quoteResponse(back, 1);
      console.log(
        `[live] ${p.name}: box ${pool.box.boxId} (${fresh.source}) fee ${pool.feeNum}/${pool.feeDenom} reserves ` +
          `${pool.x.reserve} nanoERG / ${pool.y.reserve} raw; SELL 1 ERG -> ${qSell.amountOut} ${p.token} ` +
          `(price ${qSell.price}, min ${qSell.minAmountOut}); SELL ${qBack.amountIn} ${p.token} -> ${qBack.amountOut} ERG`,
      );

      const built = await ergo.buildTransaction({
        changeAddress: ME,
        inputs: [{ box: pool.box }],
        walletBoxes: [walletBox(3n * ERG)],
        outputs: [sell.successor],
      });
      verifySwapTransaction(sell, built);
      // reduce the live pool script with the real wasm, signing with a test key only; not sent
      const signed = await signer.signTransaction(built.unsigned, built.unsigned.inputs, built.unsigned.dataInputs, {
        headers: await ergo.node.getLastHeaders(10),
      });
      expect(signed.parsed.inputs[0].spendingProof.proofBytes).toBe('');
      console.log(`[live] ${p.name}: built and test-signed ${signed.id}; pool input reduced to true; not submitted`);
    },
    120000,
  );

  afterAll(() => {
    expect(requests.some((r) => r.startsWith('POST /transactions'))).toBe(false);
    console.log(
      `[live] node requests: ${requests.length} (${new Set(requests.map((r) => r.split(' ')[0])).size} methods)`,
    );
  });
});

it('the live check is opt-in (ERGO_LIVE_NODE=1)', () => {
  expect(typeof LIVE).toBe('boolean');
});
