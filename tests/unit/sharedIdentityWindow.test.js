import { jest } from '@jest/globals';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SharedIdentityManager, cookieCheckpointPath } from '../../lib/shared-identity.js';
import { launchSharedIdentityContext } from '../../lib/shared-identity-launch.js';
import { createSharedIdentityWindowOpener } from '../../lib/shared-identity-window.js';

function fakePage(url = 'about:blank') {
  return { url: jest.fn(() => url), goto: jest.fn(async address => { url = address; }),
    isClosed: jest.fn(() => false), bringToFront: jest.fn(async () => {}) };
}
function fakeContext(page = fakePage()) {
  return { pages: jest.fn(() => [page]), newPage: jest.fn(async () => fakePage()),
    cookies: jest.fn(async () => [{ name: 'session', value: 'retained', domain: 'example.test', path: '/', expires: -1 }]),
    addCookies: jest.fn(async () => {}), close: jest.fn(async () => {}), on: jest.fn() };
}

describe('shared identity headed transition', () => {
  let root, manager, sessions, contexts, launcher, opener, busy, registerPage;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'shared-window-'));
    manager = new SharedIdentityManager({ identities: ['personal', 'lpg'], profileDir: root });
    sessions = new Map(); contexts = []; busy = new Set();
    const firefox = { launchPersistentContext: jest.fn(async (_profile, options) => {
      const context = fakeContext(); contexts.push({ context, options }); return context;
    }) };
    launcher = jest.fn((profile, { headed = false } = {}) => launchSharedIdentityContext(profile, {
      headed, firefox, launchOptions: async options => ({ ...options }), os: { platform: () => 'darwin' },
      getHostOS: () => 'macos', config: {}, events: { emitAsync: async () => {} },
    }));
    const getSession = jest.fn(async (userId, { headed = false } = {}) => {
      const context = await manager.open(userId, profile => launcher(profile, { headed }));
      const session = { context, headed, sharedIdentity: true, tabGroups: new Map(), lastUsedPage: null };
      sessions.set(userId, session); return session;
    });
    const closeSession = jest.fn(async (userId, session) => {
      await manager.close(userId, { checkpoint: true }); sessions.delete(userId);
      session.tabGroups.clear();
    });
    registerPage = jest.fn((_session, userId) => `${userId}-new-tab`);
    opener = createSharedIdentityWindowOpener({ manager, sessions, getSession, closeSession, registerPage,
      isBusy: userId => busy.has(userId) });
    opener.getSession = getSession; opener.closeSession = closeSession;
  });
  afterEach(async () => fs.rm(root, { recursive: true, force: true }));

  test('normal use launches headless on the same profile subsequently used headed', async () => {
    const original = await opener.getSession('personal');
    expect(contexts[0].options.headless).toBe(true);
    const profile = launcher.mock.calls[0][0];
    await opener.openWindow('personal');
    expect(contexts[1].options.headless).toBe(false);
    expect(launcher.mock.calls[1][0]).toBe(profile);
    expect(original.context.close).toHaveBeenCalledTimes(1);
  });

  test('checkpointed close, restored URL and session cookies, with old tabs discarded', async () => {
    const old = await opener.getSession('personal');
    old.lastUsedPage = fakePage('https://example.test/private');
    old.tabGroups.set('old', new Map([['stale-tab', { page: old.lastUsedPage }]]));
    const result = await opener.openWindow('personal');
    expect(result).toEqual({ ok: true, userId: 'personal', focused: true, tabId: 'personal-new-tab', keepOpen: true, restarted: true });
    expect(old.context.cookies).toHaveBeenCalledTimes(1);
    expect(old.context.close).toHaveBeenCalledTimes(1);
    expect(old.tabGroups.size).toBe(0);
    expect(contexts[1].context.addCookies).toHaveBeenCalledWith([expect.objectContaining({ name: 'session', value: 'retained' })]);
    expect(contexts[1].context.newPage).toHaveBeenCalledTimes(1);
    expect(contexts[1].context.newPage.mock.results[0].value).toBeDefined();
    expect(registerPage).toHaveBeenCalledWith(sessions.get('personal'), 'personal', sessions.get('personal').lastUsedPage);
    expect(sessions.get('personal').lastUsedPage.goto).toHaveBeenCalledWith('https://example.test/private');
    expect(JSON.parse(await fs.readFile(cookieCheckpointPath(root, 'personal'), 'utf8')).cleanShutdown).toBe(false);
  });

  test('already headed only focuses; a session end resets next normal use to headless', async () => {
    await opener.openWindow('personal');
    const result = await opener.openWindow('personal');
    expect(result).not.toHaveProperty('restarted');
    expect(contexts).toHaveLength(1);
    await opener.closeSession('personal', sessions.get('personal'));
    await opener.getSession('personal');
    expect(contexts[1].options.headless).toBe(true);
  });

  test('busy identity refuses without close or relaunch', async () => {
    await opener.getSession('personal'); busy.add('personal');
    expect(await opener.openWindow('personal')).toEqual({ busy: true });
    expect(contexts[0].context.close).not.toHaveBeenCalled();
    expect(contexts).toHaveLength(1);
  });

  test('skips about:blank and does not relaunch when checkpoint close fails', async () => {
    const original = await opener.getSession('personal');
    await opener.openWindow('personal');
    expect(contexts[1].context.newPage).not.toHaveBeenCalled();
    await opener.closeSession('personal', sessions.get('personal'));
    const next = await opener.getSession('personal');
    next.context.close.mockRejectedValueOnce(new Error('profile still open'));
    await expect(opener.openWindow('personal')).rejects.toThrow('profile still open');
    expect(contexts).toHaveLength(3);
    expect(original.context.close).toHaveBeenCalledTimes(1);
  });

  test('concurrent opens coalesce, and other identities remain untouched', async () => {
    await opener.getSession('personal'); await opener.getSession('lpg');
    const [a, b] = await Promise.all([opener.openWindow('personal'), opener.openWindow('personal')]);
    expect(a).toEqual(b);
    expect(contexts).toHaveLength(3);
    expect(contexts[0].context.close).toHaveBeenCalledTimes(1);
    expect(contexts[1].context.close).not.toHaveBeenCalled();
    expect(sessions.get('lpg').context).toBe(contexts[1].context);
  });
});
