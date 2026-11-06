import assert from 'node:assert/strict';
const test = globalThis.test ?? (await import('node:test')).test;
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { tabClosable, latestAgentTabId } from '../../lib/idle-tabs.js';
import { createSharedIdentityIdlePolicy } from '../../lib/shared-identity-idle.js';
import { acquirePageLease, setLeasedPage, releasePageLease } from '../../lib/page-lease.js';
import { withRequestDeadline } from '../../lib/request-deadline.js';
import { browserErrorStatus, browserErrorCode, browserErrorRecovery, isRetryableBrowserError } from '../../lib/browser-errors.js';

const source = readFileSync(new URL('../../server.js', import.meta.url), 'utf8');
function serverFunction(name, deps, async = true) {
  const start = source.indexOf(`${async ? 'async ' : ''}function ${name}(`);
  if (start < 0) return undefined;
  return vm.runInNewContext(`(${source.slice(start, source.indexOf('\n}\n', start) + 2)})`, deps);
}
// Small runner-independent spy: Jest does not expose Node's `mock` export.
function spy(implementation = () => {}) {
  let calls = 0;
  const fn = (...args) => { calls++; return implementation(...args); };
  fn.mock = { callCount: () => calls, mockImplementation: next => { implementation = next; } };
  return fn;
}
const NOW = 10_000_000;
const IDLE = NOW - 31 * 60_000;
function tab(at = IDLE) {
  const page = { url: () => 'https://person:secret@fixture.test/private?token=secret#secret',
    isClosed: () => false, on: () => {}, title: async () => '', close: spy(async () => {}) };
  return { page, createdAt: at - 1000, pressureObservedAt: at - 1000, lastAgentActivityAt: at, toolCalls: 0,
    visitedUrls: new Set(), activeDownloads: 0 };
}
function fixture({ legacy = false, global = false, headed = true } = {}) {
  const old = tab(IDLE - 1000), idle = tab(), latest = tab(NOW);
  const session = { sharedIdentity: true, headed, keepOpen: true, lastAccess: NOW,
    tabGroups: new Map([['abandoned-task', new Map([['old', old], ['idle', idle]])], ['active-task', new Map([['latest', latest]])]]),
    visibility: { visible: new Map(headed ? [[1, {}]] : []), isPageVisible: spy(() => false) } };
  const sessions = new Map([['shared', session]]);
  const newTab = tab(NOW);
  const humanControlledTabs = new Set(), tabLocks = new Map();
  let handler;
  const deps = {
    app: { post: (_path, callback) => { handler = callback; } },
    sessions, humanControlledTabs, tabLocks, tabClosable, latestSharedTabId: latestAgentTabId, normalizeUserId: String,
    CONFIG: { hiddenTabIdleMin: 30, sharedTabIdleMin: 30, hiddenSessionIdleMin: 0, headedIdleReleaseMin: 0 },
    sharedIdentityIdlePolicy: createSharedIdentityIdlePolicy({ readIdleSeconds: async () => 7200, clock: () => NOW }),
    identityTransitions: new Map(), sharedIdentityRequests: new Map(),
    identityBusy: () => false, closeSession: spy(async () => {}),
    MAX_TABS_PER_SESSION: global ? 10 : 3, MAX_TABS_GLOBAL: global ? 3 : 100,
    getTotalTabCount: () => [...session.tabGroups.values()].reduce((n, g) => n + g.size, 0),
    FLY_MACHINE_ID: null, normalizeUserId: String, getSession: async () => session,
    withRequestDeadline, requestTimeoutMs: () => 1000, navigationRequestTimeoutMs: () => 1000, releasePageLease,
    createPageWithRecoveryForUser: spy(async () => ({ session, page: newTab.page })),
    createLeasedPage: spy(async () => ({ page: newTab.page })),
    registerPage: (_session, _user, _page, key) => {
      session.tabGroups.set(key, new Map([['new', newTab]]));
      return { tabId: 'new', tabState: newTab };
    },
    safePageClose: page => page.close(), clearTabDownloads: async () => {},
    findTab: (s, id) => {
      for (const [listItemId, group] of s.tabGroups) if (group.has(id)) return { tabState: group.get(id), group, listItemId };
    },
    validateUrl: () => null, withTabLock: async (_id, work) => work(),
    withPageLoadDuration: (_name, work) => work(), navigatePage: async () => {}, recordNavSuccess: () => {},
    pluginEvents: { emit: spy() }, log: () => {},
    refreshTabLockQueueDepth: () => {}, refreshActiveTabsGauge: () => {},
    tabsRecycledTotal: { inc: spy() }, tabsReapedTotal: { inc: spy() },
    recycleOldestTab: spy(async () => { await old.page.close(); return true; }),
    browserErrorStatus, browserErrorCode, browserErrorRecovery, isRetryableBrowserError,
    safeError: err => err.message, StaleRefsError: class extends Error {}, sentryCaptureException: () => {},
    hashIdentifier: () => null, actionFromReq: () => 'create',
    Date: class extends Date { static now() { return NOW; } }, URL,
  };
  for (const [name, async] of [['sharedTabClosable', false], ['closeSharedTab', true], ['recycleIdleSharedTab', true],
    ['tabLimitError', false], ['sendError', false], ['sharedSessionExpiryEligible', false], ['cleanIdleSharedSessions', true]]) {
    const fn = serverFunction(name, deps, async);
    if (fn) deps[name] = fn;
  }
  deps.handleRouteError = (err, _req, res) => deps.sendError(res, err);
  const routeStart = source.indexOf(`app.post('${legacy ? '/tabs/open' : '/tabs'}', async`);
  const routeEnd = source.indexOf('\n});', routeStart) + 4;
  vm.runInNewContext(source.slice(routeStart, routeEnd), deps);
  const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; } };
  return { deps, session, old, idle, latest, newTab, res,
    run: () => handler({ body: { userId: 'shared', sessionKey: 'new-task', listItemId: 'new-task', ...(legacy ? { url: 'https://fixture.test/' } : {}) } }, res) };
}

