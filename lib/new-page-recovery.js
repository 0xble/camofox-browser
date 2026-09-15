import { acquirePageLease, releasePageLease, setLeasedPage } from './page-lease.js';

export async function createPageWithSessionRecovery({
  userId,
  session,
  trace = false,
  timeoutMs,
  withTimeout,
  isTimeoutError,
  isDeadContextError,
  currentSession,
  destroySession,
  getSession,
  log,
  signal,
  closePage = async (_session, page) => page.close({ runBeforeUnload: false }),
}) {
  async function createPage(targetSession, label) {
    signal?.throwIfAborted();
    const lease = acquirePageLease(targetSession);
    let abandoned = false;
    let cleanupStarted = false;
    const cleanup = async page => {
      if (cleanupStarted) return;
      cleanupStarted = true;
      try { await closePage(targetSession, page); }
      catch (err) { log('warn', 'late page cleanup failed', { userId, error: err.message }); }
    };
    const pending = Promise.resolve().then(() => {
      signal?.throwIfAborted();
      return targetSession.context.newPage();
    });
    pending.then(page => {
      setLeasedPage(lease, page);
      if (abandoned || signal?.aborted) return cleanup(page);
    }, () => {});
    try {
      const page = await withTimeout(pending, timeoutMs, label);
      signal?.throwIfAborted();
      setLeasedPage(lease, page);
      return { session: targetSession, page, lease };
    } catch (err) {
      abandoned = true;
      releasePageLease(targetSession, lease);
      if (lease.page) void cleanup(lease.page);
      throw err;
    }
  }

  try {
    return await createPage(session, 'new page');
  } catch (err) {
    signal?.throwIfAborted();
    if (!isTimeoutError(err) && !isDeadContextError(err)) throw err;

    // A shared profile belongs to other tasks and human tabs too. A failed
    // newPage call is not evidence that those pages need to be destroyed.
    if (session.sharedIdentity) {
      throw Object.assign(err, { code: 'shared_page_unavailable', statusCode: 503 });
    }

    log('warn', 'new page failed, recreating user session', {
      userId,
      error: err.message,
    });

    // Another request may already have replaced this session. Never tear down
    // a newer healthy context while recovering the one that failed.
    if (currentSession() === session) {
      await destroySession(userId, { reason: 'new_page_unresponsive' });
    }

    signal?.throwIfAborted();
    session = await getSession(userId, { trace });
    return createPage(session, 'new page retry');
  }
}
