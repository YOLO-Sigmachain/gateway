/**
 * execute-swap with the network's submitMode `check`, through Fastify inject, with the real
 * chain layer, real fleet-sdk and real wasm signing, and a node stand-in. The signed swap
 * goes to the node's check endpoint only: never to the submit endpoint, never tracked, never
 * written to the pending file, and never answered as PENDING or with a signature. Covers
 * the node accepting it (409 with the id and the amounts), refusing it (400 with the node's
 * text), and giving no verdict (503, nothing was sent), on a Spectrum pool and on a
 * LithosDex pool (signed by the version-3 library).
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { ErgoNetworkConfig } from '../../../src/chains/ergo/ergo.config';
import { parseNodeJson } from '../../../src/chains/ergo/ergo.json';
import { WasmErgoSigner } from '../../../src/chains/ergo/ergo.signer';
import { Ergodex } from '../../../src/connectors/ergodex/ergodex';
import { tradingAmmRoutes } from '../../../src/trading/trading.routes';
import { fastifyWithTypeProvider } from '../../utils/testUtils';

import {
  ERG,
  makeDex,
  ME,
  ME_TREE,
  MNEMONIC_A,
  newNodeState,
  NodeState,
  RSN_POOL,
  testConfig,
  walletBox,
  dexConfig,
  ROOT,
  TOKENS,
  RSN,
} from './ergodex-test-helpers';
import {
  LIT,
  LIT_NFT,
  LIT_POOL,
  LIT_RSN_POOL,
  LIT_RSN_VAULT,
  LIT_VAULT,
  makeLithosDex,
  putPools,
} from './lithos-test-helpers';

jest.mock('../../../src/trading/learn-pool', () => ({ learnPool: jest.fn() }));

const NFT = RSN_POOL.assets[0].tokenId;
const execBody = (over: Record<string, unknown> = {}) => ({
  chainNetwork: 'ergo-mainnet',
  connector: 'ergodex',
  walletAddress: ME,
  baseToken: 'ERG',
  quoteToken: 'RSN',
  amount: 1,
  side: 'SELL',
  poolAddress: NFT,
  slippagePct: 1,
  ...over,
});

interface PostedTx {
  id: string;
  inputs: Array<{ boxId: string; spendingProof: { proofBytes: string; extension: Record<string, string> } }>;
}

/** The transaction with its signatures blanked: signing draws a fresh nonce each time. */
const withoutProofs = (json: string): unknown => {
  const tx = parseNodeJson<PostedTx>(json);
  return { ...tx, inputs: tx.inputs.map((i) => ({ ...i, spendingProof: { ...i.spendingProof, proofBytes: '' } })) };
};

/** Every POST the stand-in node saw to a /transactions path. */
const transactionPosts = (state: NodeState): string[] =>
  state.calls.filter((c) => c.method === 'POST' && c.path.startsWith('/transactions')).map((c) => c.path);

