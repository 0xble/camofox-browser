import { jest } from '@jest/globals';
import {
  RefsUnavailableError, chooseRefsAfterRebuild, iframeSnapshotBudgetMs, markRefsIncomplete,
  refsIncompleteReason, retainedRefsStillAttached,
} from '../../lib/snapshot-refs.js';
import { browserErrorCode, browserErrorRecovery, browserErrorStatus } from '../../lib/browser-errors.js';

const refsOf = (...ids) => new Map(ids.map((id, nth) => [id, { role: 'button', name: id, nth }]));

describe('refresh ref selection after an empty rebuild', () => {
  test('a failed same-URL capture whose previous refs no longer resolve fails closed (GHL re-render)', async () => {
    const existing = refsOf('e1', 'e2');
    const rebuilt = markRefsIncomplete(new Map(), 'timeout');
    const error = await chooseRefsAfterRebuild({
      rebuilt, existing, sameUrl: true, url: 'https://app.gohighlevel.com/x', validate: async () => false,
    }).catch(err => err);

    expect(error).toBeInstanceOf(RefsUnavailableError);
    expect(error).toMatchObject({ code: 'refs_unavailable', reason: 'timeout', previousRefs: 2 });
    expect(browserErrorStatus(error)).toBe(503);
    expect(browserErrorCode(error)).toBe('refs_unavailable');
    expect(browserErrorRecovery(error)).toBe('retry');
  });

  test('previous refs that still resolve are reused, never silently', async () => {
    const existing = refsOf('e1');
    const onRetained = jest.fn();
    const chosen = await chooseRefsAfterRebuild({
      rebuilt: markRefsIncomplete(new Map(), 'aria_snapshot_failed'), existing, sameUrl: true,
      validate: async () => true, onRetained,
    });
    expect(chosen).toBe(existing);
    expect(onRetained).toHaveBeenCalledWith({ failure: 'aria_snapshot_failed', previousRefs: 1 });
  });

  test('a successful capture of a page that lost its controls returns empty refs, not stale ones', async () => {
    const rebuilt = new Map();
    await expect(chooseRefsAfterRebuild({
      rebuilt, existing: refsOf('e1'), sameUrl: true, validate: async () => false,
    })).resolves.toBe(rebuilt);
  });

  test('a non-empty rebuild or a navigation always wins without validation', async () => {
    const validate = jest.fn();
    const rebuilt = refsOf('e9');
    await expect(chooseRefsAfterRebuild({ rebuilt, existing: refsOf('e1'), sameUrl: true, validate })).resolves.toBe(rebuilt);
    const empty = markRefsIncomplete(new Map(), 'timeout');
    await expect(chooseRefsAfterRebuild({ rebuilt: empty, existing: refsOf('e1'), sameUrl: false, validate })).resolves.toBe(empty);
    expect(validate).not.toHaveBeenCalled();
  });

  test('incomplete marks survive on the map without becoming a ref', () => {
    const refs = markRefsIncomplete(new Map(), 'no_aria_snapshot');
    expect(refsIncompleteReason(refs)).toBe('no_aria_snapshot');
    expect(refs.size).toBe(0);
    expect(refsIncompleteReason(new Map())).toBeNull();
  });
});

