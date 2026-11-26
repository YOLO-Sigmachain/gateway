import { parseNodeJson, stringifyWithBigInt, toAmount } from '../../../src/chains/ergo/ergo.json';
import { ErgoNodeClient, normalizeNodeBox } from '../../../src/chains/ergo/ergo.node-client';
import { formatUnits, parseUnits, toDecimalNumber } from '../../../src/chains/ergo/ergo.utils';

import {
  ABOVE_2_53,
  fakeNode,
  fixtureText,
  MAX_LONG,
  makeBox,
  nodeBoxJson,
  p2pk,
  GENERATOR_PK,
  tokenId,
} from './ergo-test-helpers';

describe('bigint-safe JSON at the node boundary', () => {
  const text = '{"a":9007199254740993,"b":9223372036854775807,"c":0,"d":1,"e":1.5,"f":-9223372036854775808,"g":"7"}';

  it('JSON.parse itself loses these values (the trap)', () => {
    const lossy = JSON.parse(text);
    expect(BigInt(lossy.a)).not.toBe(ABOVE_2_53);
    expect(BigInt(lossy.b)).not.toBe(MAX_LONG);
  });

  it('parseNodeJson keeps 2^53+1 and 2^63-1 exact as bigint', () => {
    const parsed = parseNodeJson<Record<string, unknown>>(text);
    expect(parsed.a).toBe(ABOVE_2_53);
    expect(parsed.b).toBe(MAX_LONG);
    expect(parsed.f).toBe(-9223372036854775808n);
  });

  it('keeps zero, one unit and safe integers as exact numbers, fractions as numbers', () => {
    const parsed = parseNodeJson<Record<string, unknown>>(text);
    expect(parsed.c).toBe(0);
    expect(parsed.d).toBe(1);
    expect(parsed.e).toBe(1.5);
    expect(parsed.g).toBe('7');
  });

  it('reads a real node /info (fullBlocksScore is above 2^53)', () => {
    const raw = fixtureText('mainnet-info.json');
    const info = parseNodeJson<Record<string, unknown>>(raw);
    const digits = /"fullBlocksScore"\s*:\s*(\d+)/.exec(raw)![1];
    expect(info.fullBlocksScore).toBe(BigInt(digits));
    expect(typeof info.fullHeight).toBe('number');
  });

  it('reads a real token whose emission (1e18) is above 2^53', () => {
    const token = parseNodeJson<Record<string, unknown>>(fixtureText('mainnet-token-lit.json'));
    expect(token.emissionAmount).toBe(1000000000000000000n);
  });

  it('stringifyWithBigInt writes bigints as plain JSON integers, digit for digit', () => {
    const out = stringifyWithBigInt({ x: MAX_LONG, y: [ABOVE_2_53, 1n, 0n], z: 'text' });
    expect(out).toBe('{"x":9223372036854775807,"y":[9007199254740993,1,0],"z":"text"}');
    expect(parseNodeJson<Record<string, unknown>>(out).x).toBe(MAX_LONG);
  });

  describe('toAmount', () => {
    it.each([
      [0, 0n],
      [1, 1n],
      ['9223372036854775807', MAX_LONG],
      [ABOVE_2_53, ABOVE_2_53],
    ])('accepts %p', (input, expected) => {
      expect(toAmount(input)).toBe(expected);
    });

    it.each([[1.5], [2 ** 53 + 2], ['1e3'], [''], [null], [undefined], ['12.0']])('refuses %p', (input) => {
      expect(() => toAmount(input)).toThrow();
    });
  });

  describe('normalizeNodeBox', () => {
    it('turns every amount into bigint, exact at 2^53+1 and 2^63-1', () => {
      const box = makeBox({
        ergoTree: p2pk(GENERATOR_PK),
        value: ABOVE_2_53,
        assets: [
          { tokenId: tokenId(1), amount: MAX_LONG },
          { tokenId: tokenId(2), amount: 1n },
        ],
      });
      const text = stringifyWithBigInt(nodeBoxJson(box));
      const normalized = normalizeNodeBox(parseNodeJson(text));
      expect(normalized.value).toBe(ABOVE_2_53);
      expect(normalized.assets[0].amount).toBe(MAX_LONG);
      expect(normalized.assets[1].amount).toBe(1n);
      expect(normalized.boxId).toBe(box.boxId);
    });

    it('takes registers given as { serializedValue } and refuses non-hex', () => {
      const box = makeBox({ ergoTree: p2pk(GENERATOR_PK), value: 1000000n });
      const json = nodeBoxJson(box, { additionalRegisters: { R4: { serializedValue: '0402', sigmaType: 'SInt' } } });
      expect(normalizeNodeBox(parseNodeJson(stringifyWithBigInt(json))).additionalRegisters).toEqual({ R4: '0402' });
      const bad = nodeBoxJson(box, { additionalRegisters: { R4: 'zz' } });
      expect(() => normalizeNodeBox(parseNodeJson(stringifyWithBigInt(bad)))).toThrow('register R4');
    });

    it('marks a box with no inclusion height as unconfirmed', () => {
      const box = makeBox({ ergoTree: p2pk(GENERATOR_PK), value: 1000000n });
      const json = nodeBoxJson(box, { inclusionHeight: undefined });
      expect(normalizeNodeBox(parseNodeJson(stringifyWithBigInt(json))).inclusionHeight).toBeUndefined();
    });
  });

  it('the node client returns exact bigint amounts from a raw response', async () => {
    const box = makeBox({
      ergoTree: p2pk(GENERATOR_PK),
      value: 1000000000n,
      assets: [{ tokenId: tokenId(3), amount: MAX_LONG }],
    });
    const node = fakeNode((method, urlPath) =>
      method === 'POST' && urlPath.startsWith('/blockchain/box/unspent/byAddress')
        ? { body: [nodeBoxJson(box)] }
        : undefined,
    );
    const client = new ErgoNodeClient('http://node.test', { timeoutMs: 1000, pageSize: 100, fetch: node.fetch });
    const boxes = await client.getUnspentBoxesByAddress('9fSgJ7BmUxBQJ454prQDQ7fQMBkXPLaAmDnimgTtjym6FYPHjAV', {
      includeUnconfirmed: true,
      excludeMempoolSpent: true,
    });
    expect(boxes[0].assets[0].amount).toBe(MAX_LONG);
    expect(node.calls[0].path).toContain('includeUnconfirmed=true');
    expect(node.calls[0].path).toContain('excludeMempoolSpent=true');
    expect(node.calls[0].body).toBe('9fSgJ7BmUxBQJ454prQDQ7fQMBkXPLaAmDnimgTtjym6FYPHjAV');
  });
});

