// Contexts whose close is unconfirmed stay here so the 60s sweep can confirm the
// close finished. Each context has one close attempt in flight at a time:
// the sweep starts a new attempt only after the previous one settled without
// closing it. After MAX_ABANDONED_CONTEXT_SWEEPS the context is retired with
// an error log, so a permanently wedged context cannot grow the set forever.
import { quarantinePage } from './page-registry.js';

export const abandonedContexts = new Set();
const abandonedContextMeta = new Map();
export const MAX_ABANDONED_CONTEXT_SWEEPS = 10;

// A rejected close can happen before Playwright sends any protocol close.
// Only fulfillment, the public close event, or a genuinely closed-state readback
// confirms it. Playwright 1.59.1 reports isClosed() for both "closing" and
// "closed", so prefer its state when available rather than treating the former
// as confirmation after a pre-protocol rejection.
function contextIsClosed(context) {
  if (context._closingStatus !== undefined) return context._closingStatus === 'closed';
  try { return context.isClosed?.() === true; } catch { return false; }
}

async function closeContextConfirmed(context, { driveProtocol = false } = {}) {
  let onClose;
  const closeEvent = new Promise(resolve => {
    onClose = () => resolve(true);
    context.once?.('close', onClose);
  });
  const publicClose = Promise.resolve().then(() => {
    const wasClosing = context._closingStatus === 'closing';
    return Promise.resolve(context.close()).then(
      () => ({ fulfilled: true, wasClosing }),
      () => ({ fulfilled: false, wasClosing }),
    );
  });
  try {
    // Do not await close() before observing the event. Playwright can dispatch
    // the close event while its public close promise is still waiting on a
    // late protocol response.
    const result = await Promise.race([
      closeEvent,
      publicClose.then(({ fulfilled, wasClosing }) => fulfilled && (!wasClosing || contextIsClosed(context))),
    ]);
    if (result || contextIsClosed(context)) return true;

    // Playwright 1.59.1 marks a context as "closing" before disposal. If
    // disposal rejects, a retry of the public close() returns immediately
    // because isClosed() is true, without sending the protocol close. Only a
    // retry may drive that protocol step, and it still requires the normal
    // close signal or a closed-state readback before confirming.
    if (driveProtocol && typeof context._channel?.close === 'function') {
      const protocolClose = Promise.resolve().then(() => context._channel.close({})).then(
        () => contextIsClosed(context),
        () => contextIsClosed(context),
      );
      return await Promise.race([
        closeEvent,
        protocolClose,
      ]);
    }
    // Minimal test doubles and legacy contexts without a close signal have no
    // lower-level protocol operation to drive; a fulfilled public close is the
    // only confirmation available.
    return false;
  } finally {
    context.off?.('close', onClose);
  }
}

function startCloseAttempt(context, meta) {
  const attempt = { settled: false, closed: false };
  attempt.promise = closeContextConfirmed(context, { driveProtocol: true })
    .then(closed => { attempt.closed = closed; })
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

export function hasSessionClose(session) { return closePromises.has(session); }

export function closeSessionOnce(session, teardown) {
  if (!session) return Promise.resolve();
  const existing = closePromises.get(session);
  if (existing) return existing;
  const promise = Promise.resolve().then(teardown);
  closePromises.set(session, promise);
  // Failed or cancelled preparation leaves the session live and retryable.
  // Cleanup timers set _closing before calling, so clear it too.
  const allowRetry = () => {
    if (closePromises.get(session) !== promise) return;
    closePromises.delete(session);
    session._closing = false;
  };
  promise.then(result => { if (result === false) allowRetry(); }, allowRetry);
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
// unconfirmed close remains available through pendingContextClose().
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
  try { for (const page of context.pages()) quarantinePage(page); } catch { /* context already gone */ }
  const closing = closeContextConfirmed(context);
  if (await settleWithin(() => closing, timeoutMs) && await closing) return true;
  pendingCloses.set(context, closing);
  let pages = [];
  try { pages = context.pages(); } catch { /* context already gone */ }
  await Promise.all(pages.map(page => settleWithin(() => page.close({ runBeforeUnload: false }), pageTimeoutMs)));
  return false;
}

// Teardown of an ephemeral (non-shared) session. Bookkeeping is dropped even
// when a step times out or close rejects, so the session and its tabs always leave the registry.
export async function teardownEphemeralSession({
  userId, session, sessions, reason, events, beforeClose, log = () => {},
  timeoutMs = SESSION_CLOSE_STEP_TIMEOUT_MS,
  pageTimeoutMs = PAGE_CLOSE_FALLBACK_TIMEOUT_MS,
}) {
  const retiringPages = new Set([...session.tabGroups?.values() || []].flatMap(group => [...group.values()].map(tab => tab.page)));
  try { for (const page of session.context.pages()) retiringPages.add(page); } catch { /* context already gone */ }
  for (const page of retiringPages) quarantinePage(page, session);
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
      log('warn', 'session context close unconfirmed; closed pages individually', { userId, reason, timeoutMs });
    }
  } finally {
    session.tabGroups?.clear();
    if (sessions.get(userId) === session) sessions.delete(userId);
  }
  await step('session:destroyed', () => events.emitAsync('session:destroyed', { userId, reason }));
}