for (const legacy of [false, true]) test(`headed shared identity recycles oldest idle agent tab (legacy=${legacy})`, async () => {
  const f = fixture({ legacy });
  await f.run();
  assert.equal(f.res.statusCode, 200, JSON.stringify(f.res.body));
  assert.equal(f.old.page.close.mock.callCount(), 1);
  assert.equal(f.idle.page.close.mock.callCount(), 0);
  assert.equal(f.latest.page.close.mock.callCount(), 0);
  assert.equal(f.deps.recycleOldestTab.mock.callCount(), 0);
  assert.equal(f.deps.getTotalTabCount(), 3);
});

for (const headed of [false, true]) test(`global cap recycles only requesting identity idle tab (headed=${headed})`, async () => {
  const f = fixture({ global: true, headed });
  const other = tab(NOW);
  f.deps.sessions.set('other-identity', { tabGroups: new Map([['task', new Map([['other', other]])]]) });
  await f.run();
  assert.equal(f.res.statusCode, 200, JSON.stringify(f.res.body));
  assert.equal(f.old.page.close.mock.callCount(), 1);
  assert.equal(other.page.close.mock.callCount(), 0);
});

for (const [label, protect] of [
  ['handed off', f => f.deps.humanControlledTabs.add('old')],
  ['shown to human', f => f.session.visibility.isPageVisible.mock.mockImplementation(p => p === f.old.page)],
  ['UI owned', f => { const g = f.session.tabGroups.get('abandoned-task'); g.delete('old'); f.session.tabGroups.set('__shared_identity__', new Map([['old', f.old]])); }],
  ['locked', f => f.deps.tabLocks.set('old', { active: true })],
  ['queued', f => f.deps.tabLocks.set('old', { queue: [{}] })],
  ['leased', f => setLeasedPage(acquirePageLease(f.session), f.old.page)],
  ['download', f => { f.old.activeDownloads = 1; }],
  ['already retiring', f => { f.old.retiring = true; }],
  ['handoff state', f => { f.old.handoff = 'human'; }],
  ['recent agent use in another task', f => { f.old.lastAgentActivityAt = NOW - 1; }],
]) test(`cap preserves ${label} tab`, async () => {
  const f = fixture(); protect(f);
  await f.deps.recycleIdleSharedTab(f.session, 'request', 'shared');
  assert.equal(f.old.page.close.mock.callCount(), 0);
  assert.equal(f.idle.page.close.mock.callCount(), 1);
});

