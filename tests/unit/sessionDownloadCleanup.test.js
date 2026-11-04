import { jest } from '@jest/globals';
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { clearSessionDownloads } from '../../lib/downloads.js';
import { quarantinePage } from '../../lib/page-registry.js';
import { closeSessionOnce, hasSessionClose, settleWithin, SESSION_CLOSE_STEP_TIMEOUT_MS } from '../../lib/session-close.js';

const source = readFileSync(new URL('../../server.js', import.meta.url), 'utf8');
let downloadDir;
beforeEach(async () => { downloadDir = await fs.mkdtemp(path.join(os.tmpdir(), 'camofox-session-downloads-')); });
afterEach(async () => {
  jest.useRealTimers();
  await fs.rm(downloadDir, { recursive: true, force: true });
});

async function fixture() {
  const tabs = await Promise.all(['first', 'second'].map(async id => {
    const filePath = path.join(downloadDir, `${id}.bin`);
    await fs.writeFile(filePath, `download-${id}`);
    return { page: { isClosed: () => false }, downloads: [{ id, filePath }] };
  }));
  const files = tabs.map(tab => tab.downloads[0].filePath);
  const context = { pages: () => tabs.map(tab => tab.page) };
  const session = { sharedIdentity: true, context,
    tabGroups: new Map(tabs.map((tab, index) => [`task-${index}`, new Map([[`tab-${index}`, tab]])])) };
  const sessions = new Map([['fixture', session]]);
  const contexts = new Map([['fixture', context]]);
  const deps = {
    sessions, sessionLifecycleGeneration: 0, normalizeUserId: String,
    sharedIdentityLastUrls: new Map(), closeSessionOnce, hasSessionClose,
    settleWithin, SESSION_CLOSE_STEP_TIMEOUT_MS, quarantinePage,
    clearSessionLocks: jest.fn(), clearSessionDownloads: jest.fn(clearSessionDownloads),
    refreshActiveTabsGauge: jest.fn(), log: jest.fn(),
    sharedIdentities: { contexts, failedClosures: new Set(),
      snapshotCookies: jest.fn(async () => []),
      close: jest.fn(async key => { contexts.delete(key); }),
    },
  };
  // Exercise the server's actual orchestration without importing its startup side effects.
  vm.runInNewContext(source.slice(source.indexOf('const UNAVAILABLE_IDENTITY_CLOSE_REASONS ='),
    source.indexOf('async function createSharedIdentityContext(')) +
    '\nglobalThis.closeOne = closeSession; globalThis.closeAll = closeAllSessions;', deps);
  return { deps, session, tabs, files };
}

async function expectDownloadsRemoved(f) {
  for (const file of f.files) await expect(fs.stat(file)).rejects.toMatchObject({ code: 'ENOENT' });
  for (const tab of f.tabs) expect(tab.downloads).toEqual([]);
}

async function expectDownloadsPreserved(f) {
  for (const [index, file] of f.files.entries()) {
    await expect(fs.readFile(file, 'utf8')).resolves.toBe(`download-${index ? 'second' : 'first'}`);
    expect(f.tabs[index].downloads).toHaveLength(1);
  }
  expect(f.deps.clearSessionDownloads).not.toHaveBeenCalled();
}

test.each(['headed_transition', 'headed_release'])('%s removes downloads before losing retired tab states', async reason => {
  const f = await fixture();
  await f.deps.closeOne('fixture', f.session, { reason });
  expect(f.deps.sharedIdentities.contexts.has('fixture')).toBe(false);
  expect(f.deps.sessions.has('fixture')).toBe(false);
  expect(f.session.tabGroups.size).toBe(0);
  await expectDownloadsRemoved(f);
});

test.each(['headed_transition', 'headed_release'])('%s preserves downloads when clearDownloads is false', async reason => {
  const f = await fixture();
  await f.deps.closeOne('fixture', f.session, { reason, clearDownloads: false });
  expect(f.session.tabGroups.size).toBe(0);
  await expectDownloadsPreserved(f);
});

