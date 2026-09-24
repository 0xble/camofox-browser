import { jest } from '@jest/globals';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SharedIdentityManager, cookieCheckpointPath, safeCookies } from '../../lib/shared-identity.js';

describe('SharedIdentityManager', () => {
  let root;
  beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'camofox-shared-identities-')); });
  afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

  function context(cookies = [], newPage = undefined) {
    return {
      addCookies: jest.fn(async () => {}),
      cookies: jest.fn(async () => cookies),
      close: jest.fn(async () => {}),
      pages: jest.fn(() => []),
      newPage: jest.fn(async () => newPage),
    };
  }

  test('serializes opening and restores only a clean session-cookie checkpoint before a page can be created', async () => {
    const manager = new SharedIdentityManager({ identities: ['opaque-hermes-user'], profileDir: root });
    const first = context();
    await fs.mkdir(path.dirname(cookieCheckpointPath(root, 'opaque-hermes-user')), { recursive: true });
    await fs.writeFile(cookieCheckpointPath(root, 'opaque-hermes-user'), JSON.stringify({
      version: 2,
      cleanShutdown: true,
      cookies: [
        { name: 'session', value: 'synthetic', domain: 'example.test', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' },
        { name: 'persistent', value: 'profile-owned', domain: 'example.test', path: '/', expires: 4102444800 },
      ],
    }));
    const create = jest.fn(async () => first);
    const [a, b] = await Promise.all([manager.open('opaque-hermes-user', create), manager.open('opaque-hermes-user', create)]);
    expect(a).toBe(first);
    expect(b).toBe(first);
    expect(create).toHaveBeenCalledTimes(1);
    const restored = first.addCookies.mock.calls[0][0];
    expect(restored).toEqual([expect.objectContaining({ name: 'session', httpOnly: true, secure: true, sameSite: 'Lax' })]);
    expect(restored).not.toEqual(expect.arrayContaining([expect.objectContaining({ name: 'persistent' })]));
    expect(JSON.parse(await fs.readFile(cookieCheckpointPath(root, 'opaque-hermes-user'), 'utf8'))).toEqual(expect.objectContaining({ cleanShutdown: false }));
  });

  test('a crash-invalidated checkpoint is never restored, but a clean close creates the fresh successor', async () => {
    const first = context([{ name: 'session', value: 'fresh', domain: 'example.test', path: '/', expires: -1 }]);
    const manager = new SharedIdentityManager({ identities: ['opaque-hermes-user'], profileDir: root });
    await manager.open('opaque-hermes-user', async () => first);
    await manager.close('opaque-hermes-user');

    const second = context();
    const restarted = new SharedIdentityManager({ identities: ['opaque-hermes-user'], profileDir: root });
    await restarted.open('opaque-hermes-user', async () => second);
    expect(second.addCookies).toHaveBeenCalledWith([expect.objectContaining({ name: 'session', value: 'fresh' })]);

    const crashed = context();
    const afterCrash = new SharedIdentityManager({ identities: ['opaque-hermes-user'], profileDir: root });
    await afterCrash.open('opaque-hermes-user', async () => crashed);
    expect(crashed.addCookies).not.toHaveBeenCalled();
  });

  test('keeps named identities and profile locations isolated', async () => {
    const manager = new SharedIdentityManager({ identities: ['personal', 'lpg'], profileDir: root });
    expect(manager.profileFor('personal')).not.toBe(manager.profileFor('lpg'));
    await expect(manager.open('meridian', async () => context())).rejects.toThrow('allowlisted');
  });

  test('replaces a prior cookie checkpoint with an empty logout checkpoint on clean close', async () => {
    const manager = new SharedIdentityManager({ identities: ['personal'], profileDir: root });
    const live = context([]);
    await manager.open('personal', async () => live);
    await manager.close('personal');
    const checkpoint = JSON.parse(await fs.readFile(cookieCheckpointPath(root, 'personal'), 'utf8'));
    expect(checkpoint).toEqual(expect.objectContaining({ cleanShutdown: true, cookies: [] }));
  });

  test('storage-reset close keeps the checkpoint dirty so session credentials cannot revive', async () => {
    const first = context([{ name: 'session', value: 'must-not-revive', domain: 'example.test', path: '/', expires: -1 }]);
    const manager = new SharedIdentityManager({ identities: ['personal'], profileDir: root });
    await manager.open('personal', async () => first);
    await manager.close('personal', { checkpoint: false });

    expect(first.cookies).not.toHaveBeenCalled();
    expect(JSON.parse(await fs.readFile(cookieCheckpointPath(root, 'personal'), 'utf8')))
      .toEqual(expect.objectContaining({ cleanShutdown: false }));

    const reopened = context();
    const afterReset = new SharedIdentityManager({ identities: ['personal'], profileDir: root });
    await afterReset.open('personal', async () => reopened);
    expect(reopened.addCookies).not.toHaveBeenCalled();
  });

  test('a close rejection poisons ownership until a real close event confirms shutdown', async () => {
    const manager = new SharedIdentityManager({ identities: ['personal'], profileDir: root });
    let closed;
    const live = context();
    live.on = jest.fn((event, listener) => { if (event === 'close') closed = listener; });
    live.close.mockRejectedValueOnce(new Error('close uncertain'));
    const launch = jest.fn(async () => live);
    await manager.open('personal', launch);
    await expect(manager.close('personal')).rejects.toThrow('close uncertain');
    expect(manager.failedClosures.has('personal')).toBe(true);
    closed();
    expect(manager.failedClosures.has('personal')).toBe(false);
  });

  test('a cookie snapshot failure aborts headed transition without closing the live context', async () => {
    const manager = new SharedIdentityManager({ identities: ['personal'], profileDir: root });
    const live = context();
    live.cookies.mockRejectedValueOnce(new Error('cookies unavailable'));
    await manager.open('personal', async () => live);
    await expect(manager.close('personal', { reason: 'headed_transition' })).rejects.toThrow('cookies unavailable');
    expect(live.close).not.toHaveBeenCalled();
    expect(manager.contexts.get('personal')).toBe(live);
    expect(manager.failedClosures.has('personal')).toBe(false);
  });

  test('a cookie snapshot failure on non-transition closes without poisoning', async () => {
    const logger = { warn: jest.fn() };
    const manager = new SharedIdentityManager({ identities: ['personal'], profileDir: root, logger });
    const live = context();
    live.cookies.mockRejectedValueOnce(new Error('cookies unavailable'));
    await manager.open('personal', async () => live);
    await expect(manager.close('personal', { reason: 'session_closed' })).resolves.toBe(true);
    expect(live.close).toHaveBeenCalledTimes(1);
    expect(manager.failedClosures.has('personal')).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('cookie snapshot failed'), expect.anything());
  });

  test('a checkpoint write failure removes the closed context without poisoning ownership', async () => {
    const manager = new SharedIdentityManager({ identities: ['personal'], profileDir: root });
    const live = context();
    await manager.open('personal', async () => live);
    const checkpointDir = path.dirname(cookieCheckpointPath(root, 'personal'));
    await fs.rm(checkpointDir, { recursive: true, force: true });
    await fs.writeFile(checkpointDir, 'blocking file');
    await expect(manager.close('personal')).rejects.toThrow();
    expect(manager.contexts.has('personal')).toBe(false);
    expect(manager.failedClosures.has('personal')).toBe(false);
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
    await expect(manager.focus('personal')).resolves.toBe(page);
    expect(page.bringToFront).toHaveBeenCalledTimes(1);
  });

  test('focus creates and returns one visible page when a persistent context has none', async () => {
    const page = { isClosed: () => false, bringToFront: jest.fn(async () => {}) };
    const live = context([], page);
    const manager = new SharedIdentityManager({ identities: ['personal'], profileDir: root });
    await manager.open('personal', async () => live);
    await expect(manager.focus('personal')).resolves.toBe(page);
    expect(live.newPage).toHaveBeenCalledTimes(1);
    expect(page.bringToFront).toHaveBeenCalledTimes(1);
  });
});
