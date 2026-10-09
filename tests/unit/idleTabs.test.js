/**
 * Idle-tab timeout for non-shared sessions (CAMOFOX_HIDDEN_TAB_IDLE_MIN).
 *
 * A session stays alive while any tab is in use, so an abandoned sibling tab
 * used to live as long as the session. The sweep reuses the shared-identity
 * closability rules: never the most recent tab, nor one with a lock, lease,
 * download or human handoff.
 */
import { describe, test, expect, jest } from '@jest/globals';
import { acquirePageLease, setLeasedPage } from '../../lib/page-lease.js';
import { sweepIdleEphemeralTabs, tabClosable } from '../../lib/idle-tabs.js';
import { createSharedIdentityIdlePolicy } from '../../lib/shared-identity-idle.js';

const NOW = 10_000_000;
const MIN = 30;
const IDLE_AT = NOW - 31 * 60_000;
const ACTIVE_AT = NOW - 60_000;

function tab(lastAgentActivityAt, extra = {}) {
  return { page: { id: Math.random() }, lastAgentActivityAt, toolCalls: 0, ...extra };
}

function setup(tabs, { sharedIdentity = false, locks = new Map(), human = new Set() } = {}) {
  const session = { sharedIdentity, keepOpen: sharedIdentity, tabGroups: new Map([['task_1', new Map(Object.entries(tabs))]]) };
  const sessions = new Map([['hermes_1', session]]);
  const policy = createSharedIdentityIdlePolicy({ readIdleSeconds: async () => null, clock: () => NOW });
  const closeTab = jest.fn(async (s, tabId) => {
    for (const group of s.tabGroups.values()) group.delete(tabId);
    return true;
  });
  const run = () => sweepIdleEphemeralTabs({
    sessions, minutes: MIN, agentIdle: policy.agentIdle, now: () => NOW,
    closable: (s, tabId, t, latestTabId) => tabClosable({ session: s, tabId, tab: t, latestTabId, tabLocks: locks, humanControlledTabs: human }),
    closeTab,
  });
  return { session, sessions, closeTab, run };
}

describe('idle tab sweep for non-shared sessions', () => {
  test('closes an idle tab while its active sibling stays open', async () => {
    const { session, sessions, closeTab, run } = setup({ idle: tab(IDLE_AT), active: tab(ACTIVE_AT) });
    await expect(run()).resolves.toEqual(['idle']);
    expect(closeTab).toHaveBeenCalledWith(session, 'idle', expect.anything(), { userId: 'hermes_1', reason: 'idle_tab' });
    expect([...session.tabGroups.get('task_1').keys()]).toEqual(['active']);
    expect(sessions.has('hermes_1')).toBe(true);
  });

  test('busy tabs (lock, queued lock, lease, download, human handoff) are not closed', async () => {
    const tabs = {
      locked: tab(IDLE_AT), queued: tab(IDLE_AT), leased: tab(IDLE_AT),
      downloading: tab(IDLE_AT, { activeDownloads: 1 }), handedOff: tab(IDLE_AT), active: tab(ACTIVE_AT),
    };
    const locks = new Map([['locked', { active: true, queue: [] }], ['queued', { active: false, queue: [{}] }]]);
    const { session, closeTab, run } = setup(tabs, { locks, human: new Set(['handedOff']) });
    setLeasedPage(acquirePageLease(session), tabs.leased.page);
    await expect(run()).resolves.toEqual([]);
    expect(closeTab).not.toHaveBeenCalled();
    expect(session.tabGroups.get('task_1').size).toBe(6);
  });

  test('keeps the most recent tab even when every tab is idle', async () => {
    const { session, run } = setup({ older: tab(IDLE_AT - 1000), newest: tab(IDLE_AT) });
    await expect(run()).resolves.toEqual(['older']);
    expect([...session.tabGroups.get('task_1').keys()]).toEqual(['newest']);
  });

  test('a tool call since the last sweep counts as activity', async () => {
    const stale = tab(IDLE_AT);
    const { closeTab, run } = setup({ stale, active: tab(ACTIVE_AT) });
    stale._idleSweepToolCalls = 0;
    stale.toolCalls = 1;
    await expect(run()).resolves.toEqual([]);
    expect(closeTab).not.toHaveBeenCalled();
    expect(stale.lastAgentActivityAt).toBe(NOW);
  });

  test('skips shared, closing and keep-open sessions, and is disabled by 0', async () => {
    const shared = setup({ idle: tab(IDLE_AT), active: tab(ACTIVE_AT) }, { sharedIdentity: true });
    await expect(shared.run()).resolves.toEqual([]);

    const closing = setup({ idle: tab(IDLE_AT), active: tab(ACTIVE_AT) });
    closing.session._closing = true;
    await expect(closing.run()).resolves.toEqual([]);

    const disabled = setup({ idle: tab(IDLE_AT), active: tab(ACTIVE_AT) });
    await expect(sweepIdleEphemeralTabs({
      sessions: disabled.sessions, minutes: 0, agentIdle: () => true, closable: () => true, closeTab: disabled.closeTab,
    })).resolves.toEqual([]);
    expect(disabled.closeTab).not.toHaveBeenCalled();
  });
});
