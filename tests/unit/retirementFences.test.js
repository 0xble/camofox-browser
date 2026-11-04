import { jest } from '@jest/globals';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createSharedIdentityWindowOpener } from '../../lib/shared-identity-window.js';
import { SharedIdentityManager } from '../../lib/shared-identity.js';
import { quarantinePage, isQuarantinedPage, createPageRegistry } from '../../lib/page-registry.js';

const source = readFileSync(new URL('../../server.js', import.meta.url), 'utf8');
function serverFunction(name, dependencies) {
  const start = source.indexOf(`async function ${name}(`);
  const end = source.indexOf('\n}\n', start) + 2;
  return vm.runInNewContext(`(${source.slice(start, end)})`, dependencies);
}

function closeFixture() {
  const session = { sharedIdentity: true, tabGroups: new Map(), tracePath: 'trace',
    context: { tracing: { stop: jest.fn(async () => {}) } } };
  const deps = {
    normalizeUserId: id => id, sessions: new Map([['identity', session]]),
    sharedIdentities: { snapshotCookies: jest.fn(async () => []), close: jest.fn(async () => {}) },
    sharedIdentityLastUrls: new Map(), clearSessionLocks: jest.fn(), clearSessionDownloads: jest.fn(async () => {}),
    log() {}, refreshActiveTabsGauge() {}, quarantinePage,
  };
  return { session, deps, close: serverFunction('closeSessionNow', deps) };
}

test('an expired preparation leaves locks and downloads intact before the final destructive fence', async () => {
  const f = closeFixture();
  let expired = false;
  f.session.context.tracing.stop.mockImplementation(async () => { expired = true; });
  const error = new Error('deadline');
  await expect(f.close('identity', f.session, { reason: 'headed_transition', transitionCheck() { if (expired) throw error; } })).rejects.toBe(error);
  expect(f.deps.clearSessionLocks).not.toHaveBeenCalled();
  expect(f.deps.clearSessionDownloads).not.toHaveBeenCalled();
  expect(f.deps.sharedIdentities.close).not.toHaveBeenCalled();
  expect(f.deps.sessions.get('identity')).toBe(f.session);
});

test('once locks are drained a transition cannot abort instead of closing its context', async () => {
  const f = closeFixture();
  let drained = false;
  f.deps.clearSessionLocks.mockImplementation(() => { drained = true; });
  await expect(f.close('identity', f.session, { reason: 'headed_transition', transitionCheck() {
    if (drained) throw new Error('deadline after drain');
  } })).resolves.toBeUndefined();
  expect(f.deps.sharedIdentities.close).toHaveBeenCalledTimes(1);
  expect(f.deps.sessions.has('identity')).toBe(false);
});

test('terminal close still attempts context teardown when pages enumeration throws', async () => {
  const f = closeFixture();
  f.session.context.pages = () => { throw Error('dead context'); };
  await expect(f.close('identity', f.session, { reason: 'admin_stop' })).resolves.toBeUndefined();
  expect(f.deps.sharedIdentities.close).toHaveBeenCalledTimes(1);
});

function creationFixture() {
  const page = { isClosed: () => false, url: () => 'about:blank', goto: jest.fn(async () => {}) };
  let expired = false;
  let expireOnVisibility = true;
  const context = { pages: () => [page], on() {}, newPage: jest.fn(async () => page),
    get sharedIdentityVisibility() { if (expireOnVisibility) expired = true; return null; } };
  const deps = {
    normalizeUserId: id => id, sessions: new Map(), sessionCreations: new Map(),
    sharedIdentityWindow: null, sharedIdentityLastUrls: new Map([['identity', 'https://healthy.test/restore']]),
    sharedIdentities: { failedClosures: new Set(), closings: new Set(), contexts: new Map([['identity', context]]),
      owns: () => true, open: async () => context },
    coalesceInflight: (_map, _key, operation) => operation(), MAX_SESSIONS: 10, FLY_MACHINE_ID: null,
    CONFIG: {}, isQuarantinedPage, proxyPool: null, browserLaunchProxy: null, contextIdentityOptions: () => ({}),
    registerSharedIdentityPage() {}, clearSessionLocks() {}, clearSessionDownloads: async () => {},
    refreshActiveTabsGauge() {}, log() {},
  };
  return { page, deps, create: serverFunction('getSession', deps),
    check() { if (expired) throw new Error('deadline before publication'); },
    retry() { expired = false; expireOnVisibility = false; } };
}

test('a deadline before publication preserves URL restoration for the next session creation', async () => {
  const f = creationFixture();
  await expect(f.create('identity', { transitionCheck: f.check })).rejects.toThrow('deadline before publication');
  expect(f.deps.sessions.has('identity')).toBe(false);
  expect(f.deps.sharedIdentityLastUrls.get('identity')).toBe('https://healthy.test/restore');
  f.retry();
  const session = await f.create('identity');
  expect(f.deps.sessions.get('identity')).toBe(session);
  expect(f.page.goto).toHaveBeenCalledWith('https://healthy.test/restore', { timeout: 10000 });
  expect(f.deps.sharedIdentityLastUrls.has('identity')).toBe(false);
});

