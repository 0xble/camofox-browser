import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { readFileSync } from 'node:fs';
import { it as nodeIt } from 'node:test';
import vm from 'node:vm';
import { handleTabTimeout } from '../../lib/tab-timeout.js';
import { createPageRegistry, quarantinePage, isQuarantinedPage } from '../../lib/page-registry.js';
import { createSharedIdentityWindowOpener } from '../../lib/shared-identity-window.js';
import { SharedIdentityManager } from '../../lib/shared-identity.js';
import { applySharedTabHandoff } from '../../lib/shared-tab-handoff.js';

const it = globalThis.it ?? nodeIt;
const source = readFileSync(new URL('../../server.js', import.meta.url), 'utf8');
const turn = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
}
function serverFunction(name) {
  const matches = [...source.matchAll(new RegExp(`^(?:async )?function ${name}\\([^\\n]*\\) \\{[\\s\\S]*?^\\}`, 'gm'))];
  assert.equal(matches.length, 1, `expected actual server ${name}`);
  return matches[0][0];
}

// Run the actual lock, timeout, destruction and identity admission functions.
// Only pages, filesystem cleanup, metrics and the clock are collaborators.
function fixture() {
  const timers = new Set(), closed = [], destroyed = [], logs = [];
  const page = name => ({ closed: false, isClosed() { return this.closed; },
    evaluate: expression => typeof expression === 'function' ? Promise.resolve(1) : new Promise(() => {}),
    async close() { this.closed = true; closed.push(name); }, removeAllListeners() {},
    async bringToFront() {},
  });
  const group = new Map(['A', 'B'].map(id => [id, { page: page(id) }]));
  const session = { headed: true, tabGroups: new Map([['task', group]]) };
  const sessions = new Map([['identity', session]]);
  const box = {
    AsyncLocalStorage,
    setTimeout(fn, ms) { const timer = { fn, ms, unref() {} }; timers.add(timer); return timer; },
    clearTimeout(timer) { timers.delete(timer); },
    TAB_LOCK_TIMEOUT_MS: 1000, HANDLER_TIMEOUT_MS: 10, ABANDONED_TAB_TIMEOUT_MS: 20,
    PAGE_CLOSE_TIMEOUT_MS: 100, PAGE_FORCE_CLOSE_TIMEOUT_MS: 25,
    TAB_LIVENESS_TIMEOUT_MS: 5, MAX_CONSECUTIVE_TIMEOUTS: 3,
    tabLockTimeoutsTotal: { inc() {} }, refreshTabLockQueueDepth() {}, refreshActiveTabsGauge() {},
    findTabOwner(id) { const tabState = group.get(id); return tabState ? { tabState, session, userId: 'identity' } : null; },
    findTab(_session, id) { const tabState = group.get(id); return tabState ? { tabState, group, listItemId: 'task' } : null; },
    isTabLockQueueTimeout: () => false, handleTabTimeout,
    quarantinePage, clearTabDownloads: async () => {}, log: (...entry) => logs.push(entry), applySharedTabHandoff,
    AbortController, ensureBrowser: async () => {}, getSearchFallbacks: () => [], validateUrl: () => null,
    isGoogleSearchUrl: () => false, withPageLoadDuration: (_label, operation) => operation(),
    navigatePage: page => page.goto(), NAVIGATE_TIMEOUT_MS: 1000, navigationRequestTimeoutMs: () => 10,
    MAX_CONCURRENT_PER_USER: 1, healthState: { activeOps: 0 },
    normalizeUserId: id => id, handleRouteError: (error, _req, res) => { res.error = error; },
    tabsRecycledTotal: { inc() {} },
    tabsDestroyedTotal: { labels: reason => ({ inc: () => destroyed.push(reason) }) }, pluginEvents: { emit() {} },
    sharedIdentityRequests: new Map(), sessionCreations: new Map(),
    sharedIdentities: { closings: new Set() }, userConcurrency: new Map(), hasActivePageLeases: () => false,
  };
  vm.runInNewContext(source.slice(source.indexOf('class TabLock {'), source.indexOf('function findTabOwner(tabId)')) +
    '\n' + ['handleTimedOutTab', 'safePageClose', 'destroyUnresponsiveTab', 'destroyTab', 'recycleOldestTab', 'closeSharedTab', 'identityBusy', 'withUserLimit'].map(serverFunction).join('\n') +
    ';globalThis.run = withTabLock; globalThis.timeout = withTimeout; globalThis.locks = tabLocks; globalThis.human = humanControlledTabs;', box);
  function route(declaration) {
    const start = source.indexOf(declaration);
    assert.notEqual(start, -1);
    const handlerStart = source.indexOf('async (req, res) => {', start);
    const handlerEnd = source.indexOf('\n});', handlerStart);
    return vm.runInNewContext(`(${source.slice(handlerStart, handlerEnd + 2)})`, box);
  }
  box.handoff = route("app.post('/tabs/:tabId/handoff'");
  box.navigate = route("app.post('/tabs/:tabId/navigate'");
  box.closeTab = route("app.delete('/tabs/:tabId'");
  box.closeGroup = route("app.delete('/tabs/group/:listItemId'");
  return Object.assign(box, { session, group, sessions, closed, destroyed, timers, logs,
    async fire(ms) { for (const timer of [...timers]) if (timer.ms === ms && timers.delete(timer)) timer.fn(); await turn(); },
  });
}
async function abandon(f, operation = () => f.group.get('A').page.evaluate('new Promise(() => {})'), budget = 10) {
  const result = f.run('A', operation, budget).catch(error => error);
  await turn();
  await f.fire(budget);
  const error = await result;
  assert.equal(error.code, 'operation_timeout');
  assert.equal(f.locks.get('A').settling, true);
}

