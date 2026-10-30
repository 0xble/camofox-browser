import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { readFileSync } from 'node:fs';
import { it as nodeIt } from 'node:test';
import vm from 'node:vm';
import { handleTabTimeout } from '../../lib/tab-timeout.js';
import { createPageRegistry, quarantinePage } from '../../lib/page-registry.js';
import { createSharedIdentityWindowOpener } from '../../lib/shared-identity-window.js';

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
  const timers = new Set(), closed = [], destroyed = [];
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
    quarantinePage, clearTabDownloads: async () => {}, log() {},
    tabsDestroyedTotal: { labels: reason => ({ inc: () => destroyed.push(reason) }) }, pluginEvents: { emit() {} },
    sharedIdentityRequests: new Map(), sessionCreations: new Map(),
    sharedIdentities: { closings: new Set() }, userConcurrency: new Map(), hasActivePageLeases: () => false,
  };
  vm.runInNewContext(source.slice(source.indexOf('class TabLock {'), source.indexOf('function findTabOwner(tabId)')) +
    '\n' + ['handleTimedOutTab', 'safePageClose', 'destroyUnresponsiveTab', 'identityBusy'].map(serverFunction).join('\n') +
    ';globalThis.run = withTabLock; globalThis.timeout = withTimeout; globalThis.locks = tabLocks;', box);
  return Object.assign(box, { session, group, sessions, closed, destroyed, timers,
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
});
