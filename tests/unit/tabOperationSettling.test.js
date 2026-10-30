import { jest } from '@jest/globals';
import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs';
import vm from 'node:vm';
import { applySharedTabHandoff } from '../../lib/shared-tab-handoff.js';
import { handleTabTimeout } from '../../lib/tab-timeout.js';

const source = fs.readFileSync(new URL('../../server.js', import.meta.url), 'utf8');
const turn = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture() {
  const owners = new Map(['A', 'B', 'other-identity'].map(id => [id, { tabState: {} }]));
  const box = {
    AsyncLocalStorage, setTimeout, clearTimeout,
    tabLockTimeoutsTotal: { inc() {} }, refreshTabLockQueueDepth() {},
    TAB_LOCK_TIMEOUT_MS: 1000, HANDLER_TIMEOUT_MS: 10, ABANDONED_TAB_TIMEOUT_MS: 1000,
    findTabOwner: id => owners.get(id), isTabLockQueueTimeout: () => false,
    handleTimedOutTab: jest.fn(async () => ({ destroyed: false })),
  };
  vm.runInNewContext(source.slice(source.indexOf('class TabLock {'), source.indexOf('function findTabOwner(tabId)')) +
    ';globalThis.run = withTabLock; globalThis.timeout = withTimeout; globalThis.human = humanControlledTabs; globalThis.locks = tabLocks;', box);
  box.owners = owners;
  box.enableRecovery = () => {
    Object.assign(box, {
      handleTabTimeout, TAB_LIVENESS_TIMEOUT_MS: 10, MAX_CONSECUTIVE_TIMEOUTS: 3, log() {},
      destroyUnresponsiveTab: jest.fn(async (_session, id) => {
        owners.delete(id);
        box.locks.get(id)?.drain();
        box.locks.delete(id);
        return true;
      }),
    });
    vm.runInNewContext(source.slice(source.indexOf('async function handleTimedOutTab('), source.indexOf('function requestTimeoutMs(')), box);
    for (const owner of owners.values()) {
      owner.session = {};
      owner.tabState.page = { evaluate: jest.fn(async () => { throw new Error('unresponsive'); }) };
    }
  };
  return box;
}
const busy = { code: 'tab_busy', statusCode: 503, retryable: true, recovery: 'retry' };

test.each([false, true])('timed-out work refuses retries and handoff until it settles (reject=%s)', async rejects => {
  const f = fixture();
  const slow = deferred();
  const events = [];
  const first = f.run('A', async () => {
    await slow.promise;
    events.push(f.human.has('A') ? 'stale-human-mutation' : 'old-mutation');
  }).catch(error => error);
  await turn();
  const queued = f.run('A', async () => events.push('queued-mutation')).catch(error => error);
  expect(await first).toMatchObject({ code: 'operation_timeout', message: expect.stringContaining('Work may still be running') });
  expect(await queued).toMatchObject(busy);
  await expect(f.run('A', async () => events.push('retry-mutation'))).rejects.toMatchObject(busy);
  const handoff = () => f.run('A', async () => { f.human.add('A'); events.push('human-handoff'); }, 10, { allowHumanControl: true });
  await expect(handoff()).rejects.toMatchObject(busy);
  expect(f.locks.get('A').active).toBe(true);
  await expect(f.run('B', async () => 42)).resolves.toBe(42);
  await expect(f.run('other-identity', async () => 43)).resolves.toBe(43);
  if (rejects) slow.reject(new Error('late browser failure'));
  else slow.resolve();
  await turn();
  await handoff();
  await turn();
  expect(events).toEqual(rejects ? ['human-handoff'] : ['old-mutation', 'human-handoff']);
  expect(f.locks.get('A').active).toBe(false);
});

test('nested timeout retains the actual mouse operation after the route promise rejects', async () => {
  const f = fixture();
  const mouse = deferred();
  const first = f.run('A', async () => {
    await f.timeout(mouse.promise, 1, 'native mouse move');
    throw new Error('unreachable');
  }, 100);
  await expect(first).rejects.toThrow('native mouse move timed out');
  await expect(f.run('A', async () => 42)).rejects.toMatchObject(busy);
  mouse.resolve();
  await turn();
  await expect(f.run('A', async () => 42)).resolves.toBe(42);
});

test('outer timeout also retains nested work started by a late continuation', async () => {
  const f = fixture();
  const before = deferred(), mouse = deferred();
  const first = f.run('A', async () => {
    await before.promise;
    await f.timeout(mouse.promise, 1, 'native mouse down');
  }).catch(error => error);
  expect(await first).toMatchObject({ code: 'operation_timeout' });
  before.resolve();
  await new Promise(resolve => setTimeout(resolve, 5));
  await expect(f.run('A', async () => 42)).rejects.toMatchObject(busy);
  mouse.resolve();
  await turn();
  await expect(f.run('A', async () => 42)).resolves.toBe(42);
});

