import { jest } from '@jest/globals';
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { quarantinePage } from '../../lib/page-registry.js';
import { SharedIdentityManager } from '../../lib/shared-identity.js';
import { createSharedIdentityRequestTracker } from '../../lib/shared-identity-requests.js';
import { createSharedIdentityWindowOpener } from '../../lib/shared-identity-window.js';
import { loadConfig } from '../../lib/config.js';
import { browserErrorStatus, browserErrorCode, browserErrorRecovery, isRetryableBrowserError } from '../../lib/browser-errors.js';

const source = readFileSync(new URL('../../server.js', import.meta.url), 'utf8');
function serverFunction(name, dependencies, async = true) {
  const start = source.indexOf(`${async ? 'async ' : ''}function ${name}(`);
  const end = source.indexOf('\n}\n', start) + 2;
  return vm.runInNewContext(`(${source.slice(start, end)})`, dependencies);
}
function route(pattern, dependencies) {
  const marker = source.indexOf(`app.post('${pattern}'`);
  const start = source.indexOf('async (req, res) => {', marker);
  const end = source.indexOf('\n});', start);
  if (marker < 0 || start < 0 || end < 0) throw new Error(`missing route ${pattern}`);
  return vm.runInNewContext(`(${source.slice(start, end + 2)})`, dependencies);
}

let profileDir;
beforeEach(async () => {
  jest.useFakeTimers();
  profileDir = await fs.mkdtemp(path.join(os.tmpdir(), 'camofox-open-deadline-'));
});
afterEach(async () => {
  jest.useRealTimers();
  await fs.rm(profileDir, { recursive: true, force: true });
});

function response() {
  return {
    statusCode: 200, body: null, headers: {},
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    on() {}, once() {},
  };
}

function fixture({ headed = true, page = null } = {}) {
  const manager = new SharedIdentityManager({ identities: ['personal'], profileDir });
  const current = page || {
    url: () => 'https://example.test/form', isClosed: () => false, bringToFront: jest.fn(async () => {}),
  };
  const context = {
    pages: () => [current], newPage: jest.fn(async () => current), close: jest.fn(async () => {}),
    cookies: jest.fn(async () => []), on: jest.fn(),
  };
  manager.contexts.set('personal', context);
  const session = {
    context, headed, sharedIdentity: true, tabGroups: new Map(), lastUsedPage: current, _closing: false,
  };
  const sessions = new Map([['personal', session]]);
  const identityTransitions = new Map();
  const sharedIdentityRequests = new Map();
  const deps = {
    sessions, sharedIdentities: manager, identityTransitions, sharedIdentityRequests,
    sessionCreations: new Map(), userConcurrency: new Map(), tabLocks: new Map(),
    humanControlledTabs: new Set(), sharedParkDisplay: null, CONFIG: { sharedIdentityAliases: {} },
    hasActivePageLeases: () => false,
    normalizeUserId: userId => userId,
    sharedIdentityParked(userId) {
      return Boolean(sessions.get(userId)?.visibility || deps.sharedParkDisplay);
    },
  };
  deps.identityBusy = serverFunction('identityBusy', deps, false);
  const opener = createSharedIdentityWindowOpener({
    manager, sessions, getSession: jest.fn(async userId => sessions.get(userId)), closeSession: jest.fn(),
    registerPage: jest.fn(() => 'personal-tab'), isBusy: deps.identityBusy,
    parkingEnabled: false, transitionTimeoutMs: 50,
  });
  deps.sharedIdentityWindow = opener;
  deps.transitionIdentity = serverFunction('transitionIdentity', deps, false);
  deps.handleRouteError = (err, _req, res) => res.status(err.statusCode || 500).json({ error: err.message, code: err.code });
  const handlers = {
    open: route('/browser/identities/:userId/open', deps),
    focus: route('/browser/identities/:userId/focus', deps),
  };
  const tracker = createSharedIdentityRequestTracker({
    getSessions: () => sessions, manager, normalizeUserId: deps.normalizeUserId,
    findTab: () => null, transitioning: userId => identityTransitions.has(userId) || opener.transitioning(userId),
    requests: sharedIdentityRequests, parkedVisibility: () => false,
    unavailable: userId => opener.unavailable?.(userId) || null,
  });
  const request = async (action, body = {}) => {
    const req = { path: `/browser/identities/personal/${action}`, params: { userId: 'personal' }, body, query: {} };
    const res = response();
    let pending;
    tracker(req, res, () => { pending = handlers[action](req, res); });
    if (pending) await pending;
    return res;
  };
  return { manager, opener, deps, request, context, session };
}

