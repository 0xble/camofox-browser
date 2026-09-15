import { jest } from '@jest/globals';
import { withRequestDeadline } from '../../lib/request-deadline.js';
import { createPageWithSessionRecovery } from '../../lib/new-page-recovery.js';

test('aborts pending page creation and cleans up a late page without reopening the shared session', async () => {
  let resolvePage;
  const pending = new Promise(resolve => { resolvePage = resolve; });
  const session = { sharedIdentity: true, context: { newPage: () => pending } };
  const closePage = jest.fn(async () => {});
  const destroySession = jest.fn();
  const registerPage = jest.fn();
  const operation = withRequestDeadline(async signal => {
    const result = await createPageWithSessionRecovery({
      session, signal, userId: 'shared', timeoutMs: 1000,
      withTimeout: promise => promise, isTimeoutError: () => true, isDeadContextError: () => false,
      currentSession: () => session, destroySession, getSession: jest.fn(), log: jest.fn(), closePage,
    });
    registerPage(result.page);
  }, 5, 'tab create');
  await expect(operation).rejects.toMatchObject({ code: 'request_timeout', statusCode: 503 });
  const page = { id: 'late' };
  resolvePage(page);
  await new Promise(resolve => setImmediate(resolve));
  expect(closePage).toHaveBeenCalledWith(session, page);
  expect(closePage).toHaveBeenCalledTimes(1);
  expect(registerPage).not.toHaveBeenCalled();
  expect(destroySession).not.toHaveBeenCalled();
});

test('cancels a page already navigating before reporting timeout', async () => {
  const closePage = jest.fn();
  let completeNavigation;
  const navigation = new Promise(resolve => { completeNavigation = resolve; });
  const publish = jest.fn();
  const operation = withRequestDeadline(async signal => {
    signal.addEventListener('abort', closePage, { once: true });
    await navigation;
    signal.throwIfAborted();
    publish();
  }, 5, 'tab create');
  await expect(operation).rejects.toMatchObject({ code: 'request_timeout' });
  expect(closePage).toHaveBeenCalledTimes(1);
  completeNavigation();
  await new Promise(resolve => setImmediate(resolve));
  expect(publish).not.toHaveBeenCalled();
});

test('clears the deadline after a successful request', async () => {
  const onAbort = jest.fn();
  await expect(withRequestDeadline(async signal => {
    signal.addEventListener('abort', onAbort);
    return 42;
  }, 5, 'tab create')).resolves.toBe(42);
  await new Promise(resolve => setTimeout(resolve, 10));
  expect(onAbort).not.toHaveBeenCalled();
});
