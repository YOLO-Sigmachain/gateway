/**
 * /chains/ergo/* through the real Gateway app (Fastify inject), with the real Ergo chain
 * class and a node stand-in behind global fetch.
 */
import { FastifyInstance } from 'fastify';

import '../../../mocks/app-mocks';

import { gatewayApp } from '../../../../src/app';
import { Ergo } from '../../../../src/chains/ergo/ergo';
import { encodeErgoAddress } from '../../../../src/chains/ergo/ergo.utils';
import { TransactionStatusCode } from '../../../../src/schemas/chain-schema';
import { mockConfigStorage } from '../../../mocks/shared-mocks';
import {
  fakeNode,
  FakeRoute,
  FEE_TREE,
  GENERATOR_ADDRESSES,
  GENERATOR_PK,
  infoBody,
  makeBox,
  MAX_LONG,
  nodeBoxJson,
  notFound,
  p2pk,
  TIP,
} from '../ergo-test-helpers';

const ME = GENERATOR_ADDRESSES[0];
const TX = 'ab'.repeat(32);
const SIGUSD = '03faf2cb329f2e90d6d23b58d91bbb6c046aa143261cc21f52fbe2824bfcbf04';

const ergoConfig: Record<string, unknown> = {
  'ergo.defaultNetwork': 'mainnet',
  'ergo.defaultWallet': '<ergo-wallet-address>',
  'ergo-mainnet.nodeURL': 'http://node.test:9053',
  'ergo-mainnet.addressPrefix': 0,
  'ergo-mainnet.nativeCurrencySymbol': 'ERG',
  'ergo-mainnet.nativeDecimals': 9,
  'ergo-mainnet.minerFee': 1100000,
  'ergo-mainnet.minerFeeErgoTree': FEE_TREE,
  'ergo-mainnet.tokenListSource': 'tokens/ergo/mainnet.json',
  'ergo-mainnet.blockTimeSeconds': 120,
  'ergo-mainnet.pendingTxTimeoutBlocks': 15,
  'ergo-mainnet.confirmations': 1,
  'ergo-testnet.nodeURL': 'http://node.test:9052',
  'ergo-testnet.addressPrefix': 16,
  'ergo-testnet.nativeCurrencySymbol': 'ERG',
  'ergo-testnet.nativeDecimals': 9,
  'ergo-testnet.minerFee': '1100000',
  'ergo-testnet.minerFeeErgoTree': FEE_TREE,
  'ergo-testnet.tokenListSource': 'tokens/ergo/testnet.json',
  'ergo-testnet.blockTimeSeconds': 120,
  'ergo-testnet.pendingTxTimeoutBlocks': 15,
  'ergo-testnet.confirmations': 1,
};

const box = makeBox({
  ergoTree: p2pk(GENERATOR_PK),
  value: 2500000000n,
  assets: [{ tokenId: SIGUSD, amount: MAX_LONG }],
});

let route: FakeRoute = () => undefined;
const node = fakeNode((method, path, body) => {
  if (method === 'GET' && path === '/info') return { body: infoBody() };
  return route(method, path, body);
});

