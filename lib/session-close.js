// Contexts whose close timed out remain here until a later 60s sweep confirms
// that the browser accepted a retry. The context is intentionally retained even
// after its session bookkeeping is gone so a hung close is still recoverable.
export const abandonedContexts = new Set();
const abandonedContextMeta = new Map();

export function rememberAbandonedContext(context, userId, log = () => {}) {
  abandonedContexts.add(context);
  abandonedContextMeta.set(context, { userId, retries: 0, log });
}

export async function reapAbandonedContexts({
  timeoutMs = SESSION_CLOSE_STEP_TIMEOUT_MS,
  log = () => {},
} = {}) {
  for (const context of [...abandonedContexts]) {
    const meta = abandonedContextMeta.get(context) || { userId: 'unknown', retries: 0 };
    meta.retries += 1;
    abandonedContextMeta.set(context, meta);
    log('warn', 'retrying abandoned browser context close', {
      userId: meta.userId, retry: meta.retries, timeoutMs,
    });
    if (await settleWithin(() => context.close(), timeoutMs)) {
      abandonedContexts.delete(context);
      abandonedContextMeta.delete(context);
      continue;
    }
    if (meta.retries >= 3) {
      log('error', 'abandoned browser context close still failing', {
        userId: meta.userId, retries: meta.retries, timeoutMs,
      });
    }
  }
}



// A page spinning a CPU-bound script never answers the protocol, so the
// checkpoint evaluate, context.close() and page.close() can all hang forever.
// Every teardown step is bounded so a hung page cannot keep a session or its
// tabs registered.
export const SESSION_CLOSE_STEP_TIMEOUT_MS = 10_000;
export const PAGE_CLOSE_FALLBACK_TIMEOUT_MS = 2_000;

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

// Resolves true when work settles (either way) within ms, false on timeout.
// Never rejects. The work keeps running after a timeout; callers move on.
export function settleWithin(work, ms) {
  let timer;
  const settled = Promise.resolve().then(work).then(() => true, () => true);
  const expired = new Promise(resolve => {
    timer = setTimeout(resolve, ms, false);
    timer.unref?.();
  });
  return Promise.race([settled, expired]).finally(() => clearTimeout(timer));
}

// Returns true if the context closed within the bound. Otherwise closes each
// page with its own bound, which tears down the tabs of a hung context.
export async function closeContextBounded(context, {
  timeoutMs = SESSION_CLOSE_STEP_TIMEOUT_MS,
  pageTimeoutMs = PAGE_CLOSE_FALLBACK_TIMEOUT_MS,
} = {}) {
  if (await settleWithin(() => context.close(), timeoutMs)) return true;
  let pages = [];
  try { pages = context.pages(); } catch { /* context already gone */ }
  await Promise.all(pages.map(page => settleWithin(() => page.close({ runBeforeUnload: false }), pageTimeoutMs)));
  return false;
}

// Teardown of an ephemeral (non-shared) session. Bookkeeping is dropped even
// when a step times out, so the session and its tabs always leave the registry.
export async function teardownEphemeralSession({
  userId, session, sessions, reason, events, beforeClose, log = () => {},
  timeoutMs = SESSION_CLOSE_STEP_TIMEOUT_MS,
  pageTimeoutMs = PAGE_CLOSE_FALLBACK_TIMEOUT_MS,
}) {
  const step = async (name, work) => {
    if (!(await settleWithin(work, timeoutMs))) {
      log('warn', 'session close step timed out', { userId, reason, step: name, timeoutMs });
    }
  };
  try {
    // Plugins checkpoint here while the context is alive. The checkpoint
    // evaluates in every page, so a hung page hangs it.
    await step('session:destroying', () => events.emitAsync('session:destroying', { userId, reason }));
    if (beforeClose) await step('before_close', beforeClose);
    if (!(await closeContextBounded(session.context, { timeoutMs, pageTimeoutMs }))) {
      rememberAbandonedContext(session.context, userId, log);
      log('warn', 'session context close timed out; closed pages individually', { userId, reason, timeoutMs });
    }
  } finally {
    session.tabGroups?.clear();
    if (sessions.get(userId) === session) sessions.delete(userId);
  }
  await step('session:destroyed', () => events.emitAsync('session:destroyed', { userId, reason }));
}
