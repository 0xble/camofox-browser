import { jest } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { withRequestDeadline } from '../../lib/request-deadline.js';
import { createPageWithSessionRecovery } from '../../lib/new-page-recovery.js';
import { releasePageLease } from '../../lib/page-lease.js';
import { isTimeoutError } from '../../lib/browser-errors.js';
import { createPageRegistry } from '../../lib/page-registry.js';

// Run the actual registered route with a deterministic browser transport. This
// avoids launching or touching any real shared identity/profile in failure tests.
const source = readFileSync(new URL('../../server.js', import.meta.url), 'utf8');
const start = source.indexOf("app.post('/tabs', async");
const route = source.slice(start, source.indexOf('// Navigate\n', start));
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const flush = () => new Promise(resolve => setImmediate(resolve));

function fixture({ initialSession, pendingPage, navigation, url = 'https://fixture.invalid/', atCapacity = false, empty = false, omitUrl = false } = {}) {
  let handler;
  const page = { url: () => 'https://fixture.invalid/', close: jest.fn(async () => {}), on: () => {} };
  const session = { sharedIdentity: true, tabGroups: new Map([['other-task', new Map([['other', { page: {} }]])]]),
    context: { newPage: jest.fn(() => pendingPage?.promise || Promise.resolve(page)) } };
  const destroySession = jest.fn();
  const closePage = jest.fn(async (_session, latePage) => latePage.close());
  const emitted = [];
  const sessions = new Map(empty ? [] : [['shared', session]]);
  const registry = createPageRegistry({ sessions, makeTabId: () => 'new-tab',
    createTabState: created => ({ page: created, visitedUrls: new Set() }), attachDownloadListener: () => {} });
  const scope = {
    app: { post: (_path, callback) => { handler = callback; } },
    FLY_MACHINE_ID: null, MAX_TABS_PER_SESSION: atCapacity === 'session' ? 1 : 10, MAX_TABS_GLOBAL: atCapacity === 'global' ? 1 : 30,
    sessions, normalizeUserId: value => value,
    withRequestDeadline, requestTimeoutMs: () => 10,
    navigationRequestTimeoutMs: () => 10,
    getSession: jest.fn(() => initialSession?.promise || Promise.resolve(session)),
    withTabLock: async (_tabId, operation) => operation(),
    getTotalTabCount: () => 1,
    recycleIdleSharedTab: jest.fn(async () => { session.tabGroups.clear(); return true; }),
    recycleOldestTab: jest.fn(async () => { session.tabGroups.clear(); return true; }),
    createPageWithRecoveryForUser: (_user, current, options) => createPageWithSessionRecovery({
      userId: 'shared', session: current, ...options, timeoutMs: 1000,
      withTimeout: promise => promise, isTimeoutError, isDeadContextError: () => false,
      currentSession: () => session, destroySession, getSession: async () => session,
      closePage, log: () => {},
    }),
    registerPage: registry.registerPage,
    releasePageLease, refreshActiveTabsGauge: () => {},
    validateUrl: runInNewContext(`(${source.slice(source.indexOf('function validateUrl('), source.indexOf('// isLoopbackAddress'))})`,
      { URL, ALLOWED_URL_SCHEMES: ['http:', 'https:'] }),
    withPageLoadDuration: (_name, fn) => fn(),
    navigatePage: jest.fn(() => navigation?.promise || Promise.resolve()),
    recordNavSuccess: jest.fn(), recordNavFailure: jest.fn(() => true),
    recoverUserSession: jest.fn(), proxyPool: null, isProxyError: () => false, isTimeoutError,
    pluginEvents: { emit: (...args) => emitted.push(args) }, log: () => {},
    destroyTab: jest.fn((current, tabId) => {
      for (const group of current.tabGroups.values()) {
        const state = group.get(tabId);
        if (state) { void state.page.close(); group.delete(tabId); }
      }
    }),
    handleRouteError: (error, _req, res) => res.status(error.statusCode || 500).json({ code: error.code, error: error.message }),
  };
  runInNewContext(route, scope);
  const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; } };
  return { scope, session, page, closePage, destroySession, emitted, res,
    run: () => handler({ body: { userId: 'shared', sessionKey: 'new-task', ...(!omitUrl && { url }) } }, res) };
}

