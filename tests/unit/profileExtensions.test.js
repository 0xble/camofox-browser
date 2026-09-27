import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  MANAGED_EXTENSIONS_FILE,
  extensionsForIdentity,
  parseSharedIdentityExtensions,
  syncProfileExtensions,
} from '../../lib/profile-extensions.js';
import { PENDING_ACTIVATION_FILE, launchSharedIdentityContext } from '../../lib/shared-identity-launch.js';
import { SharedIdentityManager } from '../../lib/shared-identity.js';
import { loadConfig } from '../../lib/config.js';

const ORIGINAL_ENV = { ...process.env };
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

let root, artifacts, profile;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'profile-extensions-'));
  artifacts = path.join(root, 'artifacts');
  profile = path.join(root, 'profile');
  await fs.mkdir(artifacts);
  await fs.mkdir(profile);
});
afterEach(async () => {
  process.env = { ...ORIGINAL_ENV };
  await fs.rm(root, { recursive: true, force: true });
});

async function artifact(name, content) {
  const file = path.join(artifacts, name);
  await fs.writeFile(file, content);
  return { path: file, sha256: sha(Buffer.from(content)) };
}
const installed = async () => (await fs.readdir(path.join(profile, 'extensions')).catch(() => [])).sort();

describe('parseSharedIdentityExtensions', () => {
  const spec = { id: 'uBlock0@raymondhill.net', path: '/abs/ubo.xpi', sha256: 'a'.repeat(64) };

  test('resolves aliases to the exact server-visible userId', () => {
    const parsed = parseSharedIdentityExtensions(
      JSON.stringify({ brianle: [spec], hermes_camofox_raw: [spec] }),
      { brianle: 'hermes_camofox_personal' },
    );
    expect(parsed).toEqual({ hermes_camofox_personal: [spec], hermes_camofox_raw: [spec] });
  });

  test('unset or empty configuration manages nothing', () => {
    expect(parseSharedIdentityExtensions(undefined)).toEqual({});
    expect(parseSharedIdentityExtensions('')).toEqual({});
  });

  test.each([
    ['relative artifact path', { ...spec, path: 'ubo.xpi' }],
    ['non-hex checksum', { ...spec, sha256: 'not-a-checksum' }],
    ['path-like extension id', { ...spec, id: '../escape' }],
  ])('rejects only the identity with an invalid entry: %s', (_label, bad) => {
    const log = jest.fn();
    const parsed = parseSharedIdentityExtensions(JSON.stringify({ bad: [bad], good: [spec] }), {}, log);
    expect(parsed).toEqual({ bad: null, good: [spec] });
    expect(log).toHaveBeenCalledWith('error', expect.any(String), { identity: 'bad' });
  });

  test('duplicate ids mark the identity invalid; malformed JSON invalidates all', () => {
    expect(parseSharedIdentityExtensions(JSON.stringify({ a: [spec, spec] }), {}, () => {})).toEqual({ a: null });
    expect(parseSharedIdentityExtensions('{nope', {}, () => {})).toBeNull();
    expect(parseSharedIdentityExtensions('[]', {}, () => {})).toBeNull();
  });

  test.each([
    ['alias then raw userId, invalid first', { brianle: [{ ...spec, sha256: 'typo' }], hermes_camofox_personal: [] }],
    ['raw userId then alias, invalid last', { hermes_camofox_personal: [], brianle: [{ ...spec, sha256: 'typo' }] }],
    ['alias and raw userId both valid', { brianle: [spec], hermes_camofox_personal: [] }],
    ['two aliases for one userId', { brianle: [spec], me: [] }],
  ])('duplicate resolved identities are invalid regardless of order: %s', (_label, config) => {
    const log = jest.fn();
    const parsed = parseSharedIdentityExtensions(
      JSON.stringify(config), { brianle: 'hermes_camofox_personal', me: 'hermes_camofox_personal' }, log,
    );
    expect(parsed).toEqual({ hermes_camofox_personal: null });
    expect(extensionsForIdentity(parsed, 'hermes_camofox_personal')).toBeNull();
    expect(log).toHaveBeenCalledWith('error', expect.stringContaining('more than once'), expect.any(Object));
  });

  test('extensionsForIdentity distinguishes unconfigured from invalid', () => {
    expect(extensionsForIdentity({}, 'x')).toEqual([]);
    expect(extensionsForIdentity({ x: [spec] }, 'x')).toEqual([spec]);
    expect(extensionsForIdentity({ x: null }, 'x')).toBeNull();
    expect(extensionsForIdentity(null, 'x')).toBeNull();
  });

  test('loadConfig exposes the parsed map and forwards the raw variable', () => {
    process.env.CAMOFOX_SHARED_IDENTITY_MAP = JSON.stringify({ brianle: 'hermes_camofox_personal' });
    process.env.CAMOFOX_SHARED_IDENTITY_EXTENSIONS = JSON.stringify({ brianle: [spec] });
    const config = loadConfig();
    expect(config.sharedIdentityExtensions).toEqual({ hermes_camofox_personal: [spec] });
    expect(config.serverEnv.CAMOFOX_SHARED_IDENTITY_EXTENSIONS).toBe(process.env.CAMOFOX_SHARED_IDENTITY_EXTENSIONS);
  });

  test('loadConfig defaults to no managed extensions', () => {
    delete process.env.CAMOFOX_SHARED_IDENTITY_EXTENSIONS;
    expect(loadConfig().sharedIdentityExtensions).toEqual({});
  });
});

