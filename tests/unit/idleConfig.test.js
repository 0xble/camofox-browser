import { afterEach, describe, expect, test } from '@jest/globals';
import { loadConfig } from '../../lib/config.js';

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('shared idle release configuration', () => {
  test('uses minute defaults and forwards the three independent settings', () => {
    delete process.env.CAMOFOX_HEADED_IDLE_RELEASE_MIN;
    delete process.env.CAMOFOX_HIDDEN_TAB_IDLE_MIN;
    delete process.env.CAMOFOX_HIDDEN_SESSION_IDLE_MIN;

    const config = loadConfig();

    expect(config.headedIdleReleaseMin).toBe(30);
    expect(config.hiddenTabIdleMin).toBe(30);
    expect(config.hiddenSessionIdleMin).toBe(120);
    expect(config.serverEnv).toMatchObject({
      CAMOFOX_HEADED_IDLE_RELEASE_MIN: undefined,
      CAMOFOX_HIDDEN_TAB_IDLE_MIN: undefined,
      CAMOFOX_HIDDEN_SESSION_IDLE_MIN: undefined,
    });
  });

  test('accepts integer minutes including zero as disabled', () => {
    process.env.CAMOFOX_HEADED_IDLE_RELEASE_MIN = '0';
    process.env.CAMOFOX_HIDDEN_TAB_IDLE_MIN = '45';
    process.env.CAMOFOX_HIDDEN_SESSION_IDLE_MIN = '180';

    expect(loadConfig()).toMatchObject({
      headedIdleReleaseMin: 0,
      hiddenTabIdleMin: 45,
      hiddenSessionIdleMin: 180,
    });
  });

  test('uses the documented default for invalid values', () => {
    process.env.CAMOFOX_HEADED_IDLE_RELEASE_MIN = '30.5';
    process.env.CAMOFOX_HIDDEN_TAB_IDLE_MIN = '-1';
    process.env.CAMOFOX_HIDDEN_SESSION_IDLE_MIN = 'nope';

    expect(loadConfig()).toMatchObject({
      headedIdleReleaseMin: 30,
      hiddenTabIdleMin: 30,
      hiddenSessionIdleMin: 120,
    });
  });
});