describe('whole-unit conversion at the edge', () => {
  it.each([
    [0n, 9, '0'],
    [1n, 9, '0.000000001'],
    [1000000000n, 9, '1'],
    [1234567n, 3, '1234.567'],
    [MAX_LONG, 0, '9223372036854775807'],
    [MAX_LONG, 9, '9223372036.854775807'],
    [ABOVE_2_53, 2, '90071992547409.93'],
  ])('formatUnits(%p, %p) = %p', (amount, decimals, expected) => {
    expect(formatUnits(amount, decimals)).toBe(expected);
  });

  it('parseUnits is the exact inverse and refuses extra precision', () => {
    expect(parseUnits('9223372036.854775807', 9)).toBe(MAX_LONG);
    expect(parseUnits('0.000000001', 9)).toBe(1n);
    expect(parseUnits('1', 0)).toBe(1n);
    expect(() => parseUnits('0.0000000001', 9)).toThrow('decimal places');
    expect(() => parseUnits('1e5', 9)).toThrow();
    expect(() => parseUnits('-1', 9)).toThrow();
  });

  it('parseUnits refuses a number with more significant digits than a double holds exactly', () => {
    // both would otherwise come back one unit off, silently
    // written as Number('...') so the literal reaches parseUnits as the double it rounds to
    expect(() => parseUnits(Number('12345678.123456789'), 9)).toThrow('send it as a string');
    expect(() => parseUnits(Number('9007199254740993'), 0)).toThrow('send it as a string');
    expect(parseUnits(0.1, 9)).toBe(100000000n);
    expect(parseUnits('12345678.123456789', 9)).toBe(12345678123456789n);
  });

  it('parseUnits expands a number JavaScript prints in exponent form, exactly', () => {
    // each literal is printed by toString in exponent form: below 1e-6
    expect((4e-7).toString()).toBe('4e-7');
    expect(parseUnits(4e-7, 9)).toBe(400n);
    expect(parseUnits(1.5e-7, 8)).toBe(15n);
    expect(parseUnits(1.23456789012345e-7, 22)).toBe(1234567890123450n);
    expect(parseUnits(1e-9, 9)).toBe(1n);
    // whole numbers up to the largest exact integer are read exactly, written either way
    expect(parseUnits(1e15, 0)).toBe(10n ** 15n);
    expect(parseUnits(JSON.parse('1e15'), 0)).toBe(10n ** 15n);
    expect(parseUnits(1234567890123450, 0)).toBe(1234567890123450n);
    expect(parseUnits(Number.MAX_SAFE_INTEGER, 0)).toBe(9007199254740991n);
  });

  it('parseUnits refuses a whole number above the largest exact integer: its last digits are not known', () => {
    // each of these reads back as a double whose text differs from what the caller wrote
    expect(() => parseUnits(JSON.parse('1e21'), 0)).toThrow('send it as a string');
    expect(() => parseUnits(JSON.parse('100000000000000001'), 0)).toThrow('send it as a string');
    expect(() => parseUnits(JSON.parse('10000000000000001'), 0)).toThrow('send it as a string');
    expect(() => parseUnits(JSON.parse('1.2345e25'), 2)).toThrow('send it as a string');
    expect(() => parseUnits(Number.MAX_SAFE_INTEGER + 1, 0)).toThrow('send it as a string');
    // as strings they are exact
    expect(parseUnits('100000000000000001', 0)).toBe(100000000000000001n);
  });

  it('parseUnits still refuses what a double cannot hold exactly, in either form', () => {
    expect(() => parseUnits(1e-10, 9)).toThrow('decimal places');
    expect(() => parseUnits(Number('1.234567890123456e-7'), 30)).toThrow('send it as a string');
    expect(() => parseUnits(Number('1.234567890123456e+22'), 0)).toThrow('send it as a string');
    expect(() => parseUnits(-4e-7, 9)).toThrow('Invalid amount');
    expect(() => parseUnits(Number.POSITIVE_INFINITY, 9)).toThrow('Invalid amount');
  });

  it('toDecimalNumber builds the integer part from digits', () => {
    expect(toDecimalNumber(123456789012345678n, 9)).toBe(Number('123456789.012345678'));
    expect(toDecimalNumber(0n, 9)).toBe(0);
  });
});
