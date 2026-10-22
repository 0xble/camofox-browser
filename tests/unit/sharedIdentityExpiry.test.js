import { jest } from '@jest/globals';
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createSharedIdentityIdlePolicy } from '../../lib/shared-identity-idle.js';
import { SharedIdentityManager, cookieCheckpointPath } from '../../lib/shared-identity.js';
import { hasActivePageLeases } from '../../lib/page-lease.js';
import { closeSessionOnce } from '../../lib/session-close.js';
import { createSharedIdentityWindowOpener } from '../../lib/shared-identity-window.js';

const source = readFileSync(new URL('../../server.js', import.meta.url), 'utf8');
function serverFunction(name, dependencies, async = true) {
  const start = source.indexOf(`${async ? 'async ' : ''}function ${name}(`);
  const end = source.indexOf('\n}\n', start) + 2;
  return vm.runInNewContext(`(${source.slice(start, end)})`, dependencies);
}

let profileDir;
beforeEach(async () => { profileDir = await fs.mkdtemp(path.join(os.tmpdir(), 'camofox-expiry-')); });
afterEach(async () => { await fs.rm(profileDir, { recursive: true, force: true }); });

function fixture({ parked = true } = {}) {
  const order = [];
  const cookies = [{ name: 'synthetic', value: 'fixture', domain: 'fixture.test', path: '/', expires: -1 }];
  const context = { cookies: jest.fn(async () => { order.push('snapshot'); return cookies; }),
    close: jest.fn(async () => { order.push('close'); }) };
  const tab = { page: { isClosed: () => false }, activeDownloads: 0, lastAgentActivityAt: 0 };
  context.pages = () => [tab.page];
  const session = { sharedIdentity: true, keepOpen: true, headed: false, lastAccess: 0,
    tabGroups: new Map([['task', new Map([['tab', tab]])]]), context,
    visibility: parked ? { visible: new Map(), release: jest.fn(async () => true) } : null };
  if (parked) session.visibility.open = jest.fn(async () => { session.visibility.visible.set(1, {}); });
  const sharedIdentities = new SharedIdentityManager({ identities: ['fixture'], profileDir });
  sharedIdentities.contexts.set('fixture', context);
  const deps = {
    sessions: new Map([['fixture', session]]), sharedIdentities,
    CONFIG: { hiddenTabIdleMin: 0, headedIdleReleaseMin: 0, hiddenSessionIdleMin: 120 },
    sharedIdentityIdlePolicy: createSharedIdentityIdlePolicy({ readIdleSeconds: async () => 0, clock: () => 121 * 60_000 }),
    sharedIdentityRequests: new Map(), sessionCreations: new Map(), identityTransitions: new Map(),
    userConcurrency: new Map(), tabLocks: new Map(), humanControlledTabs: new Set(), hasActivePageLeases,
    sharedIdentityLastUrls: new Map(), normalizeUserId: String, closeSessionOnce,
    clearSessionLocks: jest.fn(), clearSessionDownloads: jest.fn(async () => {}), refreshActiveTabsGauge: jest.fn(), log: jest.fn(),
    releaseIdentity: jest.fn(async () => ({ ok: true })),
    transitionIdentity: jest.fn((_key, _action, operation) => operation()),
  };
  deps.identityBusy = serverFunction('identityBusy', deps, false);
  deps.sharedSessionExpiryEligible = serverFunction('sharedSessionExpiryEligible', deps, false);
  deps.closeSessionNow = serverFunction('closeSessionNow', deps);
  deps.closeSession = serverFunction('closeSession', deps, false);
  const sweep = serverFunction('cleanIdleSharedSessions', deps);
  return { deps, session, tab, context, cookies, order, sweep };
}

test.each([true, false])('eligible expired hidden session checkpoints and closes once (parked=%s)', async parked => {
  const f = fixture({ parked });
  await f.sweep();
  await f.sweep();
  await f.sweep();
  expect(f.order).toEqual(['snapshot', 'close']);
  expect(f.deps.sessions.has('fixture')).toBe(false);
  expect(f.deps.sharedIdentities.contexts.has('fixture')).toBe(false);
  expect(f.deps.releaseIdentity).not.toHaveBeenCalled();
  expect(f.deps.transitionIdentity).not.toHaveBeenCalled();
  expect(f.context.close).toHaveBeenCalledTimes(1);
  if (parked) expect(f.session.visibility.release).not.toHaveBeenCalled();
  const checkpoint = JSON.parse(await fs.readFile(cookieCheckpointPath(profileDir, 'fixture'), 'utf8'));
  expect(checkpoint).toMatchObject({ cleanShutdown: true, cookies: f.cookies });
});

test.each([
  ['active request', f => f.deps.sharedIdentityRequests.set('fixture', 1)],
  ['session creation', f => f.deps.sessionCreations.set('fixture', Promise.resolve())],
  ['existing close', f => f.deps.sharedIdentities.closings.add('fixture')],
  ['active user work', f => f.deps.userConcurrency.set('fixture', { active: 1, queue: [] })],
  ['queued user work', f => f.deps.userConcurrency.set('fixture', { active: 0, queue: [{}] })],
  ['active tab work', f => f.deps.tabLocks.set('tab', { active: true, queue: [] })],
  ['queued tab work', f => f.deps.tabLocks.set('tab', { active: false, queue: [{}] })],
  ['page lease', f => { f.session.pageLeases = new Set([{}]); }],
  ['download', f => { f.tab.activeDownloads = 1; }],
  ['human control', f => f.deps.humanControlledTabs.add('tab')],
  ['visible window', f => { f.session.headed = true; }],
  ['visibility ahead of headed flag', f => f.session.visibility.visible.set(1, {})],
  ['closing session', f => { f.session._closing = true; }],
  ['identity transition', f => f.deps.identityTransitions.set('fixture', {})],
  ['recent activity', f => { f.session.lastAccess = 120 * 60_000; }],
  ['disabled timeout', f => { f.deps.CONFIG.hiddenSessionIdleMin = 0; }],
])('expiry preserves %s', async (_name, protect) => {
  const f = fixture();
  protect(f);
  await f.sweep();
  expect(f.deps.sessions.get('fixture')).toBe(f.session);
  expect(f.context.cookies).not.toHaveBeenCalled();
  expect(f.context.close).not.toHaveBeenCalled();
});

