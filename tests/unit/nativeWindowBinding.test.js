import { jest, describe, test, expect } from '@jest/globals';
import { nativeWindowFromMotion } from '../../lib/native-window-binding.js';
const w = (number, left) => ({ number, left, top: 84, width: 1153, height: 811 });
const samples = (xs = [138, 282, 138]) => [40, 200, 40].map((left, i) => ({ left, windows: [w(1, xs[i]), w(2, 138)] }));
describe('native out-and-back binding', () => {
  test.each([[138, 282, 138], [40, 200, 40], [138, 282, 139]])('binds transformed or untransformed motion %j', (...xs) => {
    expect(nativeWindowFromMotion(samples(xs))).toBe(1);
  });
  test('ignores native list order and returns a number, not a list index', () => {
    const s = samples(); s[1].windows.reverse();
    expect(nativeWindowFromMotion(s)).toBe(1);
  });
  test.each([
    ['no motion', s => s.forEach(v => v.windows[0].left = 138)],
    ['one-way motion', s => s[2].windows[0].left = 300],
    ['wrong direction', s => s[1].windows[0].left = 20],
    ['tiny motion', s => s[1].windows[0].left = 139],
    ['moving sibling', s => s[1].windows[1].left++],
    ['sibling scale transform with unchanged target', s => {
      s.forEach(v => v.windows[0].left = 138);
      s[1].windows[1] = { ...s[1].windows[1], left: 282, top: 100, width: 1000, height: 700 };
    }],
    ['candidate resizes', s => s[1].windows[0].width++],
    ['candidate moves vertically', s => s[2].windows[0].top++],
    ['missing sibling', s => s[1].windows.pop()],
    ['new window', s => s[2].windows.push(w(3, 500))],
    ['reused number', s => s[2].windows[0].number = 3],
    ['duplicate number', s => s[1].windows.push(w(1, 500))],
    ['not enough samples', s => s.pop()],
    ['not an out-and-back challenge', s => s[2].left++],
  ])('rejects ambiguous proof: %s', (_name, change) => {
    const s = samples(); change(s); expect(nativeWindowFromMotion(s)).toBe(null);
  });
});
