/**
 * The shipped Ergo network templates against their schema, and the facts they state for
 * clients: transactions never expire.
 */
import * as fs from 'fs';
import * as path from 'path';

import Ajv from 'ajv';
import * as yaml from 'js-yaml';

const templates = path.join(__dirname, '../../../src/templates');
const schema = JSON.parse(fs.readFileSync(path.join(templates, 'namespace/ergo-network-schema.json'), 'utf8'));
const load = (net: string) =>
  yaml.load(fs.readFileSync(path.join(templates, 'chains/ergo', `${net}.yml`), 'utf8')) as Record<string, unknown>;

describe('Ergo network templates', () => {
  it.each(['mainnet', 'testnet'])('%s states that its transactions never expire', (net) => {
    expect(load(net).transactionsExpire).toBe(false);
  });

  it('the schema declares transactionsExpire and pendingStateFile', () => {
    expect(schema.properties.transactionsExpire.type).toBe('boolean');
    expect(schema.properties.pendingStateFile.type).toBe('string');
  });

  it.each(['mainnet', 'testnet'])('%s is valid against the schema, and a wrong type is not', (net) => {
    const validate = new Ajv({ strict: false }).compile(schema);
    expect(validate(load(net))).toBe(true);
    expect(validate({ ...load(net), transactionsExpire: 'no' })).toBe(false);
  });
});
