import { describe, expect, jest, test } from '@jest/globals';
import { createPageWithSessionRecovery } from '../../lib/new-page-recovery.js';

const isTimeoutError = err => err.code === 'timeout';
const isDeadContextError = err => err.code === 'dead_context';
const withTimeout = promise => promise;
const log = jest.fn();

function recoveryOptions(overrides) {
  return {
    userId: 'user-1',
    trace: false,
    timeoutMs: 10000,
    withTimeout,
    isTimeoutError,
    isDeadContextError,
    log,
    ...overrides,
  };
}

describe('createPageWithSessionRecovery', () => {
  test('does not reopen a session after the caller cancels during recovery', async () => {
    const controller = new AbortController();
    const expired = new Error('request expired');
    const timeoutError = Object.assign(new Error('new page timed out'), { code: 'timeout' });
    const session = { context: { newPage: jest.fn().mockRejectedValue(timeoutError) } };
    const getSession = jest.fn(async () => ({ context: { newPage: async () => ({}) } }));
    await expect(createPageWithSessionRecovery(recoveryOptions({
      session, signal: controller.signal, currentSession: () => session,
      destroySession: async () => controller.abort(expired), getSession,
    }))).rejects.toBe(expired);
    expect(getSession).not.toHaveBeenCalled();
  });

  test('closes a page that arrives after its creation deadline', async () => {
    let resolvePage;
    const pendingPage = new Promise(resolve => { resolvePage = resolve; });
    const timeoutError = Object.assign(new Error('new page timed out'), { code: 'timeout' });
    const session = { sharedIdentity: true, context: { newPage: () => pendingPage } };
    const closePage = jest.fn(async () => {});
    await expect(createPageWithSessionRecovery(recoveryOptions({
      session, currentSession: () => session, destroySession: jest.fn(), getSession: jest.fn(),
      withTimeout: promise => Promise.race([promise, Promise.reject(timeoutError)]), closePage,
    }))).rejects.toBe(timeoutError);
    const page = { id: 'late-page' };
    resolvePage(page);
    await new Promise(resolve => setImmediate(resolve));
    expect(closePage).toHaveBeenCalledTimes(1);
    expect(closePage).toHaveBeenCalledWith(session, page);
    expect(session.pageLeases.size).toBe(0);
  });

  test('shared page creation can outlive the fixed inner timeout while the request remains active', async () => {
    const timeoutError = Object.assign(new Error('new page timed out'), { code: 'timeout' });
    const page = { id: 'slow-shared-page' };
    const session = { sharedIdentity: true, context: { newPage: jest.fn().mockResolvedValue(page) } };

    const result = await createPageWithSessionRecovery(recoveryOptions({
      session,
      signal: new AbortController().signal,
      currentSession: () => session,
      destroySession: jest.fn(),
      getSession: jest.fn(),
      withTimeout: jest.fn().mockRejectedValue(timeoutError),
    }));

    expect(result.page).toBe(page);
    expect(result.session).toBe(session);
  });

  test('keeps a late shared page for the next request instead of closing it', async () => {
    let resolvePage;
    const pendingPage = new Promise(resolve => { resolvePage = resolve; });
    const timeoutError = Object.assign(new Error('new page timed out'), { code: 'timeout' });
    const expired = Object.assign(new Error('tab create timed out'), { code: 'request_timeout' });
    const session = { sharedIdentity: true, context: { newPage: jest.fn(() => pendingPage) } };
    const controller = new AbortController();

    const first = createPageWithSessionRecovery(recoveryOptions({
      session,
      signal: controller.signal,
      currentSession: () => session,
      destroySession: jest.fn(),
      getSession: jest.fn(),
      withTimeout: jest.fn().mockRejectedValue(timeoutError),
    }));
    await new Promise(resolve => setImmediate(resolve));
    controller.abort(expired);
    await expect(first).rejects.toBe(expired);

    const page = { id: 'late-shared-page', close: jest.fn() };
    resolvePage(page);
    await new Promise(resolve => setImmediate(resolve));

    const next = await createPageWithSessionRecovery(recoveryOptions({
      session,
      signal: new AbortController().signal,
      currentSession: () => session,
      destroySession: jest.fn(),
      getSession: jest.fn(),
      withTimeout: jest.fn(() => { throw new Error('newPage should not be called'); }),
    }));

    expect(next.page).toBe(page);
    expect(page.close).not.toHaveBeenCalled();
    expect(session.context.newPage).toHaveBeenCalledTimes(1);
  });

  test('preserves other tabs when a shared identity cannot create a page', async () => {
    const timeoutError = Object.assign(new Error('new page timed out'), { code: 'timeout' });
    const existingPage = { id: 'other-task-page' };
    const session = { sharedIdentity: true, context: { newPage: jest.fn().mockRejectedValue(timeoutError) },
      tabGroups: new Map([['other-task', new Map([['existing', { page: existingPage }]])]]) };
    const destroySession = jest.fn();
    const getSession = jest.fn(async () => session);

    await expect(createPageWithSessionRecovery(recoveryOptions({
      session, currentSession: () => session, destroySession, getSession,
    }))).rejects.toBe(timeoutError);

    expect(destroySession).not.toHaveBeenCalled();
    expect(getSession).not.toHaveBeenCalled();
    expect(session.tabGroups.get('other-task').get('existing').page).toBe(existingPage);
    expect(session.pageLeases.size).toBe(0);
  });

  test('replaces an unresponsive session and succeeds on one retry', async () => {
    const timeoutError = Object.assign(new Error('new page timed out'), { code: 'timeout' });
    const oldSession = { context: { newPage: jest.fn().mockRejectedValue(timeoutError) } };
    const page = { id: 'fresh-page' };
    const replacement = { context: { newPage: jest.fn().mockResolvedValue(page) } };
    let mappedSession = oldSession;
    const destroySession = jest.fn(async () => { mappedSession = null; });
    const getSession = jest.fn(async () => replacement);

    const result = await createPageWithSessionRecovery(recoveryOptions({
      session: oldSession,
      currentSession: () => mappedSession,
      destroySession,
      getSession,
    }));

    expect(destroySession).toHaveBeenCalledWith('user-1', { reason: 'new_page_unresponsive' });
    expect(getSession).toHaveBeenCalledWith('user-1', { trace: false });
    expect(result).toMatchObject({ session: replacement, page });
    expect(result.lease).toMatchObject({ page, released: false });
  });

  test('does not destroy a session another request already replaced', async () => {
    const deadError = Object.assign(new Error('context closed'), { code: 'dead_context' });
    const oldSession = { context: { newPage: jest.fn().mockRejectedValue(deadError) } };
    const replacement = { context: { newPage: jest.fn().mockResolvedValue({ id: 'page' }) } };
    const destroySession = jest.fn();

    await createPageWithSessionRecovery(recoveryOptions({
      session: oldSession,
      currentSession: () => replacement,
      destroySession,
      getSession: async () => replacement,
    }));

    expect(destroySession).not.toHaveBeenCalled();
  });

  test('retries only once', async () => {
    const timeoutError = Object.assign(new Error('new page timed out'), { code: 'timeout' });
    const oldSession = { context: { newPage: jest.fn().mockRejectedValue(timeoutError) } };
    const replacement = { context: { newPage: jest.fn().mockRejectedValue(timeoutError) } };

    await expect(createPageWithSessionRecovery(recoveryOptions({
      session: oldSession,
      currentSession: () => oldSession,
      destroySession: async () => {},
      getSession: async () => replacement,
    }))).rejects.toThrow('new page timed out');

    expect(oldSession.context.newPage).toHaveBeenCalledTimes(1);
    expect(replacement.context.newPage).toHaveBeenCalledTimes(1);
  });

  test('resolves a separate timeout for the recovery retry', async () => {
    const timeoutError = Object.assign(new Error('new page timed out'), { code: 'timeout' });
    const first = { context: { newPage: jest.fn().mockRejectedValue(timeoutError) } };
    const page = { id: 'retry-page' };
    const replacement = { context: { newPage: jest.fn().mockResolvedValue(page) } };
    const timeoutCalls = [];

    const result = await createPageWithSessionRecovery(recoveryOptions({
      session: first,
      timeoutMs: label => label === 'new page retry' ? 23_000 : 10_000,
      withTimeout: (promise, ms, label) => {
        timeoutCalls.push({ ms, label });
        return promise;
      },
      currentSession: () => first,
      destroySession: jest.fn(),
      getSession: jest.fn(async () => replacement),
    }));

    expect(result.page).toBe(page);
    expect(timeoutCalls).toEqual([
      { ms: 10_000, label: 'new page' },
      { ms: 23_000, label: 'new page retry' },
    ]);
  });

  test('does not recover unrelated failures', async () => {
    const error = new Error('programming error');
    const session = { context: { newPage: jest.fn().mockRejectedValue(error) } };
    const destroySession = jest.fn();

    await expect(createPageWithSessionRecovery(recoveryOptions({
      session,
      currentSession: () => session,
      destroySession,
      getSession: jest.fn(),
    }))).rejects.toBe(error);

    expect(destroySession).not.toHaveBeenCalled();
  });
});
