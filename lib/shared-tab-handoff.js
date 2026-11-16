import { isQuarantinedPage } from './page-registry.js';

const humanReservations = new WeakMap();

async function applySharedTabHandoff({ tabId, handoff, tabState, session, humanControlledTabs, onAgentControl, nativeOnly = false, log }) {
  if (!tabState || tabState.page?.isClosed?.()) {
    throw Object.assign(new Error('Tab not found'), { statusCode: 404 });
  }
  const check = () => {
    if (isQuarantinedPage(tabState.page)) throw Object.assign(new Error('Tab was destroyed'), { statusCode: 410, code: 'tab_destroyed' });
  };
  check();
  let reservation;
  if (handoff === 'human') {
    reservation = humanReservations.get(tabState) || { pending: 0, committed: humanControlledTabs.has(tabId) };
    if (!reservation.pending) {
      // Timeout recovery awaits this before treating the reservation as a
      // confirmed rescue, so a provisional reservation never yields a final
      // human_handoff_required for a rescue that later fails.
      reservation.settled = new Promise(resolve => { reservation.settle = resolve; });
    }
    reservation.pending++;
    humanReservations.set(tabState, reservation);
  }
  // Reserve before asynchronous visibility work so timeout recovery cannot
  // retire the page being rescued. This does not cancel already-issued input.
  if (handoff === 'human') humanControlledTabs.add(tabId);
  let parkFailure, shown;
  try {
    if (session?.visibility) {
      try {
        if (handoff === 'human') shown = await session.visibility.open(tabState.page, ...(nativeOnly ? [{ nativeOnly: true }] : []));
        else {
          const keep = session.visibility.capability?.().scope === 'identity'
            ? [...session.tabGroups.values()].flatMap(group => [...group])
              .filter(([id, tab]) => id !== tabId && humanControlledTabs.has(id) && tab.page && !tab.page.isClosed?.() && !isQuarantinedPage(tab.page)).map(([, tab]) => tab.page) : [];
          try { await session.visibility.release({ all: false, page: tabState.page, ...(keep.length ? { keep } : {}) }); }
          catch (err) {
            parkFailure = err?.message || String(err);
            log?.('warn', 'agent handoff park failed; agent control returned', { tabId, error: parkFailure });
          }
        }
      } finally {
        session.headed = session.visibility.isVisible?.() ?? session.visibility.visible.size > 0;
      }
    }
    check();
    if (handoff === 'human' && !session?.visibility) await tabState.page.bringToFront();
    tabState.handoff = handoff;
    if (reservation) reservation.committed = true;
    if (handoff === 'agent') {
      const pending = humanReservations.get(tabState);
      if (pending) pending.committed = false;
      if (!pending?.pending) humanControlledTabs.delete(tabId);
      onAgentControl?.();
    }
  } finally {
    if (reservation && --reservation.pending === 0) {
      if (reservation.committed) humanControlledTabs.add(tabId);
      else humanControlledTabs.delete(tabId);
      humanReservations.delete(tabState);
      reservation.settle?.();
    }
  }
  return { handoff, focused: handoff === 'human' && (shown?.focused ?? true),
    ...(shown?.visible !== undefined ? { visible: shown.visible } : {}),
    ...(shown?.targetUnconfirmed ? { targetUnconfirmed: true } : {}),
    ...(nativeOnly ? { operationMayStillBeRunning: true } : {}),
    ...(parkFailure ? { parked: false, reason: parkFailure } : {}) };
}

// Resolves once every in-flight human handoff for this tab has committed or
// rolled back. Never rejects. Handoffs are bounded by their visibility deadline.
function settleHumanReservation(tabState) {
  return (tabState && humanReservations.get(tabState)?.settled) || Promise.resolve();
}

export { applySharedTabHandoff, settleHumanReservation };
