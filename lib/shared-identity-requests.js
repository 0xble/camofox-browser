// Resolve tab ownership before trusting a supplied userId. Evaluate intentionally
// parses JSON in its route, after this middleware has already run.
export function createSharedIdentityRequestTracker({ getSessions, manager, normalizeUserId, findTab, transitioning, requests, parkedVisibility = () => false }) {
  return (req, res, next) => {
    const sessions = getSessions();
    const identityPath = req.path.match(/^\/browser\/identities\/([^/]+)\//);
    const sessionPath = req.path.match(/^\/sessions\/([^/]+)(?:\/|$)/);
    const parkedWindowRequest = identityPath?.[1] && /\/(open|focus)$/.test(req.path)
      && parkedVisibility(normalizeUserId(identityPath[1]));
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
    // Parking operations do not gate one another, but count as active work so
    // expiry cannot close a window while a human is in the process of showing it.
    if ((!parkedWindowRequest && transitioning(key)) || manager.closings.has(key)) return res.status(409).json({ error: 'identity busy' });
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
