import { acquirePageLease, releasePageLease, setLeasedPage } from './page-lease.js';

function isLivePage(page) {
  try { return Boolean(page) && !page.isClosed?.(); }
  catch { return false; }
}

function takePendingSharedPage(session) {
  const pending = session.pendingSharedPages;
  if (!pending?.length) return null;
  while (pending.length > 0) {
    const page = pending.shift();
    if (isLivePage(page)) return page;
  }
  return null;
}

function queueLateSharedPage(session, page) {
  if (!isLivePage(page)) return;
  const pending = session.pendingSharedPages ||= [];
  if (!pending.includes(page)) pending.push(page);
}

function waitForAbort(signal) {
  if (!signal) return new Promise(() => {});
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

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
  function timeoutFor(label) {
    return typeof timeoutMs === 'function' ? timeoutMs(label) : timeoutMs;
  }

  async function createPage(targetSession, label) {
    signal?.throwIfAborted();

    const pendingSharedPage = targetSession.sharedIdentity && takePendingSharedPage(targetSession);
    if (pendingSharedPage) {
      const lease = acquirePageLease(targetSession);
      setLeasedPage(lease, pendingSharedPage);
      return { session: targetSession, page: pendingSharedPage, lease };
    }

    const lease = acquirePageLease(targetSession);
    let abandoned = false;
    let settled = false;
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
      settled = true;
      setLeasedPage(lease, page);
      if (abandoned || signal?.aborted) {
        if (targetSession.sharedIdentity && signal) {
          queueLateSharedPage(targetSession, page);
          releasePageLease(targetSession, lease);
        } else {
          void cleanup(page);
        }
      }
    }, () => {
      settled = true;
      if (abandoned) releasePageLease(targetSession, lease);
    });
    try {
      const page = await withTimeout(pending, timeoutFor(label), label);
      signal?.throwIfAborted();
      setLeasedPage(lease, page);
      return { session: targetSession, page, lease };
    } catch (err) {
      if (targetSession.sharedIdentity && signal && isTimeoutError(err)) {
        try {
          const page = await Promise.race([pending, waitForAbort(signal)]);
          signal.throwIfAborted();
          setLeasedPage(lease, page);
          return { session: targetSession, page, lease };
        } catch (waitErr) {
          abandoned = true;
          if (settled) releasePageLease(targetSession, lease);
          throw waitErr;
        }
      }

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
