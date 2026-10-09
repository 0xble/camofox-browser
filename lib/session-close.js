// Contexts whose close timed out stay here so the 60s sweep can confirm the
// close finished. Each context has one close attempt in flight at a time:
// the sweep starts a new attempt only after the previous one settled without
// closing it. After MAX_ABANDONED_CONTEXT_SWEEPS the context is retired with
// an error log, so a permanently wedged context cannot grow the set forever.
export const abandonedContexts = new Set();
const abandonedContextMeta = new Map();
export const MAX_ABANDONED_CONTEXT_SWEEPS = 10;

function startCloseAttempt(context, meta) {
  const attempt = { settled: false, closed: false };
  attempt.promise = Promise.resolve()
    .then(() => context.close())
    .then(() => { attempt.closed = true; }, () => {})
    .finally(() => { attempt.settled = true; });
  meta.attempt = attempt;
}

export function rememberAbandonedContext(context, userId, inFlightClose) {
  const meta = { userId, sweeps: 0, attempt: null };
  if (inFlightClose) {
    // Adopt the close that already timed out instead of starting a second one.
    const attempt = { settled: false, closed: false };
    attempt.promise = inFlightClose
      .then(closed => { attempt.closed = closed !== false; }, () => {})
      .finally(() => { attempt.settled = true; });
    meta.attempt = attempt;
  }
  abandonedContexts.add(context);
  abandonedContextMeta.set(context, meta);
}

function forgetAbandonedContext(context) {
  abandonedContexts.delete(context);
  abandonedContextMeta.delete(context);
}

export async function reapAbandonedContexts({
  timeoutMs = SESSION_CLOSE_STEP_TIMEOUT_MS,
  maxSweeps = MAX_ABANDONED_CONTEXT_SWEEPS,
  log = () => {},
} = {}) {
  for (const context of [...abandonedContexts]) {
    const meta = abandonedContextMeta.get(context);
    if (!meta) { abandonedContexts.delete(context); continue; }
    meta.sweeps += 1;
    if (!meta.attempt || (meta.attempt.settled && !meta.attempt.closed)) {
      log('warn', 'retrying abandoned browser context close', { userId: meta.userId, sweep: meta.sweeps, timeoutMs });
      startCloseAttempt(context, meta);
    }
    await settleWithin(() => meta.attempt.promise, timeoutMs);
    if (meta.attempt.closed) {
      forgetAbandonedContext(context);
      continue;
    }
    if (meta.sweeps >= maxSweeps) {
      log('error', 'abandoned browser context never closed; no longer tracking it', {
        userId: meta.userId, sweeps: meta.sweeps,
      });
      forgetAbandonedContext(context);
    }
  }
}



// A page spinning a CPU-bound script never answers the protocol, so the
// checkpoint evaluate, context.close() and page.close() can all hang forever.
// Every teardown step is bounded so a hung page cannot keep a session or its
// tabs registered.
export const SESSION_CLOSE_STEP_TIMEOUT_MS = 10_000;
export const PAGE_CLOSE_FALLBACK_TIMEOUT_MS = 2_000;
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
// page with its own bound, which tears down the tabs of a hung context. The
// timed-out close keeps running, available through pendingContextClose().
const pendingCloses = new WeakMap();

export function pendingContextClose(context) {
  return pendingCloses.get(context);
}

export async function closeContextBounded(context, {
  timeoutMs = SESSION_CLOSE_STEP_TIMEOUT_MS,
  pageTimeoutMs = PAGE_CLOSE_FALLBACK_TIMEOUT_MS,
} = {}) {
  // Resolves true once closed, false if close rejected (so a late rejection is
  // retried by the sweep). Never rejects.
  const closing = Promise.resolve().then(() => context.close()).then(() => true, () => false);
  if (await settleWithin(() => closing, timeoutMs)) return true;
  pendingCloses.set(context, closing);
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
      rememberAbandonedContext(session.context, userId, pendingContextClose(session.context));
      log('warn', 'session context close timed out; closed pages individually', { userId, reason, timeoutMs });
    }
  } finally {
    session.tabGroups?.clear();
    if (sessions.get(userId) === session) sessions.delete(userId);
  }
  await step('session:destroyed', () => events.emitAsync('session:destroyed', { userId, reason }));
}
