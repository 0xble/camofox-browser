import { isQuarantinedPage } from './page-registry.js';

const ALLOWED_URL_SCHEMES = ['http:', 'https:'];
const DEFAULT_OPEN_TIMEOUT_MS = 60_000;

function usablePage(page) {
  return !!page && !page.isClosed?.() && !isQuarantinedPage(page);
}

function restorableUrl(url) {
  try { return ALLOWED_URL_SCHEMES.includes(new URL(url).protocol); }
  catch { return false; }
}

function registeredTab(session, tabId) {
  if (tabId == null || !session?.tabGroups) return null;
  for (const group of session.tabGroups.values()) {
    const tab = group.get(tabId);
    if (usablePage(tab?.page)) return { tabId, tab };
  }
  return null;
}

function openTimeoutError() {
  // Keep this wording off the generic "timed out after" classifier so the
  // caller sees this code, not an invitation to retry immediately.
  return Object.assign(new Error('shared identity open timed out'), {
    statusCode: 503, code: 'identity_transition_timeout',
  });
}

// The transition is scoped to one identity; unrelated sessions never wait on it.
// A deadline ends the caller's wait. It does not cancel the browser operation or
// start another owner of the same profile.
export function createSharedIdentityWindowOpener({
  manager, sessions, getSession, closeSession, registerPage, isBusy,
  parkingEnabled = false, drainTimeoutMs = 3000, transitionTimeoutMs = DEFAULT_OPEN_TIMEOUT_MS,
}) {
  const transitions = new Map();

  function unavailable(userId) {
    for (let entry = transitions.get(userId); entry; entry = entry.previous) {
      if (entry.timedOut && !entry.settled) return openTimeoutError();
    }
    return null;
  }

  async function openWindow(userId, requestedTabId = null, { allowRestart = false, waitFor } = {}) {
    const blocked = unavailable(userId);
    if (blocked) throw blocked;
    const previous = transitions.get(userId);
    const sameIntent = previous && !previous.settled && !previous.timedOut
      && Object.is(previous.requestedTabId, requestedTabId) && previous.allowRestart === allowRestart;
    if (sameIntent && !waitFor && !parkingEnabled && !sessions.get(userId)?.visibility) return previous.caller;

    let timedOut = false;
    let settled = false;
    const startedAt = Date.now();
    const check = () => {
      if (timedOut || Date.now() - startedAt >= transitionTimeoutMs) {
        timedOut = true;
        throw openTimeoutError();
      }
    };
    const step = async operation => {
      check();
      try { return await operation(); }
      finally { check(); }
    };
    const raw = Promise.resolve().then(async () => {
      if (waitFor) await step(() => Promise.resolve(waitFor).catch(() => {}));
      check();
      // parkedOpen: if parking init fails, the fallback launches headed once,
      // and the legacy path below then focuses it instead of relaunching.
      const canPark = typeof parkingEnabled === 'function' ? await step(() => parkingEnabled()) : parkingEnabled;
      entry.parked ||= Boolean(canPark);
      const parkedSession = sessions.get(userId)?.visibility || canPark
        ? await step(() => getSession(userId, { parkedOpen: true, transitionCheck: check })) : null;
      entry.parked = Boolean(parkedSession?.visibility);
      if (parkedSession?.visibility) {
        const session = parkedSession;
        const requested = registeredTab(session, requestedTabId);
        const page = requested?.tab.page || (requestedTabId == null ? (usablePage(session.lastUsedPage) ? session.lastUsedPage : session.context.pages().find(usablePage)) : null)
          || await step(() => session.createPage());
        try { await step(() => session.visibility.open(page)); }
        finally { session.headed = session.visibility.visible.size > 0; }
        session.lastUsedPage = page;
        return { ok: true, userId, focused: true, tabId: registerPage(session, userId, page), keepOpen: true, restarted: false };
      }
      if (sameIntent && !waitFor) return step(() => previous.raw);
      if (previous && !previous.settled) await step(() => previous.raw.catch(() => {}));
      const hasRequestedTab = requestedTabId != null;
      if (manager.failedClosures.has(userId)) {
        throw Object.assign(new Error('shared identity close failed; profile ownership is unconfirmed'), { statusCode: 409 });
      }
      let session = sessions.get(userId);
      // A transition gates new work; allow already-counted requests a bounded
      // interval to finish rather than letting a slow body block /open forever.
      const deadline = Date.now() + drainTimeoutMs;
      while (isBusy(userId, session) && Date.now() < deadline) {
        check();
        await step(() => new Promise(resolve => setTimeout(resolve, Math.min(25, deadline - Date.now()))));
        session = sessions.get(userId);
      }
      check();
      if (isBusy(userId, session)) return { busy: true };
      if (!session) {
        session = await step(() => getSession(userId, { headed: true, transitionCheck: check }));
        check();
        if (hasRequestedTab) {
          const page = await step(() => session.context.newPage());
          check();
          await step(() => page.bringToFront());
          return { ok: true, userId, focused: true, tabId: registerPage(session, userId, page), keepOpen: true };
        }
      } else if (!session.headed) {
        if (!allowRestart && session.context.pages().some(page => !page.isClosed?.()))
          throw Object.assign(new Error('Showing this identity requires restarting its headless context and discarding all live tab state; close its tabs first or explicitly accept with allowRestart: true'), { statusCode: 409, code: 'context_restart_required' });
        const requested = hasRequestedTab ? registeredTab(session, requestedTabId) : null;
        const recentPage = requested?.tab.page || (!hasRequestedTab && usablePage(session.lastUsedPage)
          ? session.lastUsedPage
          : !hasRequestedTab ? [...session.tabGroups.values()].flatMap(group => [...group.values()])
            .map(tab => tab.page).filter(usablePage).at(-1) : null);
        const url = recentPage?.url?.();
        // closeSession drains old tab locks and deletes the old tab groups.
        // Its normal shared-identity close creates the clean cookie checkpoint.
        check();
        await step(() => closeSession(userId, session, { reason: 'headed_transition', transitionCheck: check }));
        check();
        session = await step(() => getSession(userId, { headed: true, transitionCheck: check }));
        check();
        let restoredPage;
        let restoreFailed = false;
        if (requested && url === 'about:blank') {
          restoredPage = session.context.pages().find(page => usablePage(page) && page.url?.() === 'about:blank')
            || await step(() => session.context.newPage());
          session.lastUsedPage = restoredPage;
        } else if (url && url !== 'about:blank' && restorableUrl(url)) {
          // Reuse the persistent context's initial blank page instead of leaving
          // an extra tab behind after restoring the last active URL.
          restoredPage = session.context.pages().find(page => usablePage(page) && page.url?.() === 'about:blank')
            || await step(() => session.context.newPage());
          session.lastUsedPage = restoredPage;
          check();
          try { await step(() => restoredPage.goto(url, { timeout: 10000 })); }
          catch { restoreFailed = true; }
        } else if (hasRequestedTab) {
          // A stale or non-restorable requested tab must never fall back to an
          // unrelated existing page or to the previous last-used page.
          restoredPage = await step(() => session.context.newPage());
          session.lastUsedPage = restoredPage;
          if (url && url !== 'about:blank') restoreFailed = true;
        } else if (url && url !== 'about:blank') {
          restoreFailed = true;
        }
        check();
        const page = restoredPage || await step(() => manager.focus(userId, { transitionCheck: check }));
        check();
        if (hasRequestedTab && !restoredPage) {
          throw Object.assign(new Error('requested shared identity tab could not be opened'), { statusCode: 409 });
        }
        if (restoredPage) await step(() => page.bringToFront());
        return { ok: true, userId, focused: true, tabId: registerPage(session, userId, page), keepOpen: true, restarted: true,
          ...(restoreFailed ? { restoreFailed: true } : {}) };
      }
      if (hasRequestedTab) {
        const requested = registeredTab(session, requestedTabId);
        if (requested) {
          await step(() => requested.tab.page.bringToFront());
          check();
          return { ok: true, userId, focused: true, tabId: registerPage(session, userId, requested.tab.page), keepOpen: true };
        }
        const page = await step(() => session.context.newPage());
        check();
        await step(() => page.bringToFront());
        return { ok: true, userId, focused: true, tabId: registerPage(session, userId, page), keepOpen: true };
      }
      const page = await step(() => manager.focus(userId, { transitionCheck: check }));
      check();
      if (page) return { ok: true, userId, focused: true, tabId: registerPage(session, userId, page), keepOpen: true };
      // The headed context may have been closed by a human between the session
      // lookup and focus. Do not restart it after the caller deadline.
      check();
      if (!allowRestart && session.context.pages().some(candidate => !candidate.isClosed?.()))
        throw Object.assign(new Error('The existing window could not be focused; refusing to restart and discard live tabs without allowRestart: true'), { statusCode: 409, code: 'context_restart_required' });
      await step(() => closeSession(userId, session, { reason: 'headed_transition', transitionCheck: check }));
      check();
      const restartedSession = await step(() => getSession(userId, { headed: true, transitionCheck: check }));
      check();
      const restartedPage = await step(() => manager.focus(userId, { transitionCheck: check }));
      if (!restartedPage) throw Object.assign(new Error('headed shared identity ended and could not be relaunched'), { statusCode: 409 });
      return { ok: true, userId, focused: true, tabId: registerPage(restartedSession, userId, restartedPage), keepOpen: true, restarted: true };
    });
    const entry = {
      requestedTabId, allowRestart, raw, previous, parked: Boolean(sessions.get(userId)?.visibility),
      get timedOut() { return timedOut; },
      get settled() { return settled; },
    };
    const caller = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { timedOut = true; reject(openTimeoutError()); }, transitionTimeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
      raw.then(
        value => { clearTimeout(timer); settled = true; resolve(value); },
        error => { clearTimeout(timer); settled = true; reject(error); },
      );
    });
    entry.caller = caller;
    transitions.set(userId, entry);
    raw.finally(() => {
      settled = true;
      if (transitions.get(userId) === entry) {
        let pending = previous;
        while (pending?.settled) pending = pending.previous;
        if (pending) transitions.set(userId, pending);
        else transitions.delete(userId);
      }
    }).catch(() => {});
    return caller;
  }

  return {
    openWindow,
    unavailable,
    transitioning: userId => {
      if (unavailable(userId)) return false;
      for (let entry = transitions.get(userId); entry; entry = entry.previous) {
        if (!entry.settled && !entry.parked) return true;
      }
      return false;
    },
  };
}
