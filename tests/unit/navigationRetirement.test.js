import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import express from 'express';
import { handleTabTimeout } from '../../lib/tab-timeout.js';
import { createPageRegistry, quarantinePage } from '../../lib/page-registry.js';
import { isDeadContextError, isTimeoutError, isTabLockQueueTimeout } from '../../lib/browser-errors.js';
import { closeSessionOnce, hasSessionClose } from '../../lib/session-close.js';

const source = readFileSync(new URL('../../server.js', import.meta.url), 'utf8');
const turn = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function serverFunction(name) {
  const matches = [...source.matchAll(new RegExp(`^(?:async )?function ${name}\\([^\\n]*\\) \\{[\\s\\S]*?^\\}`, 'gm'))];
  assert.equal(matches.length, 1, `expected one server.js function ${name}`);
  return matches[0][0];
}
function sourceBetween(startMarker, endMarker) {
  assert.equal(source.split(startMarker).length, 2, `expected unique start marker ${startMarker}`);
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(end > start, `expected end marker ${endMarker} after ${startMarker}`);
  return source.slice(start, end);
}
function page() {
  return Object.assign(new EventEmitter(), {
    closed: false, isClosed() { return this.closed; }, url: () => 'https://example.test/',
    async close() { this.closed = true; this.emit('close'); },
    evaluate: async () => 1,
  });
}

