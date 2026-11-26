/**
 * Start-up and a busy Gateway port: other processes are left alone unless the
 * environment says otherwise, and a busy port is reported by number. No server is
 * started here.
 */
import * as fs from 'fs';
import * as path from 'path';

import {
  isPortInUse,
  KILL_PORT_HOLDERS_ENV,
  killsPortHolders,
  portInUseMessage,
} from '../../src/services/port-holders';

describe('processes holding the Gateway port at start-up', () => {
  it('are not killed by default', () => {
    expect(killsPortHolders({})).toBe(false);
  });

  it('are killed only when the environment says true', () => {
    expect(killsPortHolders({ [KILL_PORT_HOLDERS_ENV]: 'true' })).toBe(true);
    expect(killsPortHolders({ [KILL_PORT_HOLDERS_ENV]: ' TRUE ' })).toBe(true);
    for (const value of ['', 'false', '0', '1', 'yes']) {
      expect(killsPortHolders({ [KILL_PORT_HOLDERS_ENV]: value })).toBe(false);
    }
  });

  it('a busy port is recognised and named in the start-up error', () => {
    const busy = Object.assign(new Error('listen EADDRINUSE: address already in use 127.0.0.1:15888'), {
      code: 'EADDRINUSE',
    });
    expect(isPortInUse(busy)).toBe(true);
    expect(isPortInUse(new Error('something else'))).toBe(false);
    expect(isPortInUse(null)).toBe(false);
    const message = portInUseMessage(15888);
    expect(message).toContain('Port 15888 is already in use');
    expect(message).toContain(`${KILL_PORT_HOLDERS_ENV}=true`);
  });

  it('start-up runs the kill commands only behind that decision', () => {
    // importing app.ts builds the whole server, so its text is checked instead
    const app = fs.readFileSync(path.join(__dirname, '../../src/app.ts'), 'utf8');
    const decision = app.indexOf('if (!killsPortHolders()) {');
    expect(decision).toBeGreaterThan(-1);
    for (const command of ['taskkill /F /PID', 'kill -9']) {
      expect(app.indexOf(command)).toBeGreaterThan(decision);
    }
    expect(app).toContain('isPortInUse(err) ? portInUseMessage(port)');
  });
});
