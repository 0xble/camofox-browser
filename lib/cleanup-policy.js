// Automatic reapers must leave visible shared identity contexts untouched.
function isEligibleForAutomaticCleanup(session) {
  return Boolean(session) && !session._closing && !session.keepOpen;
}

export { isEligibleForAutomaticCleanup };