// Like abandonedTab/uploadRoute: actual server functions and Express route;
// only browser pages, external cleanup/telemetry, and deadline delivery are fake.
async function fixture({ freshContext = false } = {}) {
  const timers = new Set(), registrations = [], navigations = [], destroyed = [];
  const started = deferred(), creationStarted = deferred(), continuation = deferred();
  const releasedLeases = [], leasedPages = [];
  const closeStarted = deferred(), closeGate = deferred();
  const freshSession = { tabGroups: new Map(), sharedIdentity: true };
  const session = { tabGroups: new Map(), sharedIdentity: freshContext };
  const sessions = new Map([['owner', session]]);
  const app = express();
  app.use(express.json());
  const box = {
    app, sessions, AsyncLocalStorage, AbortController,
    setTimeout(fn, ms) { const timer = { fn, ms, unref() {} }; timers.add(timer); return timer; },
    clearTimeout: timer => timers.delete(timer),
    TAB_LOCK_TIMEOUT_MS: 1000, HANDLER_TIMEOUT_MS: 10, ABANDONED_TAB_TIMEOUT_MS: 20,
    PAGE_CLOSE_TIMEOUT_MS: 100, PAGE_FORCE_CLOSE_TIMEOUT_MS: 25,
    TAB_LIVENESS_TIMEOUT_MS: 5, MAX_CONSECUTIVE_TIMEOUTS: 3,
    MAX_CONCURRENT_PER_USER: 4, NAVIGATE_TIMEOUT_MS: 1000,
    normalizeUserId: String, quarantinePage, handleTabTimeout,
    isDeadContextError, isTimeoutError, isTabLockQueueTimeout,
    tabLockTimeoutsTotal: { inc() {} }, refreshTabLockQueueDepth() {}, refreshActiveTabsGauge() {},
    tabsDestroyedTotal: { labels: reason => ({ inc: () => destroyed.push(reason) }) },
    pluginEvents: { emit() {} }, log() {}, clearTabDownloads: async () => {},
    createTabHealthTracker: () => ({}), healthState: { activeOps: 0 }, userConcurrency: new Map(),
    ensureBrowser: async () => {}, getSearchFallbacks: () => [], validateUrl: () => null,
    isGoogleSearchUrl: () => false, isGoogleSerp: () => false, proxyPool: null,
    withPageLoadDuration: (_label, operation) => operation(),
    navigatePage: (selected, url) => { navigations.push(selected); return selected.goto(url); },
    navigationRequestTimeoutMs: () => 10, recordNavSuccess() {}, recordNavFailure: () => false,
    buildRefs: async () => new Map(),
    handleRouteError: (error, _req, res) => res.status(error.statusCode || 500).json({ code: error.code, error: error.message }),
    _lastBrowserRestartAt: 0,
    closeSessionOnce, hasSessionClose, UNAVAILABLE_IDENTITY_CLOSE_REASONS: new Set(),
    sharedIdentityLastUrls: new Map(), clearSessionDownloads: async () => {},
    browserRestartsTotal: { labels: () => ({ inc() {} }) },
    sharedIdentities: { async close() {
      closeStarted.resolve();
      await closeGate.promise;
      for (const tab of [...session.tabGroups.values()].flatMap(group => [...group.values()])) await tab.page.close();
    } },
    getSession: async () => { sessions.set('owner', freshSession); return freshSession; },
    releasePageLease: (_session, lease) => releasedLeases.push(lease),
  };
  vm.runInNewContext(sourceBetween('class TabLock {', 'function findTabOwner(tabId)') + '\n' +
    ['findTab', 'findTabOwner', 'handleTimedOutTab', 'safePageClose', 'destroyUnresponsiveTab',
      'withUserLimit', 'createTabState', 'tabNotFoundResponse', 'releaseTabId', 'isProxyError',
      'closeSession', 'clearSessionLocks'].map(serverFunction).join('\n') + '\n' +
    sourceBetween('async function closeSessionNow(', '\nasync function closeAllSessions(') +
    ';globalThis.run = withTabLock; globalThis.locks = tabLocks;', box);
  const registry = createPageRegistry({
    sessions, makeTabId: () => 'context-page', createTabState: box.createTabState,
    attachDownloadListener() {}, releaseTabId: box.releaseTabId,
  });
  box.registerPage = (...args) => {
    const result = registry.registerPage(...args);
    registrations.push({ tabId: result.tabId, page: result.tabState.page });
    return result;
  };
  const oldPage = page(), replacement = page();
  session.context = { pages: () => [oldPage] };
  const oldNavigation = deferred(), replacementNavigation = deferred();
  oldPage.goto = () => { started.resolve(); return oldNavigation.promise; };
  replacement.goto = () => replacementNavigation.promise;
  const original = box.registerPage(session, 'owner', oldPage, 'task', { tabId: 'T' }).tabState;
  box.registerPage(session, 'owner', page(), 'task', { tabId: 'sibling' });
  box.createPageWithRecoveryForUser = async () => {
    creationStarted.resolve();
    if (box.creationGate) await box.creationGate.promise;
    return { session, page: replacement, lease: {} };
  };
  box.createLeasedPage = async () => {
    creationStarted.resolve();
    if (box.creationGate) await box.creationGate.promise;
    const lease = {};
    leasedPages.push({ page: replacement, lease });
    return { page: replacement, lease };
  };
  if (freshContext) box.proxyPool = { canRotateSessions: true };
  // Observe the underlying continuation, not the already-returned HTTP timeout.
  const withTabLock = box.withTabLock;
  box.withTabLock = (id, operation, ...args) => withTabLock(id, async () => {
    try { return await operation(); }
    catch (error) { box.continuationError = error; throw error; }
    finally { continuation.resolve(); }
  }, ...args);
  const code = sourceBetween("app.post('/tabs/:tabId/navigate'", '\n// Snapshot');
  vm.runInNewContext(code, box);
  const server = await new Promise(resolve => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  return Object.assign(box, {
    session, original, oldPage, replacement, oldNavigation, replacementNavigation,
    started, creationStarted, continuation, registrations, navigations, destroyed, releasedLeases,
    closeStarted, closeGate, freshSession, leasedPages,
    async fire(ms) {
      const matching = [...timers].filter(timer => timer.ms === ms);
      assert.ok(matching.length, `expected an armed ${ms}ms deadline`);
      await Promise.all(matching.map(timer => { timers.delete(timer); return timer.fn(); }));
      await turn();
    },
    async request() {
      const response = await fetch(`${url}/tabs/T/navigate`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: 'owner', url: 'https://example.test/hang' }),
        signal: AbortSignal.timeout(2000),
      });
      return { status: response.status, body: await response.json() };
    },
    async close() {
      oldNavigation.resolve(); replacementNavigation.resolve(); box.creationGate?.resolve(); closeGate.resolve();
      await turn();
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      timers.clear();
    },
  });
}

