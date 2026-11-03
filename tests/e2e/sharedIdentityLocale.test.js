import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { firefox } from 'playwright-core';
import { launchOptions } from 'camoufox-js';
import { launchSharedIdentityContext } from '../../lib/shared-identity-launch.js';

describe('shared persistent context direct identity', () => {
  test.each([
    { locale: 'en-US', timezoneId: 'America/Los_Angeles' },
    { locale: 'en-AU', timezoneId: 'Australia/Sydney' },
  ])('the page reports $locale / $timezoneId after a persistent launch', async (directIdentity) => {
    const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'camofox-shared-identity-locale-'));
    let context;
    try {
      context = await launchSharedIdentityContext(profile, {
        extensions: [],
        firefox,
        launchOptions,
        os,
        getHostOS: () => process.platform === 'darwin' ? 'macos' : 'linux',
        config: { directIdentity, disableDefaultAddons: true },
        hasProxy: false,
        events: { emitAsync: async () => {} },
      });
      const page = await context.newPage();
      await page.goto('data:text/html,<title>Direct identity fixture</title>');
      const identity = await page.evaluate(() => ({
        language: navigator.language,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      }));
      expect(identity).toEqual({ language: directIdentity.locale, timezone: directIdentity.timezoneId });
    } finally {
      await context?.close().catch(() => {});
      await fs.rm(profile, { recursive: true, force: true });
    }
  }, 60_000);
});
