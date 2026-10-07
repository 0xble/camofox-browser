import path from 'node:path';
import { jest } from '@jest/globals';
import { createProfileCleanupGuard } from '../../lib/cleanup-policy.js';
import { darwinDescendantProfilePaths, parseDarwinProcesses, snapshotDarwinProcesses } from '../../lib/darwin-processes.js';
import { liveBrowserProfilePaths } from '../../lib/process-ownership.js';

const PS_OUTPUT = `
  100     1 /opt/node/bin/node --max-old-space-size=512 /srv/camofox/server.js
  101   100 /Users/u/Library/Caches/camoufox/Camoufox.app/Contents/MacOS/camoufox -no-remote -headless -profile /tmp/playwright_firefoxdev_profile-live -juggler-pipe -silent
  102   100 /Users/u/Library/Caches/camoufox/Camoufox.app/Contents/MacOS/camoufox -no-remote -headless -profile /Users/u/My Profiles/shared -juggler-pipe about:blank
  103   101 /Users/u/Library/Caches/camoufox/Camoufox.app/Contents/MacOS/plugin-container.app/Contents/MacOS/plugin-container -isForBrowser -profile /tmp/playwright_firefoxdev_profile-live org.mozilla.machname.1 8 tab
  200     1 /opt/node/bin/node /other/server.js
  201   200 /Users/u/Library/Caches/camoufox/Camoufox.app/Contents/MacOS/camoufox -no-remote -profile /tmp/playwright_firefoxdev_profile-other -juggler-pipe
`;

describe('macOS live profile discovery', () => {
  test('reads only browser main processes owned by this server, including paths with spaces', () => {
    const profiles = darwinDescendantProfilePaths(100, parseDarwinProcesses(PS_OUTPUT));
    expect(profiles).toEqual([
      path.resolve('/tmp/playwright_firefoxdev_profile-live'),
      path.resolve('/Users/u/My Profiles/shared'),
    ]);
  });

  test('liveBrowserProfilePaths uses ps on darwin and reports null when ps fails', () => {
    expect(liveBrowserProfilePaths(100, { platform: 'darwin', darwinSnapshot: () => parseDarwinProcesses(PS_OUTPUT) }))
      .toEqual(new Set([path.resolve('/tmp/playwright_firefoxdev_profile-live'), path.resolve('/Users/u/My Profiles/shared')]));
    expect(liveBrowserProfilePaths(100, { platform: 'darwin', darwinSnapshot: () => null })).toBeNull();
    expect(snapshotDarwinProcesses({ execFile: () => { throw new Error('ps missing'); } })).toBeNull();
  });

  (process.platform === 'darwin' ? test : test.skip)('real ps output parses this process tree', () => {
    const processes = snapshotDarwinProcesses();
    expect(processes).not.toBeNull();
    expect(processes.some(proc => proc.pid === process.pid && proc.ppid === process.ppid)).toBe(true);
  });
});

describe('periodic profile cleanup guard', () => {
  test('warns once per unavailable stretch and never cleans while a live browser profile is unknown', () => {
    const unavailable = jest.fn();
    const guard = createProfileCleanupGuard(unavailable);

    expect(guard({ browserRunning: true, protectedPaths: new Set() })).toBeNull();
    expect(guard({ browserRunning: true, protectedPaths: null })).toBeNull();
    expect(unavailable).toHaveBeenCalledTimes(1);

    const live = new Set(['/tmp/live-profile']);
    expect(guard({ browserRunning: true, protectedPaths: live })).toBe(live);
    expect(guard({ browserRunning: true, protectedPaths: new Set() })).toBeNull();
    expect(unavailable).toHaveBeenCalledTimes(2);

    expect(guard({ browserRunning: false, protectedPaths: null })).toEqual(new Set());
  });
});