describe('syncProfileExtensions', () => {
  test('no configuration and no prior record leaves the profile untouched', async () => {
    const summary = await syncProfileExtensions(profile, []);
    expect(summary).toEqual({ installed: [], unchanged: [], removed: [], rejected: [], skipped: [] });
    expect(await fs.readdir(profile)).toEqual([]);
  });

  test('installs verified artifacts as <id>.xpi and records ownership', async () => {
    const a = await artifact('a.xpi', 'alpha');
    const b = await artifact('b.xpi', 'beta');
    const summary = await syncProfileExtensions(profile, [
      { id: 'a@test', ...a }, { id: '{00000000-0000-0000-0000-000000000000}', ...b },
    ]);
    expect(summary.installed).toHaveLength(2);
    expect(await installed()).toEqual(['a@test.xpi', '{00000000-0000-0000-0000-000000000000}.xpi']);
    expect(await fs.readFile(path.join(profile, 'extensions', 'a@test.xpi'), 'utf8')).toBe('alpha');
    const record = JSON.parse(await fs.readFile(path.join(profile, MANAGED_EXTENSIONS_FILE), 'utf8'));
    expect(record.ids.sort()).toEqual(['a@test', '{00000000-0000-0000-0000-000000000000}']);
  });

  test('checksum mismatch is never installed and keeps any prior copy', async () => {
    const good = await artifact('a.xpi', 'v1');
    await syncProfileExtensions(profile, [{ id: 'a@test', ...good }]);
    await fs.writeFile(good.path, 'tampered');
    const log = jest.fn();
    const summary = await syncProfileExtensions(profile, [{ id: 'a@test', ...good }], log);
    expect(summary.rejected).toEqual(['a@test']);
    expect(await fs.readFile(path.join(profile, 'extensions', 'a@test.xpi'), 'utf8')).toBe('v1');
    expect(log).toHaveBeenCalledWith('error', expect.stringContaining('checksum mismatch'), { id: 'a@test' });

    const fresh = path.join(root, 'fresh');
    await fs.mkdir(fresh);
    await syncProfileExtensions(fresh, [{ id: 'a@test', ...good }], () => {});
    expect(await fs.readdir(path.join(fresh, 'extensions'))).toEqual([]);
  });

  test('unchanged installs are not rewritten, so Firefox keeps its state', async () => {
    const a = await artifact('a.xpi', 'alpha');
    await syncProfileExtensions(profile, [{ id: 'a@test', ...a }]);
    const target = path.join(profile, 'extensions', 'a@test.xpi');
    const before = (await fs.stat(target)).ino;
    const summary = await syncProfileExtensions(profile, [{ id: 'a@test', ...a }]);
    expect(summary.unchanged).toEqual(['a@test']);
    expect((await fs.stat(target)).ino).toBe(before);
  });

  test('a pinned version bump replaces the installed file', async () => {
    const v1 = await artifact('a1.xpi', 'v1');
    await syncProfileExtensions(profile, [{ id: 'a@test', ...v1 }]);
    const v2 = await artifact('a2.xpi', 'v2');
    const summary = await syncProfileExtensions(profile, [{ id: 'a@test', ...v2 }]);
    expect(summary.installed).toEqual(['a@test']);
    expect(await fs.readFile(path.join(profile, 'extensions', 'a@test.xpi'), 'utf8')).toBe('v2');
  });

  test.each([
    ['identical bytes', 'alpha'],
    ['different bytes', 'human copy'],
  ])('never claims a pre-existing human install (%s)', async (_label, humanBytes) => {
    const a = await artifact('a.xpi', 'alpha');
    await fs.mkdir(path.join(profile, 'extensions'));
    const target = path.join(profile, 'extensions', 'a@test.xpi');
    await fs.writeFile(target, humanBytes);
    const log = jest.fn();
    const summary = await syncProfileExtensions(profile, [{ id: 'a@test', ...a }], log);
    expect(summary.skipped).toEqual(['a@test']);
    expect(summary.installed).toEqual([]);
    expect(await fs.readFile(target, 'utf8')).toBe(humanBytes);
    expect(log).toHaveBeenCalledWith('warn', expect.stringContaining('outside Camofox management'), { id: 'a@test' });

    const cleared = await syncProfileExtensions(profile, []);
    expect(cleared.removed).toEqual([]);
    expect(await fs.readFile(target, 'utf8')).toBe(humanBytes);
  });

  test('installs exactly the verified bytes even if the artifact changes afterwards', async () => {
    const a = await artifact('a.xpi', 'alpha');
    const realReadFile = fs.readFile;
    const spy = jest.spyOn(fs, 'readFile').mockImplementation(async (file, ...rest) => {
      const result = await realReadFile(file, ...rest);
      if (file === a.path) await fs.writeFile(a.path, 'swapped after hashing');
      return result;
    });
    try {
      const summary = await syncProfileExtensions(profile, [{ id: 'a@test', ...a }]);
      expect(summary.installed).toEqual(['a@test']);
    } finally {
      spy.mockRestore();
    }
    expect(await fs.readFile(path.join(profile, 'extensions', 'a@test.xpi'), 'utf8')).toBe('alpha');
  });

  test.each([
    ['the ownership claim before install', target => target.endsWith(MANAGED_EXTENSIONS_FILE), 1],
    ['the final ownership record write', target => target.endsWith(MANAGED_EXTENSIONS_FILE), 2],
    ['the extension file commit', target => target.endsWith('example@test.xpi'), 1],
  ])('an interrupted install stays recoverable: failure at %s', async (_label, isTarget, failOnCall) => {
    const a = await artifact('a.xpi', 'alpha');
    const spec = [{ id: 'example@test', ...a }];
    const realRename = fs.rename;
    let calls = 0;
    const spy = jest.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (isTarget(to) && ++calls === failOnCall) {
        throw Object.assign(new Error('injected'), { code: 'EIO' });
      }
      return realRename(from, to);
    });
    try {
      await expect(syncProfileExtensions(profile, spec)).rejects.toThrow('injected');
    } finally {
      spy.mockRestore();
    }
    expect((await installed()).filter(name => name.includes('.tmp-'))).toEqual([]);

    const retry = await syncProfileExtensions(profile, spec);
    expect(retry.skipped).toEqual([]);
    expect([...retry.installed, ...retry.unchanged]).toEqual(['example@test']);
    expect(await installed()).toEqual(['example@test.xpi']);

    const cleared = await syncProfileExtensions(profile, []);
    expect(cleared.removed).toEqual(['example@test']);
    expect(await installed()).toEqual([]);
  });

  test('prunes only extensions it previously managed', async () => {
    const a = await artifact('a.xpi', 'alpha');
    const b = await artifact('b.xpi', 'beta');
    await syncProfileExtensions(profile, [{ id: 'a@test', ...a }, { id: 'b@test', ...b }]);
    await fs.writeFile(path.join(profile, 'extensions', 'human@installed.xpi'), 'mine');
    const summary = await syncProfileExtensions(profile, [{ id: 'a@test', ...a }]);
    expect(summary.removed).toEqual(['b@test']);
    expect(await installed()).toEqual(['a@test.xpi', 'human@installed.xpi']);

    const cleared = await syncProfileExtensions(profile, []);
    expect(cleared.removed).toEqual(['a@test']);
    expect(await installed()).toEqual(['human@installed.xpi']);
  });
});

