import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { launchWithVisibilityFallback } from '../../lib/shared-identity-visibility.js';

const source = await fs.readFile(new URL('../../server.js', import.meta.url), 'utf8');
function serverFunction(name, dependencies) {
  const start = source.indexOf(`async function ${name}(`);
  const end = source.indexOf('\n}\n', start) + 2;
  return vm.runInNewContext(`(${source.slice(start, end)})`, dependencies);
}

for (const all of [false, true]) {
  test(`single-display first acquisition and release (all=${all}) retain both tasks' live pages`, async () => {
    const a = { input: 'unsaved A', isClosed: () => false, url: () => 'https://form.test/a' };
    const b = { input: 'unsaved B', isClosed: () => false, url: () => 'https://form.test/b' };
    const context = new EventEmitter();
    context.pages = () => [a, b];
    let closed = 0, launched;
    context.close = async () => { closed++; a.input = b.input = ''; };
    const visible = new Map([[1, {}]]);
    const visibility = { visible, attach: async () => {}, release: async () => { visible.clear(); return true; } };
    const create = serverFunction('createSharedIdentityContext', {
      os: { platform: () => 'darwin' }, CONFIG: { sharedIdentityExtensions: [], sharedIdentityAliases: {}, identityColors: {} },
      refreshSharedParkDisplay: async () => null,
      createDarwinIdentityVisibility: () => visibility,
      createSharedIdentityVisibility: () => { throw Error('No secondary display exists'); },
      launchWithVisibilityFallback,
      launchSharedIdentityContext: async (_profile, options) => { launched = options; return context; },
      extensionsForIdentity: () => [], identityIndicator: () => null, launchOptions() {}, firefox: {}, getHostOS() {}, pluginEvents: {}, log() {},
    });
    await create('identity', '/unused/profile', { headed: true });
    const session = { context, sharedIdentity: true, headed: true, visibility: context.sharedIdentityVisibility,
      tabGroups: new Map([['a', new Map([['tab-a', { page: a }]])], ['b', new Map([['tab-b', { page: b }]])]]) };
    const release = serverFunction('releaseIdentity', {
      sessions: new Map([['identity', session]]), sharedParkDisplay: null, sessionCreations: new Map(),
      identityBusy: () => false, closeSession: async () => context.close(), sharedIdentityLastUrls: new Map(), log() {},
    });
    await release('identity', { all });
    assert.equal(closed, 0, 'visibility release must never close the shared context');
    assert.equal(launched.headed, true);
    assert.equal(context.sharedIdentityVisibility, visibility, 'first acquisition must install a same-context controller');
    assert.deepEqual(context.pages(), [a, b]);
    assert.deepEqual([a.input, b.input], ['unsaved A', 'unsaved B']);
    assert.equal(session.headed, false);
  });
}
