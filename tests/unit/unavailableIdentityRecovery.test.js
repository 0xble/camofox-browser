import { jest } from '@jest/globals';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { quarantinePage } from '../../lib/page-registry.js';
import { closeSessionOnce, hasSessionClose, settleWithin, SESSION_CLOSE_STEP_TIMEOUT_MS } from '../../lib/session-close.js';
import { createSharedIdentityWindowOpener } from '../../lib/shared-identity-window.js';

const source = readFileSync(new URL('../../server.js', import.meta.url), 'utf8');
function serverFunction(name) {
  const match = source.match(new RegExp(`^(?:async )?function ${name}\\([^\\n]*\\) \\{[\\s\\S]*?^\\}`, 'm'));
  if (!match) throw new Error(`missing server function ${name}`);
  return match[0];
}

async function fixture() {
  const contexts = ['blocked', 'healthy'].map(() => ({ close: jest.fn(async () => {}) }));
  const sessions = new Map(contexts.map((context, index) => [index ? 'healthy' : 'blocked', {
    context, sharedIdentity: true, tabGroups: new Map(),
  }]));
  sessions.get('blocked').visibility = { visible: new Set() };
  const sharedIdentityWindow = createSharedIdentityWindowOpener({
    manager: { failedClosures: new Set() }, sessions,
    getSession: () => new Promise(() => {}), isBusy: () => false,
    transitionTimeoutMs: 10,
  });
  const pending = sharedIdentityWindow.openWindow('blocked').catch(error => error);
  await jest.advanceTimersByTimeAsync(10);
  expect(await pending).toMatchObject({ code: 'identity_transition_timeout' });
  expect(sharedIdentityWindow.unavailable('blocked')).not.toBeNull();
  const checkpoint = jest.fn();
  const box = {
    sessionLifecycleGeneration: 0, sessions, sharedIdentityWindow, closeSessionOnce, hasSessionClose, settleWithin, SESSION_CLOSE_STEP_TIMEOUT_MS, quarantinePage,
    sharedIdentities: { close: jest.fn(async (id, { checkpoint: save }) => {
      if (save) checkpoint(id);
      await sessions.get(id).context.close();
    }) },
    normalizeUserId: id => id, sharedIdentityLastUrls: new Map(),
    tabLocks: new Map(), humanControlledTabs: new Set(), refreshTabLockQueueDepth() {},
    clearSessionDownloads: async () => {}, refreshActiveTabsGauge() {},
    log: jest.fn(), failuresTotal: { labels: jest.fn(() => ({ inc: jest.fn() })) },
    browserRestartsTotal: { labels: () => ({ inc() {} }) }, userNavHealth: new Map(),
    healthState: {}, pluginEvents: { emit() {}, emitAsync: async () => {} },
    browser: { isConnected: () => false }, _browserClosePromise: null,
    browserLaunchPromise: null, proxyPool: null, clearBrowserIdleTimer() {},
    launchBrowserInstance: jest.fn(async () => ({})),
    closeBrowserFully: jest.fn(async () => { box.browser = null; }),
    setTimeout, clearTimeout, clearInterval, sharedIdleInterval: null,
    server: { close: jest.fn() }, stopMemoryReporter() {}, sentryFlush: async () => {},
    process: { exit: jest.fn() },
  };
  vm.runInNewContext(source.slice(source.indexOf('function clearSessionLocks('), source.indexOf('async function createSharedIdentityContext(')) +
    '\nlet shuttingDown = false;\n' + ['gracefulShutdown', 'restartBrowser', 'ensureBrowser'].map(serverFunction).join('\n') +
    '\nglobalThis.closeOne = closeSession; globalThis.closeAll = closeAllSessions;', box);
  return { box, contexts, checkpoint };
}

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

test.each(['shutdown', 'restart', 'disconnect', 'admin_stop'])('%s closes every session and reaches browser close while one identity is unavailable', async action => {
  const { box, contexts, checkpoint } = await fixture();
  if (action === 'shutdown') await box.gracefulShutdown('SIGTERM');
  if (action === 'restart') await box.restartBrowser('recovery');
  if (action === 'disconnect') await box.ensureBrowser();
  if (action === 'admin_stop') {
    await box.closeAll('admin_stop');
    await box.closeBrowserFully('admin_stop');
  }
  for (const context of contexts) expect(context.close).toHaveBeenCalledTimes(1);
  expect(checkpoint.mock.calls.map(([id]) => id)).toEqual(['blocked', 'healthy']);
  expect(box.closeBrowserFully).toHaveBeenCalledTimes(1);
  expect(box.sessions.size).toBe(0);
  if (action === 'shutdown') expect(box.process.exit).toHaveBeenCalledWith(0);
  if (['restart', 'disconnect'].includes(action)) expect(box.launchBrowserInstance).toHaveBeenCalledTimes(1);
});

