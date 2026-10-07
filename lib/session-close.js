// Several timers (session expiry, the tab reaper, memory pressure) can pick the
// same session in one tick. Every caller must share one teardown so the
// pre-close persistence checkpoint runs exactly once, before the context closes.
const closePromises = new WeakMap();

export function closeSessionOnce(session, teardown) {
  if (!session) return Promise.resolve();
  const existing = closePromises.get(session);
  if (existing) return existing;
  const promise = Promise.resolve().then(teardown);
  closePromises.set(session, promise);
  // A failed close (for example an aborted headed transition) leaves the
  // session live, so a later caller must be able to retry it. Cleanup timers
  // set _closing before calling and skip sessions that have it, so clear it
  // too or the session would never be reclaimed.
  promise.catch(() => {
    if (closePromises.get(session) !== promise) return;
    closePromises.delete(session);
    session._closing = false;
  });
  return promise;
}
