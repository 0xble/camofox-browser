// The transition is scoped to one identity; unrelated sessions never wait on it.
export function createSharedIdentityWindowOpener({ manager, sessions, getSession, closeSession, registerPage, isBusy }) {
  const transitions = new Map();

  async function openWindow(userId) {
    const existing = transitions.get(userId);
    if (existing) return existing;
    const promise = (async () => {
      if (manager.failedClosures.has(userId)) {
        throw Object.assign(new Error('shared identity close failed; profile ownership is unconfirmed'), { statusCode: 409 });
      }
      let session = sessions.get(userId);
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
          // Reuse the persistent context's initial blank page instead of leaving
          // an extra tab behind after restoring the last active URL.
          restoredPage = session.context.pages().find(page => !page.isClosed?.() && page.url?.() === 'about:blank')
            || await session.context.newPage();
          session.lastUsedPage = restoredPage;
          try { await restoredPage.goto(url, { timeout: 10000 }); }
          catch { restoreFailed = true; }
        }
        const page = restoredPage || await manager.focus(userId);
        if (restoredPage) await page.bringToFront();
        return { ok: true, userId, focused: true, tabId: registerPage(session, userId, page), keepOpen: true, restarted: true,
          ...(restoreFailed ? { restoreFailed: true } : {}) };
      }
      const page = await manager.focus(userId);
      return { ok: true, userId, focused: true, tabId: registerPage(session, userId, page), keepOpen: true };
    })();
    transitions.set(userId, promise);
    try { return await promise; } finally { transitions.delete(userId); }
  }

  return { openWindow, transitioning: userId => transitions.has(userId) };
}