test('bulk close records a failed session and still checkpoints later sessions', async () => {
  const { box, contexts, checkpoint } = await fixture();
  const failure = new Error('session teardown failed');
  box.closeSessionOnce = jest.fn((session, close) => session === box.sessions.get('blocked')
    ? Promise.reject(failure) : closeSessionOnce(session, close));
  const failures = await box.closeAll('admin_stop');
  expect(contexts[1].close).toHaveBeenCalledTimes(1);
  expect(checkpoint).toHaveBeenCalledWith('healthy');
  expect(failures).toEqual([{ userId: 'blocked', error: failure }]);
  expect(box.log).toHaveBeenCalledWith('error', 'session close failed', {
    userId: 'blocked', reason: 'admin_stop', error: 'session teardown failed',
  });
});

test.each(['hidden_idle', 'session_timeout', 'api_delete_session', 'headed_transition', 'headed_release'])('%s still refuses destructive close for an unavailable identity', async reason => {
  const { box, contexts } = await fixture();
  await expect(box.closeOne('blocked', box.sessions.get('blocked'), { reason })).rejects.toMatchObject({ code: 'identity_transition_timeout' });
  expect(contexts[0].close).not.toHaveBeenCalled();
  expect(box.sessions.has('blocked')).toBe(true);
});

for (const stuck of ['existing transition', 'context close']) {
  test.each(['shutdown', 'restart', 'disconnect', 'admin_stop'])(`%s reaches browser finalization despite a hung ${stuck}`, async action => {
    const { box, contexts } = await fixture();
    const session = box.sessions.get('blocked');
    if (stuck === 'existing transition') closeSessionOnce(session, () => new Promise(() => {}));
    else contexts[0].close.mockImplementation(() => new Promise(() => {}));
    let finished = false;
    const pending = (async () => {
      if (action === 'shutdown') await box.gracefulShutdown('SIGTERM');
      if (action === 'restart') await box.restartBrowser('recovery');
      if (action === 'disconnect') await box.ensureBrowser();
      if (action === 'admin_stop') { await box.closeAll('admin_stop'); await box.closeBrowserFully('admin_stop'); }
      finished = true;
    })();
    await jest.advanceTimersByTimeAsync(10001);
    expect(finished).toBe(true);
    await pending;
    expect(contexts[0].close).toHaveBeenCalledTimes(1);
    expect(contexts[1].close).toHaveBeenCalledTimes(1);
    expect(box.closeBrowserFully).toHaveBeenCalledTimes(1);
    expect(box.sessions.has('blocked')).toBe(false);
  });
}

test('terminal takeover fences a late headed-transition cookie continuation before it can close a replacement', async () => {
  const { box, contexts } = await fixture();
  // Allow a transition to start, then recreate the blocked state only for the
  // terminal caller. The recovery guard must not control terminal authority.
  box.sharedIdentityWindow = null;
  let resume;
  box.sharedIdentities.snapshotCookies = () => new Promise(resolve => { resume = resolve; });
  const session = box.sessions.get('blocked');
  const old = box.closeSession('blocked', session, { reason: 'headed_transition' }).catch(error => error);
  await jest.advanceTimersByTimeAsync(0);
  await box.closeAll('admin_stop');
  expect(contexts[0].close).toHaveBeenCalledTimes(1);
  box.sessions.set('blocked', { context: { close: () => { throw Error('closed replacement'); } }, tabGroups: new Map() });
  resume([]);
  expect((await old).code).toBe('session_destroyed');
  expect(contexts[0].close).toHaveBeenCalledTimes(1);
});

test('terminal cleanup includes a manager-owned context with no published session', async () => {
  const { box } = await fixture();
  const orphan = { pages: () => [], close: jest.fn(async () => {}) };
  box.sharedIdentities.contexts = new Map([['orphan', orphan]]);
  const close = box.sharedIdentities.close.getMockImplementation();
  box.sharedIdentities.close.mockImplementation((id, options) => id === 'orphan' ? orphan.close() : close(id, options));
  await box.closeAll('admin_stop');
  expect(orphan.close).toHaveBeenCalledTimes(1);
});
