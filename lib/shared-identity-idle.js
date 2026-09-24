// Isolated policy: native desktop input idle is never inferred from agent activity.
export function createSharedIdentityIdlePolicy({ readIdleSeconds, clock = () => Date.now() }) {
  if (typeof readIdleSeconds !== 'function') throw new TypeError('idle reader required');
  return {
    async shouldReleaseHeaded(minutes) {
      if (!Number.isInteger(minutes) || minutes <= 0) return false;
      try {
        const seconds = await readIdleSeconds();
        return Number.isFinite(seconds) && seconds >= minutes * 60;
      } catch {
        return false;
      }
    },
    agentIdle(lastAccess, minutes) {
      return Number.isInteger(minutes) && minutes > 0 && Number.isFinite(lastAccess)
        && clock() - lastAccess >= minutes * 60_000;
    },
  };
}
