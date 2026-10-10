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
    expect(contexts[1].context.newPage).not.toHaveBeenCalled();
    expect(registerPage).toHaveBeenCalledWith(sessions.get('personal'), 'personal', sessions.get('personal').lastUsedPage);
    expect(sessions.get('personal').lastUsedPage.goto).toHaveBeenCalledWith('https://example.test/private', { timeout: 10000 });
    expect(JSON.parse(await fs.readFile(cookieCheckpointPath(root, 'personal'), 'utf8')).cleanShutdown).toBe(false);
  });

  test('already headed with a requested tab focuses and returns that tab', async () => {
    await opener.openWindow('personal');
    const session = sessions.get('personal');
    const firstPage = contexts[0].context.pages()[0];
    const secondPage = fakePage('https://example.test/second');
    contexts[0].context.pages.mockReturnValue([firstPage, secondPage]);
    session.tabGroups.set('task-a', new Map([['first-tab', { page: firstPage }]]));
    session.tabGroups.set('task-b', new Map([['second-tab', { page: secondPage }]]));
    registerPage.mockImplementation((_session, _userId, page) => page === secondPage ? 'second-tab' : 'first-tab');

    const result = await opener.openWindow('personal', 'second-tab');

    expect(result).toMatchObject({ ok: true, userId: 'personal', focused: true, tabId: 'second-tab', keepOpen: true });
    expect(secondPage.bringToFront).toHaveBeenCalledTimes(1);
    expect(firstPage.bringToFront).toHaveBeenCalledTimes(1);
  });

  test('already headed with an unknown requested tab opens a new tab', async () => {
    await opener.openWindow('personal');
    const session = sessions.get('personal');
    const existingPage = contexts[0].context.pages()[0];
    session.tabGroups.set('task-a', new Map([['existing-tab', { page: existingPage }]]));
    const newPage = fakePage('about:blank');
    contexts[0].context.newPage.mockResolvedValueOnce(newPage);
    registerPage.mockReturnValueOnce('new-tab');

    const result = await opener.openWindow('personal', 'stale-tab');

    expect(result).toMatchObject({ ok: true, userId: 'personal', focused: true, tabId: 'new-tab', keepOpen: true });
    expect(contexts[0].context.newPage).toHaveBeenCalledTimes(1);
    expect(newPage.bringToFront).toHaveBeenCalledTimes(1);
    expect(registerPage).toHaveBeenLastCalledWith(session, 'personal', newPage);
    expect(result.tabId).not.toBe('existing-tab');
  });

  test('already headed without a requested tab keeps focusing the manager-selected page', async () => {
    await opener.openWindow('personal');
    const focus = jest.spyOn(manager, 'focus');
    const result = await opener.openWindow('personal');

    expect(focus).toHaveBeenCalledWith('personal');
    expect(result).toMatchObject({ ok: true, userId: 'personal', focused: true, tabId: 'personal-new-tab', keepOpen: true });
    focus.mockRestore();
    await opener.closeSession('personal', sessions.get('personal'));
    await opener.getSession('personal');
    expect(contexts[1].options.headless).toBe(true);
  });

  test('headless transition restores the requested tab URL instead of lastUsedPage', async () => {
    const old = await opener.getSession('personal');
    const requestedPage = fakePage('https://example.test/caller');
    old.lastUsedPage = fakePage('https://example.test/other-task');
    old.tabGroups.set('caller-task', new Map([['caller-tab', { page: requestedPage }]]));
    old.tabGroups.set('other-task', new Map([['other-tab', { page: old.lastUsedPage }]]));
    registerPage.mockReturnValueOnce('restored-caller-tab');

    const result = await opener.openWindow('personal', 'caller-tab');

    expect(result).toMatchObject({ ok: true, userId: 'personal', focused: true, tabId: 'restored-caller-tab', keepOpen: true, restarted: true });
    expect(sessions.get('personal').lastUsedPage.goto).toHaveBeenCalledWith('https://example.test/caller', { timeout: 10000 });
    expect(sessions.get('personal').lastUsedPage.goto).not.toHaveBeenCalledWith('https://example.test/other-task', { timeout: 10000 });
  });

  test('already headed relaunches when the headed window has been closed', async () => {
    await opener.openWindow('personal');
    const oldSession = sessions.get('personal');
    const visible = await manager.focus('personal');
    visible.isClosed.mockReturnValue(true);
    const focus = jest.spyOn(manager, 'focus').mockResolvedValueOnce(null).mockResolvedValueOnce(await contexts[0].context.newPage());
    const result = await opener.openWindow('personal');
    expect(result).toMatchObject({ restarted: true, focused: true, tabId: 'personal-new-tab' });
    expect(opener.closeSession).toHaveBeenCalledWith('personal', oldSession, { reason: 'headed_transition' });
    expect(contexts).toHaveLength(2);
    focus.mockRestore();
  });

  test('unsupported URL schemes skip restore and report restoreFailed', async () => {
    const old = await opener.getSession('personal');
    old.lastUsedPage = fakePage('file:///tmp/private.html');
    const result = await opener.openWindow('personal');
    expect(result).toMatchObject({ restarted: true, restoreFailed: true });
    expect(contexts[1].context.newPage).not.toHaveBeenCalled();
  });

  test('open returns busy after a bounded request drain', async () => {
    const bounded = createSharedIdentityWindowOpener({ manager, sessions, getSession: opener.getSession,
      closeSession: opener.closeSession, registerPage, isBusy: () => true, drainTimeoutMs: 10 });
    const started = Date.now();
    await expect(bounded.openWindow('personal')).resolves.toEqual({ busy: true });
    expect(Date.now() - started).toBeLessThan(500);
  });


  test('skips about:blank and does not relaunch when checkpoint close fails', async () => {
    const original = await opener.getSession('personal');
    await opener.openWindow('personal');
    expect(contexts[1].context.newPage).not.toHaveBeenCalled();
    await opener.closeSession('personal', sessions.get('personal'));
    const next = await opener.getSession('personal');
    next.context.close.mockRejectedValueOnce(new Error('profile still open'));
    await expect(opener.openWindow('personal')).rejects.toThrow('profile still open');
    await expect(opener.openWindow('personal')).rejects.toThrow('profile ownership is unconfirmed');
    await expect(manager.open('personal', () => launcher('unused'))).rejects.toThrow('profile ownership is unconfirmed');
    expect(contexts).toHaveLength(3);
    expect(sessions.get('personal')).toBe(next);
    expect(original.context.close).toHaveBeenCalledTimes(1);
  });

  test('failed URL restore still returns the headed page without a stray blank tab', async () => {
    const old = await opener.getSession('personal');
    old.lastUsedPage = fakePage('https://example.test/fails');
    const resultPage = fakePage();
    resultPage.goto.mockRejectedValueOnce(new Error('navigation failed'));
    const headed = fakeContext(resultPage);
    // Substitute the headed launch while retaining the original manager lifecycle.
    const originalGetSession = opener.getSession;
    const open = createSharedIdentityWindowOpener({ manager, sessions,
      getSession: async (userId, options) => {
        if (options?.headed) {
          await manager.open(userId, async () => headed);
          const session = { context: headed, headed: true, sharedIdentity: true, tabGroups: new Map() };
          sessions.set(userId, session);
          return session;
        }
        return originalGetSession(userId, options);
      },
      closeSession: opener.closeSession, registerPage, isBusy: () => false });
    const result = await open.openWindow('personal');
    expect(result).toMatchObject({ restarted: true, restoreFailed: true, tabId: 'personal-new-tab' });
    expect(resultPage.goto).toHaveBeenCalledWith('https://example.test/fails', { timeout: 10000 });
    expect(headed.newPage).not.toHaveBeenCalled();
    expect(registerPage).toHaveBeenCalledWith(sessions.get('personal'), 'personal', resultPage);
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
