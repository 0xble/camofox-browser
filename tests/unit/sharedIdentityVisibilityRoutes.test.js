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
  expect(transitionIdentity.mock.calls[0][3]).toEqual({ coalesceKey: 'B' });
});