for (const selection of ['last used', 'registered fallback']) {
  test(`release does not restore a quarantined ${selection} page`, async () => {
    const retired = { isClosed: () => false, url: () => 'https://retired.test/' };
    const healthy = { isClosed: () => false, url: () => 'https://healthy.test/' };
    quarantinePage(retired);
    const session = { headed: true, lastUsedPage: selection === 'last used' ? retired : null,
      context: { pages: () => [retired, healthy] },
      tabGroups: new Map([['task', new Map([['healthy', { page: healthy }], ['retired', { page: retired }]])]]) };
    const deps = { sessions: new Map([['identity', session]]), sessionCreations: new Map(),
      sharedIdentityLastUrls: new Map(), identityBusy: () => false, closeSession: async () => {}, log() {},
      isQuarantinedPage };
    await serverFunction('releaseIdentity', deps)('identity', { all: true });
    expect(deps.sharedIdentityLastUrls.get('identity')).toBe('https://healthy.test/');
  });
}

test('page replacement quarantines the outgoing page at the registry boundary', () => {
  const retired = { on() {}, isClosed: () => false };
  const incoming = { on() {}, isClosed: () => false };
  const session = { tabGroups: new Map([['task', new Map([['same-id', { page: retired }]])]]), lastUsedPage: retired };
  const sessions = new Map([['identity', session]]);
  const registry = createPageRegistry({ sessions, createTabState: page => ({ page }), attachDownloadListener() {} });
  registry.registerPage(session, 'identity', incoming, 'task', { tabId: 'same-id' });
  expect(isQuarantinedPage(retired)).toBe(true);
  expect(session.lastUsedPage).not.toBe(retired);
  expect(() => registry.registerPage(session, 'identity', retired, 'task')).toThrow();
});

test('a failed shared context close quarantines registered and unregistered pages before losing ownership', async () => {
  const f = closeFixture();
  const registered = { isClosed: () => false }, unregistered = { isClosed: () => false };
  f.session.tabGroups.set('task', new Map([['old', { page: registered }]]));
  f.session.lastUsedPage = unregistered;
  f.session.context.pages = () => [registered, unregistered];
  f.deps.quarantinePage = quarantinePage;
  f.deps.sharedIdentities.close.mockRejectedValue(new Error('close failed'));
  await f.close('identity', f.session, { reason: 'api_delete_session' });
  expect(isQuarantinedPage(registered)).toBe(true);
  expect(isQuarantinedPage(unregistered)).toBe(true);
  expect(f.session.lastUsedPage).toBe(null);
});

test.each(['shutdown:SIGTERM', 'admin_stop', 'browser_restart:recovery', 'browser_disconnected', 'api_delete_session'])(
  '%s still issues context close when shared cookie snapshot never settles', async reason => {
    jest.useFakeTimers();
    try {
      const page = {};
      const context = { pages: () => [page], cookies: () => new Promise(() => {}), close: jest.fn(async () => {}) };
      const manager = new SharedIdentityManager({ identities: ['identity'] });
      manager.contexts.set('identity', context);
      let done = false;
      const closing = manager.close('identity', { reason }).then(() => { done = true; });
      await jest.advanceTimersByTimeAsync(2501);
      expect(done).toBe(true);
      await closing;
      expect(context.close).toHaveBeenCalledTimes(1);
      expect(isQuarantinedPage(page)).toBe(true);
    } finally { jest.useRealTimers(); }
  });

test('terminal generation cancels an opener already awaiting destructive context close', async () => {
  let generation = 0, resume;
  const page = { isClosed: () => false, url: () => 'https://fixture.test/form' };
  const session = { headed: false, context: { pages: () => [page] }, tabGroups: new Map(), lastUsedPage: page };
  const sessions = new Map([['identity', session]]);
  const getSession = jest.fn(async () => ({ ...session, headed: true }));
  const opener = createSharedIdentityWindowOpener({
    manager: { focus: async () => page, failedClosures: new Set() }, sessions, getSession, isBusy: () => false,
    registerPage: () => 'replacement', lifecycleGeneration: () => generation,
    closeSession: async () => { await new Promise(resolve => { resume = resolve; }); sessions.delete('identity'); },
  });
  const opening = opener.openWindow('identity', null, { allowRestart: true }).catch(error => error);
  for (let i = 0; i < 10 && !resume; i++) await Promise.resolve();
  expect(resume).toBeDefined();
  generation++;
  resume();
  expect((await opening).code).toBe('session_destroyed');
  expect(getSession).not.toHaveBeenCalled();
});

test('an acquisition returning after terminal retirement closes its exact context without publishing', async () => {
  const f = creationFixture(); f.retry();
  f.deps.sessionLifecycleGeneration = 0;
  const context = f.deps.sharedIdentities.contexts.get('identity');
  context.close = jest.fn(async () => {});
  f.deps.sharedIdentities.close = jest.fn(async () => context.close());
  let resume;
  f.deps.sharedIdentities.open = () => new Promise(resolve => { resume = resolve; });
  const opening = f.create('identity').catch(error => error);
  await Promise.resolve();
  f.deps.sessionLifecycleGeneration++;
  resume(context);
  expect((await opening).code).toBe('session_destroyed');
  await Promise.resolve();
  expect(f.deps.sessions.size).toBe(0);
  expect(context.close).toHaveBeenCalledTimes(1);
});
