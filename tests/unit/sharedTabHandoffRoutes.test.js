import { jest } from '@jest/globals';
import fs from 'node:fs';
import vm from 'node:vm';
import { applySharedTabHandoff } from '../../lib/shared-tab-handoff.js';

const source = fs.readFileSync(new URL('../../server.js', import.meta.url), 'utf8');
function response() {
  const res = { status: jest.fn(() => res), json: jest.fn(() => res) };
  return res;
}
function fixture({ parked = true, visibleOther = false, handoff = 'agent' } = {}) {
  const page = { isClosed: () => false, bringToFront: jest.fn(async () => {}) };
  const tabState = { page, handoff };
  const humanControlledTabs = new Set(handoff === 'human' ? ['B'] : []);
  const visible = new Map(visibleOther ? [[1, { windowId: 1 }]] : []);
  if (handoff === 'human') visible.set(2, { windowId: 2 });
  const visibility = {
    visible,
    open: jest.fn(async target => { expect(target).toBe(page); visible.set(2, { windowId: 2 }); }),
    release: jest.fn(async ({ page: target, all }) => { expect(target).toBe(page); expect(all).toBe(false); visible.delete(2); return true; }),
  };
  const session = { sharedIdentity: true, headed: visible.size > 0, ...(parked ? { visibility } : {}) };
  let handler;
  const log = jest.fn();
  const withTabLock = jest.fn(async (_id, operation) => operation());
  const start = source.indexOf("app.post('/tabs/:tabId/handoff'");
  const end = source.indexOf('\n});', start) + 5;
  vm.runInNewContext(source.slice(start, end), {
    app: { post: (_path, fn) => { handler = fn; } }, normalizeUserId: String,
    sessions: new Map([['identity', session]]), findTab: (_session, id) => id === 'B' ? { tabState } : null,
    tabNotFoundResponse: res => res.status(404).json({ error: 'Tab not found' }),
    withTabLock, HANDLER_TIMEOUT_MS: 1000, applySharedTabHandoff, humanControlledTabs, log,
    handleRouteError: (err, _req, res) => res.status(err.statusCode || 500).json({ error: err.message }),
  });
  const request = async (value, res = response()) => {
    await handler({ params: { tabId: 'B' }, body: { userId: 'identity', handoff: value } }, res);
    return res;
  };
  return { request, handler, session, visibility, page, tabState, humanControlledTabs, log };
}

test('parked human handoff moves the requested window even with another window visible', async () => {
  const f = fixture({ visibleOther: true });
  const res = await f.request('human');
  expect(f.visibility.open).toHaveBeenCalledTimes(1);
  expect(f.visibility.open).toHaveBeenCalledWith(f.page);
  expect(f.page.bringToFront).not.toHaveBeenCalled();
  expect(res.status).not.toHaveBeenCalled();
  expect(res.json).toHaveBeenCalledWith({ ok: true, handoff: 'human', focused: true });
  expect([...f.visibility.visible.keys()]).toEqual([1, 2]);
  expect(f.session.headed).toBe(true);
  expect(f.humanControlledTabs.has('B')).toBe(true);
  expect(f.tabState.handoff).toBe('human');
});

test('focused:true is withheld until the visibility move completes', async () => {
  const f = fixture();
  let complete, started;
  const moving = new Promise(resolve => { started = resolve; });
  f.visibility.open.mockImplementation(async () => { started(); await new Promise(resolve => { complete = resolve; }); f.visibility.visible.set(2, {}); });
  const res = response();
  const pending = f.request('human', res);
  await Promise.race([moving, pending]);
  expect(f.visibility.open).toHaveBeenCalledTimes(1);
  expect(res.json).not.toHaveBeenCalled();
  expect(f.session.headed).toBe(false);
  complete();
  await pending;
  expect(res.json).toHaveBeenCalledWith({ ok: true, handoff: 'human', focused: true });
  expect(f.session.headed).toBe(true);
});

test('failed human move reports error and retains agent control', async () => {
  const f = fixture();
  f.visibility.open.mockRejectedValueOnce(new Error('move failed'));
  const res = await f.request('human');
  expect(res.status).toHaveBeenCalledWith(500);
  expect(res.json).toHaveBeenCalledWith({ error: 'move failed' });
  expect(f.humanControlledTabs.has('B')).toBe(false);
  expect(f.tabState.handoff).toBe('agent');
  expect(f.session.headed).toBe(false);
});

test.each([false, true])('agent return parks only this tab and recomputes headed (other visible=%s)', async visibleOther => {
  const f = fixture({ visibleOther, handoff: 'human' });
  const res = await f.request('agent');
  expect(f.visibility.release).toHaveBeenCalledWith({ all: false, page: f.page });
  expect(res.json).toHaveBeenCalledWith({ ok: true, handoff: 'agent', focused: false });
  expect(f.visibility.visible.has(2)).toBe(false);
  expect(f.session.headed).toBe(visibleOther);
  expect(f.humanControlledTabs.has('B')).toBe(false);
  expect(f.tabState.handoff).toBe('agent');
  expect(f.page.bringToFront).not.toHaveBeenCalled();
});

test('failed park still returns agent control, logs, and reports parked:false with live visibility', async () => {
  const f = fixture({ handoff: 'human' });
  f.visibility.release.mockImplementationOnce(async () => { f.visibility.visible.clear(); throw new Error('park failed'); });
  const res = await f.request('agent');
  expect(res.status).not.toHaveBeenCalled();
  expect(res.json).toHaveBeenCalledWith({ ok: true, handoff: 'agent', focused: false, parked: false, reason: 'park failed' });
  expect(f.humanControlledTabs.has('B')).toBe(false);
  expect(f.tabState.handoff).toBe('agent');
  expect(f.session.headed).toBe(false);
  expect(f.log).toHaveBeenCalledWith('warn', 'agent handoff park failed; agent control returned', { tabId: 'B', error: 'park failed' });
  // The tab is not stuck: a later agent return succeeds normally.
  expect((await f.request('agent')).json).toHaveBeenCalledWith({ ok: true, handoff: 'agent', focused: false });
});

test('legacy handoff still brings the page forward and agent return does not park', async () => {
  const f = fixture({ parked: false });
  expect((await f.request('human')).json).toHaveBeenCalledWith({ ok: true, handoff: 'human', focused: true });
  expect(f.page.bringToFront).toHaveBeenCalledTimes(1);
  expect((await f.request('agent')).json).toHaveBeenCalledWith({ ok: true, handoff: 'agent', focused: false });
  expect(f.visibility.open).not.toHaveBeenCalled();
  expect(f.visibility.release).not.toHaveBeenCalled();
});
