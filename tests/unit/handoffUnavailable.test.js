import { jest } from '@jest/globals';
import fs from 'node:fs';
import vm from 'node:vm';
import { browserErrorStatus, browserErrorCode, browserErrorRecovery, isRetryableBrowserError } from '../../lib/browser-errors.js';
import { classifyError, actionFromReq } from '../../lib/request-utils.js';

const source = fs.readFileSync(new URL('../../server.js', import.meta.url), 'utf8');
const extract = name => source.slice(source.indexOf(`function ${name}(`), source.indexOf('\n}\n', source.indexOf(`function ${name}(`)) + 2);

test.each(['display query failed', 'identity visibility operation timed out after 12000ms', 'Browser closed'])('handoff unavailable does not become a retryable timeout or destroy tabs (%s)', message => {
  const err = Object.assign(new Error(message, { cause: Error(message) }), { code: 'handoff_unavailable', statusCode: 409 });
  expect(browserErrorStatus(err)).toBe(409);
  expect(browserErrorCode(err)).toBe('handoff_unavailable');
  expect(browserErrorRecovery(err)).toBeNull();
  expect(isRetryableBrowserError(err)).toBe(false);
  const inc = jest.fn();
  const labels = jest.fn(() => ({ inc }));
  const sendError = vm.runInNewContext(`(${extract('sendError')})`, {
    browserErrorStatus, browserErrorCode, browserErrorRecovery, isRetryableBrowserError,
    safeError: error => error.message, StaleRefsError: class extends Error {},
  });
  // No session/timeout/reporter dependencies: crossing those paths is a failure.
  const handle = vm.runInNewContext(`(${extract('handleRouteError')})`, { classifyError, actionFromReq, failuresTotal: { labels }, sendError });
  const res = { status: jest.fn(() => res), json: jest.fn() };
  handle(err, { method: 'POST', path: '/tabs/A/handoff', body: { userId: 'identity' }, params: { tabId: 'A' } }, res);
  expect(res.status).toHaveBeenCalledWith(409);
  expect(res.json).toHaveBeenCalledWith({ error: message, code: 'handoff_unavailable', retryable: false });
  expect(labels).toHaveBeenCalledWith('handoff_unavailable', 'handoff');
});
