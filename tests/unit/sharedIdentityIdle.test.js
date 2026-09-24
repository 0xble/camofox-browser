import { describe, test, expect, jest } from '@jest/globals';
import { createSharedIdentityIdlePolicy } from '../../lib/shared-identity-idle.js';

describe('shared identity idle policy', () => {
  test('releases headed only at the HID threshold and fails closed on null', async () => {
    const read = jest.fn().mockResolvedValue(null);
    const policy = createSharedIdentityIdlePolicy({ readIdleSeconds: read, clock: () => 10_000_000 });
    await expect(policy.shouldReleaseHeaded(30)).resolves.toBe(false);
    read.mockResolvedValue(1799);
    await expect(policy.shouldReleaseHeaded(30)).resolves.toBe(false);
    read.mockResolvedValue(1800);
    await expect(policy.shouldReleaseHeaded(30)).resolves.toBe(true);
    await expect(policy.shouldReleaseHeaded(0)).resolves.toBe(false);
    expect(read).toHaveBeenCalledTimes(3);
  });

  test('hidden cleanup measures agent activity independently of HID', () => {
    const read = jest.fn();
    const policy = createSharedIdentityIdlePolicy({ readIdleSeconds: read, clock: () => 10_000_000 });
    expect(policy.agentIdle(8_200_000, 30)).toBe(true);
    expect(policy.agentIdle(8_200_001, 30)).toBe(false);
    expect(policy.agentIdle(0, 0)).toBe(false);
    expect(read).not.toHaveBeenCalled();
  });
});
