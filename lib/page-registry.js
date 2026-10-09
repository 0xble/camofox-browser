// One Playwright page maps to at most one tab ID per session.
//
// A shared persistent identity reports every new page through the context
// `page` event, and a popup also arrives through its opener's `popup` event.
// Tab creation and dead-page replacement create pages that the context event
// has already seen. Every one of those paths registers through `registerPage`,
// so the second sighting of a page reuses the first registration instead of
// creating another tab ID with its own lock, download listener and reaper
// lifetime.

export const SHARED_IDENTITY_GROUP = '__shared_identity__';
const POPUP_GROUP = '__popups__';

export function findTabByPage(session, page) {
  if (!session || !page) return null;
  for (const [listItemId, group] of session.tabGroups) {
    for (const [tabId, tabState] of group) {
      if (tabState.page === page) return { tabId, tabState, listItemId, group };
    }
  }
  return null;
}

export function tabIdsForPage(session, page) {
  const ids = [];
  if (!session || !page) return ids;
  for (const group of session.tabGroups.values()) {
    for (const [tabId, tabState] of group) if (tabState.page === page) ids.push(tabId);
  }
  return ids;
}

function tabGroup(session, listItemId) {
  let group = session.tabGroups.get(listItemId);
  if (!group) {
    group = new Map();
    session.tabGroups.set(listItemId, group);
  }
  return group;
}

function removeEntry(session, found) {
  found.group.delete(found.tabId);
  if (!found.group.size) session.tabGroups.delete(found.listItemId);
}

export function createPageRegistry({
  sessions,
  normalizeUserId = value => value,
  makeTabId,
  createTabState,
  attachDownloadListener,
  releaseTabId = () => {},
  onChange = () => {},
  log = () => {},
  emit = () => {},
}) {
  function createTab(session, userId, page, tabId, listItemId) {
    const tabState = createTabState(page);
    // Listeners read the current ID so a page folded into another tab reports
    // under the tab that owns it.
    tabState.tabId = tabId;
    attachDownloadListener(tabState, tabId, userId);
    attachPopupHandler(page, userId, listItemId);
    if (session.sharedIdentity) {
      page.on?.('close', () => {
        const found = findTabByPage(session, page);
        if (found?.tabState !== tabState) return;
        removeEntry(session, found);
        releaseTabId(found.tabId);
        onChange();
      });
    }
    return tabState;
  }

  /**
   * Register `page` once in `session` and return { tabId, tabState, created }.
   *
   * Without `tabId`, an existing registration is returned as is. A page still
   * in the unclaimed shared-identity group moves to `listItemId`; a page that a
   * task group already holds never moves.
   *
   * With `tabId`, `page` replaces that tab's page and keeps that ID. If the
   * context event already registered the new page under another ID, that entry
   * is folded into `tabId` rather than left behind as a second tab.
   */
  function registerPage(session, userId, page, listItemId, { tabId = null } = {}) {
    const existing = findTabByPage(session, page);
    if (existing && (!tabId || existing.tabId === tabId)) {
      if (existing.listItemId === SHARED_IDENTITY_GROUP && listItemId !== SHARED_IDENTITY_GROUP) {
        removeEntry(session, existing);
        tabGroup(session, listItemId).set(existing.tabId, existing.tabState);
      }
      return { tabId: existing.tabId, tabState: existing.tabState, created: false };
    }
    if (existing) {
      for (const [groupId, group] of session.tabGroups) {
        if (group.delete(tabId) && !group.size) session.tabGroups.delete(groupId);
      }
      removeEntry(session, existing);
      releaseTabId(existing.tabId);
      existing.tabState.tabId = tabId;
      tabGroup(session, listItemId).set(tabId, existing.tabState);
      log('info', 'page folded into existing tab', { userId, tabId, foldedTabId: existing.tabId });
      return { tabId, tabState: existing.tabState, created: false };
    }
    if (tabId) {
      // Replacing a tab's page: drop its retired entry wherever it lives.
      for (const [groupId, group] of session.tabGroups) {
        if (group.delete(tabId) && !group.size) session.tabGroups.delete(groupId);
      }
    }
    const id = tabId || makeTabId();
    const tabState = createTab(session, userId, page, id, listItemId);
    tabGroup(session, listItemId).set(id, tabState);
    return { tabId: id, tabState, created: true };
  }

  function attachPopupHandler(page, userId, listItemId) {
    page.on('popup', (popupPage) => {
      const key = normalizeUserId(userId);
      const session = sessions.get(key);
      if (!session || session._closing) return;
      // The opener may have moved groups since this handler was attached.
      const group = findTabByPage(session, page)?.listItemId || listItemId || POPUP_GROUP;
      const { tabId, created } = registerPage(session, key, popupPage, group);
      session.lastAccess = Date.now();
      onChange();
      if (!created) return;
      const url = safeUrl(popupPage);
      log('info', 'popup registered as managed tab', { userId: key, tabId, url });
      emit('tab:created', { userId: key, tabId, page: popupPage, url });
    });
  }

  function registerSharedIdentityPage(session, userId, page) {
    if (!session?.sharedIdentity || !page || page.isClosed?.()) return null;
    const { tabId, created } = registerPage(session, userId, page, SHARED_IDENTITY_GROUP);
    if (!created) return tabId;
    onChange();
    log('info', 'shared identity page registered', { userId, tabId });
    emit('tab:created', { userId, tabId, page, url: safeUrl(page) });
    return tabId;
  }

  return { registerPage, attachPopupHandler, registerSharedIdentityPage };
}

function safeUrl(page) {
  try { return page.url(); } catch { return null; }
}
