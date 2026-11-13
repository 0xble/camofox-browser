import { jest } from '@jest/globals';
import fs from 'node:fs';
import vm from 'node:vm';
import { createDarwinIdentityVisibility } from '../../lib/darwin-identity-visibility.js';
import { applySharedTabHandoff } from '../../lib/shared-tab-handoff.js';

const source = fs.readFileSync(new URL('../../server.js', import.meta.url), 'utf8');

function handoffRoute(deps) {
  let handler;
  const start = source.indexOf("app.post('/tabs/:tabId/handoff'");
  const end = source.indexOf('\n});', start) + 5;
  vm.runInNewContext(source.slice(start, end), { app: { post: (_path, fn) => { handler = fn; } }, ...deps });
  return handler;
}

test('human handoff shows a busy tab without acquiring its input lock', async () => {
  const human = new Set();
  const page = { isClosed: () => false };
  const tabState = { page };
  const open = jest.fn(async () => {
    expect(human.has('A')).toBe(true); // recovery cannot retire the tab while showing it
    return { visible: true, focused: false, targetUnconfirmed: true };
  });
  const session = { sharedIdentity: true, visibility: { open, isVisible: () => true } };
  const withTabLock = jest.fn(async () => { throw Object.assign(new Error('busy'), { statusCode: 503 }); });
  const handler = handoffRoute({
    normalizeUserId: String, sessions: new Map([['identity', session]]), findTab: () => ({ tabState }),
    tabLocks: new Map([['A', { active: true, settling: true }]]), humanControlledTabs: human,
    withTabLock, HANDLER_TIMEOUT_MS: 20, applySharedTabHandoff, armAbandonedTabRecovery() {}, log() {},
    handleRouteError: (err, _req, res) => res.status(err.statusCode || 500).json({ error: err.message }),
  });
  const res = { status: jest.fn(() => res), json: jest.fn(() => res) };
  await handler({ params: { tabId: 'A' }, body: { userId: 'identity', handoff: 'human' } }, res);
  expect(res.status).not.toHaveBeenCalled();
  expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ ok: true, handoff: 'human', visible: true, targetUnconfirmed: true }));
  expect(withTabLock).not.toHaveBeenCalled();
  expect(open).toHaveBeenCalledWith(page, { nativeOnly: true });
});

test('native-only handoff unhides the identity without waiting on Juggler or moving an unconfirmed window', async () => {
  let state = { hidden: true, active: false };
  const focus = jest.fn(async () => {}), move = jest.fn(async () => ({ onMain: true, frontmost: true }));
  const visibility = createDarwinIdentityVisibility('/fixture/profile', {
    rootPid: 10, snapshot: () => [{ pid: 12, ppid: 10, args: '/engine/camoufox -profile /fixture/profile -juggler-pipe' }],
    setHidden: async (_pid, hidden) => (state = { hidden, active: !hidden }), readState: async () => state,
    createWindowControl: async () => ({ open: move, close: async () => {} }),
  });
  try {
    const shown = await visibility.open({ bringToFront: focus }, { nativeOnly: true });
    expect(shown).toMatchObject({ visible: true, focused: false, targetUnconfirmed: true });
    expect(state.hidden).toBe(false);
    expect(focus).not.toHaveBeenCalled();
    expect(move).not.toHaveBeenCalled();
  } finally { await visibility.close(); }
});

test('failed human visibility restores agent control instead of claiming a handoff', async () => {
  const human = new Set();
  await expect(applySharedTabHandoff({ tabId: 'A', handoff: 'human',
    tabState: { page: { isClosed: () => false } }, humanControlledTabs: human,
    session: { visibility: { open: async () => { expect(human.has('A')).toBe(true); throw new Error('native unavailable'); }, isVisible: () => false } },
  })).rejects.toThrow('native unavailable');
  expect(human.has('A')).toBe(false);
});
