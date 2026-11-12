// Resolve tab ownership before trusting a supplied userId. Evaluate and upload
// parse JSON in their routes, after this middleware has already run.
export function createSharedIdentityRequestTracker({ getSessions, manager, normalizeUserId, findTab, transitioning, requests, parkedVisibility = () => false, unavailable = () => null }) {
  return (req, res, next) => {
    const sessions = getSessions();
    const identityPath = req.path.match(/^\/browser\/identities\/([^/]+)\//);
    const sessionPath = req.path.match(/^\/sessions\/([^/]+)(?:\/|$)/);
    const identityKey = identityPath?.[1] ? normalizeUserId(identityPath[1]) : null;
    const windowRequest = identityPath?.[1] && /\/(open|focus)$/.test(req.path);
    const parkingAvailable = identityKey && parkedVisibility(identityKey);
    // A park display can exist before a session has successfully acquired a
    // visibility controller. Do not count that startup request: a failed park
    // falls back to a legacy headed context, whose opener would otherwise see
    // this request's own tracker entry as an identity-busy request.
    const parkedWindowRequest = windowRequest && parkingAvailable
      && Boolean(sessions.get(identityKey)?.visibility);
    const blocked = identityKey && unavailable(identityKey);
    if (blocked) return res.status(blocked.statusCode || 503).json({ error: blocked.message, code: blocked.code });
    if (identityPath?.[1] && req.path.endsWith('/open') && !parkedWindowRequest) return next();
    const tabId = req.path.match(/^\/tabs\/([^/]+)/)?.[1];
    let owner;
    if (tabId) {
      for (const [key, session] of sessions) {
        if (findTab(session, tabId)) { owner = key; break; }
      }
    }
    const userId = owner || identityPath?.[1] || sessionPath?.[1] || req.body?.userId || req.query?.userId;
    if (!userId) return next();
    const key = normalizeUserId(userId);
    if (!manager.owns(key)) return next();
    const unavailableError = unavailable(key);
    if (unavailableError) return res.status(unavailableError.statusCode || 503).json({ error: unavailableError.message, code: unavailableError.code });
    // Parking operations do not gate one another, but count as active work so
    // expiry cannot close a window while a human is in the process of showing it.
    if ((!parkedWindowRequest && transitioning(key)) || manager.closings.has(key)) return res.status(409).json({ error: 'identity busy' });
    // A legacy /focus still passes the transition and closing gates above, but
    // must not count itself: openWindow checks identityBusy while focusing the
    // fallback headed context and would otherwise see this request as busy.
    if (windowRequest && !parkedWindowRequest) return next();
    requests.set(key, (requests.get(key) || 0) + 1);
    const session = sessions.get(key);
    if (session && tabId) session.lastUsedPage = findTab(session, tabId)?.tabState.page || session.lastUsedPage;
    res.once('close', () => {
      const remaining = requests.get(key) - 1;
      if (remaining) requests.set(key, remaining);
      else requests.delete(key);
    });
    next();
  };
}
