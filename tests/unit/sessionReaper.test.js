import { shouldCloseEmptySession } from '../../lib/session-reaper.js';

describe('empty session reaper eligibility', () => {
  const now = 1_000_000;

  test('does not reap a recently accessed empty session', () => {
    const session = { tabGroups: new Map(), pageLeases: new Set(), lastAccess: now - 5_000 };

    expect(shouldCloseEmptySession(session, now, { sessionTimeoutMs: 30_000, graceMs: 10_000 })).toBe(false);
  });

  test('reaps an old empty session after the effective grace period', () => {
    const session = { tabGroups: new Map(), pageLeases: new Set(), lastAccess: now - 31_000 };

    expect(shouldCloseEmptySession(session, now, { sessionTimeoutMs: 30_000, graceMs: 10_000 })).toBe(true);
  });

  test('does not reap a session with a pending page lease', () => {
    const session = { tabGroups: new Map(), pageLeases: new Set([{}]), lastAccess: now - 60_000 };

    expect(shouldCloseEmptySession(session, now, { sessionTimeoutMs: 30_000, graceMs: 10_000 })).toBe(false);
  });

  test('does not reap a session that still has tabs', () => {
    const session = { tabGroups: new Map([['task', new Map([['tab', {}]])]]), pageLeases: new Set(), lastAccess: now - 60_000 };

    expect(shouldCloseEmptySession(session, now, { sessionTimeoutMs: 30_000, graceMs: 10_000 })).toBe(false);
  });
});
