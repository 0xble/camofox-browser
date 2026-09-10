import { jest } from '@jest/globals';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SharedIdentityManager, cookieCheckpointPath, safeCookies } from '../../lib/shared-identity.js';

describe('SharedIdentityManager', () => {
  let root;
  beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'camofox-shared-identities-')); });
  afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

  function context(cookies = []) {
    return {
      addCookies: jest.fn(async () => {}),
      cookies: jest.fn(async () => cookies),
      close: jest.fn(async () => {}),
      pages: jest.fn(() => []),
    };
  }

  test('serializes open and restores the cookie checkpoint before a page can be created', async () => {
    const manager = new SharedIdentityManager({ identities: ['personal'], profileDir: root });
    const first = context();
    await fs.mkdir(path.dirname(cookieCheckpointPath(root, 'personal')), { recursive: true });
    await fs.writeFile(cookieCheckpointPath(root, 'personal'), JSON.stringify({ cookies: [{ name: 'sid', value: 'synthetic', domain: 'example.test', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' }] }));
    const create = jest.fn(async () => first);
    const [a, b] = await Promise.all([manager.open('personal', create), manager.open('personal', create)]);
    expect(a).toBe(first);
    expect(b).toBe(first);
    expect(create).toHaveBeenCalledTimes(1);
    expect(first.addCookies).toHaveBeenCalledWith([expect.objectContaining({ name: 'sid', httpOnly: true, secure: true, sameSite: 'Lax' })]);
  });

  test('keeps named identities and profile locations isolated', async () => {
    const manager = new SharedIdentityManager({ identities: ['personal', 'lpg'], profileDir: root });
    expect(manager.profileFor('personal')).not.toBe(manager.profileFor('lpg'));
    await expect(manager.open('meridian', async () => context())).rejects.toThrow('allowlisted');
  });

  test('replaces a prior cookie checkpoint with an empty logout checkpoint', async () => {
    const manager = new SharedIdentityManager({ identities: ['personal'], profileDir: root });
    const live = context([]);
    await manager.open('personal', async () => live);
    await manager.checkpoint('personal');
    expect(JSON.parse(await fs.readFile(cookieCheckpointPath(root, 'personal'), 'utf8')).cookies).toEqual([]);
  });

  test('preserves supported attributes while omitting expired cookies', () => {
    const cookies = safeCookies([
      { name: 'current', value: 'synthetic', domain: 'example.test', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Strict', partitionKey: 'https://example.test' },
      { name: 'expired', value: 'synthetic', domain: 'example.test', path: '/', expires: 1 },
    ], 2);
    expect(cookies).toEqual([expect.objectContaining({ name: 'current', httpOnly: true, secure: true, sameSite: 'Strict', partitionKey: 'https://example.test' })]);
  });

  test('focuses an existing visible page without launching another context', async () => {
    const page = { isClosed: () => false, bringToFront: jest.fn(async () => {}) };
    const live = context(); live.pages.mockReturnValue([page]);
    const manager = new SharedIdentityManager({ identities: ['personal'], profileDir: root });
    await manager.open('personal', async () => live);
    await expect(manager.focus('personal')).resolves.toBe(true);
    expect(page.bringToFront).toHaveBeenCalledTimes(1);
  });
});
