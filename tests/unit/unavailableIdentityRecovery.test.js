import { jest } from '@jest/globals';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { closeSessionOnce } from '../../lib/session-close.js';
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
    sessions, sharedIdentityWindow, closeSessionOnce,
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
