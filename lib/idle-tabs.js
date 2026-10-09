import { isPageLeased } from './page-lease.js';
import { tabIdsForPage } from './page-registry.js';
import { isEligibleForAutomaticCleanup } from './cleanup-policy.js';

function registeredTab(session, tabId) {
  for (const group of session.tabGroups.values()) {
    if (group.has(tabId)) return group.get(tabId);
  }
  return undefined;
}

// A tab may be closed by an idle sweep only when nothing could be using it
// right now: no active or queued lock, no page lease, no human handoff and no
// download. Rechecked immediately before close so a request that arrived since
// candidate selection is never cut off. The most recently used tab is kept.
export function tabClosable({ session, tabId, tab, latestTabId, tabLocks, humanControlledTabs }) {
  const lock = tabLocks.get(tabId);
  return tabId !== latestTabId && registeredTab(session, tabId) === tab
    && tabIdsForPage(session, tab.page).length === 1
    && !isPageLeased(session, tab.page) && !humanControlledTabs.has(tabId) && !(tab.activeDownloads > 0)
    && !lock?.active && !lock?.queue?.length;
}

export function latestAgentTabId(session) {
  let latest = null;
  for (const group of session.tabGroups.values()) {
    for (const [tabId, tab] of group) if (!latest || tab.lastAgentActivityAt > latest[1].lastAgentActivityAt) latest = [tabId, tab];
  }
  return latest?.[0];
}

// Idle-tab timeout for ephemeral (non-shared) sessions. The shared-identity
// sweep handles shared sessions. A session stays alive while any of its tabs is
// in use, so without this an abandoned sibling tab lives as long as the session.
export async function sweepIdleEphemeralTabs({ sessions, minutes, agentIdle, closable, closeTab, now = Date.now }) {
  const closed = [];
  if (!minutes) return closed;
  for (const [userId, session] of [...sessions]) {
    if (session.sharedIdentity || !isEligibleForAutomaticCleanup(session)) continue;
    const tabs = [...session.tabGroups.values()].flatMap(group => [...group.entries()]);
    // Legacy routes address tabs by targetId outside /tabs/:tabId and only
    // bump toolCalls, so a tool call since the last sweep counts as activity.
    for (const [, tab] of tabs) {
      if (tab._idleSweepToolCalls !== undefined && tab._idleSweepToolCalls !== tab.toolCalls) {
        tab.lastAgentActivityAt = Math.max(tab.lastAgentActivityAt || 0, now());
      }
      tab._idleSweepToolCalls = tab.toolCalls;
    }
    const latestTabId = latestAgentTabId(session);
    for (const [tabId, tab] of tabs) {
      if (sessions.get(userId) !== session || session._closing) break;
      if (!agentIdle(tab.lastAgentActivityAt, minutes) || !closable(session, tabId, tab, latestTabId)) continue;
      if (await closeTab(session, tabId, tab, { userId, reason: 'idle_tab' })) closed.push(tabId);
    }
  }
  return closed;
}