describe('retained ref validation', () => {
  test('every retained ref must still be attached', async () => {
    const refs = refsOf('e1', 'e2', 'e3');
    await expect(retainedRefsStillAttached(refs, { isAttached: async () => true })).resolves.toBe(true);
    await expect(retainedRefsStillAttached(refs, { isAttached: async id => id !== 'e2' })).resolves.toBe(false);
    await expect(retainedRefsStillAttached(refs, { isAttached: async () => { throw new Error('detached'); } })).resolves.toBe(false);
    await expect(retainedRefsStillAttached(new Map(), { isAttached: async () => true })).resolves.toBe(false);
  });

  test('a validation that outlives its budget counts as stale', async () => {
    const never = () => new Promise(() => {});
    await expect(retainedRefsStillAttached(refsOf('e1'), { isAttached: never, budgetMs: 20 })).resolves.toBe(false);
  });

  test('one detached ref anywhere in a large map rejects the whole map', async () => {
    const refs = new Map(Array.from({ length: 500 }, (_, i) => [`e${i + 1}`, {}]));
    const checked = [];
    const isAttached = async id => { checked.push(id); return id !== 'e257'; };
    await expect(retainedRefsStillAttached(refs, { isAttached })).resolves.toBe(false);
    // Stops at the batch containing the miss instead of probing every ref.
    expect(checked.length).toBeGreaterThanOrEqual(257);
    expect(checked.length).toBeLessThanOrEqual(272);
  });

  test('all refs are checked when they are attached, in bounded batches', async () => {
    const refs = new Map(Array.from({ length: 100 }, (_, i) => [`e${i + 1}`, {}]));
    let inFlight = 0;
    let peak = 0;
    const isAttached = async () => {
      inFlight++; peak = Math.max(peak, inFlight);
      await new Promise(resolve => setImmediate(resolve));
      inFlight--;
      return true;
    };
    await expect(retainedRefsStillAttached(refs, { isAttached, concurrency: 16 })).resolves.toBe(true);
    expect(peak).toBeLessThanOrEqual(16);
  });

  test('no new checks start after the budget is spent', async () => {
    const refs = new Map(Array.from({ length: 100 }, (_, i) => [`e${i + 1}`, {}]));
    let started = 0;
    const isAttached = () => { started++; return new Promise(() => {}); };
    await expect(retainedRefsStillAttached(refs, { isAttached, budgetMs: 20, concurrency: 16 })).resolves.toBe(false);
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(started).toBe(16);
  });
});

describe('adaptive iframe snapshot budget', () => {
  test('a frame may use the time left minus a minimum reserved for each later frame', () => {
    expect(iframeSnapshotBudgetMs({ remainingMs: 9000, framesLeft: 1 })).toBe(8000);
    expect(iframeSnapshotBudgetMs({ remainingMs: 9000, framesLeft: 3 })).toBe(7000);
    expect(iframeSnapshotBudgetMs({ remainingMs: 6000, framesLeft: 1 })).toBe(6000);
  });

  test('an early slow frame among eight candidates is not starved below the old fixed 3 s', () => {
    expect(iframeSnapshotBudgetMs({ remainingMs: 11000, framesLeft: 8 })).toBeGreaterThan(3000);
  });

  test('never exceeds the remaining deadline and stops when too little time is left', () => {
    expect(iframeSnapshotBudgetMs({ remainingMs: 1500, framesLeft: 4 })).toBe(1000);
    expect(iframeSnapshotBudgetMs({ remainingMs: 999, framesLeft: 1 })).toBe(0);
    expect(iframeSnapshotBudgetMs({ remainingMs: 5000, framesLeft: 0 })).toBe(0);
    for (const remainingMs of [1000, 2500, 7000, 11750]) {
      for (const framesLeft of [1, 2, 8]) {
        expect(iframeSnapshotBudgetMs({ remainingMs, framesLeft })).toBeLessThanOrEqual(remainingMs);
      }
    }
  });

  test('frames that each use their full budget never overrun the deadline; later frames are skipped', () => {
    for (const deadline of [2500, 6000, 11750]) {
      for (const frames of [1, 3, 8, 20]) {
        let remainingMs = deadline;
        let visited = 0;
        for (let i = 0; i < frames; i++) {
          const budget = iframeSnapshotBudgetMs({ remainingMs, framesLeft: frames - i });
          if (!budget) break;
          remainingMs -= budget;
          visited++;
        }
        expect(remainingMs).toBeGreaterThanOrEqual(0);
        expect(visited).toBeLessThanOrEqual(Math.max(1, Math.floor(deadline / 1000)));
      }
    }
  });

  test('a single slow app frame (GHL workflow-builder) gets more than the old fixed 3 s', () => {
    // buildRefs has a 12 s deadline; after a ~3 s main-frame capture about 8.7 s remain.
    expect(iframeSnapshotBudgetMs({ remainingMs: 8750, framesLeft: 1 })).toBeGreaterThan(3000);
  });
});
