/**
 * Record a timed-out operation and only reap a tab after repeated timeouts
 * prove that its page is no longer responsive. A timeout by itself is a
 * recoverable operation failure, not evidence that the tab or its session is
 * disposable.
 */
export async function handleTabTimeout({
  tabId,
  userId,
  findTab,
  isHumanControlled,
  probeLiveness,
  destroyTab,
  maxConsecutiveTimeouts = 3,
  log = () => {},
}) {
  const found = findTab(tabId);
  if (!found) return { handled: false, destroyed: false, reason: 'tab_missing' };

  if (isHumanControlled(tabId)) {
    log('info', 'preserving timed-out tab under human control', { tabId, userId });
    return { handled: true, destroyed: false, reason: 'human_control' };
  }

  const tabState = found.tabState;
  tabState.consecutiveTimeouts = (tabState.consecutiveTimeouts || 0) + 1;
  if (tabState.consecutiveTimeouts < maxConsecutiveTimeouts) {
    return { handled: true, destroyed: false, reason: 'timeout_recorded', streak: tabState.consecutiveTimeouts };
  }

  let responsive = false;
  try {
    responsive = await probeLiveness(tabState.page);
  } catch {
    responsive = false;
  }

  if (responsive) {
    tabState.consecutiveTimeouts = 0;
    log('info', 'timed-out tab passed liveness probe', { tabId, userId });
    return { handled: true, destroyed: false, reason: 'liveness_ok' };
  }

  tabState.consecutiveTimeouts = 0;
  log('warn', 'destroying unresponsive tab after consecutive timeouts', {
    tabId,
    userId,
    count: maxConsecutiveTimeouts,
  });
  const destroyed = await destroyTab(found.session, tabId, 'unresponsive_after_timeouts', userId);
  return {
    handled: true,
    destroyed: Boolean(destroyed),
    reason: destroyed ? 'unresponsive_after_timeouts' : 'preserved',
  };
}
