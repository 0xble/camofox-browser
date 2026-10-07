/**
 * Regression: two cleanup timers closing the same session.
 *
 * Production logged "failed to persist storage state ... has been closed"
 * after every idle expiry: the session-expiry timer and the tab reaper both
 * called closeSession() for the same session in one tick. The second call
 * emitted session:destroying again, and its checkpoint ran after the first
 * call had already closed the context. closeSessionOnce makes every caller
 * share the first teardown, so persistence checkpoints once, before close.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { jest } from '@jest/globals';
import { createPluginEvents } from '../../lib/plugins.js';
import { closeSessionOnce } from '../../lib/session-close.js';
import { register } from '../../plugins/persistence/index.js';

function liveContext() {
  let closed = false;
  return {
    get closed() { return closed; },
    storageState: jest.fn(async ({ path: target }) => {
      // Let the competing caller run while this checkpoint is in flight.
      await new Promise(resolve => setTimeout(resolve, 20));
      if (closed) throw new Error('browserContext.storageState: Target page, context or browser has been closed');
      await fs.writeFile(target, JSON.stringify({ cookies: [], origins: [] }));
    }),
    close: jest.fn(async () => { closed = true; }),
  };
}

describe('closeSessionOnce', () => {
  let tmpDir;
  let events;
  let log;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'camofox-close-once-'));
    events = createPluginEvents();
    log = jest.fn();
    await register({ delete: jest.fn() }, {
      events, log, config: { cookiesDir: path.join(tmpDir, 'cookies') },
      auth: () => (req, res, next) => next(), normalizeUserId: String, safeError: e => e.message,
      destroySession: jest.fn(),
    }, { profileDir: tmpDir });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // Mirrors closeSessionNow's ordering for an ephemeral context.
  const teardown = (userId, session, reason) => async () => {
    await events.emitAsync('session:destroying', { userId, reason });
    await session.context.close();
    await events.emitAsync('session:destroyed', { userId, reason });
  };

  test('expiry and the tab reaper share one checkpoint taken before close', async () => {
    const userId = 'hermes_race';
    const session = { context: liveContext() };
    await events.emitAsync('session:created', { userId, context: session.context });

    const expiry = closeSessionOnce(session, teardown(userId, session, 'session_timeout'));
    const reaper = closeSessionOnce(session, teardown(userId, session, 'tab_reaper_empty_session'));
    expect(reaper).toBe(expiry);
    await Promise.all([expiry, reaper]);

    expect(session.context.storageState).toHaveBeenCalledTimes(1);
    expect(session.context.close).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith('info', 'storage state persisted', expect.objectContaining({ userId, reason: 'session_timeout' }));
    expect(log).not.toHaveBeenCalledWith('warn', 'failed to persist storage state', expect.anything());
  });

  test('without the shared teardown the second checkpoint fails after close (the old bug)', async () => {
    const userId = 'hermes_race_old';
    const session = { context: liveContext() };
    await events.emitAsync('session:created', { userId, context: session.context });

    await Promise.all([
      teardown(userId, session, 'session_timeout')(),
      teardown(userId, session, 'tab_reaper_empty_session')(),
    ]);
    expect(log).toHaveBeenCalledWith('warn', 'failed to persist storage state', expect.objectContaining({ userId }));
  });

  test('a rejected close can be retried by a later caller', async () => {
    const session = {};
    const failure = new Error('cookie snapshot failed');
    await expect(closeSessionOnce(session, async () => { throw failure; })).rejects.toBe(failure);
    const retry = jest.fn(async () => 'closed');
    await expect(closeSessionOnce(session, retry)).resolves.toBe('closed');
    expect(retry).toHaveBeenCalledTimes(1);
  });

  test('a failed timer close clears _closing so the next timer pass retries it', async () => {
    // Timers mark the session and skip marked sessions; a stuck mark leaked it.
    const session = { _closing: true };
    await expect(closeSessionOnce(session, async () => { throw new Error('close failed'); })).rejects.toThrow('close failed');
    expect(session._closing).toBe(false);
  });

  test('a successful close keeps _closing set', async () => {
    const session = { _closing: true };
    await closeSessionOnce(session, async () => {});
    expect(session._closing).toBe(true);
  });
});
