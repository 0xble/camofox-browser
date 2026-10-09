/**
 * Regression: an expired session whose page spins a CPU-bound script.
 *
 * Production (2026-10-09) logged `session expired` for hermes_51df174154 at
 * 01:57:20Z but no `storage state persisted` and no close. The teardown awaited
 * the persistence checkpoint (which evaluates in every page) and then
 * context.close(), both unbounded, so the hung page kept the session and its
 * tab registered for 43 minutes. Every teardown step is now bounded and the
 * session always leaves the registry.
 */
import { describe, test, expect, jest } from '@jest/globals';
import { createPluginEvents } from '../../lib/plugins.js';
import { closeContextBounded, closeSessionOnce, settleWithin, teardownEphemeralSession, abandonedContexts, reapAbandonedContexts } from '../../lib/session-close.js';

const never = () => new Promise(() => {});

function fakePage({ hangs = false } = {}) {
  let closed = false;
  return {
    isClosed: () => closed,
    close: jest.fn(async () => { if (hangs) return never(); closed = true; }),
  };
}

function fakeContext(pages, { hangs = true } = {}) {
  return { pages: () => pages, close: jest.fn(async () => (hangs ? never() : undefined)) };
}

function fakeSession(context, tabIds) {
  const group = new Map(tabIds.map((tabId, i) => [tabId, { page: context.pages()[i] }]));
  return { context, tabGroups: new Map([['task_1', group]]) };
}

describe('bounded session close', () => {
  afterEach(() => abandonedContexts.clear());

  test('a context.close that never resolves still removes the session and its tabs within the bound', async () => {
    const hung = fakePage({ hangs: true });
    const healthy = fakePage();
    const context = fakeContext([hung, healthy]);
    const session = fakeSession(context, ['tab-hung', 'tab-ok']);
    const sessions = new Map([['hermes_1', session]]);
    const events = createPluginEvents();
    const destroyed = jest.fn();
    events.on('session:destroyed', destroyed);
    const log = jest.fn();

    const started = Date.now();
    await closeSessionOnce(session, () => teardownEphemeralSession({
      userId: 'hermes_1', session, sessions, reason: 'session_timeout', events, log,
      timeoutMs: 50, pageTimeoutMs: 20,
    }));
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(1000);
    expect(sessions.has('hermes_1')).toBe(false);
    expect(session.tabGroups.size).toBe(0);
    expect(context.close).toHaveBeenCalledTimes(1);
    expect(hung.close).toHaveBeenCalledWith({ runBeforeUnload: false });
    expect(healthy.isClosed()).toBe(true);
    expect(destroyed).toHaveBeenCalledWith({ userId: 'hermes_1', reason: 'session_timeout' });
    expect(log).toHaveBeenCalledWith('warn', 'session context close timed out; closed pages individually',
      expect.objectContaining({ userId: 'hermes_1', reason: 'session_timeout' }));
  });

  test('a timed-out context stays abandoned until a later sweep closes it', async () => {
    let closeCalls = 0;
    const context = {
      pages: () => [],
      close: jest.fn(async () => {
        closeCalls += 1;
        if (closeCalls === 1) return never();
      }),
    };
    const session = fakeSession(context, []);
    const sessions = new Map([['hermes_retry', session]]);
    const events = createPluginEvents();

    await teardownEphemeralSession({
      userId: 'hermes_retry', session, sessions, reason: 'session_timeout', events,
      timeoutMs: 20, pageTimeoutMs: 10,
    });
    expect(abandonedContexts.has(context)).toBe(true);

    await reapAbandonedContexts({ timeoutMs: 20 });
    expect(closeCalls).toBe(2);
    expect(abandonedContexts.has(context)).toBe(false);
  });

  test('a checkpoint that never finishes (hung page evaluate) does not block close', async () => {
    const context = fakeContext([fakePage()], { hangs: false });
    const session = fakeSession(context, ['tab-1']);
    const sessions = new Map([['hermes_2', session]]);
    const events = createPluginEvents();
    events.on('session:destroying', never);
    const log = jest.fn();

    await teardownEphemeralSession({
      userId: 'hermes_2', session, sessions, reason: 'session_timeout', events, log, timeoutMs: 50, pageTimeoutMs: 20,
    });

    expect(context.close).toHaveBeenCalledTimes(1);
    expect(sessions.has('hermes_2')).toBe(false);
    expect(log).toHaveBeenCalledWith('warn', 'session close step timed out',
      expect.objectContaining({ userId: 'hermes_2', step: 'session:destroying' }));
  });

  test('a prompt close keeps the normal order and logs nothing', async () => {
    const order = [];
    const context = { pages: () => [], close: jest.fn(async () => { order.push('close'); }) };
    const session = fakeSession(context, []);
    const sessions = new Map([['u', session]]);
    const events = createPluginEvents();
    events.on('session:destroying', async () => { order.push('destroying'); });
    events.on('session:destroyed', async () => { order.push('destroyed'); });
    const log = jest.fn();
    await teardownEphemeralSession({ userId: 'u', session, sessions, reason: 'r', events, log });
    expect(order).toEqual(['destroying', 'close', 'destroyed']);
    expect(log).not.toHaveBeenCalled();
    expect(sessions.size).toBe(0);
  });

  test('closeContextBounded reports success when the context closes in time', async () => {
    await expect(closeContextBounded(fakeContext([], { hangs: false }), { timeoutMs: 50 })).resolves.toBe(true);
  });

  test('settleWithin never rejects', async () => {
    await expect(settleWithin(async () => { throw new Error('x'); }, 50)).resolves.toBe(true);
    await expect(settleWithin(() => { throw new Error('sync'); }, 50)).resolves.toBe(true);
    await expect(settleWithin(never, 10)).resolves.toBe(false);
  });
});