test('settling navigation remains active but never blocks another tab', async () => {
  const f = fixture();
  const navigation = deferred();
  await expect(f.run('A', () => navigation.promise, 1, { navigation: true })).rejects.toMatchObject({ code: 'operation_timeout' });
  expect(f.locks.get('A').active).toBe(true);
  await expect(f.run('B', async () => 'independent')).resolves.toBe('independent');
  navigation.resolve();
  await turn();
  await expect(f.run('A', async () => 'recovered')).resolves.toBe('recovered');
});

test('the actual handoff route cannot report human control before stale work finishes', async () => {
  const f = fixture();
  const slow = deferred(), events = [];
  const tabState = { page: { isClosed: () => false, bringToFront: async () => events.push('focused') } };
  const session = { sharedIdentity: true };
  let handler;
  Object.assign(f, {
    app: { post: (_path, fn) => { handler = fn; } }, normalizeUserId: String,
    sessions: new Map([['identity', session]]), findTab: () => ({ tabState }),
    applySharedTabHandoff, log() {},
    handleRouteError: (error, _req, res) => res.status(error.statusCode).json({ code: error.code }),
  });
  const start = source.indexOf("app.post('/tabs/:tabId/handoff'");
  vm.runInNewContext(source.slice(start, source.indexOf('\n});', start) + 5), f);
  const handoff = async () => {
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; } };
    await handler({ params: { tabId: 'A' }, body: { userId: 'identity', handoff: 'human' } }, res);
    return res;
  };
  await expect(f.run('A', async () => { await slow.promise; events.push('old-mutation'); })).rejects.toMatchObject({ code: 'operation_timeout' });
  expect(await handoff()).toMatchObject({ statusCode: 503, body: { code: 'tab_busy' } });
  expect(f.human.has('A')).toBe(false);
  slow.resolve();
  await turn();
  expect(await handoff()).toMatchObject({ statusCode: 200, body: { handoff: 'human', focused: true } });
  await turn();
  expect(events).toEqual(['old-mutation', 'focused']);
  expect(f.human.has('A')).toBe(true);
});


test('settling refusals reach failed-liveness recovery without running a newer operation', async () => {
  const f = fixture();
  f.enableRecovery();
  const old = deferred(), newer = jest.fn();
  const original = jest.fn(() => old.promise);
  await expect(f.run('A', original, 1)).rejects.toMatchObject({ code: 'operation_timeout' });
  expect(original).toHaveBeenCalledTimes(1);
  await expect(f.run('A', newer)).rejects.toMatchObject(busy);
  await expect(f.run('A', newer)).rejects.toMatchObject({ code: 'tab_destroyed', statusCode: 410, recovery: 'create_new_tab' });
  expect(newer).not.toHaveBeenCalled();
  expect(f.destroyUnresponsiveTab).toHaveBeenCalledTimes(1);
  await expect(f.run('B', async () => 42)).resolves.toBe(42);
  old.resolve();
  await turn();
});

test('a settling refusal observed after settlement cannot count or destroy newer work', async () => {
  const f = fixture();
  f.enableRecovery();
  const old = deferred(), refusal = deferred(), newer = jest.fn();
  await expect(f.run('A', () => old.promise, 1)).rejects.toMatchObject({ code: 'operation_timeout' });
  const lock = f.locks.get('A');
  jest.spyOn(lock, 'acquire').mockImplementationOnce(() => refusal.promise);
  const retry = f.run('A', newer);
  old.resolve();
  await turn();
  expect(lock.settling).toBe(false);
  f.owners.get('A').tabState.consecutiveTimeouts = 2;
  refusal.reject(Object.assign(new Error('Previous operation was settling'), busy));
  await expect(retry).rejects.toMatchObject(busy);
  expect(f.owners.get('A').tabState.consecutiveTimeouts).toBe(2);
  expect(f.owners.get('A').tabState.page.evaluate).not.toHaveBeenCalled();
  expect(f.destroyUnresponsiveTab).not.toHaveBeenCalled();
  expect(newer).not.toHaveBeenCalled();
});

test.each(['retired', 'replaced'])('an acquired but not resumed %s lock refuses stale work', async state => {
  const f = fixture(), operation = jest.fn();
  const result = f.run('A', operation);
  const lock = f.locks.get('A');
  if (state === 'retired') lock.drain();
  else f.owners.set('A', { tabState: {}, session: {} });
  await expect(result).rejects.toMatchObject({ code: 'tab_destroyed', statusCode: 410 });
  expect(operation).not.toHaveBeenCalled();
});

