const ALLOWED_URL_SCHEMES = ['http:', 'https:'];

function restorableUrl(url) {
  try { return ALLOWED_URL_SCHEMES.includes(new URL(url).protocol); }
  catch { return false; }
}

// The transition is scoped to one identity; unrelated sessions never wait on it.
export function createSharedIdentityWindowOpener({ manager, sessions, getSession, closeSession, registerPage, isBusy, drainTimeoutMs = 3000 }) {
  const transitions = new Map();

  async function openWindow(userId) {
    const existing = transitions.get(userId);
    if (existing) return existing;
    const promise = (async () => {
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
      } else if (!session.headed) {
        const recentPage = session.lastUsedPage && !session.lastUsedPage.isClosed?.()
          ? session.lastUsedPage
          : [...session.tabGroups.values()].flatMap(group => [...group.values()])
            .map(tab => tab.page).filter(page => !page.isClosed?.()).at(-1);
        const url = recentPage?.url?.();
        // closeSession drains old tab locks and deletes the old tab groups.
        // Its normal shared-identity close creates the clean cookie checkpoint.
        await closeSession(userId, session, { reason: 'headed_transition' });
        session = await getSession(userId, { headed: true });
        let restoredPage;
        let restoreFailed = false;
        if (url && url !== 'about:blank') {
          if (!restorableUrl(url)) restoreFailed = true;
          else {
            // Reuse the persistent context's initial blank page instead of leaving
            // an extra tab behind after restoring the last active URL.
            restoredPage = session.context.pages().find(page => !page.isClosed?.() && page.url?.() === 'about:blank')
              || await session.context.newPage();
            session.lastUsedPage = restoredPage;
            try { await restoredPage.goto(url, { timeout: 10000 }); }
            catch { restoreFailed = true; }
          }
        }
        const page = restoredPage || await manager.focus(userId);
        if (restoredPage) await page.bringToFront();
        return { ok: true, userId, focused: true, tabId: registerPage(session, userId, page), keepOpen: true, restarted: true,
          ...(restoreFailed ? { restoreFailed: true } : {}) };
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
    transitions.set(userId, promise);
    try { return await promise; } finally { transitions.delete(userId); }
  }

  return { openWindow, transitioning: userId => transitions.has(userId) };
}
