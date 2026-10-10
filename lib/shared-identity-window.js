const ALLOWED_URL_SCHEMES = ['http:', 'https:'];

function restorableUrl(url) {
  try { return ALLOWED_URL_SCHEMES.includes(new URL(url).protocol); }
  catch { return false; }
}

function registeredTab(session, tabId) {
  if (tabId == null || !session?.tabGroups) return null;
  for (const group of session.tabGroups.values()) {
    const tab = group.get(tabId);
    if (tab?.page && !tab.page.isClosed?.()) return { tabId, tab };
  }
  return null;
}

// The transition is scoped to one identity; unrelated sessions never wait on it.
export function createSharedIdentityWindowOpener({ manager, sessions, getSession, closeSession, registerPage, isBusy, drainTimeoutMs = 3000 }) {
  const transitions = new Map();

  async function openWindow(userId, requestedTabId = null) {
    const hasRequestedTab = requestedTabId != null;
    const existing = transitions.get(userId);
    if (existing && Object.is(existing.requestedTabId, requestedTabId)) return existing.promise;
    const promise = (async () => {
      if (existing) await existing.promise.catch(() => {});
      if (manager.failedClosures.has(userId)) {
        throw Object.assign(new Error('shared identity close failed; profile ownership is unconfirmed'), { statusCode: 409 });
      }
      let session = sessions.get(userId);
      // A transition gates new work; allow already-counted requests a bounded
      // interval to finish rather than letting a slow body block /open forever.
      const deadline = Date.now() + drainTimeoutMs;
      while (isBusy(userId, session) && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, Math.min(25, deadline - Date.now())));
        session = sessions.get(userId);
      }
      if (isBusy(userId, session)) return { busy: true };
      if (!session) {
        session = await getSession(userId, { headed: true });
        if (hasRequestedTab) {
          const page = await session.context.newPage();
          await page.bringToFront();
          return { ok: true, userId, focused: true, tabId: registerPage(session, userId, page), keepOpen: true };
        }
      } else if (!session.headed) {
        const requested = hasRequestedTab ? registeredTab(session, requestedTabId) : null;
        const recentPage = requested?.tab.page || (!hasRequestedTab && session.lastUsedPage && !session.lastUsedPage.isClosed?.()
          ? session.lastUsedPage
          : !hasRequestedTab ? [...session.tabGroups.values()].flatMap(group => [...group.values()])
            .map(tab => tab.page).filter(page => !page.isClosed?.()).at(-1) : null);
        const url = recentPage?.url?.();
        // closeSession drains old tab locks and deletes the old tab groups.
        // Its normal shared-identity close creates the clean cookie checkpoint.
        await closeSession(userId, session, { reason: 'headed_transition' });
        session = await getSession(userId, { headed: true });
        let restoredPage;
        let restoreFailed = false;
        if (requested && url === 'about:blank') {
          restoredPage = session.context.pages().find(page => !page.isClosed?.() && page.url?.() === 'about:blank')
            || await session.context.newPage();
          session.lastUsedPage = restoredPage;
        } else if (url && url !== 'about:blank' && restorableUrl(url)) {
          // Reuse the persistent context's initial blank page instead of leaving
          // an extra tab behind after restoring the last active URL.
          restoredPage = session.context.pages().find(page => !page.isClosed?.() && page.url?.() === 'about:blank')
            || await session.context.newPage();
          session.lastUsedPage = restoredPage;
          try { await restoredPage.goto(url, { timeout: 10000 }); }
          catch { restoreFailed = true; }
        } else if (hasRequestedTab) {
          // A stale or non-restorable requested tab must never fall back to an
          // unrelated existing page or to the previous last-used page.
          restoredPage = await session.context.newPage();
          session.lastUsedPage = restoredPage;
          if (url && url !== 'about:blank') restoreFailed = true;
        } else if (url && url !== 'about:blank') {
          restoreFailed = true;
        }
        const page = restoredPage || await manager.focus(userId);
        if (hasRequestedTab && !restoredPage) {
          throw Object.assign(new Error('requested shared identity tab could not be opened'), { statusCode: 409 });
        }
        if (restoredPage) await page.bringToFront();
        return { ok: true, userId, focused: true, tabId: registerPage(session, userId, page), keepOpen: true, restarted: true,
          ...(restoreFailed ? { restoreFailed: true } : {}) };
      }
      if (hasRequestedTab) {
        const requested = registeredTab(session, requestedTabId);
        if (requested) {
          await requested.tab.page.bringToFront();
          return { ok: true, userId, focused: true, tabId: registerPage(session, userId, requested.tab.page), keepOpen: true };
        }
        const page = await session.context.newPage();
        await page.bringToFront();
        return { ok: true, userId, focused: true, tabId: registerPage(session, userId, page), keepOpen: true };
      }
      const page = await manager.focus(userId);
      if (page) return { ok: true, userId, focused: true, tabId: registerPage(session, userId, page), keepOpen: true };
      // The headed context may have been closed by a human between the session
      // lookup and focus. Treat it as ended and restart through the same path.
      await closeSession(userId, session, { reason: 'headed_transition' });
      const restartedSession = await getSession(userId, { headed: true });
      const restartedPage = await manager.focus(userId);
      if (!restartedPage) throw Object.assign(new Error('headed shared identity ended and could not be relaunched'), { statusCode: 409 });
      return { ok: true, userId, focused: true, tabId: registerPage(restartedSession, userId, restartedPage), keepOpen: true, restarted: true };
    })();
    const entry = { promise, requestedTabId };
    transitions.set(userId, entry);
    try { return await promise; } finally {
      if (transitions.get(userId) === entry) transitions.delete(userId);
    }
  }

  return { openWindow, transitioning: userId => transitions.has(userId) };
}
