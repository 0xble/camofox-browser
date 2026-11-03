import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PENDING_ACTIVATION_FILE, launchSharedIdentityContext } from '../../lib/shared-identity-launch.js';

const directIdentity = { locale: 'en-US', timezoneId: 'America/Los_Angeles' };
const serverSource = readFileSync(fileURLToPath(new URL('../../server.js', import.meta.url)), 'utf8');

describe('shared identity persistent launch identity', () => {
  let profile;

  beforeEach(async () => {
    profile = await fs.mkdtemp(path.join(os.tmpdir(), 'shared-identity-locale-'));
  });

  afterEach(async () => {
    await fs.rm(profile, { recursive: true, force: true });
  });

  async function launch({ hasProxy, headed = false, warmup = false, identity = directIdentity }) {
    if (warmup) await fs.writeFile(path.join(profile, PENDING_ACTIVATION_FILE), '');
    const fingerprint = [];
    const contexts = [];
    const firefox = {
      launchPersistentContext: jest.fn(async (_profile, options) => {
        contexts.push(options);
        return { close: async () => {} };
      }),
    };
    const launchOptions = jest.fn(async (options) => {
      fingerprint.push({ ...options });
      return { ...options, fromFingerprint: true };
    });
    await launchSharedIdentityContext(profile, {
      extensions: [],
      firefox,
      launchOptions,
      os: { platform: () => 'darwin' },
      getHostOS: () => 'macos',
      config: { directIdentity: identity },
      hasProxy,
      headed,
      events: { emitAsync: async () => {} },
    });
    return { fingerprint, contexts };
  }

  test('applies the configured direct identity to the fingerprint and the persistent context', async () => {
    const { fingerprint, contexts } = await launch({ hasProxy: false });

    expect(fingerprint[0].locale).toBe(directIdentity.locale);
    expect(fingerprint[0]).not.toHaveProperty('timezoneId');
    expect(fingerprint[0]).not.toHaveProperty('geolocation');
    expect(contexts[0]).toMatchObject({
      locale: directIdentity.locale,
      timezoneId: directIdentity.timezoneId,
    });
    expect(contexts[0]).not.toHaveProperty('geolocation');
  });

  test('leaves locale and timezone to the proxy when one is set', async () => {
    const { fingerprint, contexts } = await launch({ hasProxy: true });

    expect(fingerprint[0].locale).toBeUndefined();
    expect(contexts[0].locale).toBeUndefined();
    expect(contexts[0].timezoneId).toBeUndefined();
    expect(fingerprint[0]).not.toHaveProperty('geolocation');
    expect(contexts[0]).not.toHaveProperty('geolocation');
    // Shared persistent contexts are never proxied or GeoIP-spoofed, so the
    // ephemeral proxy path's geolocation grant must not leak onto them.
    expect(contexts[0]).not.toHaveProperty('permissions');
  });

  test('warm-up and headed launches receive the same configured identity', async () => {
    const { fingerprint, contexts } = await launch({ hasProxy: false, headed: true, warmup: true });
    expect(fingerprint.map(options => options.headless)).toEqual([true, false]);
    expect(contexts).toHaveLength(2);
    for (let index = 0; index < contexts.length; index++) {
      expect(fingerprint[index].locale).toBe(directIdentity.locale);
      expect(contexts[index]).toMatchObject(directIdentity);
      expect(contexts[index]).not.toHaveProperty('geolocation');
    }
  });

  test('leaves an unconfigured direct identity untouched', async () => {
    const { fingerprint, contexts } = await launch({ hasProxy: false, identity: null });
    expect(fingerprint[0]).not.toHaveProperty('locale');
    expect(contexts[0]).not.toHaveProperty('locale');
    expect(contexts[0]).not.toHaveProperty('timezoneId');
    expect(contexts[0]).not.toHaveProperty('geolocation');
    expect(contexts[0]).not.toHaveProperty('permissions');
  });

  test('the shared-identity opener uses the same proxy signal as ephemeral contexts', () => {
    const opener = serverSource.slice(
      serverSource.indexOf('async function createSharedIdentityContext'),
      serverSource.indexOf('async function getSession'),
    );
    expect(opener).toContain('hasProxy: !!proxyPool');
    expect(opener).toContain('config: CONFIG');
    expect(opener).not.toContain('geolocation:');
  });
});
