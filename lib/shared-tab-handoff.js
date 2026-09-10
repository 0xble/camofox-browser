async function applySharedTabHandoff({ tabId, handoff, tabState, humanControlledTabs }) {
  if (!tabState || tabState.page?.isClosed?.()) {
    throw Object.assign(new Error('Tab not found'), { statusCode: 404 });
  }
  tabState.handoff = handoff;
  if (handoff === 'human') {
    humanControlledTabs.add(tabId);
    await tabState.page.bringToFront();
  } else {
    humanControlledTabs.delete(tabId);
  }
  return { handoff, focused: handoff === 'human' };
}

export { applySharedTabHandoff };
