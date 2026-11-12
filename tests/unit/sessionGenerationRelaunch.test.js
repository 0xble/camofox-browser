import { jest } from '@jest/globals';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { coalesceInflight } from '../../lib/inflight.js';
import { quarantinePage } from '../../lib/page-registry.js';
import { closeSessionOnce, hasSessionClose, settleWithin, SESSION_CLOSE_STEP_TIMEOUT_MS } from '../../lib/session-close.js';

// Drives the server's actual getSession(), ensureBrowser() and closeAllSessions()
// so the generation fence is exercised exactly as production wires it.
const source = readFileSync(new URL('../../server.js', import.meta.url), 'utf8');
function serverFunction(name) {
  const match = source.match(new RegExp(`^(?:async )?function ${name}\\([^\\n]*\\) \\{[\\s\\S]*?^\\}`, 'm'));
  if (!match) throw new Error(`missing server function ${name}`);
  return match[0];
}

function deferred() {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
}

function fixture({ connected = true } = {}) {
  const sessions = new Map();
  const staleContext = { close: jest.fn(async () => {}), pages: () => [] };
  sessions.set('stale-user', { context: staleContext, tabGroups: new Map(), pageLeases: new Set() });
  const newContextGate = deferred();
  const freshContext = { close: jest.fn(async () => {}), pages: () => [], on() {}, tracing: {} };
  const relaunched = { isConnected: () => true, newContext: jest.fn(() => newContextGate.promise) };
  const box = {
    sessionLifecycleGeneration: 0, sessions, sessionCreations: new Map(), coalesceInflight,
    sharedIdentityWindow: null, sharedIdentityLastUrls: new Map(),
    sharedIdentities: { owns: () => false, failedClosures: new Set(), closings: new Set(), contexts: new Map() },
    closeSessionOnce, hasSessionClose, settleWithin, SESSION_CLOSE_STEP_TIMEOUT_MS, quarantinePage,
    normalizeUserId: id => id, MAX_SESSIONS: 10, FLY_MACHINE_ID: null, CONFIG: {},
    proxyPool: null, contextIdentityOptions: () => ({}), trackContextTracing() {},
    pluginEvents: { emit() {}, emitAsync: async () => {} },
    tabLocks: new Map(), humanControlledTabs: new Set(), refreshTabLockQueueDepth() {},
    clearSessionDownloads: async () => {}, refreshActiveTabsGauge() {},
    teardownEphemeralSession: async ({ session, sessions: registry, userId }) => {
      await session.context.close();
      if (registry.get(userId) === session) registry.delete(userId);
    },
    registerPage() { return { created: false }; }, isQuarantinedPage: () => false,
    log() {}, failuresTotal: { labels: () => ({ inc() {} }) },
    browser: connected ? relaunched : { isConnected: () => false }, _browserClosePromise: null,
    browserRecoveryPromise: null, browserLaunchRecoveryGeneration: null,
    browserLaunchPromise: null, browserLaunchProxy: null, clearBrowserIdleTimer() {},
    launchBrowserInstance: jest.fn(async () => { box.browser = relaunched; return relaunched; }),
    closeBrowserFully: jest.fn(async () => { box.browser = null; }),
    setTimeout, clearTimeout,
  };
  vm.runInNewContext(
    source.slice(source.indexOf('function clearSessionLocks('), source.indexOf('async function createSharedIdentityContext(')) +
    '\n' + ['ensureBrowser', 'getSession'].map(serverFunction).join('\n') +
    '\nglobalThis.closeAll = closeAllSessions;', box);
  return { box, sessions, staleContext, freshContext, relaunched, newContextGate };
}

test('the first ephemeral request after a browser crash relaunches and succeeds instead of retiring itself', async () => {
  const f = fixture({ connected: false });
  const acquiring = f.box.getSession('fresh-user');
  for (let i = 0; i < 50 && f.relaunched.newContext.mock.calls.length === 0; i++) await Promise.resolve();
  expect(f.relaunched.newContext).toHaveBeenCalledTimes(1);
  f.newContextGate.resolve(f.freshContext);
  const session = await acquiring;
  expect(f.box.launchBrowserInstance).toHaveBeenCalledTimes(1);
  expect(f.box.sessionLifecycleGeneration).toBe(1);
  expect(f.staleContext.close).toHaveBeenCalledTimes(1);
  expect(f.sessions.get('fresh-user')).toBe(session);
  expect(f.freshContext.close).not.toHaveBeenCalled();
});