it('does not arm abandoned recovery without an expected or current owner', async () => {
  const f = fixture();
  const lock = f.getTabLock('missing');
  lock.settling = true;
  assert.doesNotThrow(() => f.armAbandonedTabRecovery('missing', lock, null));
  assert.equal(lock.settlingTimer ?? null, null);
  assert.equal([...f.timers].some(timer => timer.ms === 20), false);
  await f.fire(20);
  assert.deepEqual(f.destroyed, []);
});

it('logs a no-op when the owner disappears before abandoned recovery fires', async () => {
  const f = fixture();
  await abandon(f);
  const lock = f.locks.get('A');
  f.group.delete('A');
  await f.fire(20);
  assert.equal(lock.settlingTimer, null);
  assert.deepEqual(f.destroyed, []);
  assert.equal(f.group.has('B'), true);
  assert.ok(f.logs.some(([level, message, fields]) => level === 'info' &&
    message === 'abandoned tab recovery skipped' && fields.tabId === 'A' && fields.reason === 'tab_missing'));
});

for (const failure of ['synchronous', 'asynchronous']) {
  it(`logs ${failure} recovery errors instead of escaping the timer`, async () => {
    const f = fixture();
    await abandon(f);
    f.destroyUnresponsiveTab = () => {
      if (failure === 'synchronous') throw new Error('recovery failed');
      return Promise.reject(new Error('recovery failed'));
    };
    await f.fire(20);
    assert.ok(f.logs.some(([level, message, fields]) => level === 'error' &&
      message === 'abandoned tab recovery failed' && fields.tabId === 'A' && fields.error === 'recovery failed'));
    assert.equal(await f.run('B', async () => 42), 42);
  });
}

