import { isQuarantinedPage } from './page-registry.js';

async function applySharedTabHandoff({ tabId, handoff, tabState, session, humanControlledTabs, onAgentControl, nativeOnly = false, log }) {
  if (!tabState || tabState.page?.isClosed?.()) {
    throw Object.assign(new Error('Tab not found'), { statusCode: 404 });
  }
  const check = () => {
    if (isQuarantinedPage(tabState.page)) throw Object.assign(new Error('Tab was destroyed'), { statusCode: 410, code: 'tab_destroyed' });
  };
  check();
  const wasHumanControlled = humanControlledTabs.has(tabId);
  // Reserve before asynchronous visibility work so timeout recovery cannot
  // retire the page being rescued. This does not cancel already-issued input.
  if (handoff === 'human') humanControlledTabs.add(tabId);
  let parkFailure, shown;
  try {
    if (session?.visibility) {
      try {
        if (handoff === 'human') shown = await session.visibility.open(tabState.page, ...(nativeOnly ? [{ nativeOnly: true }] : []));
        else {
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
        session.headed = session.visibility.isVisible?.() ?? session.visibility.visible.size > 0;
      }
    }
    check();
    if (handoff === 'human' && !session?.visibility) await tabState.page.bringToFront();
    tabState.handoff = handoff;
    if (handoff === 'agent') {
      humanControlledTabs.delete(tabId);
      onAgentControl?.();
    }
  } catch (error) {
    if (handoff === 'human' && !wasHumanControlled) humanControlledTabs.delete(tabId);
    throw error;
  }
  return { handoff, focused: handoff === 'human' && (shown?.focused ?? true),
    ...(shown?.visible !== undefined ? { visible: shown.visible } : {}),
    ...(shown?.targetUnconfirmed ? { targetUnconfirmed: true } : {}),
    ...(nativeOnly ? { operationMayStillBeRunning: true } : {}),
    ...(parkFailure ? { parked: false, reason: parkFailure } : {}) };
}

export { applySharedTabHandoff };
