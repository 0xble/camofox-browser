// CGWindow bounds can include WindowServer's desktop transform (for example,
// 0.9x while the Mac is locked). AppKit/WebExtension coordinates do not. Bind
// by an exact, reversible window-local motion challenge, never guessed units,
// titles, order in a PID's window list, or a singleton/sibling fallback.
// Sized parking uses two unequal excursions with a window-local code. Unlike
// the legacy identical out-and-back challenge, this distinguishes concurrent
// movers without treating a sibling's movement as the target's proof. One
// positive affine x transform must explain all five observations; its scale
// and origin are measured from the observations, never guessed from a display.
export function nativeWindowFromCodedMotion(samples) {
  if (samples.length !== 5) return null;
  const [a, b, c, d, e] = samples;
  if (a.left !== c.left || a.left !== e.left || Math.abs(b.left - a.left) < 32
    || Math.abs(d.left - a.left) < 64 || b.left === d.left) return null;
  const maps = samples.map(s => new Map(s.windows.map(w => [w.number, w])));
  if (maps.some((m, i) => m.size !== samples[i].windows.length || m.size !== maps[0].size)
    || [...maps[0].keys()].some(n => maps.some(m => !m.has(n)))) return null;
  const matches = [];
  for (const [number, first] of maps[0]) {
    if (!Number.isSafeInteger(number)) return null;
    const positions = maps.map(m => m.get(number));
    if (!positions.every(w => ['top', 'width', 'height'].every(k => w[k] === first[k]))) continue;
    if (![positions[2], positions[4]].every(w => Math.abs(w.left - first.left) <= 2)) continue;
    const scale = (positions[3].left - first.left) / (d.left - a.left);
    if (!(scale > 0) || Math.abs(positions[1].left - first.left) < 16
      || Math.abs(positions[3].left - first.left) < 16) continue;
    if (samples.every((s, i) => Math.abs(positions[i].left - first.left - scale * (s.left - a.left)) <= 2)) matches.push(number);
  }
  return matches.length === 1 ? matches[0] : null;
}

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