it('rejects navigation queued before tab deletion without touching the wedged captured page', async () => {
  const f = fixture(), release = deferred();
  const capturedPage = f.group.get('A').page;
  let navigations = 0;
  capturedPage.close = () => new Promise(() => {});
  capturedPage.goto = () => { navigations++; return new Promise(() => {}); };
  const occupying = f.withUserLimit('identity', () => release.promise);
  const res = { json(body) { this.body = body; return this; } };
  const navigation = f.navigate({ params: { tabId: 'A' }, body: { userId: 'identity', url: 'https://example.test/' } }, res);
  await turn();
  assert.equal(f.userConcurrency.get('identity').queue.length, 1);
  const closed = { json(body) { this.body = body; return this; } };
  const deletion = f.closeTab({ params: { tabId: 'A' }, query: { userId: 'identity' } }, closed);
  await turn();
  await f.fire(100);
  await f.fire(25);
  await deletion;
  assert.equal(closed.body.ok, true);
  assert.equal(capturedPage.isClosed(), false, 'page close remains unconfirmed');
  assert.equal(f.findTabOwner('A'), null);
  release.resolve();
  await occupying;
  await turn();
  await f.fire(10);
  await navigation;
  assert.equal(res.error?.code, 'tab_destroyed');
  assert.equal(res.error.statusCode, 410);
  assert.equal(navigations, 0, 'the captured page must not receive stale work');
  assert.equal([...f.timers].some(timer => timer.ms === 20), false);
  await f.fire(20);
  assert.deepEqual(f.destroyed, []);
  assert.equal(await f.run('B', async () => 42), 42);
});

it('re-arms abandoned recovery when a late agent handoff releases human control after the first ceiling', async () => {
  const f = fixture(), release = deferred();
  f.session.sharedIdentity = true;
  f.human.add('A');
  f.session.visibility = {
    visible: new Set([f.group.get('A').page]),
    async release() {
      await release.promise;
      await f.timeout(new Promise(() => {}), 5, 'park');
    },
  };
  const res = { json(body) { this.body = body; return this; } };
  const pending = f.handoff({ params: { tabId: 'A' }, body: { userId: 'identity', handoff: 'agent' } }, res);
  await turn();
  await f.fire(10);
  await pending;
  assert.equal(res.error.code, 'operation_timeout');
  await f.fire(20);
  assert.deepEqual(f.closed, [], 'human ownership must prevent forced destruction');
  release.resolve();
  await turn();
  await f.fire(5);
  assert.equal(f.human.has('A'), false);
  assert.equal(f.locks.get('A').settling, true, 'nested browser work is still pending');
  await assert.rejects(f.run('A', () => assert.fail('overlap')), { code: 'tab_busy' });
  await f.fire(20);
  assert.equal(f.group.has('A'), false);
  assert.deepEqual(f.closed, ['A']);
  assert.equal(await f.run('B', async () => 42), 42);
});

it('destroys a responsive never-settling evaluate at the fixed ceiling without further requests', async () => {
  const f = fixture();
  await abandon(f);
  for (let i = 0; i < 5; i++) await assert.rejects(f.run('A', () => assert.fail('overlap')), { code: 'tab_busy' });
  assert.equal(f.group.get('A').consecutiveTimeouts, 0, 'liveness passed but must not reset the ceiling');
  await f.fire(20);
  assert.equal(f.group.has('A'), false);
  assert.equal(f.locks.has('A'), false);
  assert.deepEqual(f.closed, ['A']);
  assert.deepEqual(f.destroyed, ['abandoned_operation']);
  assert.equal(await f.run('B', async () => 42), 42);
});

it('removes abandoned locks from identityBusy and permits handoff while file cleanup remains pending', async () => {
  const f = fixture();
  f.clearTabDownloads = () => new Promise(() => {});
  await abandon(f);
  assert.equal(f.identityBusy('identity', f.session), true);
  await f.fire(20);
  assert.equal(f.identityBusy('identity', f.session), false);
  const opener = createSharedIdentityWindowOpener({
    manager: { failedClosures: new Set(), focus: async () => f.group.get('B').page },
    sessions: f.sessions, registerPage: () => 'B', isBusy: f.identityBusy,
  });
  assert.equal((await opener.openWindow('identity')).tabId, 'B');
  assert.deepEqual(f.closed, ['A']);
});

