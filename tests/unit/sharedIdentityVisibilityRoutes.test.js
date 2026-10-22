import { jest } from '@jest/globals';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../../server.js', import.meta.url), 'utf8');
function route(name, dependencies) {
  let handler;
  const start = source.indexOf(`app.post('/browser/identities/:userId/${name}'`);
  const end = source.indexOf('\n});', start) + 5;
  vm.runInNewContext(source.slice(start, end), { app: { post: (_path, ...args) => { handler = args.at(-1); } }, ...dependencies });
  return handler;
}
function response() { const res = { status: jest.fn(() => res), json: jest.fn(() => res) }; return res; }

test('focus shows the requested parked tab and only reports focused after open succeeds', async () => {
  const session = { visibility: {}, headed: false };
  const result = { ok: true, tabId: 'B', focused: true, restarted: false };
  const openWindow = jest.fn(async () => result), legacyFocus = jest.fn();
  const deps = { normalizeUserId: String, sharedIdentities: { owns: () => true, focus: legacyFocus },
    sessions: new Map([['identity', session]]), sharedIdentityWindow: { openWindow },
    handleRouteError: (err, _req, res) => res.status(500).json({ error: err.message }) };
  const handler = route('focus', deps), res = response();
  await handler({ params: { userId: 'identity' }, body: { tabId: 'B' } }, res);
  expect(openWindow).toHaveBeenCalledWith('identity', 'B'); expect(res.json).toHaveBeenCalledWith(result);
  expect(res.status).not.toHaveBeenCalled(); expect(legacyFocus).not.toHaveBeenCalled();
  openWindow.mockRejectedValueOnce(new Error('move failed'));
  const failed = response(); await handler({ params: { userId: 'identity' }, body: { tabId: 'B' } }, failed);
  expect(failed.status).toHaveBeenCalledWith(500); expect(failed.json).toHaveBeenCalledWith({ error: 'move failed' });
});

test('release passes the optional requested tab and distinct coalescing key', async () => {
  const releaseIdentity = jest.fn(async () => ({ ok: true, released: true }));
  const transitionIdentity = jest.fn(async (_id, _action, operation) => operation());
  const handler = route('release', { authMiddleware: () => () => {}, normalizeUserId: String,
    sharedIdentities: { owns: () => true }, releaseIdentity, transitionIdentity });
  const res = response(); await handler({ params: { userId: 'identity' }, body: { tabId: 'B' } }, res);
  expect(releaseIdentity).toHaveBeenCalledWith('identity', { tabId: 'B' });
  expect(transitionIdentity.mock.calls[0][3]).toEqual({ coalesceKey: '["B",false]' });
});

test.each([false, true])('last-URL restoration respects the parked page factory (parked=%s)', async parked => {
  const blank = { isClosed: () => false, url: () => 'about:blank', goto: jest.fn(async () => {}) };
  const restored = { isClosed: () => false, url: () => 'about:blank#camofox-restored', goto: jest.fn(async () => {}) };
  const visibility = { newPage: jest.fn(async () => restored), isManagedPage: () => true };
  const context = { pages: () => [blank], newPage: jest.fn(async () => restored), on: jest.fn(),
    sharedIdentityVisibility: parked ? visibility : null };
  const urls = new Map([['identity', 'https://fixture.test/previous']]);
  const registerSharedIdentityPage = jest.fn();
  const getSession = serverFunction('getSession', {
    normalizeUserId: String, sessions: new Map(), sessionCreations: new Map(),
    sharedIdentities: { failedClosures: new Set(), owns: () => true, open: async () => context },
    coalesceInflight: (_map, _key, operation) => operation(), MAX_SESSIONS: 10, FLY_MACHINE_ID: '',
    proxyPool: null, browserLaunchProxy: null, CONFIG: {}, contextIdentityOptions: () => ({}),
    sharedIdentityLastUrls: urls, registerSharedIdentityPage, log: jest.fn(),
  });
  const session = await getSession('identity');
  const target = parked ? restored : blank;
  expect(target.goto).toHaveBeenCalledWith('https://fixture.test/previous', { timeout: 10_000 });
  expect(session.lastUsedPage).toBe(target);
  expect(urls.has('identity')).toBe(false);
  expect(context.newPage).not.toHaveBeenCalled();
  expect(visibility.newPage).toHaveBeenCalledTimes(parked ? 1 : 0);
  if (parked) {
    expect(blank.goto).not.toHaveBeenCalled();
    expect(registerSharedIdentityPage).toHaveBeenCalledWith(session, 'identity', restored);
  }
});

