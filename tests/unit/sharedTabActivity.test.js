import { jest } from '@jest/globals';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../../server.js', import.meta.url), 'utf8');
const activityStart = source.indexOf('// Agent requests, not browser focus');
const middleware = source.slice(source.indexOf('app.use(', activityStart) + 8, source.indexOf('\n});', activityStart) + 2);

for (const [path, method, tabTarget] of [
  ['/tabs/tab/snapshot', 'GET', {}], ['/navigate', 'POST', { body: { targetId: 'tab' } }],
  ['/snapshot', 'GET', { query: { targetId: 'tab' } }], ['/act', 'POST', { body: { targetId: 'tab' } }],
]) test(`agent activity includes ${method} ${path}`, () => {
  const tab = { lastAgentActivityAt: 1 };
  const session = { sharedIdentity: true, lastAccess: 1 };
  const next = jest.fn();
  const track = vm.runInNewContext(`(${middleware})`, {
    sessions: new Map([['shared', session]]), findTab: (_session, id) => id === 'tab' ? { tabState: tab } : null,
    Date: { now: () => 300000 },
  });
  track({ path, method, ...tabTarget }, {}, next);
  expect(tab.lastAgentActivityAt).toBe(300000);
  expect(session.lastAccess).toBe(300000);
  expect(next).toHaveBeenCalledTimes(1);
});

test('passive tab lists do not renew any agent tab', () => {
  const findTab = jest.fn();
  const track = vm.runInNewContext(`(${middleware})`, { sessions: new Map([['shared', {}]]), findTab });
  track({ path: '/tabs', method: 'GET', query: { userId: 'shared' } }, {}, jest.fn());
  expect(findTab).not.toHaveBeenCalled();
});
