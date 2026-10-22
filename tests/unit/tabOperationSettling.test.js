import { jest } from '@jest/globals';
import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs';
import vm from 'node:vm';
import { applySharedTabHandoff } from '../../lib/shared-tab-handoff.js';

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
    TAB_LOCK_TIMEOUT_MS: 1000, HANDLER_TIMEOUT_MS: 10,
    findTabOwner: id => owners.get(id), isTabLockQueueTimeout: () => false,
    handleTimedOutTab: jest.fn(async () => ({ destroyed: false })),
  };
  vm.runInNewContext(source.slice(source.indexOf('class TabLock {'), source.indexOf('function findTabOwner(tabId)')) +
    ';globalThis.run = withTabLock; globalThis.timeout = withTimeout; globalThis.human = humanControlledTabs; globalThis.locks = tabLocks;', box);
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
  expect(await first).toMatchObject({ code: 'operation_timeout' });
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