for (const legacy of [false, true]) test(`all busy returns coded 429 with redacted tab diagnostics (legacy=${legacy})`, async () => {
  const f = fixture({ legacy });
  f.deps.tabLocks.set('old', { active: true });
  f.deps.humanControlledTabs.add('idle');
  await f.run();
  assert.equal(f.res.statusCode, 429);
  assert.equal(f.res.body.code, 'tab_limit_reached');
  assert.equal(f.res.body.tabs.length, 3);
  assert.equal(JSON.stringify(f.res.body.tabs.find(t => t.tabId === 'old')), JSON.stringify({ tabId: 'old', sessionKey: 'abandoned-task', origin: 'https://fixture.test', ageSeconds: 1862, idleSeconds: 1861 }));
  assert.doesNotMatch(JSON.stringify(f.res.body), /secret|private|token/);
  assert.equal(f.old.page.close.mock.callCount(), 0);
  assert.equal(f.idle.page.close.mock.callCount(), 0);
});

for (const seconds of [0, null]) test(`recent or unknown human activity preserves user-visible pages (${seconds})`, async () => {
  const f = fixture();
  f.deps.sharedIdentityIdlePolicy = createSharedIdentityIdlePolicy({ readIdleSeconds: async () => seconds, clock: () => NOW });
  f.session.visibility.isPageVisible.mock.mockImplementation(() => true);
  await f.run();
  assert.equal(f.res.statusCode, 429);
  assert.equal(f.old.page.close.mock.callCount(), 0);
});

test('rechecks agent activity and handoff after awaiting native visibility readback', async () => {
  const f = fixture();
  f.session.visibility.refresh = async () => {
    f.old.lastAgentActivityAt = NOW;
    f.deps.humanControlledTabs.add('idle');
  };
  await f.run();
  assert.equal(f.res.statusCode, 429);
  assert.equal(f.old.page.close.mock.callCount(), 0);
  assert.equal(f.idle.page.close.mock.callCount(), 0);
});

test('cap admission refreshes external human visibility before recycling', async () => {
  const f = fixture({ headed: false });
  f.session.visibility.refresh = async () => {
    f.session.visibility.visible.set(0, {});
    f.session.visibility.isPageVisible.mock.mockImplementation(() => true);
  };
  await f.run();
  assert.equal(f.res.statusCode, 429);
  assert.equal(f.old.page.close.mock.callCount(), 0);
});

test('unknown native visibility prevents cap eviction and idle reaping', async () => {
  const f = fixture();
  f.session.visibility.refresh = async () => { throw new Error('unavailable'); };
  await f.run();
  await f.deps.cleanIdleSharedSessions();
  assert.equal(f.res.statusCode, 429);
  assert.equal(f.old.page.close.mock.callCount(), 0);
});

test('disabled cleanup retains the cap and returns diagnostics', async () => {
  const f = fixture();
  f.deps.CONFIG.hiddenTabIdleMin = 0;
  f.deps.CONFIG.sharedTabIdleMin = 0;
  await f.run();
  assert.equal(f.res.statusCode, 429);
  assert.equal(f.res.body.code, 'tab_limit_reached');
  assert.equal(f.old.page.close.mock.callCount(), 0);
});

test('headed contexts without per-page visibility proof fail closed', async () => {
  const f = fixture();
  delete f.session.visibility.isPageVisible;
  await f.run();
  assert.equal(f.res.statusCode, 429);
  assert.equal(f.old.page.close.mock.callCount(), 0);
});

for (const hiddenTabIdleMin of [0, 30]) test(`headed identity cannot expire with session cleanup enabled (tab idle=${hiddenTabIdleMin})`, async () => {
  const f = fixture();
  f.session.lastAccess = IDLE - 120 * 60_000;
  Object.assign(f.deps.CONFIG, { hiddenTabIdleMin, hiddenSessionIdleMin: 120 });
  await f.deps.cleanIdleSharedSessions();
  assert.equal(f.deps.closeSession.mock.callCount(), 0, 'real expiry predicate must preserve headed identities');
});

test('concurrent recyclers never claim the same retiring tab', async () => {
  const f = fixture();
  let finish;
  f.old.page.close.mock.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const first = f.deps.recycleIdleSharedTab(f.session, 'a', 'shared');
  await new Promise(resolve => setImmediate(resolve));
  await f.deps.recycleIdleSharedTab(f.session, 'b', 'shared');
  assert.equal(f.old.page.close.mock.callCount(), 1);
  assert.equal(f.idle.page.close.mock.callCount(), 1);
  finish(); await first;
});