it('normal settlement cancels the ceiling and never releases the next operation', async () => {
  const f = fixture(), old = deferred(), current = deferred();
  await abandon(f, () => old.promise);
  old.resolve();
  await turn();
  const running = f.run('A', () => current.promise, 1000);
  await turn();
  await f.fire(20);
  assert.deepEqual(f.closed, []);
  assert.equal(f.locks.get('A').active, true);
  current.resolve();
  await running;
});

it('a stale ceiling cannot destroy a replacement tab or release its active lock', async () => {
  const f = fixture(), old = deferred(), current = deferred();
  await abandon(f, () => old.promise);
  const stale = [...f.timers].find(timer => timer.ms === 20);
  f.locks.get('A').drain();
  f.locks.delete('A');
  f.group.set('A', { page: {} });
  const running = f.run('A', () => current.promise, 1000);
  await turn();
  stale.fn();
  old.resolve();
  await turn();
  assert.deepEqual(f.closed, []);
  assert.equal(f.locks.get('A').active, true);
  current.resolve();
  await running;
});

it('nested browser timeouts receive the same abandoned-work ceiling', async () => {
  const f = fixture();
  const result = f.run('A', () => f.timeout(new Promise(() => {}), 5, 'mouse'), 1000).catch(error => error);
  await turn();
  await f.fire(5);
  assert.match((await result).message, /mouse timed out/);
  await f.fire(20);
  assert.equal(f.group.has('A'), false);
  assert.deepEqual(f.closed, ['A']);
});

it('retirement fences late continuations while bounded page close is pending', async () => {
  const f = fixture(), old = deferred();
  const page = f.group.get('A').page;
  page.close = () => new Promise(() => {});
  await abandon(f, () => old.promise);
  await f.fire(20);
  const lock = f.locks.get('A');
  assert.equal(lock.retired, true);
  old.resolve();
  await turn();
  await assert.rejects(f.run('A', () => assert.fail('overlap during close')), { code: 'tab_destroyed' });
  await f.fire(100);
  await f.fire(25);
  assert.equal(f.group.has('A'), false);
  assert.equal(f.locks.has('A'), false);
  assert.equal(f.identityBusy('identity', f.session), false);
  const registry = createPageRegistry({ sessions: f.sessions });
  assert.throws(() => registry.registerPage(f.session, 'identity', page, 'task'), { code: 'tab_destroyed' });
  f.session.sharedIdentity = 'identity';
  assert.equal(registry.registerSharedIdentityPage(f.session, 'identity', page), null,
    'an unconfirmed close cannot reintroduce the quarantined page under a new ID');
  const healthy = f.group.get('B').page;
  page.bringToFront = () => assert.fail('handoff must never focus the abandoned page');
  const manager = new SharedIdentityManager({ identities: ['identity'] });
  manager.contexts.set('identity', { pages: () => [page, healthy] });
  assert.equal(await manager.focus('identity'), healthy);
});

for (const selection of ['last-used', 'context', 'requested']) {
  it(`parked handoff skips a quarantined ${selection} page before visibility opens`, async () => {
    const abandoned = { isClosed: () => false };
    const healthy = { isClosed: () => false };
    quarantinePage(abandoned);
    const opened = [];
    const session = {
      visibility: { visible: new Set(), async open(page) { opened.push(page); this.visible.add(page); } },
      tabGroups: new Map([['task', new Map([['old', { page: abandoned }]])]]),
      lastUsedPage: selection === 'last-used' ? abandoned : null,
      context: { pages: () => [abandoned, healthy] },
      createPage: async () => healthy,
    };
    const opener = createSharedIdentityWindowOpener({
      manager: {}, sessions: new Map([['identity', session]]),
      getSession: async () => session,
      registerPage: (_session, _user, page) => page === healthy ? 'healthy' : 'old',
      isBusy: () => false,
    });
    const result = await opener.openWindow('identity', selection === 'requested' ? 'old' : null);
    assert.deepEqual(opened, [healthy], 'quarantine must be checked before opening the visible page');
    assert.equal(result.tabId, 'healthy');
  });
}

