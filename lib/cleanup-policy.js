// Automatic reapers must leave visible shared identity contexts untouched.
function isEligibleForAutomaticCleanup(session) {
  return Boolean(session) && !session._closing && !session.keepOpen;
}

/**
 * Decide the protected profile set for one periodic cleanup tick.
 * Returns null to skip the tick. A running browser whose live profile cannot
 * be found must never have its profile removed, so the tick is skipped, but
 * the warning is logged once per unavailable stretch rather than every tick.
 */
function createProfileCleanupGuard(onUnavailable) {
  let unavailable = false;
  return ({ browserRunning, protectedPaths }) => {
    if (!browserRunning) {
      unavailable = false;
      return new Set();
    }
    if (protectedPaths && protectedPaths.size > 0) {
      unavailable = false;
      return protectedPaths;
    }
    if (!unavailable) {
      unavailable = true;
      onUnavailable();
    }
    return null;
  };
}

export { createProfileCleanupGuard, isEligibleForAutomaticCleanup };
