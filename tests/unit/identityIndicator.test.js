import { jest } from '@jest/globals';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  INDICATOR_PALETTE, contrastRatio, identityIndicator, indicatorAddonFiles, writeIndicatorAddon,
} from '../../lib/identity-indicator.js';
import { launchSharedIdentityContext } from '../../lib/shared-identity-launch.js';

const id = c => `hermes_camofox_${c.repeat(24)}`;
const aliases = { meridian: id('c'), brianle: id('a'), lpg: id('b') };

describe('identity indicator table', () => {
  test('colors come from the shared identity map by sorted alias, not per-alias code', () => {
    expect(identityIndicator(aliases, id('a'))).toMatchObject({ alias: 'brianle', name: 'blue' });
    expect(identityIndicator(aliases, id('b'))).toMatchObject({ alias: 'lpg', name: 'green' });
    expect(identityIndicator(aliases, id('c'))).toMatchObject({ alias: 'meridian', name: 'purple' });
    expect(identityIndicator(aliases, 'lpg')).toMatchObject({ alias: 'lpg' });
    expect(identityIndicator(aliases, id('d'))).toBeNull();
    expect(identityIndicator(undefined, id('a'))).toBeNull();
  });

  test('palette colors are distinct and keep white text and labels accessible (WCAG AA)', () => {
    expect(new Set(INDICATOR_PALETTE.map(row => row.toolbar)).size).toBe(INDICATOR_PALETTE.length);
    for (const { toolbar, frame } of INDICATOR_PALETTE) {
      expect(contrastRatio(toolbar, '#ffffff')).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(frame, '#ffffff')).toBeGreaterThanOrEqual(4.5);
    }
  });

  test('the generated extension only themes chrome: no content scripts or page-visible resources', () => {
    const files = indicatorAddonFiles(identityIndicator(aliases, id('b')));
    const manifest = JSON.parse(files['manifest.json']);
    expect(manifest.permissions).toEqual(['theme']);
    expect(manifest.content_scripts).toBeUndefined();
    expect(manifest.web_accessible_resources).toBeUndefined();
    expect(files['background.js']).toContain('browser.theme.update');
    expect(files['background.js']).toContain('#047857');
    expect(files['label.svg']).toContain('>lpg</text>');
  });

  test('writing is content-addressed and idempotent', async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'indicator-'));
    try {
      const indicator = identityIndicator(aliases, id('a'));
      const first = await writeIndicatorAddon(indicator, { rootDir });
      const second = await writeIndicatorAddon(indicator, { rootDir });
      expect(second).toBe(first);
      expect(JSON.parse(await fs.readFile(path.join(first, 'manifest.json'), 'utf8')).name).toBe('Camofox identity: brianle');
    } finally {
      await fs.rm(rootDir, { recursive: true, force: true });
    }
  });
});

describe('indicator at launch', () => {
  let profile;
  const launched = [];
  const firefox = { launchPersistentContext: jest.fn(async (_profile, options) => { launched.push(options); return { on() {}, close: async () => {} }; }) };
  const launch = (headed, indicator) => launchSharedIdentityContext(profile, {
    headed, indicator, firefox, launchOptions: async options => ({ ...options }), os: { platform: () => 'darwin' },
    getHostOS: () => 'macos', config: {}, events: { emitAsync: async () => {} },
  });

  beforeEach(async () => {
    profile = await fs.mkdtemp(path.join(os.tmpdir(), 'indicator-profile-'));
    launched.length = 0;
  });
  afterEach(async () => fs.rm(profile, { recursive: true, force: true }));

  test('headed launches of a mapped identity load the indicator add-on', async () => {
    await launch(true, identityIndicator(aliases, id('a')));
    expect(launched).toHaveLength(1);
    expect(launched[0].headless).toBe(false);
    expect(launched[0].addons).toHaveLength(1);
    expect(await fs.readFile(path.join(launched[0].addons[0], 'background.js'), 'utf8')).toContain('#1d4ed8');
  });

  test('headless launches and unmapped identities are unchanged, and nothing is written to the profile', async () => {
    await launch(false, identityIndicator(aliases, id('a')));
    await launch(true, null);
    expect(launched.map(options => options.addons)).toEqual([undefined, undefined]);
    expect(await fs.readdir(profile)).toEqual([]);
  });
});