for (const deletion of ['tab', 'group']) {
  it(`an unconfirmed ${deletion} delete cannot resurrect or select the retired page`, async () => {
    const f = fixture();
    const page = f.group.get('A').page;
    f.session.sharedIdentity = true;
    f.session.lastUsedPage = page;
    page.close = () => new Promise(() => {});
    const res = { json(body) { this.body = body; return this; } };
    const pending = deletion === 'tab'
      ? f.closeTab({ params: { tabId: 'A' }, query: { userId: 'identity' } }, res)
      : f.closeGroup({ params: { listItemId: 'task' }, query: { userId: 'identity' } }, res);
    await turn();
    assert.equal(isQuarantinedPage(page), true, 'quarantine precedes asynchronous cleanup');
    assert.notEqual(f.session.lastUsedPage, page);
    await f.fire(100);
    await f.fire(25);
    await pending;
    assert.equal(res.body.ok, true);
    assert.equal(page.isClosed(), false);
    const registry = createPageRegistry({ sessions: f.sessions });
    assert.throws(() => registry.registerPage(f.session, 'identity', page, 'task'), { code: 'tab_destroyed' });
    assert.equal(registry.registerSharedIdentityPage(f.session, 'identity', page), null);
    const healthy = { isClosed: () => false, bringToFront: async () => {} };
    f.session.context = { pages: () => [page, healthy] };
    page.bringToFront = () => assert.fail('retired page was focused');
    const manager = new SharedIdentityManager({ identities: ['identity'] });
    manager.contexts.set('identity', f.session.context);
    assert.equal(await manager.focus('identity'), healthy);
    const opened = [];
    f.session.visibility = { visible: new Set(), async open(selected) { opened.push(selected); } };
    const opener = createSharedIdentityWindowOpener({
      manager, sessions: f.sessions, getSession: async () => f.session,
      registerPage: (_session, _user, selected) => { assert.equal(selected, healthy); return 'healthy'; },
      isBusy: () => false,
    });
    assert.equal((await opener.openWindow('identity')).tabId, 'healthy');
    assert.deepEqual(opened, [healthy]);
  });
}

for (const path of ['safe close', 'destroy', 'recycle', 'shared idle']) {
  it(`the ${path} retirement boundary quarantines an unconfirmed close and fences further work`, async () => {
    const f = fixture();
    const tab = f.group.get('A'), page = tab.page;
    f.session.lastUsedPage = page;
    page.close = async () => { throw new Error('protocol close rejected'); };
    const pending = path === 'safe close' ? f.safePageClose(page)
      : path === 'destroy' ? f.destroyTab(f.session, 'A', 'crashed', 'identity')
      : path === 'recycle' ? f.recycleOldestTab(f.session, 'request', 'identity')
      : f.closeSharedTab(f.session, 'A', tab, { userId: 'identity', reason: 'idle_tab' });
    await pending;
    assert.equal(isQuarantinedPage(page), true);
    assert.notEqual(f.session.lastUsedPage, page);
    await assert.rejects(f.run('A', () => assert.fail('retired page received work')), { code: 'tab_destroyed' });
    const registry = createPageRegistry({ sessions: f.sessions });
    assert.throws(() => registry.registerPage(f.session, 'identity', page, 'task'), { code: 'tab_destroyed' });
  });
}

it('generic destruction without an owner is a harmless no-op', () => {
  const f = fixture();
  assert.equal(f.destroyTab(null, 'missing', 'crashed', 'identity'), false);
});

it('handoff refuses a quarantined page before changing visibility or ownership', async () => {
  const page = { isClosed: () => false, bringToFront: () => assert.fail('focused retired page') };
  quarantinePage(page);
  const human = new Set();
  await assert.rejects(applySharedTabHandoff({ tabId: 'retired', handoff: 'human', tabState: { page },
    humanControlledTabs: human, session: { visibility: { visible: new Set(), open: async () => {} } } }),
  { code: 'tab_destroyed' });
  assert.equal(human.size, 0);
});