async function bounded(pending) {
  let result;
  pending.then(value => { result = value; });
  await jest.advanceTimersByTimeAsync(50);
  expect(result).toEqual(expect.objectContaining({
    statusCode: 503,
    body: expect.objectContaining({ code: 'identity_transition_timeout' }),
  }));
  return result;
}

describe('shared identity open deadline', () => {
  test('an open that never settles returns a loud deadline and releases the identity when the open settles', async () => {
    const f = fixture();
    let releaseFocus;
    const entered = new Promise(resolve => { releaseFocus = resolve; });
    const held = new Promise(resolve => { releaseFocus.settle = resolve; });
    jest.spyOn(f.manager, 'focus').mockImplementationOnce(() => {
      releaseFocus();
      return held;
    });

    const pending = f.request('open');
    await entered;
    expect((await f.request('focus')).body).toEqual({ error: 'identity busy' });

    const timedOut = await bounded(pending);
    expect(timedOut.body.error).toBe('shared identity open timed out');
    expect(f.deps.identityTransitions.size).toBe(0);
    expect(f.manager.focus).toHaveBeenCalledTimes(1);

    const during = await f.request('focus');
    expect(during.statusCode).toBe(503);
    expect(during.body.code).toBe('identity_transition_timeout');
    const retry = await f.request('open');
    expect(retry.statusCode).toBe(503);
    expect(retry.body.code).toBe('identity_transition_timeout');
    expect(f.manager.focus).toHaveBeenCalledTimes(1);

    releaseFocus.settle(f.context.pages()[0]);
    await jest.advanceTimersByTimeAsync(0);
    expect(f.opener.unavailable('personal')).toBeNull();
    expect((await f.request('open')).statusCode).toBe(200);
    expect(f.manager.focus).toHaveBeenCalledTimes(2);
  });

  test('a late null focus does not close or relaunch after the deadline', async () => {
    const manager = new SharedIdentityManager({ identities: ['personal'], profileDir });
    const page = { url: () => 'https://example.test/kept', isClosed: () => false, bringToFront: async () => {} };
    const context = { pages: () => [page], newPage: async () => page, close: async () => {}, cookies: async () => [], on() {} };
    manager.contexts.set('personal', context);
    const sessions = new Map([['personal', { context, headed: true, sharedIdentity: true, tabGroups: new Map(), lastUsedPage: page }]]);
    let settle;
    manager.focus = () => new Promise(resolve => { settle = resolve; });
    const closeSession = jest.fn(async () => { throw new Error('closed after deadline'); });
    const getSession = jest.fn(async () => { throw new Error('relaunched after deadline'); });
    const opener = createSharedIdentityWindowOpener({
      manager, sessions, getSession, closeSession, registerPage: () => 'tab', isBusy: () => false,
      parkingEnabled: false, transitionTimeoutMs: 50,
    });
    const pending = opener.openWindow('personal');
    const captured = pending.then(() => null, error => error);
    await jest.advanceTimersByTimeAsync(50);
    await expect(captured).resolves.toMatchObject({ statusCode: 503, code: 'identity_transition_timeout' });
    settle(null);
    await jest.advanceTimersByTimeAsync(0);
    expect(closeSession).not.toHaveBeenCalled();
    expect(getSession).not.toHaveBeenCalled();
    expect(opener.unavailable('personal')).toBeNull();
  });

  test('a queued opposite release cannot run after open times out', async () => {
    const f = fixture();
    let settle, entered;
    const inside = new Promise(resolve => { entered = resolve; });
    jest.spyOn(f.manager, 'focus').mockImplementationOnce(() => {
      entered();
      return new Promise(resolve => { settle = resolve; });
    });
    const first = f.request('open');
    await inside;
    const releaseOperation = jest.fn(async () => ({ released: true }));
    const release = f.deps.transitionIdentity('personal', 'release', releaseOperation).catch(error => error);
    await bounded(first);
    await expect(release).resolves.toMatchObject({ code: 'identity_transition_timeout' });
    expect(releaseOperation).not.toHaveBeenCalled();
    expect((await f.request('focus')).statusCode).toBe(503);
    settle(f.context.pages()[0]);
    await jest.advanceTimersByTimeAsync(0);
    expect(f.opener.unavailable('personal')).toBeNull();
    expect((await f.request('open')).statusCode).toBe(200);
  });

  test('open queued behind release has its own deadline and never launches afterward', async () => {
    const f = fixture();
    const focus = jest.spyOn(f.manager, 'focus');
    let settle;
    const release = f.deps.transitionIdentity('personal', 'release', () => new Promise(resolve => { settle = resolve; }));
    const pending = f.request('open');
    await bounded(pending);
    expect(focus).not.toHaveBeenCalled();
    settle({ released: true });
    await release;
    await jest.advanceTimersByTimeAsync(0);
    expect(focus).not.toHaveBeenCalled();
    expect(f.opener.unavailable('personal')).toBeNull();
    expect(f.deps.identityTransitions.size).toBe(0);
  });

  test('independent parked windows do not queue and cannot erase an older deadline', async () => {
    const f = fixture();
    const a = f.context.pages()[0];
    const b = { url: () => 'https://example.test/second', isClosed: () => false };
    f.session.tabGroups.set('tabs', new Map([['A', { page: a }], ['B', { page: b }]]));
    let settle, entered;
    const inside = new Promise(resolve => { entered = resolve; });
    f.session.visibility = { visible: new Map(), open: jest.fn(async page => {
      if (page === a) { entered(); await new Promise(resolve => { settle = resolve; }); }
    }) };
    const pending = f.request('open', { tabId: 'A' });
    await inside;
    const second = await f.request('open', { tabId: 'B' });
    expect(second.statusCode).toBe(200);
    expect(f.opener.transitioning('personal')).toBe(false);
    await bounded(pending);
    expect((await f.request('open', { tabId: 'B' })).statusCode).toBe(503);
    settle();
    await jest.advanceTimersByTimeAsync(0);
    expect(f.opener.unavailable('personal')).toBeNull();
  });

  test('production error response preserves the explicit failure without destroying the session', () => {
    const sendError = serverFunction('sendError', {
      browserErrorStatus, browserErrorCode, browserErrorRecovery, isRetryableBrowserError,
      safeError: error => error.message, StaleRefsError: class extends Error {},
    }, false);
    const destroySession = jest.fn();
    const handle = serverFunction('handleRouteError', {
      sendError, destroySession, classifyError: () => 'timeout', actionFromReq: () => 'open',
      failuresTotal: { labels: () => ({ inc() {} }) },
    }, false);
    const res = response();
    handle(Object.assign(new Error('shared identity open timed out'), {
      statusCode: 503, code: 'identity_transition_timeout',
    }), { body: { userId: 'personal' } }, res);
    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual({ error: 'shared identity open timed out', code: 'identity_transition_timeout', retryable: false });
    expect(destroySession).not.toHaveBeenCalled();
  });

  test('elapsed deadline before the timer callback still rejects the caller', async () => {
    const f = fixture();
    jest.spyOn(f.manager, 'focus').mockImplementationOnce(async () => {
      jest.setSystemTime(Date.now() + 51);
      return f.context.pages()[0];
    });
    const response = await f.request('open');
    expect(response.statusCode).toBe(503);
    expect(response.body.code).toBe('identity_transition_timeout');
    expect(f.opener.unavailable('personal')).toBeNull();
  });

  test('manager focus cannot bring a late new page to front after the deadline', async () => {
    const f = fixture();
    let settle;
    f.context.pages = () => [];
    f.context.newPage.mockImplementationOnce(() => new Promise(resolve => { settle = resolve; }));
    const bringToFront = jest.fn(async () => {});
    const pending = f.request('open');
    await bounded(pending);
    settle({ isClosed: () => false, bringToFront });
    await jest.advanceTimersByTimeAsync(0);
    expect(bringToFront).not.toHaveBeenCalled();
    expect(f.opener.unavailable('personal')).toBeNull();
  });

  test('idle cleanup does not reap tabs while timed-out open work is unresolved', async () => {
    const f = fixture({ headed: false });
    f.session.tabGroups.set('group', new Map([['old', { page: {}, lastAgentActivityAt: 0 }]]));
    const closeSharedTab = jest.fn(async () => true);
    f.deps.CONFIG = { hiddenTabIdleMin: 1, headedIdleReleaseMin: 0 };
    f.deps.sharedIdentityIdlePolicy = { agentIdle: () => true };
    f.deps.latestSharedTabId = () => 'other';
    f.deps.sharedTabClosable = () => true;
    f.deps.closeSharedTab = closeSharedTab;
    f.deps.sharedSessionExpiryEligible = () => false;
    f.deps.tabsReapedTotal = { inc() {} };
    const sweep = serverFunction('cleanIdleSharedSessions', f.deps);
    let settle;
    f.opener.openWindow('personal', null, {
      allowRestart: true, waitFor: new Promise(resolve => { settle = resolve; }),
    }).catch(() => {});
    await jest.advanceTimersByTimeAsync(50);
    await sweep();
    expect(closeSharedTab).not.toHaveBeenCalled();
    settle();
    await jest.advanceTimersByTimeAsync(0);
  });

  test('an existing parked session does not gate sibling tabs while getSession is pending', async () => {
    const page = { isClosed: () => false };
    const session = { context: { pages: () => [page] }, lastUsedPage: page,
      visibility: { visible: new Map(), open: jest.fn(async () => {}) } };
    let resolveSession;
    const getSession = jest.fn(() => new Promise(resolve => { resolveSession = resolve; }));
    const opener = createSharedIdentityWindowOpener({ manager: {}, sessions: new Map([['personal', session]]),
      getSession, closeSession: jest.fn(), registerPage: () => 'tab', isBusy: () => false, transitionTimeoutMs: 50 });
    const pending = opener.openWindow('personal');
    await jest.advanceTimersByTimeAsync(0);
    expect(getSession).toHaveBeenCalledTimes(1);
    expect(opener.transitioning('personal')).toBe(false);
    resolveSession(session);
    await expect(pending).resolves.toMatchObject({ tabId: 'tab', restarted: false });
  });

  test('deadline during cookie snapshot cannot start destructive close afterward', async () => {
    const f = fixture({ headed: false });
    let settle;
    f.context.cookies.mockImplementationOnce(() => new Promise(resolve => { settle = resolve; }));
    const closeSessionOnce = (session, operation) => operation();
    Object.assign(f.deps, {
      closeSessionOnce, quarantinePage, UNAVAILABLE_IDENTITY_CLOSE_REASONS: new Set(['shutdown', 'admin_stop', 'browser_restart', 'browser_disconnected']), sharedIdentityLastUrls: new Map(),
      clearSessionLocks: jest.fn(), clearSessionDownloads: jest.fn(async () => {}),
      refreshActiveTabsGauge() {}, log() {},
    });
    f.deps.closeSessionNow = serverFunction('closeSessionNow', f.deps);
    const actualClose = serverFunction('closeSession', f.deps, false);
    // The opener invokes this collaborator; the implementation below is the
    // production close path, including its post-snapshot continuation fence.
    const opener = createSharedIdentityWindowOpener({
      manager: f.manager, sessions: f.deps.sessions, getSession: jest.fn(), closeSession: actualClose,
      registerPage: () => 'tab', isBusy: () => false, transitionTimeoutMs: 50,
    });
    f.deps.sharedIdentityWindow = opener;
    const pending = opener.openWindow('personal', null, { allowRestart: true }).catch(error => error);
    await jest.advanceTimersByTimeAsync(50);
    await expect(pending).resolves.toMatchObject({ code: 'identity_transition_timeout' });
    settle([]);
    await jest.advanceTimersByTimeAsync(0);
    expect(f.context.close).not.toHaveBeenCalled();
    expect(f.deps.clearSessionLocks).not.toHaveBeenCalled();
    expect(f.deps.sessions.get('personal')).toBe(f.session);
    expect(opener.unavailable('personal')).toBeNull();
  });

  test('configuration uses the 60s default and bounds a JSON override to the timer range', async () => {
    const configPath = path.join(profileDir, 'config.json');
    await fs.writeFile(configPath, '{}');
    expect(loadConfig({ configPath }).sharedIdentityOpenTimeoutMs).toBe(60000);
    await fs.writeFile(configPath, JSON.stringify({ sharedIdentityOpenTimeoutMs: 1234 }));
    expect(loadConfig({ configPath }).sharedIdentityOpenTimeoutMs).toBe(1234);
    await fs.writeFile(configPath, JSON.stringify({ sharedIdentityOpenTimeoutMs: 2147483648 }));
    expect(loadConfig({ configPath }).sharedIdentityOpenTimeoutMs).toBe(60000);
  });
});
