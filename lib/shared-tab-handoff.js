import { isQuarantinedPage } from './page-registry.js';

async function applySharedTabHandoff({ tabId, handoff, tabState, session, humanControlledTabs, onAgentControl, log }) {
  if (!tabState || tabState.page?.isClosed?.()) {
    throw Object.assign(new Error('Tab not found'), { statusCode: 404 });
  }
  const check = () => {
    if (isQuarantinedPage(tabState.page)) throw Object.assign(new Error('Tab was destroyed'), { statusCode: 410, code: 'tab_destroyed' });
  };
  check();
  let parkFailure, shown;
  if (session?.visibility) {
    try {
      if (handoff === 'human') shown = await session.visibility.open(tabState.page);
      else {
        // A failed park must never leave the tab human-controlled: every agent
        // action would 409 until the tab is deleted. Return control and report it.
        const keep = session.visibility.capability?.().scope === 'identity'
          ? [...session.tabGroups.values()].flatMap(group => [...group])
            .filter(([id, tab]) => id !== tabId && humanControlledTabs.has(id) && tab.page && !tab.page.isClosed?.() && !isQuarantinedPage(tab.page)).map(([, tab]) => tab.page) : [];
        try { await session.visibility.release({ all: false, page: tabState.page, ...(keep.length ? { keep } : {}) }); }
        catch (err) {
          parkFailure = err?.message || String(err);
          log?.('warn', 'agent handoff park failed; agent control returned', { tabId, error: parkFailure });
        }
      }
    } finally {
      session.headed = session.visibility.visible.size > 0;
    }
  }
  check();
  tabState.handoff = handoff;
  if (handoff === 'human') {
    humanControlledTabs.add(tabId);
    if (!session?.visibility) await tabState.page.bringToFront();
  } else {
    humanControlledTabs.delete(tabId);
    onAgentControl?.();
  }
  return { handoff, focused: handoff === 'human' && (shown?.focused ?? true),
    ...(shown?.visible !== undefined ? { visible: shown.visible } : {}), ...(parkFailure ? { parked: false, reason: parkFailure } : {}) };
}

export { applySharedTabHandoff };
