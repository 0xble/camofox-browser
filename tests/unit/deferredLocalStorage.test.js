import { jest } from '@jest/globals';
import { runInNewContext } from 'node:vm';
import { deferredLocalStorageInit, installDeferredLocalStorage } from '../../lib/deferred-local-storage.js';

test('deferred localStorage script restores only missing keys for the current origin', () => {
  const values = new Map([['existing', 'current']]);
  const localStorage = {
    getItem: name => values.has(name) ? values.get(name) : null,
    setItem: (name, value) => values.set(name, value),
  };
  const restore = runInNewContext(`(${deferredLocalStorageInit.toString()})`, {
    localStorage,
    location: { origin: 'https://example.com' },
  });

  restore({ data: {
    'https://example.com': [
      { name: 'existing', value: 'old' },
      { name: 'missing', value: 'new' },
    ],
  } });

  expect(Object.fromEntries(values)).toEqual({ existing: 'current', missing: 'new' });
});

test('installDeferredLocalStorage registers no script for empty state', async () => {
  const context = { addInitScript: jest.fn() };
  await expect(installDeferredLocalStorage(context, {})).resolves.toBe(false);
  expect(context.addInitScript).not.toHaveBeenCalled();
});

test('installDeferredLocalStorage passes the snapshot as an init-script argument', async () => {
  const context = { addInitScript: jest.fn(async () => {}) };
  const data = { 'https://example.com': [{ name: 'token', value: 'abc' }] };

  await expect(installDeferredLocalStorage(context, data)).resolves.toBe(true);
  expect(context.addInitScript).toHaveBeenCalledWith(expect.any(Function), { data });
});
