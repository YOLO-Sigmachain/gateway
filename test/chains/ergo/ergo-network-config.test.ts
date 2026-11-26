/**
 * The network config as the chain reads it: the depth that reports a lost race as failed
 * comes from failedAfterConfirmations, and falls back to confirmations when it is not set.
 */
import '../../mocks/app-mocks';

import { getErgoNetworkConfig } from '../../../src/chains/ergo/ergo.config';
import { mockConfigStorage } from '../../mocks/shared-mocks';

import { FEE_TREE } from './ergo-test-helpers';

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
  'ergo-mainnet.confirmations': 2,
};

describe('failedAfterConfirmations in the network config', () => {
  const keys = [...Object.keys(ergoMainnet), 'ergo-mainnet.failedAfterConfirmations'];
  let saved: Record<string, unknown>;

  beforeEach(() => {
    saved = Object.fromEntries(keys.map((k) => [k, mockConfigStorage[k]]));
    Object.assign(mockConfigStorage, ergoMainnet);
    delete mockConfigStorage['ergo-mainnet.failedAfterConfirmations'];
  });

  afterEach(() => {
    for (const k of keys) {
      if (saved[k] === undefined) delete mockConfigStorage[k];
      else mockConfigStorage[k] = saved[k];
    }
  });

  it('is read when it is set, and confirmations stays as it is', () => {
    mockConfigStorage['ergo-mainnet.failedAfterConfirmations'] = 3;
    const config = getErgoNetworkConfig('mainnet');
    expect(config.failedAfterConfirmations).toBe(3);
    expect(config.confirmations).toBe(2);
  });

  it('a config file without it uses confirmations', () => {
    const config = getErgoNetworkConfig('mainnet');
    expect(config.failedAfterConfirmations).toBe(2);
    expect(config.confirmations).toBe(2);
  });
});