test('stale detached continuation cannot release a newer lock holder a second time', async () => {
  const f = fixture();
  const old = deferred(), current = deferred();
  let detached;
  await expect(f.run('A', async () => {
    const resume = AsyncLocalStorage.snapshot();
    detached = () => resume(() => f.timeout(Promise.resolve(), 100, 'detached work'));
    await old.promise;
  }, 1)).rejects.toMatchObject({ code: 'operation_timeout' });
  const release = jest.spyOn(f.locks.get('A'), 'release');
  old.resolve();
  await turn();
  expect(release).toHaveBeenCalledTimes(1);
  const newer = f.run('A', () => current.promise, 1000);
  await turn();
  await detached();
  let overlapped = false;
  const queued = f.run('A', async () => { overlapped = true; }, 1000);
  await turn();
  try {
    expect(release).toHaveBeenCalledTimes(1);
    expect(overlapped).toBe(false);
    expect(f.locks.get('A').active).toBe(true);
  } finally {
    current.resolve();
    await Promise.all([newer, queued]);
  }
});

test('responsive settling survives repeated and concurrent retries, then releases once', async () => {
  const f = fixture();
  f.enableRecovery();
  const owner = f.owners.get('A'), probe = deferred(), old = deferred();
  owner.tabState.page.evaluate.mockImplementation(() => probe.promise);
  await expect(f.run('A', () => old.promise, 1)).rejects.toMatchObject({ code: 'operation_timeout' });
  await expect(f.run('A', jest.fn())).rejects.toMatchObject(busy);
  const retries = Array.from({ length: 4 }, () => f.run('A', jest.fn()).catch(error => error));
  await turn();
  probe.resolve(1);
  expect(await Promise.all(retries)).toEqual(expect.arrayContaining([expect.objectContaining(busy)]));
  expect(owner.tabState.page.evaluate).toHaveBeenCalledTimes(1);
  expect(f.destroyUnresponsiveTab).not.toHaveBeenCalled();
  expect(f.locks.get('A').settling).toBe(true);
  old.resolve();
  await turn();
  await expect(f.run('A', async () => 42)).resolves.toBe(42);
});

test('retiring cleanup refuses new work and preserves a replacement during page close', async () => {
  const f = fixture();
  const close = deferred(), old = deferred();
  const oldOwner = f.owners.get('A');
  const group = new Map([['A', oldOwner.tabState]]);
  const session = { tabGroups: new Map([['group', group]]) };
  oldOwner.session = session;
  Object.assign(f, {
    findTab: () => ({ tabState: group.get('A'), group, listItemId: 'group' }),
    safePageClose: () => close.promise, clearTabDownloads: async () => {}, log() {}, quarantinePage() {},
    refreshActiveTabsGauge() {}, tabsDestroyedTotal: { labels: () => ({ inc() {} }) },
    pluginEvents: { emit() {} },
  });
  const start = source.indexOf('async function destroyUnresponsiveTab(');
  vm.runInNewContext(source.slice(start, source.indexOf('\n/**', start)) + ';globalThis.destroy = destroyUnresponsiveTab;', f);
  await expect(f.run('A', () => old.promise, 1)).rejects.toMatchObject({ code: 'operation_timeout' });
  const destroying = f.destroy(session, 'A', 'test', 'identity');
  old.resolve();
  await turn();
  await expect(f.run('A', jest.fn())).rejects.toMatchObject({ code: 'tab_destroyed', statusCode: 410 });
  const replacement = { page: {} };
  group.set('A', replacement);
  f.owners.set('A', { session, tabState: replacement });
  f.locks.delete('A');
  f.human.add('A');
  const holder = deferred();
  const running = f.run('A', () => holder.promise, 1000, { allowHumanControl: true });
  await turn();
  const currentLock = f.locks.get('A');
  close.resolve();
  expect(await destroying).toBe(false);
  expect(group.get('A')).toBe(replacement);
  expect(f.locks.get('A')).toBe(currentLock);
  expect(currentLock.active).toBe(true);
  expect(f.human.has('A')).toBe(true);
  holder.resolve();
  await running;
});

test('late settlement and detached work cannot release a replacement tab lock', async () => {
  const f = fixture();
  const old = deferred(), replacement = deferred();
  let detached;
  await expect(f.run('A', async () => {
    const resume = AsyncLocalStorage.snapshot();
    detached = () => resume(() => f.timeout(Promise.resolve(), 100, 'detached'));
    await old.promise;
  }, 1)).rejects.toMatchObject({ code: 'operation_timeout' });
  const retired = f.locks.get('A');
  retired.drain();
  f.locks.delete('A');
  f.owners.set('A', { tabState: {}, session: {} });
  const running = f.run('A', () => replacement.promise, 1000);
  await turn();
  const current = f.locks.get('A');
  const release = jest.spyOn(current, 'release');
  old.resolve();
  await turn();
  await detached();
  expect(current.active).toBe(true);
  expect(release).not.toHaveBeenCalled();
  replacement.resolve();
  await running;
});