for (const phase of ['after cleanup', 'while replacement creation is pending']) {
  test(`retired navigation cannot restore T ${phase}`, async () => {
    const f = await fixture();
    try {
      const response = f.request();
      await Promise.race([f.started.promise, response.then(result => assert.fail(`navigation did not start: ${JSON.stringify(result)}`))]);
      const oldLock = f.locks.get('T');
      if (phase === 'while replacement creation is pending') {
        f.creationGate = deferred();
        f.oldNavigation.reject(new Error('Target page, context or browser has been closed'));
        await f.creationStarted.promise;
      }
      await f.fire(10);
      expect(await response).toMatchObject({ status: 503, body: { code: 'operation_timeout' } });
      expect(oldLock.settling).toBe(true);
      let outsideFence = 0;
      await expect(f.run('T', async () => { outsideFence++; })).rejects.toMatchObject({
        code: phase === 'after cleanup' ? 'tab_busy' : 'tab_destroyed',
      });
      await f.fire(20);
      expect(f.oldPage.isClosed()).toBe(true);
      expect(oldLock.retired).toBe(true);
      expect(f.findTabOwner('T')).toBeNull();
      expect(f.destroyed).toEqual(['abandoned_operation']);
      f.oldNavigation.reject(new Error('Target page, context or browser has been closed'));
      f.creationGate?.resolve();
      await turn();
      await turn();
      const owner = f.findTabOwner('T');
      const action = await f.run('T', async () => { outsideFence++; return 'escaped'; }).catch(error => error.code);
      f.replacementNavigation.resolve({ status: () => 200 });
      await f.continuation.promise;
      const later = await f.request();
      expect(f.continuationError).toMatchObject({ code: 'tab_destroyed', statusCode: 410 });
      expect(Boolean(owner)).toBe(false);
      expect(f.registrations.filter(entry => entry.tabId === 'T')).toHaveLength(1);
      expect(action).toBe('tab_destroyed');
      expect(outsideFence).toBe(0);
      expect(f.navigations).toEqual([f.oldPage]);
      expect(later.status).toBe(404);
      expect(f.releasedLeases).toHaveLength(phase === 'after cleanup' ? 0 : 1);
      if (phase !== 'after cleanup') expect(f.replacement.isClosed()).toBe(true);
      expect(await f.run('sibling', async () => 42)).toBe(42);
    } finally { await f.close(); }
  }, 5000);
}

for (const pageClosed of [false, true]) {
  test(`fresh-context proxy recovery cannot restore T retired during shared close (pageClosed=${pageClosed})`, async () => {
    const f = await fixture({ freshContext: true });
    try {
      const response = f.request();
      await Promise.race([f.started.promise, response.then(result => assert.fail(`navigation did not start: ${JSON.stringify(result)}`))]);
      const lock = f.locks.get('T');
      f.oldNavigation.reject(new Error('NS_ERROR_PROXY_CONNECTION_REFUSED'));
      await f.closeStarted.promise;
      // The real shared-session teardown preserves T's lock and keeps the old
      // owner findable until the synthetic identity close completes.
      expect(f.findTabOwner('T').tabState).toBe(f.original);
      expect(f.locks.get('T')).toBe(lock);
      expect(lock.retired).toBe(false);
      if (pageClosed) await f.oldPage.close();
      expect(f.findTabOwner('T').tabState).toBe(f.original);
      await f.fire(10);
      expect(await response).toMatchObject({ status: 503, body: { code: 'operation_timeout' } });
      await f.fire(20);
      expect(lock.retired).toBe(true);
      expect(f.locks.has('T')).toBe(false);
      expect(f.findTabOwner('T')).toBeNull();
      f.closeGate.resolve();
      f.replacementNavigation.resolve({ status: () => 200 });
      await f.continuation.promise;
      expect(f.registrations.filter(entry => entry.tabId === 'T')).toHaveLength(1);
      expect(f.continuationError).toMatchObject({ code: 'tab_destroyed', statusCode: 410 });
      expect(f.leasedPages).toHaveLength(0);
      expect(f.navigations).toEqual([f.oldPage]);
      await expect(f.run('T', async () => 'escaped')).rejects.toMatchObject({ code: 'tab_destroyed' });
      expect((await f.request()).status).toBe(404);
    } finally { await f.close(); }
  }, 5000);
}