describe('ergodex execute-swap with submitMode check', () => {
  let app: ReturnType<typeof fastifyWithTypeProvider>;
  let state: NodeState;
  let dex: Ergodex;
  let dir: string;
  let file: string;

  const checkConfig = (): ErgoNetworkConfig => testConfig({ submitMode: 'check', pendingStateFile: file });

  beforeAll(async () => {
    app = fastifyWithTypeProvider();
    await app.register(require('@fastify/sensible'));
    await app.register(tradingAmmRoutes, { prefix: '/trading/amm' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ergo-check-'));
    file = path.join(dir, 'mainnet-pending.json');
    state = newNodeState();
    state.pools.set(NFT, [RSN_POOL]);
    state.wallet = [walletBox(5n * ERG)];
    dex = makeDex(state, dexConfig(), ROOT, TOKENS, checkConfig());
    jest.spyOn(Ergodex, 'getInstance').mockImplementation(async () => dex);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const execute = () => app.inject({ method: 'POST', url: '/trading/amm/execute-swap', payload: execBody() });

  it('the node accepts it: 409 with the id and the amounts, one POST to the check path, nothing tracked or written', async () => {
    const sign = jest.spyOn(dex.ergo, 'signTransaction');
    const res = await execute();
    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body);
    expect(body).not.toHaveProperty('signature');
    expect(body).not.toHaveProperty('status');
    expect(body.code).toBeUndefined();

    expect(transactionPosts(state)).toEqual(['/transactions/check']);
    expect(state.posted).toEqual([]);
    expect(state.checked.length).toBe(1);
    // the very JSON the signer wrote, byte for byte
    const signed = await sign.mock.results[0].value;
    expect(state.checked[0]).toBe(signed.json);
    const id = signed.id;
    expect(body.message).toBe(
      `Check only: the node accepted transaction ${id} as valid; nothing was sent. If it were sent, it would move ` +
        `1 ERG in and 23.693 RSN out on spectrum:n2t pool ${NFT} box ${RSN_POOL.boxId} (confirmed), miner fee ` +
        '0.0011 ERG; the wallet would change by -1.0011 ERG and 23.693 RSN',
    );
    expect(body.message).not.toContain('TRANSACTION_TIMEOUT');

    // nothing kept: no entry, no hidden box, no file
    expect(dex.ergo.pending.get(id)).toBeUndefined();
    expect(dex.ergo.pending.spentBoxIds().size).toBe(0);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('the checked JSON is what send mode would have posted, apart from the signatures', async () => {
    await execute();
    const sendState = newNodeState();
    sendState.pools.set(NFT, [RSN_POOL]);
    sendState.wallet = state.wallet;
    const sendDex = makeDex(sendState, dexConfig(), ROOT, TOKENS, testConfig({ submitMode: 'send' }));
    (Ergodex.getInstance as jest.Mock).mockImplementation(async () => sendDex);
    const sent = await execute();
    expect(sent.statusCode).toBe(200);
    expect(transactionPosts(sendState)).toEqual(['/transactions']);
    expect(JSON.parse(sent.body).signature).toBe(parseNodeJson<PostedTx>(state.checked[0]).id);
    expect(withoutProofs(state.checked[0])).toEqual(withoutProofs(sendState.posted[0]));
  });

  it('the wallet box and the pool box are selectable again in an immediate second request', async () => {
    const first = await execute();
    const second = await execute();
    expect(first.statusCode).toBe(409);
    expect(second.statusCode).toBe(409);
    expect(state.checked.length).toBe(2);
    const inputs = (json: string) => parseNodeJson<PostedTx>(json).inputs.map((i) => i.boxId);
    expect(inputs(state.checked[0])).toEqual([RSN_POOL.boxId, state.wallet[0].boxId]);
    expect(inputs(state.checked[1])).toEqual(inputs(state.checked[0]));
    expect(state.posted).toEqual([]);
    expect(fs.existsSync(file)).toBe(false);
  });

  it("the node refuses it: 400 with the node's text, said to be a check; nothing tracked", async () => {
    state.check = () => ({
      status: 400,
      body: { error: 400, reason: 'bad.request', detail: 'Malformed transaction: Script reduced to false' },
    });
    const res = await execute();
    expect(res.statusCode).toBe(400);
    const message: string = JSON.parse(res.body).message;
    expect(message).toContain('Check only, nothing was sent');
    expect(message).toContain('Malformed transaction: Script reduced to false');
    expect(transactionPosts(state)).toEqual(['/transactions/check']);
    expect(dex.ergo.pending.spentBoxIds().size).toBe(0);
    expect(fs.existsSync(file)).toBe(false);
  });

  it.each([
    ['a timeout', () => 'timeout' as const],
    ['a lost connection', () => 'throw' as const],
    ['a refused connection', () => 'refused' as const],
    ['a 5xx', () => ({ status: 500, body: { error: 500, reason: 'internal', detail: 'boom' } })],
    ['a 200 without an id', () => ({ body: '' })],
    ['another 4xx', () => ({ status: 404, body: { error: 404, reason: 'not-found', detail: null } })],
  ])(
    'the check gives no verdict (%s): 503 that says nothing was sent, never a timeout to poll',
    async (_name, check) => {
      state.check = check as NodeState['check'];
      const res = await execute();
      expect(res.statusCode).toBe(503);
      const body = JSON.parse(res.body);
      expect(body.message).toContain('could not be completed');
      expect(body.message).toContain('nothing was sent');
      expect(body.message).not.toContain('TRANSACTION_TIMEOUT');
      expect(body.code).toBeUndefined();
      expect(transactionPosts(state)).toEqual(['/transactions/check']);
      expect(dex.ergo.pending.spentBoxIds().size).toBe(0);
      expect(fs.existsSync(file)).toBe(false);
    },
  );

  it('a LithosDex swap is signed by the version-3 signer and goes to the check path too', async () => {
    const lState = newNodeState();
    putPools(lState, [
      [LIT_POOL, LIT_VAULT],
      [LIT_RSN_POOL, LIT_RSN_VAULT],
    ]);
    lState.wallet = [
      walletBox(5n * ERG, [
        { tokenId: LIT, amount: 2000n * ERG },
        { tokenId: RSN, amount: 5000n },
      ]),
    ];
    const lDex = makeLithosDex(lState, undefined, checkConfig());
    const v3Loads: jest.SpyInstance[] = [];
    jest.spyOn(lDex.ergo, 'getWallet').mockImplementation(async () => {
      const fresh = WasmErgoSigner.fromMnemonic(MNEMONIC_A);
      v3Loads.push(jest.spyOn(fresh, 'forTreeVersion3'));
      return { address: ME, ergoTree: ME_TREE, signer: fresh };
    });
    (Ergodex.getInstance as jest.Mock).mockImplementation(async () => lDex);
    const res = await app.inject({
      method: 'POST',
      url: '/trading/amm/execute-swap',
      payload: execBody({ quoteToken: 'LIT', poolAddress: LIT_NFT }),
    });
    expect(res.statusCode).toBe(409);
    expect(v3Loads.length).toBe(1);
    expect(v3Loads[0]).toHaveBeenCalledTimes(1);
    expect(transactionPosts(lState)).toEqual(['/transactions/check']);
    expect(lState.posted).toEqual([]);
    const tx = parseNodeJson<PostedTx>(lState.checked[0]);
    expect(tx.inputs[0].boxId).toBe(LIT_POOL.boxId);
    const message: string = JSON.parse(res.body).message;
    expect(message).toContain(`Check only: the node accepted transaction ${tx.id} as valid; nothing was sent`);
    expect(message).toContain('1 ERG in and 241.428628025 LIT out on lithos:');
    expect(lDex.ergo.pending.spentBoxIds().size).toBe(0);
    expect(fs.existsSync(file)).toBe(false);
  });
});
