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
import { symbolForMessage } from '../../../src/chains/ergo/ergo.utils';
import { Ergodex } from '../../../src/connectors/ergodex/ergodex';
import { logger } from '../../../src/services/logger';
import { tradingAmmRoutes } from '../../../src/trading/trading.routes';
import { fastifyWithTypeProvider } from '../../utils/testUtils';

import {
  checkTestConfig,
  ERG,
  makeDex,
  n2tPool,
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
  withoutSubmitMode,
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

  const checkConfig = (): ErgoNetworkConfig => checkTestConfig({ pendingStateFile: file });

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
        `1 ERG in and 23.693 RSN (${RSN.slice(0, 8)}…) out on spectrum:n2t pool ${NFT} box ${RSN_POOL.boxId} ` +
        `(confirmed), miner fee 0.0011 ERG; the wallet would change by -1.0011 ERG and 23.693 RSN (${RSN.slice(0, 8)}…)`,
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

  describe('a node refusal that repeats the signed swap, signatures included', () => {
    /** The node's refusal for a transaction above the cost limit, which prints the transaction. */
    const costRefusal = (body: string) => {
      const tx = JSON.parse(body);
      const printed =
        `ErgoTransaction(id: ${tx.id}, inputs: [${tx.inputs.map((i: unknown) => JSON.stringify(i)).join(',')}], ` +
        `dataInputs: [], outputs: [${tx.outputs.map((o: unknown) => JSON.stringify(o)).join(',')}], size: 400)`;
      return {
        status: 400,
        body: {
          error: 400,
          reason: 'bad.request',
          detail: `Malformed transaction: Transaction ${printed} has too high cost 1000001 (limit 1000000)`,
        },
      };
    };
    // the pool input's proof is empty (its contract needs no signature); the wallet's is not
    const proofsOf = (json: string): string[] =>
      parseNodeJson<PostedTx>(json)
        .inputs.map((i) => i.spendingProof.proofBytes)
        .filter((proof) => proof !== '');

    it.each([['check'], ['send']])('in %s mode: the answer and the log lines carry no proof bytes', async (mode) => {
      const spies = [jest.spyOn(logger, 'info'), jest.spyOn(logger, 'warn'), jest.spyOn(logger, 'error')];
      if (mode === 'send') {
        dex = makeDex(state, dexConfig(), ROOT, TOKENS, testConfig({ submitMode: 'send', pendingStateFile: file }));
        (Ergodex.getInstance as jest.Mock).mockImplementation(async () => dex);
      }
      state.check = costRefusal;
      state.submit = costRefusal;
      const res = await execute();
      expect(res.statusCode).toBe(400);
      const sentJson = mode === 'check' ? state.checked : state.posted;
      expect(sentJson).toHaveLength(1);
      expect(transactionPosts(state)).toEqual([mode === 'check' ? '/transactions/check' : '/transactions']);
      const message: string = JSON.parse(res.body).message;
      expect(message).toContain('Malformed transaction: Transaction ErgoTransaction(id: ');
      expect(message).toContain('"spendingProof":<redacted>');
      expect(proofsOf(sentJson[0]).length).toBeGreaterThan(0);
      const lines = spies.flatMap((spy) => spy.mock.calls.map((c) => c.map(String).join(' ')));
      for (const text of [message, ...lines]) {
        for (const proof of proofsOf(sentJson[0])) expect(text).not.toContain(proof);
        expect(text).not.toMatch(/proofBytes"\s*:\s*"[0-9a-f]/i);
      }
    });
  });

  it('a token named like another message is written in the 409 as the start of its id', async () => {
    const lookalike = 'ab'.repeat(32);
    const hostile = `TRANSACTION_TIMEOUT Transaction ${lookalike} pending`;
    const tokens = TOKENS.map((t) => (t.address === RSN ? { ...t, symbol: hostile, name: hostile } : t));
    dex = makeDex(state, dexConfig(), ROOT, tokens, checkConfig());
    (Ergodex.getInstance as jest.Mock).mockImplementation(async () => dex);
    const res = await app.inject({
      method: 'POST',
      url: '/trading/amm/execute-swap',
      payload: execBody({ quoteToken: RSN }),
    });
    expect(res.statusCode).toBe(409);
    const message: string = JSON.parse(res.body).message;
    expect(message).not.toContain('TRANSACTION_TIMEOUT');
    expect(message).not.toContain(lookalike);
    expect(message).toContain(`23.693 ${RSN.slice(0, 8)}… (${RSN.slice(0, 8)}…) out`);
    expect(transactionPosts(state)).toEqual(['/transactions/check']);
  });

  it('an unlisted token whose on-chain name is a listed symbol is told apart by the start of its id', async () => {
    const UNLISTED = 'c7'.repeat(32);
    const nft = 'fc'.repeat(32);
    state.pools.set(nft, [n2tPool({ x: 1000n * ERG, y: 5000000n, fee: 997, token: UNLISTED, nft })]);
    state.emission.set(UNLISTED, 1000000000n);
    state.tokenNames = new Map([[UNLISTED, 'RSN']]);
    const res = await app.inject({
      method: 'POST',
      url: '/trading/amm/execute-swap',
      payload: execBody({ quoteToken: UNLISTED, poolAddress: nft }),
    });
    expect(res.statusCode).toBe(409);
    const message: string = JSON.parse(res.body).message;
    expect(message).toContain(` RSN (${UNLISTED.slice(0, 8)}…) out on `);
    expect(message).not.toContain(`RSN (${RSN.slice(0, 8)}…)`);
    expect(message).toContain('1 ERG in');
    expect(transactionPosts(state)).toEqual(['/transactions/check']);
  });

  it('a symbol is written in a message as it is only when it is short and plain', () => {
    expect(symbolForMessage('RSN', RSN)).toBe('RSN');
    expect(symbolForMessage('WT_ERG', RSN)).toBe('WT_ERG');
    expect(symbolForMessage('ERG', null)).toBe('ERG');
    expect(symbolForMessage('a b', RSN)).toBe(`${RSN.slice(0, 8)}…`);
    expect(symbolForMessage('ABCDEFGHIJKLMNOPQ', RSN)).toBe(`${RSN.slice(0, 8)}…`);
    expect(symbolForMessage('', RSN)).toBe(`${RSN.slice(0, 8)}…`);
    expect(symbolForMessage('E R G', null)).toBe('native');
  });

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
    expect(message).toContain(`1 ERG in and 241.428628025 LIT (${LIT.slice(0, 8)}…) out on lithos:`);
    expect(lDex.ergo.pending.spentBoxIds().size).toBe(0);
    expect(fs.existsSync(file)).toBe(false);
  });
});

