/**
 * fs-extra with wallet files kept in memory, so no test writes into conf/wallets. Every
 * path outside conf/wallets goes to the real fs-extra.
 *
 * Use: jest.mock('fs-extra', () => require('./wallet-fs-mock').createFsExtraMock());
 */
export const walletFiles = new Map<string, string>();

const isWalletPath = (p: unknown): p is string =>
  typeof p === 'string' && p.replace(/^\.\//, '').startsWith('conf/wallets');
const key = (p: string) => p.replace(/^\.\//, '');

export function createFsExtraMock() {
  const actual = jest.requireActual('fs-extra');
  const overrides = {
    readFile: async (p: string, ...rest: unknown[]) => {
      if (!isWalletPath(p)) return actual.readFile(p, ...rest);
      if (!walletFiles.has(key(p))) throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
      return walletFiles.get(key(p));
    },
    writeFile: async (p: string, data: string, ...rest: unknown[]) => {
      if (!isWalletPath(p)) return actual.writeFile(p, data, ...rest);
      walletFiles.set(key(p), data);
    },
    chmod: async (p: string, ...rest: unknown[]) => (isWalletPath(p) ? undefined : actual.chmod(p, ...rest)),
    mkdir: async (p: string, ...rest: unknown[]) => (isWalletPath(p) ? undefined : actual.mkdir(p, ...rest)),
    remove: async (p: string) => {
      if (!isWalletPath(p)) return actual.remove(p);
      walletFiles.delete(key(p));
    },
    pathExists: async (p: string) => {
      if (!isWalletPath(p)) return actual.pathExists(p);
      const k = key(p);
      return walletFiles.has(k) || [...walletFiles.keys()].some((f) => f.startsWith(`${k}/`)) || k === 'conf/wallets';
    },
    readdir: async (p: string, options?: { withFileTypes?: boolean }) => {
      if (!isWalletPath(p)) return actual.readdir(p, options);
      const dir = key(p).replace(/\/+$/, '');
      const names = new Map<string, boolean>();
      for (const f of walletFiles.keys()) {
        if (!f.startsWith(`${dir}/`)) continue;
        const rest = f.slice(dir.length + 1);
        const [first, ...more] = rest.split('/');
        names.set(first, more.length > 0 || names.get(first) === true);
      }
      if (!options?.withFileTypes) return [...names.keys()];
      return [...names.entries()].map(([name, isDir]) => ({ name, isDirectory: () => isDir, isFile: () => !isDir }));
    },
  };
  const merged = { ...actual, ...overrides };
  return { __esModule: true, ...merged, default: merged };
}
