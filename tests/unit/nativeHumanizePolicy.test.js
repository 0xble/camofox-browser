import { jest } from '@jest/globals';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const root = mkdtempSync(path.join(os.tmpdir(), 'humanize-policy-'));
// The shared launcher uses camoufox-js's install directory, not an unrelated
// default cache when CAMOUFOX_INSTALL_DIR selects a different engine.
jest.unstable_mockModule('camoufox-js/dist/pkgman.js', () => ({ INSTALL_DIR: root }));
const { launchSharedIdentityContext } = await import('../../lib/shared-identity-launch.js');
beforeEach(() => mkdirSync(root, { recursive: true }));
afterEach(() => rmSync(root, { recursive: true, force: true }));

async function sharedOptions(metadata, platform = 'darwin') {
  if (metadata !== undefined) writeFileSync(path.join(root, 'version.json'), JSON.stringify(metadata));
  let observed;
  await launchSharedIdentityContext(root, {
    launchOptions: async options => { observed = options; return options; },
    firefox: { launchPersistentContext: async () => ({}) },
    os: { platform: () => platform }, getHostOS: () => 'macos',
    config: { camoufoxCacheDir: root }, events: { emitAsync: async () => {} },
  });
  return observed;
}

test.each([
  ['beta.30', { version: '152.0.4', release: 'beta.30' }, false],
  ['last unsafe beta', { version: '158.0.1', release: 'beta.40' }, false],
  ['beta.41', { version: '158.0.1', release: 'beta.41' }, true],
  ['newer beta', { version: '158.0.1', release: 'beta.42' }, true],
  ['unknown', undefined, false],
  ['malformed', { version: '158.0.1', release: 'beta.nope' }, false],
])('shared launch gates macOS humanize for %s', async (_name, metadata, expected) => {
  expect((await sharedOptions(metadata)).humanize).toBe(expected);
});

test.each(['linux', 'win32'])('humanize stays on with unknown engine on %s', async platform => {
  expect((await sharedOptions(undefined, platform)).humanize).toBe(true);
});

test('ephemeral and shared launch use the same engine-aware policy', async () => {
  const { nativeHumanizeEnabled } = await import('../../lib/camoufox-executable.js');
  for (const file of ['server.js', 'lib/shared-identity-launch.js']) {
    const source = readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');
    expect(source).toMatch(/import\s*\{[^}]*nativeHumanizeEnabled[^}]*\}\s*from\s*['"].*camoufox-executable\.js['"]/);
    expect(source).toMatch(/humanize:\s*nativeHumanizeEnabled\(/);
  }
  const log = jest.fn();
  const options = { platform: 'darwin', cacheDir: root, log };
  expect(nativeHumanizeEnabled(options)).toBe(false);
  expect(nativeHumanizeEnabled(options)).toBe(false);
  expect(log).toHaveBeenCalledTimes(1);
  expect(log).toHaveBeenCalledWith('warn', expect.stringContaining('humanize disabled'), expect.any(Object));
});

test('selected executable metadata wins over a newer default cache, including a symlinked macOS app', async () => {
  const { nativeHumanizeEnabled } = await import('../../lib/camoufox-executable.js');
  writeFileSync(path.join(root, 'version.json'), JSON.stringify({ version: '158.0.1', release: 'beta.41' }));
  const engine = path.join(root, 'old-engine');
  const binary = path.join(engine, 'Camoufox.app', 'Contents', 'MacOS', 'camoufox');
  mkdirSync(path.dirname(binary), { recursive: true });
  writeFileSync(binary, '');
  writeFileSync(path.join(engine, 'version.json'), JSON.stringify({ version: '152.0.4', release: 'beta.30' }));
  const selected = path.join(root, 'selected');
  symlinkSync(binary, selected);
  expect(nativeHumanizeEnabled({ platform: 'darwin', executablePath: selected, cacheDir: root })).toBe(false);
  rmSync(path.join(engine, 'version.json'));
  expect(nativeHumanizeEnabled({ platform: 'darwin', executablePath: selected, cacheDir: root })).toBe(false);
});