describe('ergodex with submitMode not set', () => {
  let app: ReturnType<typeof fastifyWithTypeProvider>;
  let state: NodeState;
  let dex: Ergodex;

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
    state = newNodeState();
    state.pools.set(NFT, [RSN_POOL]);
    state.wallet = [walletBox(5n * ERG)];
    dex = makeDex(state, dexConfig(), ROOT, TOKENS, withoutSubmitMode(testConfig()));
    jest.spyOn(Ergodex, 'getInstance').mockImplementation(async () => dex);
  });

  afterEach(() => jest.restoreAllMocks());

  it('execute-swap answers 503 that says how to set it: no node request, no key loaded, nothing signed', async () => {
    const getWallet = jest.spyOn(dex.ergo, 'getWallet');
    const sign = jest.spyOn(dex.ergo, 'signTransaction');
    const res = await app.inject({ method: 'POST', url: '/trading/amm/execute-swap', payload: execBody() });
    expect(res.statusCode).toBe(503);
    const body = JSON.parse(res.body);
    expect(body.message).toBe(
      'Failed to execute ergodex swap: ergo-mainnet.submitMode is not set. Add "submitMode: send" to send ' +
        'transactions, or "submitMode: check" to have the node only check them, to the network\'s config file, ' +
        'then restart Gateway. Nothing was signed or sent.',
    );
    expect(body).not.toHaveProperty('signature');
    expect(body.code).toBeUndefined();
    expect(state.calls).toEqual([]);
    expect(transactionPosts(state)).toEqual([]);
    expect(getWallet).not.toHaveBeenCalled();
    expect(sign).not.toHaveBeenCalled();
    expect(dex.ergo.pending.spentBoxIds().size).toBe(0);
  });

  it('a LithosDex execute-swap answers the same, and nothing is loaded', async () => {
    const lState = newNodeState();
    putPools(lState, [[LIT_POOL, LIT_VAULT]]);
    const lDex = makeLithosDex(lState, undefined, withoutSubmitMode(testConfig()));
    const getWallet = jest.spyOn(lDex.ergo, 'getWallet');
    (Ergodex.getInstance as jest.Mock).mockImplementation(async () => lDex);
    const res = await app.inject({
      method: 'POST',
      url: '/trading/amm/execute-swap',
      payload: execBody({ quoteToken: 'LIT', poolAddress: LIT_NFT }),
    });
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body).message).toContain('ergo-mainnet.submitMode is not set.');
    expect(lState.calls).toEqual([]);
    expect(getWallet).not.toHaveBeenCalled();
  });

  it('quote-swap and pool-info answer as before', async () => {
    const quote = await app.inject({
      method: 'GET',
      url:
        '/trading/amm/quote-swap?' +
        new URLSearchParams({
          chainNetwork: 'ergo-mainnet',
          connector: 'ergodex',
          baseToken: 'ERG',
          quoteToken: 'RSN',
          amount: '1',
          side: 'SELL',
          poolAddress: NFT,
        }),
    });
    expect(quote.statusCode).toBe(200);
    expect(JSON.parse(quote.body).amountOut).toBe('23.693');
    const info = await app.inject({
      method: 'GET',
      url: `/trading/amm/pool-info?connector=ergodex&chainNetwork=ergo-mainnet&poolAddress=${NFT}`,
    });
    expect(info.statusCode).toBe(200);
    expect(transactionPosts(state)).toEqual([]);
  });
});
