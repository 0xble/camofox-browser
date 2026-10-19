import { handleTabTimeout } from '../../lib/tab-timeout.js';

describe('tab timeout handling', () => {
  function setup({ responsive = true, human = false } = {}) {
    const tabState = { page: {}, consecutiveTimeouts: 0 };
    const session = {};
    const destroyed = [];
    const logs = [];
    return {
      tabState,
      session,
      destroyed,
      logs,
      findTab: () => ({ tabState, session }),
      isHumanControlled: () => human,
      probeLiveness: async () => responsive,
      destroyTab: async (...args) => { destroyed.push(args); return true; },
      log: (_level, message, fields) => logs.push({ message, fields }),
    };
  }

  test('a single slow click is recoverable and keeps the tab', async () => {
    const state = setup({ responsive: false });

    const result = await handleTabTimeout({ tabId: 'tab-1', userId: 'user-1', ...state });

    expect(result).toMatchObject({ destroyed: false, reason: 'timeout_recorded', streak: 1 });
    expect(state.destroyed).toHaveLength(0);
  });

  test('navigation in flight is preserved without incrementing the timeout streak', async () => {
    const state = setup({ responsive: false });
    state.isNavigationInFlight = () => true;

    const result = await handleTabTimeout({ tabId: 'tab-1', userId: 'user-1', ...state });

    expect(result).toMatchObject({ destroyed: false, reason: 'navigation_in_flight' });
    expect(state.tabState.consecutiveTimeouts).toBe(0);
    expect(state.destroyed).toHaveLength(0);
  });

  test('repeated timeouts destroy only after a failed liveness probe', async () => {
    const state = setup({ responsive: false });
    await handleTabTimeout({ tabId: 'tab-1', userId: 'user-1', ...state });
    await handleTabTimeout({ tabId: 'tab-1', userId: 'user-1', ...state });
    const result = await handleTabTimeout({ tabId: 'tab-1', userId: 'user-1', ...state });

    expect(result).toMatchObject({ destroyed: true, reason: 'unresponsive_after_timeouts' });
    expect(state.destroyed).toEqual([[state.session, 'tab-1', 'unresponsive_after_timeouts', 'user-1']]);
  });

  test('a responsive tab is preserved and its timeout streak resets', async () => {
    const state = setup({ responsive: true });

    await handleTabTimeout({ tabId: 'tab-1', userId: 'user-1', ...state });
    await handleTabTimeout({ tabId: 'tab-1', userId: 'user-1', ...state });
    const result = await handleTabTimeout({ tabId: 'tab-1', userId: 'user-1', ...state });

    expect(result).toMatchObject({ destroyed: false, reason: 'liveness_ok' });
    expect(state.destroyed).toHaveLength(0);
    expect(state.tabState.consecutiveTimeouts).toBe(0);
  });

  test('human-controlled tabs are never destroyed', async () => {
    const state = setup({ responsive: false, human: true });

    for (let i = 0; i < 5; i++) {
      await handleTabTimeout({ tabId: 'tab-1', userId: 'user-1', ...state });
    }

    expect(state.destroyed).toHaveLength(0);
  });
});
