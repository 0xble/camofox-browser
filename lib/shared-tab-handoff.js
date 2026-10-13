async function applySharedTabHandoff({ tabId, handoff, tabState, session, humanControlledTabs, log }) {
  if (!tabState || tabState.page?.isClosed?.()) {
    throw Object.assign(new Error('Tab not found'), { statusCode: 404 });
  }
  let parkFailure;
  if (session?.visibility) {
    try {
      if (handoff === 'human') await session.visibility.open(tabState.page);
      else {
        // A failed park must never leave the tab human-controlled: every agent
        // action would 409 until the tab is deleted. Return control and report it.
        try { await session.visibility.release({ all: false, page: tabState.page }); }
        catch (err) {
          parkFailure = err?.message || String(err);
          log?.('warn', 'agent handoff park failed; agent control returned', { tabId, error: parkFailure });
        }
      }
    } finally {
      session.headed = session.visibility.visible.size > 0;
    }
  }
  tabState.handoff = handoff;
  if (handoff === 'human') {
    humanControlledTabs.add(tabId);
    if (!session?.visibility) await tabState.page.bringToFront();
  } else {
    humanControlledTabs.delete(tabId);
  }
  return { handoff, focused: handoff === 'human', ...(parkFailure ? { parked: false, reason: parkFailure } : {}) };
}

export { applySharedTabHandoff };
