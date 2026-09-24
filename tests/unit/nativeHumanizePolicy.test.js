import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

// Inspect both actual launch call sites so one cannot retain the macOS hang.
const source = [new URL('../../server.js', import.meta.url), new URL('../../lib/shared-identity-launch.js', import.meta.url)]
  .map(url => readFileSync(url, 'utf8')).join('\n');
const expressions = [...source.matchAll(/humanize:\s*([^,\n]+)/g)].map(match => match[1]);

test.each(['darwin', 'linux', 'win32'])('both browser launch paths use the native mouse policy on %s', platform => {
  expect(expressions).toHaveLength(2);
  for (const expression of expressions) {
    expect(runInNewContext(expression, { os: { platform: () => platform } })).toBe(platform !== 'darwin');
  }
});