test.each(['headed_transition', 'headed_release'])('%s cleans downloads after a confirmed close reports a checkpoint failure', async reason => {
  const f = await fixture();
  const error = new Error('checkpoint write failed');
  f.deps.sharedIdentities.close.mockImplementationOnce(async key => {
    f.deps.sharedIdentities.contexts.delete(key);
    throw error;
  });
  await expect(f.deps.closeOne('fixture', f.session, { reason })).rejects.toBe(error);
  expect(f.deps.sessions.has('fixture')).toBe(false);
  expect(f.session.tabGroups.size).toBe(0);
  await expectDownloadsRemoved(f);
});

test('confirmed close checkpoint failure respects clearDownloads false', async () => {
  const f = await fixture();
  const error = new Error('checkpoint write failed');
  f.deps.sharedIdentities.close.mockImplementationOnce(async key => {
    f.deps.sharedIdentities.contexts.delete(key);
    throw error;
  });
  await expect(f.deps.closeOne('fixture', f.session, { reason: 'headed_transition', clearDownloads: false })).rejects.toBe(error);
  await expectDownloadsPreserved(f);
});

test.each([true, false])('terminal close timeout cleans retired downloads only when enabled (clearDownloads=%s)', async clearDownloads => {
  const f = await fixture();
  let resumeClose;
  f.deps.sharedIdentities.close.mockImplementationOnce(() => new Promise(resolve => { resumeClose = resolve; }));
  jest.useFakeTimers();
  const closing = f.deps.closeAll('admin_stop', { clearDownloads });
  await jest.advanceTimersByTimeAsync(SESSION_CLOSE_STEP_TIMEOUT_MS + 1);
  const failures = await closing;
  expect(failures).toMatchObject([{ userId: 'fixture', error: { code: 'session_close_timeout' } }]);
  expect(f.deps.sharedIdentities.close).toHaveBeenCalledTimes(1);
  expect(f.deps.sharedIdentities.contexts.get('fixture')).toBe(f.session.context);
  expect(f.deps.sessions.has('fixture')).toBe(false);
  expect(f.session.tabGroups.size).toBe(0);
  try {
    if (clearDownloads) await expectDownloadsRemoved(f);
    else await expectDownloadsPreserved(f);
  } finally {
    resumeClose();
    await f.deps.closeOne('fixture', f.session, { reason: 'admin_stop', clearDownloads });
  }
});

test.each(['headed_transition', 'headed_release'])('%s cleans downloads even when page close events remove original group entries', async reason => {
  const f = await fixture();
  f.deps.sharedIdentities.close.mockImplementationOnce(async key => {
    for (const group of f.session.tabGroups.values()) group.clear();
    f.deps.sharedIdentities.contexts.delete(key);
  });
  await f.deps.closeOne('fixture', f.session, { reason });
  await expectDownloadsRemoved(f);
});

test('terminal timeout cleans downloads removed from original groups while close is pending', async () => {
  const f = await fixture();
  let resumeClose;
  f.deps.sharedIdentities.close.mockImplementationOnce(() => {
    for (const group of f.session.tabGroups.values()) group.clear();
    return new Promise(resolve => { resumeClose = resolve; });
  });
  jest.useFakeTimers();
  const closing = f.deps.closeAll('admin_stop');
  await jest.advanceTimersByTimeAsync(SESSION_CLOSE_STEP_TIMEOUT_MS + 1);
  expect(await closing).toHaveLength(1);
  try { await expectDownloadsRemoved(f); }
  finally {
    resumeClose();
    await f.deps.closeOne('fixture', f.session, { reason: 'admin_stop' });
  }
});

test.each(['headed_transition', 'headed_release'])('%s preserves downloads when context close is unconfirmed', async reason => {
  const f = await fixture();
  const error = new Error('context close failed');
  f.deps.sharedIdentities.close.mockRejectedValueOnce(error);
  f.deps.sharedIdentities.failedClosures.add('fixture');
  await expect(f.deps.closeOne('fixture', f.session, { reason })).rejects.toBe(error);
  expect(f.deps.sessions.get('fixture')).toBe(f.session);
  expect(f.session.tabGroups.size).toBe(2);
  await expectDownloadsPreserved(f);
});
