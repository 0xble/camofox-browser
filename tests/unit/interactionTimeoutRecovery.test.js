import { jest } from '@jest/globals';
import express from 'express';
import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs';
import vm from 'node:vm';
import * as browserErrors from '../../lib/browser-errors.js';
import { actionFromReq, classifyError } from '../../lib/request-utils.js';

// Execute the actual route registrations and lock/error functions through a
// disposable Express server. Only browser/metrics collaborators are synthetic;
// no browser engine, live service, persistent profile, or production API is used.
const source = fs.readFileSync(new URL('../../server.js', import.meta.url), 'utf8');
function slice(startMarker, endMarker, endExtra = 0) {
  const start = source.indexOf(startMarker);
  if (start < 0 || source.indexOf(startMarker, start + startMarker.length) !== -1) {
    throw new Error(`server.js fixture start marker missing or nonunique: ${startMarker}`);
  }
  const end = source.indexOf(endMarker, start + startMarker.length);
  if (end < 0) throw new Error(`server.js fixture end marker missing after ${startMarker}: ${endMarker}`);
  return source.slice(start, end + endExtra);
}
const turn = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
}

async function fixture({ keyboard, click, mouse, fill, focus, refresh, frames = [] } = {}) {
  const app = express();
  app.use(express.json());
  const locator = {
    click: click || jest.fn(async () => {}),
    boundingBox: async () => ({ x: 0, y: 0, width: 10, height: 10 }),
  };
  const page = {
    isClosed: () => false, url: () => 'https://fixture.invalid/changed', frames: () => frames,
    keyboard: { type: keyboard || jest.fn(async () => {}), press: async () => {} },
    mouse: { move: async () => {}, down: async () => {}, up: async () => {}, ...mouse },
    locator: () => locator, focus: focus || (async () => {}), waitForTimeout: async () => {},
  };
  const tabState = { page, refs: new Map([['e1', {}]]), toolCalls: 0, visitedUrls: new Set(), lastSnapshot: 'old snapshot' };
  const session = {};
  const refreshes = [];
  const box = {
    ...browserErrors, AsyncLocalStorage, setTimeout, clearTimeout,
    app: { post(path, handler) {
      app.post(path, (req, res, next) => Promise.resolve(handler(req, res)).catch(next));
    } },
    HANDLER_TIMEOUT_MS: 50, TAB_LOCK_TIMEOUT_MS: 100, ABANDONED_TAB_TIMEOUT_MS: 60000,
    sessions: new Map([['fixture', session]]), normalizeUserId: String,
    findTab: () => ({ tabState }), findTabOwner: () => ({ session, tabState }),
    tabLockTimeoutsTotal: { inc() {} }, refreshTabLockQueueDepth() {},
    handleTimedOutTab: async () => ({ destroyed: false }),
    withUserLimit: (_userId, operation) => operation(),
    selectorValidationError: () => null, visibleSelectorCandidate: () => null,
    isGoogleSerp: () => false, clickWithDownloadGuard: (_tab, operation) => operation(),
    fillLocator: fill || (async () => {}), typeEventPayload: value => value,
    refreshTabRefs: jest.fn(async (_tab, options) => {
      refreshes.push({ reason: options.reason, active: box.locks.get('A')?.active, settling: box.locks.get('A')?.settling || false, insideOperation: box.insideOperation() });
      if (refresh) await refresh();
      return new Map([['e2', {}]]);
    }),
    log() {}, pluginEvents: { emit() {} },
    classifyError, actionFromReq, failuresTotal: { labels: () => ({ inc() {} }) },
    _countTabs: () => 1, _browserPid: () => null, isProxyError: () => false, proxyPool: null,
    CONFIG: { nodeEnv: 'development' }, StaleRefsError: class StaleRefsError extends Error {},
  };
  vm.createContext(box);
  vm.runInContext(slice('class TabLock {', 'function findTabOwner(tabId)') + ';globalThis.locks = tabLocks; globalThis.run = withTabLock; globalThis.timeout = withTimeout; globalThis.insideOperation = () => Boolean(tabOperationContext.getStore());', box);
  vm.runInContext(slice('function safeError(', 'function validateUrl('), box);
  vm.runInContext(slice('function handleRouteError(', 'function destroyTab('), box);
  for (const action of ['click', 'type']) {
    vm.runInContext(slice(`app.post('/tabs/:tabId/${action}'`, '\n});', 5), box);
  }
  const server = await new Promise(resolve => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    ...box, tabState, refreshes,
    request: async (action, body = {}) => {
      const response = await fetch(`${base}/tabs/A/${action}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: 'fixture', selector: '#target', text: 'synthetic', ...body }),
      });
      return { status: response.status, body: await response.json() };
    },
    close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  };
}

test('1Password notification returns human_handoff_required before any native input and releases the lock', async () => {
  const click = jest.fn(async () => {}), move = jest.fn(async () => {});
  const frames = [{ name: () => 'op-notification', url: () => 'moz-extension://fixture/inline/notification/notification.html',
    frameElement: async () => ({ isVisible: async () => true, dispose: async () => {} }),
  }];
  const f = await fixture({ click, mouse: { move }, frames });
  try {
    expect(await f.request('click')).toMatchObject({ status: 409, body: {
      code: 'human_handoff_required', retryable: false, recovery: 'human_handoff',
    } });
    expect(click).not.toHaveBeenCalled();
    expect(move).not.toHaveBeenCalled();
    expect(f.locks.get('A').active).toBe(false);
    frames.length = 0;
    expect(await f.request('click')).toMatchObject({ status: 200 });
  } finally { await f.close(); }
});

function observe(label, f, response) {
  console.log(JSON.stringify({ case: label, ...response, refreshes: f.refreshes, settling: f.locks.get('A')?.settling || false }));
}
const timeoutResponse = {
  status: 503,
  body: expect.objectContaining({ code: 'operation_timeout', retryable: true, recovery: 'retry', error: expect.stringContaining('Work may still be running') }),
};

test.each(['click', 'type'])('outer %s timeout retains its metadata and never refreshes refs while work settles', async action => {
  const slow = deferred();
  const f = await fixture({ keyboard: () => slow.promise, click: () => slow.promise });
  try {
    const response = await f.request(action, { mode: 'keyboard' });
    observe(`outer ${action} timeout`, f, response);
    expect(response).toEqual(timeoutResponse);
    expect(f.refreshes).toEqual([]);
    expect(f.locks.get('A').settling).toBe(true);
    expect(await f.request(action, { mode: 'keyboard' })).toMatchObject({ status: 503, body: { code: 'tab_busy' } });
  } finally {
    slow.resolve();
    await turn();
    await f.close();
  }
});

test.each(['move', 'down', 'up'])('nested native mouse %s timeout retains classification without a settling ref refresh', async action => {
  const slow = deferred();
  const f = await fixture({
    click: async () => { throw new Error('not visible'); },
    mouse: { [action]: () => slow.promise },
  });
  try {
    const response = await f.request('click');
    observe(`nested mouse ${action}`, f, response);
    expect(response).toEqual(timeoutResponse);
    expect(response.body.error).toContain(`native mouse ${action} timed out`);
    expect(f.refreshes).toEqual([]);
    expect(f.locks.get('A').settling).toBe(true);
    expect(await f.request('click')).toMatchObject({ status: 503, body: { code: 'tab_busy' } });
  } finally {
    slow.resolve();
    await turn();
    await f.close();
  }
});

test.each([
  ['type', 'fill', 'locator.fill'],
  ['type', 'keyboard', 'page.focus'],
  ['click', 'fill', 'locator.fill'],
])('%s keeps Playwright %s locator timeouts actionable (%s)', async (action, mode, api) => {
  const error = new Error(`${api}: Timeout 10000ms exceeded.\nCall log:\n  - waiting for locator('#missing')`);
  const fail = async () => { throw error; };
  // Click's own timeout has a mouse fallback. Fail its normal post-click ref
  // refresh to exercise the same outer catch with the unmodified locator error.
  const f = await fixture({ fill: fail, focus: fail, ...(action === 'click' ? { refresh: fail } : {}) });
  try {
    const response = await f.request(action, { mode });
    expect(response).toMatchObject({ status: 422, body: { code: 'element_not_actionable', retryable: true, recovery: 'snapshot_then_retry' } });
    expect(response.body.error).not.toContain('Work may still be running');
    expect(error.code).toBeUndefined();
    expect(f.refreshes.map(({ reason }) => reason)).toEqual(action === 'click' ? ['post_click'] : []);
    expect(f.locks.get('A').settling).toBe(false);
  } finally { await f.close(); }
});

test.each(['click', 'type'])('%s preserves genuine page-change recovery and refreshes refs under the tab lock', async action => {
  const pageChanged = async () => { throw new Error('Execution context was destroyed, most likely because of a navigation'); };
  const f = await fixture({ click: pageChanged, fill: pageChanged });
  try {
    const response = await f.request(action);
    observe(`genuine ${action} page change`, f, response);
    expect(response).toMatchObject({ status: 409, body: { code: 'page_changed', recovery: 'snapshot_then_retry', refsCount: 1 } });
    expect(f.refreshes).toEqual([expect.objectContaining({ active: true, settling: false, insideOperation: true })]);
    expect(f.tabState.lastSnapshot).toBe(null);
  } finally { await f.close(); }
});

test.each(['click', 'type'])('%s preserves structured timeout and tab-destroyed codes ahead of navigation wording', async action => {
  for (const [code, status, recovery] of [['operation_timeout', 503, 'retry'], ['tab_destroyed', 410, 'create_new_tab']]) {
    const structured = async () => { throw Object.assign(new Error('Execution context was destroyed; work may still run'), { code, statusCode: status }); };
    const f = await fixture({ click: structured, fill: structured });
    try {
      const response = await f.request(action);
      expect(response).toMatchObject({ status, body: { code, retryable: true, recovery } });
      if (code === 'operation_timeout') expect(response.body.error).toContain('work may still run');
      expect(f.refreshes).toEqual([]);
    } finally { await f.close(); }
  }
});

test.each(['click', 'type'].flatMap(action => [
  [action, 'action timed out after 10000ms; Execution context was destroyed'],
  ...['move', 'down', 'up'].map(step => [action, `native mouse ${step} timed out; Execution context was destroyed`]),
]))('%s treats a handler/native timeout plus navigation wording as a timeout (%s)', async (action, message) => {
  const timedOut = async () => { throw new Error(message); };
  const f = await fixture({ click: timedOut, fill: timedOut });
  try {
    const response = await f.request(action);
    expect(response).toMatchObject({ status: 503, body: { code: 'operation_timeout', retryable: true, recovery: 'retry' } });
    expect(f.refreshes).toEqual([]);
  } finally { await f.close(); }
});

test.each(['click', 'type'])('%s refuses page-change recovery while nested work is still settling', async action => {
  const slow = deferred();
  let f;
  const pageChanged = async () => {
    void f.timeout(slow.promise, 5000, 'synthetic nested work');
    throw new Error('Execution context was destroyed');
  };
  f = await fixture({ click: pageChanged, fill: pageChanged });
  try {
    const response = await f.request(action);
    expect(response).toMatchObject({ status: 503, body: { code: 'tab_busy', recovery: 'retry' } });
    expect(f.refreshes).toEqual([]);
    expect(f.locks.get('A').settling).toBe(true);
  } finally {
    slow.resolve();
    await turn();
    await f.close();
  }
});

test.each(['click', 'type'])('%s reports a recovery refresh timeout rather than page_changed', async action => {
  const slow = deferred();
  const pageChanged = async () => { throw new Error('Execution context was destroyed'); };
  const f = await fixture({ click: pageChanged, fill: pageChanged, refresh: () => slow.promise });
  try {
    const response = await f.request(action);
    expect(response).toEqual(timeoutResponse);
    expect(f.refreshes).toEqual([expect.objectContaining({ active: true, settling: false, insideOperation: true })]);
    expect(f.locks.get('A').settling).toBe(true);
    expect(await f.request(action)).toMatchObject({ status: 503, body: { code: 'tab_busy' } });
    expect(f.refreshes).toHaveLength(1);
  } finally {
    slow.resolve();
    await turn();
    await f.close();
  }
});

test('type still recovers a target that changed into a non-input under the tab lock', async () => {
  const f = await fixture({ fill: async () => { throw new Error('Element is not an <input>'); } });
  try {
    const response = await f.request('type');
    observe('non-input type target', f, response);
    expect(response).toMatchObject({ status: 409, body: { code: 'page_changed' } });
    expect(f.refreshes).toEqual([expect.objectContaining({ active: true, settling: false, insideOperation: true })]);
  } finally { await f.close(); }
});