test('a terminal close after relaunch still retires the in-flight acquisition without publishing it', async () => {
  const f = fixture({ connected: false });
  const acquiring = f.box.getSession('fresh-user').catch(error => error);
  for (let i = 0; i < 50 && f.relaunched.newContext.mock.calls.length === 0; i++) await Promise.resolve();
  expect(f.relaunched.newContext).toHaveBeenCalledTimes(1);
  await f.box.closeAll('admin_stop');
  f.newContextGate.resolve(f.freshContext);
  expect(await acquiring).toMatchObject({ code: 'session_destroyed', statusCode: 410 });
  expect(f.freshContext.close).toHaveBeenCalledTimes(1);
  expect(f.sessions.has('fresh-user')).toBe(false);
});

test('a terminal close during relaunch still retires the in-flight acquisition', async () => {
  const f = fixture({ connected: false });
  let releaseLaunch;
  f.box.launchBrowserInstance.mockImplementation(() => new Promise(resolve => {
    releaseLaunch = () => { f.box.browser = f.relaunched; resolve(f.relaunched); };
  }));
  const acquiring = f.box.getSession('fresh-user').catch(error => error);
  for (let i = 0; i < 50 && !releaseLaunch; i++) await Promise.resolve();
  await f.box.closeAll('admin_stop');
  releaseLaunch();
  f.newContextGate.resolve(f.freshContext);
  expect(await acquiring).toMatchObject({ code: 'session_destroyed', statusCode: 410 });
  expect(f.sessions.has('fresh-user')).toBe(false);
});

test('concurrent acquisitions after a browser crash share the recovery generation', async () => {
  const f = fixture({ connected: false });
  const acquiringA = f.box.getSession('fresh-user-a');
  const acquiringB = f.box.getSession('fresh-user-b');
  for (let i = 0; i < 50 && f.relaunched.newContext.mock.calls.length < 2; i++) await Promise.resolve();
  expect(f.relaunched.newContext).toHaveBeenCalledTimes(2);
  f.newContextGate.resolve(f.freshContext);
  const [sessionA, sessionB] = await Promise.all([acquiringA, acquiringB]);
  expect(f.box.sessionLifecycleGeneration).toBe(1);
  expect(f.sessions.get('fresh-user-a')).toBe(sessionA);
  expect(f.sessions.get('fresh-user-b')).toBe(sessionB);
});

test.each(['admin_stop', 'shutdown', 'browser_restart:test'])('a terminal close during a cold launch retires the acquisition (%s)', async reason => {
  const f = fixture({ connected: true });
  f.box.browser = null;
  let releaseLaunch;
  f.box.launchBrowserInstance.mockImplementation(() => new Promise(resolve => {
    releaseLaunch = () => { f.box.browser = f.relaunched; resolve(f.relaunched); };
  }));
  const acquiring = f.box.getSession('fresh-user').catch(error => error);
  for (let i = 0; i < 50 && !releaseLaunch; i++) await Promise.resolve();
  await f.box.closeAll(reason);
  releaseLaunch();
  f.newContextGate.resolve(f.freshContext);
  expect(await acquiring).toMatchObject({ code: 'session_destroyed', statusCode: 410 });
  expect(f.freshContext.close).not.toHaveBeenCalled();
  expect(f.sessions.has('fresh-user')).toBe(false);
});

test('a terminal close while awaiting an in-progress browser close retires the acquisition', async () => {
  const f = fixture({ connected: true });
  let releaseClose;
  f.box._browserClosePromise = new Promise(resolve => { releaseClose = resolve; });
  const acquiring = f.box.getSession('fresh-user').catch(error => error);
  for (let i = 0; i < 50 && f.relaunched.newContext.mock.calls.length > 0; i++) await Promise.resolve();
  await f.box.closeAll('browser_restart:test');
  releaseClose();
  for (let i = 0; i < 50 && f.relaunched.newContext.mock.calls.length === 0; i++) await Promise.resolve();
  f.newContextGate.resolve(f.freshContext);
  expect(await acquiring).toMatchObject({ code: 'session_destroyed', statusCode: 410 });
  expect(f.freshContext.close).not.toHaveBeenCalled();
  expect(f.sessions.has('fresh-user')).toBe(false);
});

test('a terminal close racing a connected browser still retires the acquisition', async () => {
  const f = fixture({ connected: true });
  const acquiring = f.box.getSession('fresh-user').catch(error => error);
  for (let i = 0; i < 50 && f.relaunched.newContext.mock.calls.length === 0; i++) await Promise.resolve();
  await f.box.closeAll('browser_restart:test');
  f.newContextGate.resolve(f.freshContext);
  expect(await acquiring).toMatchObject({ code: 'session_destroyed' });
  expect(f.freshContext.close).toHaveBeenCalledTimes(1);
  expect(f.sessions.has('fresh-user')).toBe(false);
});