describe('/chains/ergo routes', () => {
  let fastify: FastifyInstance;
  const realFetch = globalThis.fetch;

  beforeAll(async () => {
    Object.assign(mockConfigStorage, ergoConfig);
    globalThis.fetch = node.fetch as unknown as typeof fetch;
    fastify = gatewayApp;
    await fastify.ready();
  });

  afterAll(async () => {
    globalThis.fetch = realFetch;
    await fastify.close();
  });

  beforeEach(() => {
    Ergo.clearInstances();
    route = () => undefined;
    // app-mocks replaces fs reads of any 'tokens' path with a Solana list; give the chain its own
    jest
      .spyOn(Ergo.prototype, 'getTokenList')
      .mockResolvedValue([{ address: SIGUSD, symbol: 'SigUSD', name: 'SigUSD', decimals: 2 }]);
  });

  it('GET /chains/ergo/status', async () => {
    const res = await fastify.inject({ method: 'GET', url: '/chains/ergo/status?network=mainnet' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      chain: 'ergo',
      network: 'mainnet',
      rpcUrl: 'http://node.test:9053',
      rpcProvider: 'url',
      currentBlockNumber: TIP,
      nativeCurrency: 'ERG',
      swapProvider: '',
    });
  });

  it('GET /chains/ergo/status on testnet uses that network config', async () => {
    const res = await fastify.inject({ method: 'GET', url: '/chains/ergo/status?network=testnet' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).rpcUrl).toBe('http://node.test:9052');
  });

  it('rejects a network of another chain', async () => {
    const res = await fastify.inject({ method: 'GET', url: '/chains/ergo/status?network=mainnet-beta' });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).message).toContain('is not a ergo network');
  });

  it('GET /chains/ergo/estimate-gas reports the configured miner fee', async () => {
    const res = await fastify.inject({ method: 'GET', url: '/chains/ergo/estimate-gas' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.fee).toBe('0.0011'); // DecimalNumber fields travel as decimal strings
    expect(body.feeAsset).toBe('ERG');
    expect(body.computeUnits).toBe(1);
  });

  it('POST /chains/ergo/balances', async () => {
    route = (method, path) =>
      method === 'POST' && path.startsWith('/blockchain/box/unspent/byAddress')
        ? { body: [nodeBoxJson(box)] }
        : undefined;
    const res = await fastify.inject({
      method: 'POST',
      url: '/chains/ergo/balances',
      payload: { network: 'mainnet', address: ME },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.balances).toEqual({ ERG: 2.5, SigUSD: 92233720368547760 });
    expect(body.tokens).toContainEqual({
      key: 'SigUSD',
      symbol: 'SigUSD',
      address: SIGUSD,
      balance: 92233720368547760,
    });
  });

  it('POST /chains/ergo/balances refuses an address of another network with 400', async () => {
    const res = await fastify.inject({
      method: 'POST',
      url: '/chains/ergo/balances',
      payload: { network: 'mainnet', address: GENERATOR_ADDRESSES[16] },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).message).toContain('network prefix 16');
  });

  it('POST /chains/ergo/balances with no address falls to the placeholder default wallet and refuses it', async () => {
    const res = await fastify.inject({ method: 'POST', url: '/chains/ergo/balances', payload: { network: 'mainnet' } });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).message).toContain('Invalid Ergo address');
  });

  it('POST /chains/ergo/poll: confirmed, pending, not found', async () => {
    const tx = { id: TX, inputs: [], outputs: [], inclusionHeight: TIP, numConfirmations: 1 };
    route = (_m, path) => (path === `/blockchain/transaction/byId/${TX}` ? { body: tx } : undefined);
    let res = await fastify.inject({
      method: 'POST',
      url: '/chains/ergo/poll',
      payload: { network: 'mainnet', signature: TX },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({
      txStatus: TransactionStatusCode.CONFIRMED,
      txBlock: TIP,
      currentBlock: TIP,
    });

    route = (_m, path) => {
      if (path.startsWith('/blockchain/transaction/byId/')) return notFound();
      if (path.startsWith('/transactions/unconfirmed/byTransactionId/'))
        return { body: { ...tx, inclusionHeight: undefined } };
      return undefined;
    };
    res = await fastify.inject({
      method: 'POST',
      url: '/chains/ergo/poll',
      payload: { network: 'mainnet', signature: TX },
    });
    expect(JSON.parse(res.body)).toMatchObject({ txStatus: TransactionStatusCode.PENDING, txBlock: null });

    route = (_m, path) => {
      if (path === '/blockchain/indexedHeight') return { body: { indexedHeight: TIP, fullHeight: TIP } };
      return notFound();
    };
    res = await fastify.inject({
      method: 'POST',
      url: '/chains/ergo/poll',
      payload: { network: 'mainnet', signature: TX },
    });
    expect(JSON.parse(res.body)).toMatchObject({ txStatus: TransactionStatusCode.NOT_FOUND, error: null });
  });

  it('POST /chains/ergo/poll surfaces the node error text', async () => {
    route = () => ({ status: 503, body: { error: 503, reason: 'service-unavailable', detail: 'node is syncing' } });
    const res = await fastify.inject({
      method: 'POST',
      url: '/chains/ergo/poll',
      payload: { network: 'mainnet', signature: TX },
    });
    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body).message).toContain('node is syncing');
  });

  it('POST /chains/ergo/wrap and /unwrap answer 501', async () => {
    let res = await fastify.inject({
      method: 'POST',
      url: '/chains/ergo/wrap',
      payload: { network: 'mainnet', address: ME, amount: '1' },
    });
    expect(res.statusCode).toBe(501);
    expect(JSON.parse(res.body).message).toContain('wrap does not apply to ergo');
    res = await fastify.inject({
      method: 'POST',
      url: '/chains/ergo/unwrap',
      payload: { network: 'mainnet', address: ME },
    });
    expect(res.statusCode).toBe(501);
    expect(JSON.parse(res.body).message).toContain('unwrap does not apply to ergo');
  });

  it('serves a prefix-32 network from config alone', async () => {
    Object.assign(mockConfigStorage, { 'ergo-mainnet.addressPrefix': 32, 'ergo-mainnet.nativeCurrencySymbol': 'YOLO' });
    try {
      route = (method, path) =>
        method === 'POST' && path.startsWith('/blockchain/box/unspent/byAddress')
          ? { body: [nodeBoxJson(box)] }
          : undefined;
      const yolo = encodeErgoAddress(p2pk(GENERATOR_PK), 32);
      expect(yolo).toBe(GENERATOR_ADDRESSES[32]);
      const res = await fastify.inject({
        method: 'POST',
        url: '/chains/ergo/balances',
        payload: { network: 'mainnet', address: yolo, tokens: ['YOLO'] },
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).balances).toEqual({ YOLO: 2.5 });
    } finally {
      Object.assign(mockConfigStorage, { 'ergo-mainnet.addressPrefix': 0, 'ergo-mainnet.nativeCurrencySymbol': 'ERG' });
    }
  });
});
