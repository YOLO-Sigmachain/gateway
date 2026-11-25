/**
 * The unified trading routes, asked for chain `ergo` with no connector, read Ergo's own
 * swapProvider (A7), not Ethereum's.
 */
import '../../mocks/app-mocks';

import { resolveSwapConnector } from '../../../src/trading/common';
import { mockConfigStorage } from '../../mocks/shared-mocks';

import { FEE_TREE } from './ergo-test-helpers';

const fs = jest.requireActual<typeof import('fs')>('fs');
const path = jest.requireActual<typeof import('path')>('path');

const ergoMainnet: Record<string, unknown> = {
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
};

describe('default swap connector for chain ergo', () => {
  const keys = [...Object.keys(ergoMainnet), 'ergo-mainnet.swapProvider', 'ethereum-mainnet.swapProvider'];
  let saved: Record<string, unknown>;

  beforeEach(() => {
    saved = Object.fromEntries(keys.map((k) => [k, mockConfigStorage[k]]));
    Object.assign(mockConfigStorage, ergoMainnet, { 'ethereum-mainnet.swapProvider': 'uniswap/router' });
  });

  afterEach(() => {
    for (const k of keys) {
      if (saved[k] === undefined) delete mockConfigStorage[k];
      else mockConfigStorage[k] = saved[k];
    }
  });

  it("reads ergo-mainnet.swapProvider, not Ethereum's", () => {
    mockConfigStorage['ergo-mainnet.swapProvider'] = 'ergodex/amm';
    expect(resolveSwapConnector('ergo', 'mainnet', 'amm')).toBe('ergodex');
  });

  it('the shipped Ergo network templates name ergodex/amm, in the connector/type format', () => {
    for (const net of ['mainnet', 'testnet']) {
      const text = fs.readFileSync(path.join(__dirname, '../../../src/templates/chains/ergo', `${net}.yml`), 'utf8');
      expect(text).toMatch(/^swapProvider: ergodex\/amm$/m);
    }
  });

  it('with no ergo swapProvider configured, answers 400 naming ergo-mainnet', () => {
    delete mockConfigStorage['ergo-mainnet.swapProvider'];
    let error: (Error & { statusCode?: number }) | undefined;
    try {
      resolveSwapConnector('ergo', 'mainnet', 'router');
    } catch (e) {
      error = e as Error & { statusCode?: number };
    }
    expect(error?.statusCode).toBe(400);
    expect(error?.message).toContain('no swapProvider configured for ergo-mainnet');
  });
});
