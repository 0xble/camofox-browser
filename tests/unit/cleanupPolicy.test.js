import { createProfileCleanupGuard } from '../../lib/cleanup-policy.js';

test('profile cleanup guard warns once while a live profile path is unavailable', () => {
  const unavailable = jest.fn();
  const guard = createProfileCleanupGuard(unavailable);
  const browser = {};

  expect(guard({ browser, protectedPaths: new Set() })).toBeNull();
  expect(guard({ browser, protectedPaths: new Set() })).toBeNull();
  expect(unavailable).toHaveBeenCalledTimes(1);

  const liveProfile = new Set(['/tmp/live-profile']);
  expect(guard({ browser, protectedPaths: liveProfile })).toBe(liveProfile);
  expect(guard({ browser, protectedPaths: new Set() })).toBeNull();
  expect(unavailable).toHaveBeenCalledTimes(2);

  expect(guard({ browser: null, protectedPaths: new Set() })).toEqual(new Set());
});