// CGWindow bounds can include WindowServer's desktop transform (for example,
// 0.9x while the Mac is locked). AppKit/WebExtension coordinates do not. Bind
// by an exact, reversible window-local motion challenge, never guessed units,
// titles, order in a PID's window list, or a singleton/sibling fallback.
export function nativeWindowFromMotion(samples) {
  if (samples.length !== 3) return null;
  const [a, b, c] = samples;
  if (a.left !== c.left || Math.abs(b.left - a.left) < 32) return null;
  const maps = samples.map(s => new Map(s.windows.map(w => [w.number, w])));
  if (maps.some((m, i) => m.size !== samples[i].windows.length || m.size !== maps[0].size)) return null;
  if ([...maps[0].keys()].some(n => !maps[1].has(n) || !maps[2].has(n))) return null;
  let moved = null;
  for (const [number, first] of maps[0]) {
    const middle = maps[1].get(number), last = maps[2].get(number);
    const same = w => ['left', 'top', 'width', 'height'].every(k => w[k] === first[k]);
    if (same(middle) && same(last)) continue;
    const dx = middle.left - first.left, back = last.left - middle.left;
    // Two opposite, substantial moves must track the requested directions and
    // return to the same native x. Any other moving window makes proof ambiguous.
    if (moved !== null || !Number.isSafeInteger(number)
      || !['top', 'width', 'height'].every(k => middle[k] === first[k] && last[k] === first[k])
      || Math.abs(dx) < 16 || Math.abs(back) < 16
      || Math.sign(dx) !== Math.sign(b.left - a.left) || Math.sign(back) !== Math.sign(c.left - b.left)
      || Math.abs(last.left - first.left) > 2) return null;
    moved = number;
  }
  return moved;
}
