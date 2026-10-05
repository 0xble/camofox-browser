export const DEFAULT_EMPTY_SESSION_GRACE_MS = 120_000;

export function shouldCloseEmptySession(
  session,
  now = Date.now(),
  { sessionTimeoutMs = 0, graceMs = DEFAULT_EMPTY_SESSION_GRACE_MS } = {},
) {
  if (!session || session._closing) return false;
  if (session.tabGroups?.size !== 0) return false;
  if (session.pageLeases?.size) return false;
  if (!Number.isFinite(session.lastAccess)) return false;

  const effectiveGraceMs = Math.max(
    graceMs,
    sessionTimeoutMs > 0 ? sessionTimeoutMs : 0,
  );
  return now - session.lastAccess >= effectiveGraceMs;
}
