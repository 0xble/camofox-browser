import { jest } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { withRequestDeadline } from '../../lib/request-deadline.js';
import { createPageWithSessionRecovery } from '../../lib/new-page-recovery.js';
import { releasePageLease } from '../../lib/page-lease.js';
import { isTimeoutError } from '../../lib/browser-errors.js';

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

function fixture({ initialSession, pendingPage, navigation } = {}) {
  let handler;
  const page = { url: () => 'https://fixture.invalid/', close: jest.fn(async () => {}) };
  const session = { sharedIdentity: true, tabGroups: new Map([['other-task', new Map([['other', { page: {} }]])]]),
    context: { newPage: jest.fn(() => pendingPage?.promise || Promise.resolve(page)) } };
  const destroySession = jest.fn();
  const closePage = jest.fn(async (_session, latePage) => latePage.close());
  const emitted = [];
  const scope = {
    app: { post: (_path, callback) => { handler = callback; } },
    FLY_MACHINE_ID: null, MAX_TABS_PER_SESSION: 10, MAX_TABS_GLOBAL: 30,
    sessions: new Map([['shared', session]]), normalizeUserId: value => value,
    withRequestDeadline, requestTimeoutMs: () => 10,
    getSession: jest.fn(() => initialSession?.promise || Promise.resolve(session)),
    getTotalTabCount: () => 1,
    createPageWithRecoveryForUser: (_user, current, options) => createPageWithSessionRecovery({
      userId: 'shared', session: current, ...options, timeoutMs: 1000,
      withTimeout: promise => promise, isTimeoutError, isDeadContextError: () => false,
      currentSession: () => session, destroySession, getSession: async () => session,
      closePage, log: () => {},
    }),
    getTabGroup: (current, key) => {
      if (!current.tabGroups.has(key)) current.tabGroups.set(key, new Map());
      return current.tabGroups.get(key);
    },
    findTabByPage: () => null,
    fly: { makeTabId: () => 'new-tab' },
    createTabState: created => ({ page: created, visitedUrls: new Set() }),
    attachDownloadListener: () => {}, attachPopupHandler: () => {},
    releasePageLease, refreshActiveTabsGauge: () => {},
    validateUrl: () => null, withPageLoadDuration: (_name, fn) => fn(),
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
    handleRouteError: (error, _req, res) => res.status(error.statusCode || 500).json({ code: error.code }),
  };
  runInNewContext(route, scope);
  const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; } };
  return { scope, session, page, closePage, destroySession, emitted, res,
    run: () => handler({ body: { userId: 'shared', sessionKey: 'new-task', url: 'https://fixture.invalid/' } }, res) };
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
