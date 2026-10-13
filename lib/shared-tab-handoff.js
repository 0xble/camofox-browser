async function applySharedTabHandoff({ tabId, handoff, tabState, session, humanControlledTabs }) {
  if (!tabState || tabState.page?.isClosed?.()) {
    throw Object.assign(new Error('Tab not found'), { statusCode: 404 });
  }
  if (session?.visibility) {
    try {
      if (handoff === 'human') await session.visibility.open(tabState.page);
      else await session.visibility.release({ all: false, page: tabState.page });
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
  return { handoff, focused: handoff === 'human' };
}

export { applySharedTabHandoff };