// Closing an idle tab awaits the browser, so eligibility must be checked again.
test('activity during idle-tab cleanup prevents session expiry', async () => {
  const f = fixture();
  f.deps.CONFIG.hiddenTabIdleMin = 30;
  f.deps.latestSharedTabId = () => null;
  f.deps.sharedTabClosable = () => true;
  f.deps.closeSharedTab = async () => { f.deps.humanControlledTabs.add('tab'); return false; };
  await f.sweep();
  expect(f.deps.sessions.get('fixture')).toBe(f.session);
  expect(f.context.close).not.toHaveBeenCalled();
});

const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

test.each(['snapshot', 'tracing'])('new active work during %s preparation aborts expiry before teardown', async preparation => {
  const f = fixture();
  const entered = deferred(), resume = deferred();
  if (preparation === 'snapshot') f.context.cookies.mockImplementationOnce(async () => {
    entered.resolve(); await resume.promise; return f.cookies;
  });
  else {
    f.session.tracePath = 'synthetic.zip';
    f.context.tracing = { stop: async () => { entered.resolve(); await resume.promise; } };
  }
  const pending = f.sweep();
  await entered.promise;
  f.deps.sharedIdentityRequests.set('fixture', 1);
  resume.resolve();
  await pending;
  expect(f.deps.sessions.get('fixture')).toBe(f.session);
  expect(f.context.close).not.toHaveBeenCalled();
  expect(f.deps.clearSessionLocks).not.toHaveBeenCalled();
  expect(f.deps.clearSessionDownloads).not.toHaveBeenCalled();
  f.deps.sharedIdentityRequests.delete('fixture');
  await f.sweep();
  await f.sweep();
  expect(f.context.close).toHaveBeenCalledTimes(1);
  expect(f.deps.sessions.has('fixture')).toBe(false);
});

test('human open during cookie preparation succeeds and cancels expiry', async () => {
  const f = fixture();
  const entered = deferred(), resume = deferred();
  f.context.cookies.mockImplementationOnce(async () => { entered.resolve(); await resume.promise; return f.cookies; });
  const opener = createSharedIdentityWindowOpener({ manager: f.deps.sharedIdentities, sessions: f.deps.sessions,
    getSession: serverFunction('getSession', f.deps), closeSession: f.deps.closeSession,
    registerPage: () => 'tab', isBusy: key => f.deps.identityBusy(key, f.deps.sessions.get(key)), parkingEnabled: true });
  const pending = f.sweep();
  await entered.promise;
  expect(await opener.openWindow('fixture', 'tab')).toMatchObject({ ok: true, focused: true });
  expect(f.session.headed).toBe(true);
  resume.resolve();
  await pending;
  expect(f.context.close).not.toHaveBeenCalled();
  expect(f.deps.sessions.get('fixture')).toBe(f.session);
  expect(f.deps.clearSessionLocks).not.toHaveBeenCalled();
  expect(f.deps.clearSessionDownloads).not.toHaveBeenCalled();
  f.session.visibility.visible.clear();
  f.session.headed = false;
  f.session.lastAccess = 0;
  await f.sweep();
  expect(f.context.close).toHaveBeenCalledTimes(1);
  expect(f.deps.sessions.has('fixture')).toBe(false);
});

test('a parked open cannot reuse a context once destructive close has begun', async () => {
  const f = fixture();
  const entered = deferred(), resume = deferred();
  f.context.close.mockImplementationOnce(async () => { entered.resolve(); await resume.promise; });
  const pending = f.sweep();
  await entered.promise;
  const getSession = serverFunction('getSession', f.deps);
  await expect(getSession('fixture', { parkedOpen: true })).rejects.toMatchObject({ statusCode: 409 });
  expect(f.session.visibility.open).not.toHaveBeenCalled();
  resume.resolve();
  await pending;
  expect(f.deps.sessions.has('fixture')).toBe(false);
});

test('download cleanup runs only after expired context and session are gone', async () => {
  const f = fixture();
  const entered = deferred(), resume = deferred();
  f.deps.clearSessionDownloads.mockImplementationOnce(async () => { entered.resolve(); await resume.promise; });
  const pending = f.sweep();
  await entered.promise;
  expect(f.order).toEqual(['snapshot', 'close']);
  expect(f.context.close).toHaveBeenCalledTimes(1);
  expect(f.deps.sessions.has('fixture')).toBe(false);
  expect(f.deps.sharedIdentities.contexts.has('fixture')).toBe(false);
  resume.resolve();
  await pending;
});

test('failed expiry cookie preparation leaves the live session untouched', async () => {
  const f = fixture();
  f.context.cookies.mockRejectedValueOnce(new Error('snapshot failed'));
  await f.sweep();
  expect(f.deps.sessions.get('fixture')).toBe(f.session);
  expect(f.context.close).not.toHaveBeenCalled();
  expect(f.deps.clearSessionLocks).not.toHaveBeenCalled();
  expect(f.deps.clearSessionDownloads).not.toHaveBeenCalled();
});
