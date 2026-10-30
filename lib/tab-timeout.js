/**
 * Record a timed-out operation and only reap a tab after repeated timeouts
 * prove that its page is no longer responsive. A timeout by itself is a
 * recoverable operation failure, not evidence that the tab or its session is
 * disposable. The tab lock separately bounds abandoned work, even when this
 * liveness check succeeds. Passing a probe never extends that deadline.
 */
export async function handleTabTimeout({
  tabId,
  userId,
  findTab,
  isHumanControlled,
  isNavigationInFlight = () => false,
  isTimeoutCurrent = () => true,
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

  if (!isTimeoutCurrent()) {
    return { handled: true, destroyed: false, reason: 'timeout_no_longer_current' };
  }

  const tabState = found.tabState;
  // Concurrent retries observe busy without launching duplicate probes/closes.
  // This belongs to the exact tab state, never a shared identity or replacement.
  if (tabState.timeoutRecoveryInFlight) {
    return { handled: true, destroyed: false, reason: 'recovery_in_flight' };
  }
  if (isNavigationInFlight(tabId)) {
    log('info', 'preserving tab while navigation is in flight', { tabId, userId });
    return { handled: true, destroyed: false, reason: 'navigation_in_flight' };
  }
  tabState.consecutiveTimeouts = (tabState.consecutiveTimeouts || 0) + 1;
  if (tabState.consecutiveTimeouts < maxConsecutiveTimeouts) {
    return { handled: true, destroyed: false, reason: 'timeout_recorded', streak: tabState.consecutiveTimeouts };
  }

  tabState.timeoutRecoveryInFlight = true;
  try {
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

    // A navigation can start while the liveness probe is awaiting the page. Do
    // not destroy a tab that became active, or a replacement that took its ID,
    // after the initial checks.
    if (isNavigationInFlight(tabId)) {
      tabState.consecutiveTimeouts = 0;
      log('info', 'preserving tab while navigation started during liveness probe', { tabId, userId });
      return { handled: true, destroyed: false, reason: 'navigation_in_flight' };
    }
    if (isHumanControlled(tabId) || !isTimeoutCurrent()) {
      tabState.consecutiveTimeouts = 0;
      return { handled: true, destroyed: false, reason: 'timeout_no_longer_current' };
    }
    const current = findTab(tabId);
    if (!current || current.session !== found.session || current.tabState !== tabState) {
      tabState.consecutiveTimeouts = 0;
      log('info', 'preserving tab after timeout target changed during liveness probe', { tabId, userId });
      return { handled: true, destroyed: false, reason: 'tab_changed' };
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
  } finally {
    delete tabState.timeoutRecoveryInFlight;
  }
}
