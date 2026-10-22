import { jest } from '@jest/globals';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../../server.js', import.meta.url), 'utf8');
function route(method, path, dependencies) {
  let handler;
  const start = source.indexOf(`app.${method}('${path}'`);
  const end = source.indexOf('\n});', start) + 5;
  vm.runInNewContext(source.slice(start, end), { app: { [method]: (_path, ...args) => { handler = args.at(-1); } }, ...dependencies });
  return handler;
}
function serverFunction(name, dependencies) {
  const start = source.indexOf(`async function ${name}(`);
  const end = source.indexOf('\n}\n', start) + 2;
  return vm.runInNewContext(`(${source.slice(start, end)})`, dependencies);
}
function response() {
  const res = { status: jest.fn(() => res), json: jest.fn(() => res) };
  return res;
}

test.each(['tab-a', null])('no-park release (%s) preserves idle sibling input instead of closing the context', async tabId => {
  const a = { isClosed: () => false, url: () => 'https://form.test/a', input: 'unsaved A' };
  const b = { isClosed: () => false, url: () => 'https://form.test/b', input: 'unsaved B' };
  const context = { pages: () => [a, b], close: jest.fn() };
  const session = { context, sharedIdentity: true, headed: true, tabGroups: new Map([
    ['a', new Map([['tab-a', { page: a }]])], ['b', new Map([['tab-b', { page: b }]])],
  ]) };
  const closeSession = jest.fn();
  const release = serverFunction('releaseIdentity', { sessions: new Map([['identity', session]]),
    sessionCreations: new Map(), sharedIdentityLastUrls: new Map(), identityBusy: () => false, closeSession, log: jest.fn() });
  await expect(release('identity', { tabId })).rejects.toMatchObject({ statusCode: 409, code: 'context_close_required' });
  expect(closeSession).not.toHaveBeenCalled();
  expect(context.close).not.toHaveBeenCalled();
  expect(context.pages()).toEqual([a, b]);
  expect([a.input, b.input]).toEqual(['unsaved A', 'unsaved B']);
  await expect(release('identity', { all: true })).resolves.toEqual({ ok: true, released: true });
  expect(closeSession).toHaveBeenCalledWith('identity', session, { reason: 'headed_release' });
});

test('release refuses ambiguous all plus tabId without invoking a transition', async () => {
  const releaseIdentity = jest.fn(), transitionIdentity = jest.fn();
  const handler = route('post', '/browser/identities/:userId/release', { normalizeUserId: value => value,
    authMiddleware: () => () => {}, sharedIdentities: { owns: () => true }, releaseIdentity, transitionIdentity });
  const res = response();
  await handler({ params: { userId: 'identity' }, body: { tabId: 'B', all: true } }, res);
  expect(res.status).toHaveBeenCalledWith(400);
  expect(transitionIdentity).not.toHaveBeenCalled();
  expect(releaseIdentity).not.toHaveBeenCalled();
});

test('release passes an explicit all request without broadening a targeted request', async () => {
  const releaseIdentity = jest.fn(async () => ({ ok: true, released: true })), transitionIdentity = jest.fn(async (_id, _action, operation) => operation());
  const handler = route('post', '/browser/identities/:userId/release', { normalizeUserId: value => value,
    authMiddleware: () => () => {}, sharedIdentities: { owns: () => true }, releaseIdentity, transitionIdentity });
  const res = response();
  await handler({ params: { userId: 'identity' }, body: { all: true } }, res);
  expect(releaseIdentity).toHaveBeenCalledWith('identity', { tabId: null, all: true });
  expect(transitionIdentity.mock.calls[0][3]).toEqual({ coalesceKey: '[null,true]' });
});

test.each([false, true])('open propagates explicit restart acceptance (%s) without coalescing with an unaccepted restart', async allowRestart => {
  const openWindow = jest.fn(async () => ({ ok: true }));
  const transitionIdentity = jest.fn(async (_id, _action, operation) => operation());
  const handler = route('post', '/browser/identities/:userId/open', { normalizeUserId: value => value,
    sharedIdentities: { owns: () => true }, sharedIdentityWindow: { openWindow }, transitionIdentity });
  await handler({ params: { userId: 'identity' }, body: { tabId: 'A', allowRestart } }, response());
  expect(openWindow).toHaveBeenCalledWith('identity', 'A', { allowRestart });
  expect(transitionIdentity.mock.calls[0][3]).toEqual({ coalesceKey: JSON.stringify(['A', allowRestart]) });
});

test.each([null, { park: {}, main: {} }])('health separates current parking capability from liveness (display=%j)', async sharedParkDisplay => {
  const updateDisplay = jest.fn(), refreshSharedParkDisplay = jest.fn();
  const controller = { updateDisplay, visible: new Map(), capability: () => ({ sameContextHandoff: Boolean(sharedParkDisplay), failedWindows: 2 }) };
  const sessions = new Map([['parked', { visibility: controller }], ['legacy', { sharedIdentity: true, headed: false }]]);
  const handler = route('get', '/health', {
    CONFIG: { sharedIdentityNames: ['identity'], parkDisplay: 'DeskPad' }, refreshSharedParkDisplay, sharedParkDisplay,
    sessions, os: { platform: () => 'darwin' }, healthState: { isRecovering: false }, browser: null,
    process, _lastBrowserStopReason: null, getTotalTabCount: () => 2, userNavHealth: new Map(), FLY_MACHINE_ID: null,
  });
  const res = response(); await handler({}, res);
  expect(res.status).not.toHaveBeenCalled();
  expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ ok: true, visibility: {
    mode: sharedParkDisplay ? 'parking' : 'unavailable', parking: Boolean(sharedParkDisplay),
    sameContextSessions: sharedParkDisplay ? 1 : 0, restartRequiredSessions: 1, failedWindows: 2,
  } }));
  expect(refreshSharedParkDisplay).toHaveBeenCalledTimes(1);
  expect(updateDisplay).toHaveBeenCalledWith(sharedParkDisplay);
});

test('failed topology discovery degrades explicitly rather than throwing during session creation', async () => {
  const log = jest.fn();
  const refresh = serverFunction('refreshSharedParkDisplay', { CONFIG: { parkDisplay: 'DeskPad' }, sharedParkDisplay: {}, parkDiscoverySequence: 0, appliedParkDiscovery: 0,
    findParkDisplay: async () => { throw Error('display discovery timed out'); }, log });
  await expect(refresh()).resolves.toBe(null);
  expect(log).toHaveBeenCalledWith('warn', 'park display discovery failed', { error: 'display discovery timed out' });
});

test('a slow older discovery cannot reinstate disconnected topology over a newer result', async () => {
  let oldResolve;
  const findParkDisplay = jest.fn().mockImplementationOnce(() => new Promise(resolve => { oldResolve = resolve; })).mockResolvedValueOnce(null);
  const refresh = serverFunction('refreshSharedParkDisplay', { CONFIG: { parkDisplay: 'DeskPad' }, sharedParkDisplay: {},
    parkDiscoverySequence: 0, appliedParkDiscovery: 0, findParkDisplay, log: jest.fn() });
  const old = refresh();
  await expect(refresh()).resolves.toBe(null);
  oldResolve({ park: {}, main: {} });
  await expect(old).resolves.toBe(null);
});
