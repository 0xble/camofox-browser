// Snapshot ref reliability helpers.
//
// Ref maps are rebuilt from the accessibility tree. A rebuild can come back
// empty for two very different reasons: the page really has no interactive
// elements, or the capture failed (timeout, detached frame, no tree). The old
// refresh path returned the previous refs for any same-URL empty rebuild, so
// after an SPA re-render callers clicked refs that pointed at detached nodes.

const INCOMPLETE = Symbol('refsIncomplete');

/** Mark a ref map as the result of a failed or partial capture. */
export function markRefsIncomplete(refs, reason) {
  refs[INCOMPLETE] = reason || 'incomplete';
  return refs;
}

export function refsIncompleteReason(refs) {
  return refs?.[INCOMPLETE] || null;
}

export class RefsUnavailableError extends Error {
  constructor({ reason, url, previousRefs }) {
    super('Element refs are unavailable: the page snapshot could not be captured and the previous refs no longer match the page. Retry the snapshot.');
    this.name = 'RefsUnavailableError';
    this.code = 'refs_unavailable';
    this.statusCode = 503;
    this.reason = reason;
    this.url = url;
    this.previousRefs = previousRefs;
  }
}

/**
 * Per-frame ariaSnapshot budget, bounded by the overall snapshot deadline.
 * A frame may use all remaining time except a minimum reserved for each frame
 * still to visit, so one slow app frame (GHL's workflow builder) is not starved
 * by an equal split, and time fast frames leave unused rolls over. The budget
 * never exceeds the time left. Returns 0 when not even the minimum fits.
 */
export function iframeSnapshotBudgetMs({ remainingMs, framesLeft, minMs = 1000, maxMs = 8000 }) {
  if (!(remainingMs >= minMs) || !(framesLeft > 0)) return 0;
  const reserved = (framesLeft - 1) * minMs;
  return Math.min(remainingMs, maxMs, Math.max(minMs, remainingMs - reserved));
}

/**
 * True only when every retained ref still resolves to an attached element
 * within the budget. Checking a sample is not enough: chooseRefsAfterRebuild
 * returns the whole map, so one unchecked detached ref would leak. Checks run
 * in bounded batches and stop at the first miss or when the budget is spent,
 * so at most one batch of page calls can outlive the request. Errors and
 * budget exhaustion count as not attached, which fails closed.
 */
export async function retainedRefsStillAttached(refs, { isAttached, budgetMs = 1500, concurrency = 16, now = Date.now }) {
  if (!refs?.size) return false;
  const deadline = now() + budgetMs;
  const ids = [...refs.keys()];
  for (let i = 0; i < ids.length; i += concurrency) {
    const remaining = deadline - now();
    if (remaining <= 0) return false;
    let timer;
    const expired = new Promise(resolve => { timer = setTimeout(() => resolve(false), remaining); });
    const batch = Promise.all(ids.slice(i, i + concurrency).map(async id => {
      try { return Boolean(await isAttached(id, refs.get(id))); }
      catch { return false; }
    })).then(results => results.every(Boolean));
    try {
      if (!(await Promise.race([batch, expired]))) return false;
    } finally {
      clearTimeout(timer);
    }
  }
  return true;
}

/**
 * Decide which refs a refresh returns.
 * - A non-empty rebuild always wins.
 * - After navigation, the (possibly empty) rebuild wins.
 * - On the same URL with previous refs, the previous refs are kept only if
 *   they still resolve to attached elements. Otherwise a genuine empty page
 *   returns empty refs, and a failed capture fails closed.
 */
export async function chooseRefsAfterRebuild({ rebuilt, existing, sameUrl, url, validate, onRetained }) {
  const failure = refsIncompleteReason(rebuilt);
  if (rebuilt.size > 0 || !sameUrl || !existing?.size) return rebuilt;
  if (await validate(existing)) {
    onRetained?.({ failure, previousRefs: existing.size });
    return existing;
  }
  if (failure) throw new RefsUnavailableError({ reason: failure, url, previousRefs: existing.size });
  return rebuilt;
}
