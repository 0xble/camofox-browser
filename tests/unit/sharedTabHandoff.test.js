import { describe, expect, jest, test } from '@jest/globals';
import { applySharedTabHandoff } from '../../lib/shared-tab-handoff.js';

describe('applySharedTabHandoff', () => {
  test('focuses exactly the transferred page and blocks it from agent operations', async () => {
    const target = { isClosed: () => false, bringToFront: jest.fn(async () => {}) };
    const unrelated = { bringToFront: jest.fn(async () => {}) };
    const tabState = { page: target, handoff: 'agent' };
    const humanControlledTabs = new Set();

    await expect(applySharedTabHandoff({ tabId: 'target', handoff: 'human', tabState, humanControlledTabs }))
      .resolves.toEqual({ handoff: 'human', focused: true });
    expect(target.bringToFront).toHaveBeenCalledTimes(1);
    expect(unrelated.bringToFront).not.toHaveBeenCalled();
    expect(humanControlledTabs.has('target')).toBe(true);

    await applySharedTabHandoff({ tabId: 'target', handoff: 'agent', tabState, humanControlledTabs });
    expect(humanControlledTabs.has('target')).toBe(false);
    expect(target.bringToFront).toHaveBeenCalledTimes(1);
  });

  test('does not transfer a closed or missing tab', async () => {
    await expect(applySharedTabHandoff({ tabId: 'missing', handoff: 'human', humanControlledTabs: new Set() }))
      .rejects.toMatchObject({ statusCode: 404 });
  });
});