test('fresh-context proxy recovery closes a leased page after its lock generation is released', async () => {
  const f = await fixture({ freshContext: true });
  try {
    f.creationGate = deferred();
    const response = f.request();
    await Promise.race([f.started.promise, response.then(result => assert.fail(`navigation did not start: ${JSON.stringify(result)}`))]);
    const lock = f.locks.get('T');
    f.oldNavigation.reject(new Error('NS_ERROR_PROXY_CONNECTION_REFUSED'));
    await f.closeStarted.promise;
    f.closeGate.resolve();
    await f.creationStarted.promise;
    // Rotation has removed the old owner, so the abandoned-work timer cannot
    // select it now. Exercise the post-creation fence with the real lock-release
    // primitive, rather than claim that timer delivered this interleaving.
    f.releaseTabId('T');
    expect(lock.retired).toBe(true);
    expect(f.locks.has('T')).toBe(false);
    f.creationGate.resolve();
    f.replacementNavigation.resolve({ status: () => 200 });
    expect(await response).toMatchObject({ status: 410, body: { code: 'tab_destroyed' } });
    await f.continuation.promise;
    expect(f.continuationError).toMatchObject({ code: 'tab_destroyed', statusCode: 410 });
    expect(f.registrations.filter(entry => entry.tabId === 'T')).toHaveLength(1);
    expect(f.leasedPages).toHaveLength(1);
    expect(f.releasedLeases).toEqual([f.leasedPages[0].lease]);
    expect(f.replacement.isClosed()).toBe(true);
    expect(f.findTabOwner('T')).toBeNull();
    expect(f.navigations).toEqual([f.oldPage]);
    await expect(f.run('T', async () => 'escaped')).rejects.toMatchObject({ code: 'tab_destroyed' });
    expect((await f.request()).status).toBe(404);
  } finally { await f.close(); }
}, 5000);

test('non-retired fresh-context proxy recovery preserves T and releases its page lease', async () => {
  const f = await fixture({ freshContext: true });
  try {
    const response = f.request();
    await Promise.race([f.started.promise, response.then(result => assert.fail(`navigation did not start: ${JSON.stringify(result)}`))]);
    const lock = f.locks.get('T');
    f.oldNavigation.reject(new Error('NS_ERROR_PROXY_CONNECTION_REFUSED'));
    await f.closeStarted.promise;
    f.closeGate.resolve();
    f.replacementNavigation.resolve({ status: () => 200 });
    expect(await response).toMatchObject({ status: 200, body: { ok: true, tabId: 'T' } });
    expect(f.findTabOwner('T')).toMatchObject({ session: f.freshSession });
    expect(f.findTabOwner('T').tabState.page).toBe(f.replacement);
    expect(f.findTabOwner('T').tabState.googleRetryCount).toBe(1);
    expect(f.oldPage.isClosed()).toBe(true);
    expect(f.original.preserveLockOnClose).toBeUndefined();
    expect(f.session.tabGroups.get('task')?.has('T') || false).toBe(false);
    f.oldPage.emit('close');
    expect(f.locks.get('T')).toBe(lock);
    expect(lock.retired).toBe(false);
    expect(f.leasedPages).toHaveLength(1);
    expect(f.releasedLeases).toEqual([f.leasedPages[0].lease]);
    expect(f.replacement.isClosed()).toBe(false);
    expect(f.navigations).toEqual([f.oldPage, f.replacement]);
    expect(await f.run('T', async () => 42)).toBe(42);
    expect((await f.request()).status).toBe(200);
  } finally { await f.close(); }
}, 5000);

test('a non-retired dead page is deliberately replaced and keeps T usable', async () => {
  const f = await fixture();
  try {
    const response = f.request();
    await Promise.race([f.started.promise, response.then(result => assert.fail(`navigation did not start: ${JSON.stringify(result)}`))]);
    const lock = f.locks.get('T');
    f.oldNavigation.reject(new Error('Target page, context or browser has been closed'));
    await f.creationStarted.promise;
    f.replacementNavigation.resolve({ status: () => 200 });
    expect(await response).toMatchObject({ status: 200, body: { ok: true, tabId: 'T' } });
    expect(f.findTabOwner('T').tabState.page).toBe(f.replacement);
    expect(f.locks.get('T')).toBe(lock);
    expect(lock.retired).toBe(false);
    expect(f.navigations).toEqual([f.oldPage, f.replacement]);
    expect(await f.run('T', async () => 42)).toBe(42);
    expect((await f.request()).status).toBe(200);
  } finally { await f.close(); }
}, 5000);
