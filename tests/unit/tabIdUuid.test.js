import fs from 'node:fs';
import vm from 'node:vm';
import { createFlyHelpers } from '../../lib/fly.js';

const source = fs.readFileSync(new URL('../../server.js', import.meta.url), 'utf8');
function sourceBetween(startMarker, endMarker) {
  for (const marker of [startMarker, endMarker]) {
    if (source.split(marker).length !== 2) {
      throw new Error('server.js source marker missing or not unique: ' + marker);
    }
  }
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker);
  if (end <= start) throw new Error('server.js end marker precedes ' + startMarker);
  return source.slice(start, end);
}
const handlerSource = sourceBetween('const UUID_RE =', 'function createTabState(');
const uuid = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
const machine = '68341eecdd3168';
const restartedAt = 1_000_000;

function response(tabId, { age = 299999, restart = restartedAt, machineId = machine } = {}) {
  const handler = vm.runInNewContext(handlerSource + '\ntabNotFoundResponse', {
    Date: { now: () => restart + age },
    _lastBrowserRestartAt: restart,
    fly: createFlyHelpers({ flyMachineId: machineId }),
  });
  const res = {
    status(status) { this.statusCode = status; return this; },
    json(body) { return { status: this.statusCode, body }; },
  };
  return handler(res, tabId);
}

describe('tabNotFoundResponse', () => {
  test.each([uuid, machine + '_' + uuid, uuid.toUpperCase()])('local UUID %s at age 299999 returns 410', tabId => {
    expect(response(tabId)).toEqual({
      status: 410,
      body: {
        error: 'Tab no longer exists (browser was restarted). Create a new tab.',
        code: 'browser_restarted',
      },
    });
  });

  test.each([300000, 300001, 600000])('age %i returns 404 at and beyond the grace boundary', age => {
    expect(response(uuid, { age })).toEqual({ status: 404, body: { error: 'Tab not found' } });
  });

  test('zero restart timestamp returns 404 even inside the grace window', () => {
    expect(response(uuid, { restart: 0, age: 1000 })).toEqual({
      status: 404, body: { error: 'Tab not found' },
    });
  });

  test.each([
    'non-existent-tab', 'foobar', '', null, undefined,
    machine + '_not-a-uuid', uuid + '_suffix', 'bad-prefix_' + uuid,
  ])('invalid ID %s returns 404 inside the grace window', tabId => {
    expect(response(tabId)).toEqual({ status: 404, body: { error: 'Tab not found' } });
  });

  test('nonlocal prefixed UUID returns 404 inside the grace window', () => {
    expect(response('othermachine_' + uuid)).toEqual({ status: 404, body: { error: 'Tab not found' } });
  });

  test('without Fly configuration prefixed UUIDs are local by the existing helper contract', () => {
    expect(response('othermachine_' + uuid, { machineId: '' })).toMatchObject({
      status: 410, body: { code: 'browser_restarted' },
    });
  });
});