test('expired session acquisition never creates or navigates a tab later', async () => {
  const initialSession = deferred();
  const f = fixture({ initialSession });
  await f.run();
  expect(f.res.statusCode).toBe(503);
  initialSession.resolve(f.session);
  await flush();
  expect(f.session.context.newPage).not.toHaveBeenCalled();
  expect(f.scope.navigatePage).not.toHaveBeenCalled();
  expect(f.emitted).toEqual([]);
});

test('late new page is closed without registration or navigation', async () => {
  const pendingPage = deferred();
  const f = fixture({ pendingPage });
  await f.run();
  expect(f.res.statusCode).toBe(503);
  pendingPage.resolve(f.page);
  await flush();
  expect(f.page.close).toHaveBeenCalledTimes(1);
  expect(f.session.tabGroups.has('new-task')).toBe(false);
  expect(f.scope.navigatePage).not.toHaveBeenCalled();
  expect(f.destroySession).not.toHaveBeenCalled();
  expect(f.emitted).toEqual([]);
});

test('navigation deadline removes only the new tab and fences late success', async () => {
  const navigation = deferred();
  const f = fixture({ navigation });
  await f.run();
  expect(f.res.statusCode).toBe(503);
  expect(f.page.close).toHaveBeenCalledTimes(1);
  expect(f.session.tabGroups.get('other-task').has('other')).toBe(true);
  expect(f.session.tabGroups.get('new-task').has('new-tab')).toBe(false);
  navigation.resolve();
  await flush();
  expect(f.scope.recordNavSuccess).not.toHaveBeenCalled();
  expect(f.scope.recoverUserSession).not.toHaveBeenCalled();
  expect(f.emitted).toEqual([]);
});

test('successful creation retains the new page after the deadline would have expired', async () => {
  const f = fixture();
  await f.run();
  expect(f.res.statusCode).toBe(200);
  expect(f.res.body.tabId).toBe('new-tab');
  await new Promise(resolve => setTimeout(resolve, 15));
  expect(f.page.close).not.toHaveBeenCalled();
  expect(f.emitted).toHaveLength(1);
});

test.each(['not a URL', '', 0, false, {}, [], ['https://fixture.invalid/'], ['http://fixture.invalid/'], 'about:blank', 'file:///private/fixture', 'javascript:void(0)'])(
  'invalid initial URL %s cannot allocate a session or page', async url => {
    const f = fixture({ url, empty: true });
    await f.run();
    expect(f.res.statusCode).toBe(400);
    expect(f.res.body.error).toMatch(/Invalid URL|Blocked URL scheme/);
    expect(f.scope.getSession).not.toHaveBeenCalled();
    expect(f.scope.sessions.size).toBe(0);
    expect(f.session.context.newPage).not.toHaveBeenCalled();
    expect(f.emitted).toEqual([]);
  },
);

test.each([[true, 'session'], [false, 'session'], [true, 'global'], [false, 'global']]
  .flatMap(([shared, limit]) => ['about:blank', ['https://fixture.invalid/']].map(url => [shared, limit, url])))(
  'invalid initial URL cannot recycle at capacity (shared=%s, limit=%s, url=%j)', async (shared, atCapacity, url) => {
    const f = fixture({ url, atCapacity });
    f.session.sharedIdentity = shared;
    const originalGroup = f.session.tabGroups.get('other-task');
    await f.run();
    expect(f.res.statusCode).toBe(400);
    expect(f.scope.getSession).not.toHaveBeenCalled();
    expect(f.scope.recycleIdleSharedTab).not.toHaveBeenCalled();
    expect(f.scope.recycleOldestTab).not.toHaveBeenCalled();
    expect(f.session.tabGroups.get('other-task')).toBe(originalGroup);
    expect(originalGroup.has('other')).toBe(true);
    expect(f.session.context.newPage).not.toHaveBeenCalled();
  },
);

test.each(['http://fixture.invalid/', 'https://fixture.invalid/', null, undefined])(
  'allowed or omitted initial URL creates normally (%s)', async url => {
    const f = fixture({ url, omitUrl: url === undefined });
    await f.run();
    expect(f.res.statusCode).toBe(200);
    expect(f.session.context.newPage).toHaveBeenCalledTimes(1);
    expect(f.scope.navigatePage).toHaveBeenCalledTimes(url ? 1 : 0);
    expect(f.emitted).toHaveLength(1);
  },
);
