// Automatic reapers must leave visible shared identity contexts untouched.
function isEligibleForAutomaticCleanup(session) {
  return Boolean(session) && !session._closing && !session.keepOpen;
}

function createProfileCleanupGuard(onUnavailable) {
  let unavailable = false;
  return ({ browser, protectedPaths }) => {
    if (!browser || protectedPaths.size > 0) {
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
