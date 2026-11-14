import { jest } from '@jest/globals';
import fs from 'node:fs';
import vm from 'node:vm';
import { createDarwinIdentityVisibility } from '../../lib/darwin-identity-visibility.js';
import { createSharedIdentityWindowOpener } from '../../lib/shared-identity-window.js';
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
  const session = { sharedIdentity: true, visibility: { open, isVisible: () => true, capability: () => ({ mode: 'app-hidden' }) } };
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

function visibilityFixture({ timeoutMs = 20, prepare, beforeSetHidden } = {}) {
  let state = { hidden: true, active: false };
  const changes = [], move = jest.fn(async () => ({ onMain: true, number: 8, frontmost: true }));
  const visibility = createDarwinIdentityVisibility('/fixture/profile', {
    rootPid: 10, snapshot: () => [{ pid: 12, ppid: 10, args: '/engine/camoufox -profile /fixture/profile -juggler-pipe' }],
    timeoutMs, setHidden: async (_pid, hidden, options) => { beforeSetHidden?.(hidden); changes.push(hidden); return (state = { hidden, active: !hidden }); },
    readState: async () => state,
    createWindowControl: prepare || (async () => ({ open: move, close: async () => {} })),
  });
  return { visibility, changes, move };
}

for (const stalledStage of ['activation', 'addon']) {
  test(`a never-settling ${stalledStage} falls back to native visibility; later release and handoff still work`, async () => {
    let finish;
    const stalled = new Promise(resolve => { finish = resolve; });
    const f = visibilityFixture(stalledStage === 'addon' ? { prepare: () => stalled } : {});
    const page = { isClosed: () => false, bringToFront: () => stalled };
    try {
      expect(await f.visibility.open(page)).toMatchObject({ visible: true, focused: false, targetUnconfirmed: true });
      await f.visibility.release();
      expect(f.visibility.isVisible()).toBe(false);
      expect(await f.visibility.open(page, { nativeOnly: true })).toMatchObject({ visible: true, targetUnconfirmed: true });
      await f.visibility.release();
      finish({ open: f.move, close: async () => {} });
      await new Promise(resolve => setImmediate(resolve));
      expect(f.changes.at(-1)).toBe(true);
      expect(f.move).not.toHaveBeenCalled();
    } finally { finish({ open: f.move, close: async () => {} }); await f.visibility.close(); }
  });
}

test('native rescue fences an older activation and gives later operations a fresh queue', async () => {
  let finish;
  const stalled = new Promise(resolve => { finish = resolve; });
  const f = visibilityFixture({ timeoutMs: 1000 });
  const page = { isClosed: () => false, bringToFront: () => stalled };
  const old = f.visibility.open(page).catch(error => error);
  await new Promise(resolve => setImmediate(resolve));
  try {
    await f.visibility.open(page, { nativeOnly: true });
    await f.visibility.release();
    finish();
    expect(await old).toMatchObject({ code: 'request_timeout' });
    expect(f.visibility.isVisible()).toBe(false);
    expect(f.changes).toEqual([false, false, true]);
    expect(f.move).not.toHaveBeenCalled();
  } finally { finish(); await f.visibility.close(); }
});

test('identity open uses native rescue for busy input and reports unconfirmed target placement', async () => {
  const page = { isClosed: () => false };
  const f = visibilityFixture();
  const open = jest.spyOn(f.visibility, 'open');
  const session = { sharedIdentity: true, visibility: f.visibility,
    context: { pages: () => [page] }, lastUsedPage: page, tabGroups: new Map([['task', new Map([['A', { page }]])]]) };
  const opener = createSharedIdentityWindowOpener({ sessions: new Map([['identity', session]]),
    parkingEnabled: true, manager: {}, getSession: async () => session, isBusy: () => true, isInputBusy: () => true,
    registerPage: () => 'A' });
  try {
    expect(await opener.openWindow('identity', 'A')).toMatchObject({ ok: true, visible: true, focused: false,
      targetUnconfirmed: true, operationMayStillBeRunning: true, tabId: 'A', restarted: false });
    expect(open).toHaveBeenCalledWith(page, { nativeOnly: true });
  } finally { await f.visibility.close(); }
});