test('idle reaper refreshes visibility after each close before selecting another tab', async () => {
  const f = fixture({ headed: false });
  let refreshes = 0;
  f.session.visibility.refresh = async () => {
    refreshes++;
    if (f.old.page.close.mock.callCount()) {
      f.session.visibility.visible.set(0, {});
      f.session.visibility.isPageVisible.mock.mockImplementation(() => true);
    }
  };
  await f.deps.cleanIdleSharedSessions();
  assert.equal(f.old.page.close.mock.callCount(), 1);
  assert.equal(f.idle.page.close.mock.callCount(), 0);
  assert.ok(refreshes >= 3);
});

test('idle reaper also reclaims abandoned agent tabs in headed identities', async () => {
  const f = fixture();
  await f.deps.cleanIdleSharedSessions();
  assert.equal(f.old.page.close.mock.callCount(), 1);
  assert.equal(f.idle.page.close.mock.callCount(), 1);
  assert.equal(f.latest.page.close.mock.callCount(), 0);
});
for (const seconds of [0, null]) for (const sweep of [false, true])
test(`verified parked pages and managed popups ignore unrelated desktop HID (seconds=${seconds}, sweep=${sweep})`, async () => {
  const f = fixture();
  f.old.openerPage = f.latest.page; // Managed popup remains an ordinary task-owned tab.
  f.deps.sharedIdentityIdlePolicy = createSharedIdentityIdlePolicy({ readIdleSeconds: async () => seconds, clock: () => NOW });
  if (sweep) await f.deps.cleanIdleSharedSessions();
  else await f.run();
  assert.equal(f.old.page.close.mock.callCount(), 1);
  assert.equal(f.latest.page.close.mock.callCount(), 0);
  if (!sweep) assert.equal(f.res.statusCode, 200);
});

for (const sweep of [false, true]) test(`shared agent idle threshold reclaims at five minutes, not thirty (sweep=${sweep})`, async () => {
  const f = fixture();
  f.deps.CONFIG.sharedTabIdleMin = 5;
  f.old.lastAgentActivityAt = NOW - 5 * 60_000;
  f.idle.lastAgentActivityAt = NOW - 5 * 60_000 + 1;
  if (sweep) await f.deps.cleanIdleSharedSessions();
  else await f.run();
  assert.equal(f.old.page.close.mock.callCount(), 1);
  assert.equal(f.idle.page.close.mock.callCount(), 0, 'a tab even one millisecond below the threshold stays open');
  assert.equal(f.latest.page.close.mock.callCount(), 0);
});

for (const sweep of [false, true]) test(`visible human windows are never reaped even after desktop HID idle (sweep=${sweep})`, async () => {
  const f = fixture();
  f.session.visibility.isPageVisible.mock.mockImplementation(() => true);
  if (sweep) await f.deps.cleanIdleSharedSessions();
  else await f.run();
  assert.equal(f.old.page.close.mock.callCount(), 0);
  assert.equal(f.idle.page.close.mock.callCount(), 0);
});

for (const protect of [
  ['closing session', f => { f.session._closing = true; }],
  ['retiring tab', f => { f.old.retiring = true; }],
  ['human handoff', f => { f.old.handoff = 'human'; }],
  ['queued operation', f => { f.deps.tabLocks.set('old', { active: 0, queue: [{}] }); }],
]) for (const sweep of [false, true]) test(`does not inspect a page with ${protect[0]} (sweep=${sweep})`, async () => {
  const f = fixture();
  protect[1](f);
  const inspected = [];
  f.session.visibility.refresh = async page => { if (page) inspected.push(page); };
  if (sweep) await f.deps.cleanIdleSharedSessions();
  else await f.run();
  assert.equal(inspected.includes(f.old.page), false);
  assert.equal(f.old.page.close.mock.callCount(), 0);
});

for (const sweep of [false, true]) test(`visibility refresh starting a handoff fences cleanup (sweep=${sweep})`, async () => {
  const f = fixture();
  f.session.visibility.refresh = async () => { f.deps.identityTransitions.set('shared', true); };
  if (sweep) await f.deps.cleanIdleSharedSessions();
  else await f.run();
  assert.equal(f.deps.identityTransitions.get('shared'), true);
  assert.equal(f.old.page.close.mock.callCount(), 0);
  assert.equal(f.idle.page.close.mock.callCount(), 0);
});