test('a parked createPage rejection during last-URL restore still yields a usable session', async () => {
  const visibility = { newPage: jest.fn(async () => { throw new Error('window visibility operation timed out'); }), isManagedPage: () => true };
  const context = { pages: () => [], newPage: jest.fn(), on: jest.fn(), sharedIdentityVisibility: visibility };
  const urls = new Map([['identity', 'https://fixture.test/previous']]);
  const sessions = new Map(), log = jest.fn(), registerSharedIdentityPage = jest.fn();
  const getSession = serverFunction('getSession', {
    normalizeUserId: String, sessions, sessionCreations: new Map(),
    sharedIdentities: { failedClosures: new Set(), owns: () => true, open: async () => context, contexts: new Map([['identity', context]]) },
    coalesceInflight: (_map, _key, operation) => operation(), MAX_SESSIONS: 10, FLY_MACHINE_ID: '',
    proxyPool: null, browserLaunchProxy: null, CONFIG: {}, contextIdentityOptions: () => ({}),
    sharedIdentityLastUrls: urls, registerSharedIdentityPage, log,
  });
  const session = await getSession('identity');
  expect(sessions.get('identity')).toBe(session);
  expect(session.visibility).toBe(visibility);
  expect(registerSharedIdentityPage).not.toHaveBeenCalled();
  expect(context.newPage).not.toHaveBeenCalled();
  expect(urls.get('identity')).toBe('https://fixture.test/previous');
  expect(log).toHaveBeenCalledWith('warn', 'shared identity URL restoration failed', { userId: 'identity', error: 'window visibility operation timed out' });
  // The session is usable: the next call reuses it without recreating the context.
  await expect(getSession('identity')).resolves.toBe(session);
});

function serverFunction(name, dependencies) {
  const start = source.indexOf(`async function ${name}(`);
  const end = source.indexOf('\n}\n', start) + 2;
  return vm.runInNewContext(`(${source.slice(start, end)})`, dependencies);
}

test.each([[null, false], ['B', false], [null, true], ['B', true]])(
  'release during first parked session creation preserves the context (tabId=%s, headedOnly=%s)', async (tabId, headedOnly) => {
    const sessions = new Map(), sessionCreations = new Map([['identity', Promise.resolve()]]);
    const visible = new Map([[2, { windowId: 2, tabId: 2 }]]);
    const visibility = { visible, release: jest.fn(async () => { visible.clear(); return true; }) };
    const page = { state: 'unsaved' };
    const session = { visibility, headed: false, tabGroups: new Map([['caller', new Map([['B', { page }]])]]) };
    const closeSession = jest.fn(), identityBusy = jest.fn(() => false), wakes = [];
    const releaseIdentity = serverFunction('releaseIdentity', { sessions, sessionCreations, sharedParkDisplay: {},
      findTab: (_session, id) => id === 'B' ? { tabState: { page } } : null,
      closeSession, identityBusy, setTimeout: fn => wakes.push(fn) });
    const result = releaseIdentity('identity', { tabId, headedOnly });
    expect(wakes).toHaveLength(1);
    expect(visibility.release).not.toHaveBeenCalled();
    sessions.set('identity', session); sessionCreations.delete('identity'); wakes.shift()();
    await expect(result).resolves.toEqual({ ok: true, released: true });
    expect(visibility.release).toHaveBeenCalledWith({ all: false, page: tabId ? page : undefined });
    expect(closeSession).not.toHaveBeenCalled(); expect(identityBusy).not.toHaveBeenCalled();
    expect(sessions.get('identity')).toBe(session);
    expect(session.tabGroups.get('caller').get('B').page).toBe(page);
    expect(page.state).toBe('unsaved'); expect(session.headed).toBe(false);
  });

test('parked release without tabId succeeds and always recomputes headed from live handoffs', async () => {
  const visible = new Map([[2, { windowId: 2, tabId: 2 }]]);
  const visibility = { visible, release: jest.fn(async () => { visible.clear(); return true; }) };
  const session = { visibility, headed: true };
  const releaseIdentity = serverFunction('releaseIdentity', { sessions: new Map([['identity', session]]), findTab: () => null });
  await expect(releaseIdentity('identity')).resolves.toEqual({ ok: true, released: true });
  expect(visibility.release).toHaveBeenCalledWith({ all: false, page: undefined });
  expect(session.headed).toBe(false);
  visible.set(3, { windowId: 3, tabId: 3 }); visible.set(4, { windowId: 4, tabId: 4 });
  visibility.release.mockImplementationOnce(async () => { visible.delete(4); throw new Error('1 of 2 window park operations failed'); });
  session.headed = false;
  await expect(releaseIdentity('identity', { all: true })).rejects.toThrow('1 of 2');
  expect(session.headed).toBe(true);
  visibility.release.mockImplementationOnce(async () => { visible.clear(); throw new Error('1 of 1 window park operations failed'); });
  await expect(releaseIdentity('identity', { all: true })).rejects.toThrow();
  expect(session.headed).toBe(false);
});
