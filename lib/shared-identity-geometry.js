// Camoufox 0.11.5 passes these camelCase constraints to BrowserForge.
// Constrain the screen, not `window`: identities keep varied window sizes.
export function fingerprintScreen(displays) {
  const targets = displays.filter(Boolean);
  if (!targets.length || targets.some(d => ![d.width, d.height].every(v => Number.isSafeInteger(v) && v > 0)))
    throw new Error('invalid headed identity display');
  return { maxWidth: Math.min(...targets.map(d => d.width)), maxHeight: Math.min(...targets.map(d => d.height)) };
}

function fingerprintConfig(options) {
  // camoufox-js serializes the final config as contiguous numbered chunks.
  // Read after browser:launching hooks, so this is what the engine receives.
  let text = '';
  for (let index = 1; Object.hasOwn(options.env || {}, `CAMOU_CONFIG_${index}`); index++)
    text += options.env[`CAMOU_CONFIG_${index}`];
  let config;
  try { config = JSON.parse(text); } catch { throw new Error('missing or invalid Camoufox window config'); }
  return config;
}

export function fingerprintWindowSize(options) {
  const config = fingerprintConfig(options);
  const width = config?.['window.outerWidth'], height = config?.['window.outerHeight'];
  if (![width, height].every(value => Number.isSafeInteger(value) && value >= 64))
    throw new Error('invalid Camoufox outer window size');
  return { width, height };
}

export function fittedFingerprintWindow(options, screen) {
  const config = fingerprintConfig(options), outer = fingerprintWindowSize(options);
  const width = config?.['screen.width'], height = config?.['screen.height'];
  if (![width, height].every(value => Number.isSafeInteger(value) && value >= 64))
    throw new Error('invalid Camoufox screen size');
  const scale = Math.min(1, Math.min(width, screen.maxWidth) / outer.width, Math.min(height, screen.maxHeight) / outer.height);
  // A sampled screen can be smaller than its own recorded outer window. Use
  // Camoufox's `window` path to recalculate inner/outer geometry coherently,
  // preserving the sample's aspect ratio rather than pinning all identities.
  return [Math.floor(outer.width * scale), Math.floor(outer.height * scale)];
}