describe('launchSharedIdentityContext', () => {
  test('synchronizes the identity extensions before Firefox starts', async () => {
    const a = await artifact('a.xpi', 'alpha');
    const order = [];
    const firefox = { launchPersistentContext: jest.fn(async () => {
      order.push(['launch', await installed()]);
      return { close: async () => {} };
    }) };
    await launchSharedIdentityContext(profile, {
      extensions: [{ id: 'a@test', ...a }],
      firefox, launchOptions: async options => ({ ...options }), os: { platform: () => 'darwin' },
      getHostOS: () => 'macos', config: {}, events: { emitAsync: async () => {} },
    });
    expect(order).toEqual([['launch', ['a@test.xpi']], ['launch', ['a@test.xpi']]]);
  });

  const launchDeps = captured => ({
    firefox: { launchPersistentContext: jest.fn(async () => ({ close: async () => {} })) },
    launchOptions: async options => { captured.push(options); return { ...options }; },
    os: { platform: () => 'darwin' }, getHostOS: () => 'macos', config: {},
    events: { emitAsync: async () => {} },
  });

  test('new or replaced extensions get a headless warm-up launch before the real one', async () => {
    const a = await artifact('a.xpi', 'alpha');
    const captured = [];
    const deps = launchDeps(captured);
    const closes = [];
    deps.firefox.launchPersistentContext = jest.fn(async () => {
      const context = { close: jest.fn(async () => closes.push(context)) };
      return context;
    });
    const log = jest.fn();
    const result = await launchSharedIdentityContext(profile, {
      headed: true, extensions: [{ id: 'a@test', ...a }], log, ...deps,
    });
    expect(captured.map(options => options.headless)).toEqual([true, false]);
    expect(deps.firefox.launchPersistentContext).toHaveBeenCalledTimes(2);
    expect(closes).toHaveLength(1);
    expect(closes[0]).not.toBe(result);
    expect(log).toHaveBeenCalledWith('info', 'extension warm-up launch completed', { installed: ['a@test'] });

    // Already-installed extensions start normally: a single launch only.
    const again = [];
    await launchSharedIdentityContext(profile, { extensions: [{ id: 'a@test', ...a }], ...launchDeps(again) });
    expect(again).toHaveLength(1);
  });

  test.each([
    ['a managed extension set', [{ id: 'a@test' }], { allowAddonNewtab: true }],
    ['an empty extension set', [], undefined],
    ['an invalid configuration', null, undefined],
  ])('Camoufox lets extensions open their own tabs only for %s', async (_label, specs, expected) => {
    const extensions = specs && await Promise.all(specs.map(async spec => ({ ...spec, ...await artifact('a.xpi', 'alpha') })));
    const captured = [];
    await launchSharedIdentityContext(profile, { extensions, log: () => {}, ...launchDeps(captured) });
    expect(captured.length).toBeGreaterThan(0);
    for (const options of captured) expect(options.config).toEqual(expected);
  });

  test.each([
    ['launch options fail before Firefox starts', 'options'],
    ['the warm-up launch itself fails', 'warmup'],
    ['closing the warm-up browser fails', 'close'],
  ])('warm-up eligibility survives a failed attempt: %s', async (_label, failAt) => {
    const a = await artifact('a.xpi', 'alpha');
    const extensions = [{ id: 'a@test', ...a }];
    const failing = [];
    const deps = launchDeps(failing);
    let armed = true;
    const disarm = () => { const fire = armed; armed = false; return fire; };
    const realOptions = deps.launchOptions;
    deps.launchOptions = async options => {
      if (failAt === 'options' && disarm()) throw new Error('injected');
      return realOptions(options);
    };
    deps.firefox.launchPersistentContext = jest.fn(async () => {
      if (failAt === 'warmup' && disarm()) throw new Error('injected');
      return { close: async () => { if (failAt === 'close' && disarm()) throw new Error('injected'); } };
    });
    await expect(launchSharedIdentityContext(profile, { headed: true, extensions, ...deps })).rejects.toThrow('injected');
    await expect(fs.access(path.join(profile, PENDING_ACTIVATION_FILE))).resolves.toBeUndefined();

    // Retry (as after a failed attempt or process restart): files are now
    // unchanged, yet the retry still warms up before the real headed launch.
    const retry = [];
    await launchSharedIdentityContext(profile, { headed: true, extensions, ...launchDeps(retry) });
    expect(retry.map(options => options.headless)).toEqual([true, false]);
    await expect(fs.access(path.join(profile, PENDING_ACTIVATION_FILE))).rejects.toThrow();

    // Once activated, later launches start once.
    const later = [];
    await launchSharedIdentityContext(profile, { extensions, ...launchDeps(later) });
    expect(later).toHaveLength(1);
  });

  test('a sync that dies after committing files still warms up on retry', async () => {
    const a = await artifact('a.xpi', 'alpha');
    const extensions = [{ id: 'a@test', ...a }];
    const realRename = fs.rename;
    const spy = jest.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      const result = await realRename(from, to);
      if (to.endsWith('a@test.xpi')) throw new Error('crash after commit');
      return result;
    });
    try {
      await expect(launchSharedIdentityContext(profile, { extensions, ...launchDeps([]) })).rejects.toThrow('crash after commit');
    } finally {
      spy.mockRestore();
    }
    const retry = [];
    await launchSharedIdentityContext(profile, { headed: true, extensions, ...launchDeps(retry) });
    expect(retry.map(options => options.headless)).toEqual([true, false]);
  });

  test('an unconfirmed warm-up close blocks further opens through SharedIdentityManager', async () => {
    const a = await artifact('a.xpi', 'alpha');
    const extensions = [{ id: 'a@test', ...a }];
    const profileDir = path.join(root, 'shared-profiles');
    const manager = new SharedIdentityManager({ identities: ['personal'], profileDir, logger: null });
    const captured = [];
    const deps = launchDeps(captured);
    deps.firefox.launchPersistentContext = jest.fn(async () => ({
      on: () => {},
      close: async () => { throw new Error('close rejected'); },
    }));
    const create = profilePath => launchSharedIdentityContext(profilePath, { extensions, ...deps });
    await expect(manager.open('personal', create)).rejects.toThrow('close rejected');
    expect(manager.failedClosures.has('personal')).toBe(true);
    await expect(manager.open('personal', create)).rejects.toThrow('profile ownership is unconfirmed');
    // Only the warm-up browser was ever started.
    expect(deps.firefox.launchPersistentContext).toHaveBeenCalledTimes(1);
  });

  test('a warm-up whose close rejects after the close event proceeds normally', async () => {
    const a = await artifact('a.xpi', 'alpha');
    const captured = [];
    const deps = launchDeps(captured);
    let calls = 0;
    deps.firefox.launchPersistentContext = jest.fn(async () => {
      calls += 1;
      if (calls > 1) return { close: async () => {} };
      const listeners = [];
      return {
        on: (event, fn) => { if (event === 'close') listeners.push(fn); },
        close: async () => { listeners.forEach(fn => fn()); throw new Error('late rejection'); },
      };
    });
    await launchSharedIdentityContext(profile, { extensions: [{ id: 'a@test', ...a }], ...deps });
    expect(deps.firefox.launchPersistentContext).toHaveBeenCalledTimes(2);
    await expect(fs.access(path.join(profile, PENDING_ACTIVATION_FILE))).rejects.toThrow();
  });

  test('no extensions, no warm-up launch', async () => {
    const captured = [];
    await launchSharedIdentityContext(profile, { extensions: [], ...launchDeps(captured) });
    expect(captured).toHaveLength(1);
  });

  test.each([
    ['one identity list is invalid', env => JSON.stringify({ me: [{ ...env, sha256: 'typo' }] })],
    ['the whole value is malformed JSON', () => '{nope'],
  ])('invalid configuration never prunes managed extensions: %s', async (_label, makeEnv) => {
    const a = await artifact('a.xpi', 'alpha');
    await syncProfileExtensions(profile, [{ id: 'a@test', ...a }]);
    const parsed = parseSharedIdentityExtensions(makeEnv({ id: 'a@test', ...a }), {}, () => {});
    const log = jest.fn();
    await launchSharedIdentityContext(profile, {
      extensions: extensionsForIdentity(parsed, 'me'), log, ...launchDeps([]),
    });
    expect(await installed()).toEqual(['a@test.xpi']);
    expect(log).toHaveBeenCalledWith('warn', expect.stringContaining('left unchanged'), { profilePath: profile });
  });

  test('a pinned local uBlock Origin disables the launch-time UBO download', async () => {
    const ubo = await artifact('ubo.xpi', 'ubo');
    const captured = [];
    await launchSharedIdentityContext(profile, {
      extensions: [{ id: 'uBlock0@raymondhill.net', ...ubo }], ...launchDeps(captured),
    });
    expect(captured[0].exclude_addons).toEqual(['UBO']);

    const other = path.join(root, 'other');
    await fs.mkdir(other);
    const withoutUbo = [];
    await launchSharedIdentityContext(other, { extensions: [], ...launchDeps(withoutUbo) });
    expect(withoutUbo[0].exclude_addons).toBeUndefined();
  });
});
