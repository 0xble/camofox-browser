// Visible identity indicator for headed shared-identity windows.
//
// Camoufox 152 does not load userChrome.css (toolkit.legacyUserProfile-
// Customizations has no effect there), and a static theme add-on is not
// activated when loaded temporarily. A tiny generated WebExtension that calls
// browser.theme.update() does work. It is passed through Camoufox's `addons`
// launch option for headed launches only, so it is never written into the
// persistent profile and headless launches never load it. It declares no
// content scripts and no web-accessible resources, so pages cannot observe it,
// and the theme only colors browser chrome.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { sharedIdentityMetadata } from './shared-identity-metadata.js';

// One row per identity slot, assigned by sorted alias. Every toolbar color
// keeps white text above WCAG AA (4.5:1); the frame is a darker shade of the
// same hue so the window reads as one color at a glance.
export const INDICATOR_PALETTE = [
  { name: 'blue', toolbar: '#1d4ed8', frame: '#1e3a8a' },
  { name: 'green', toolbar: '#047857', frame: '#064e3b' },
  { name: 'purple', toolbar: '#7e22ce', frame: '#581c87' },
  { name: 'amber', toolbar: '#b45309', frame: '#78350f' },
  { name: 'red', toolbar: '#b91c1c', frame: '#7f1d1d' },
  { name: 'teal', toolbar: '#0f766e', frame: '#134e4a' },
  { name: 'pink', toolbar: '#be185d', frame: '#831843' },
  { name: 'slate', toolbar: '#334155', frame: '#0f172a' },
];

const ADDON_ID = 'camofox-identity-indicator@camofox.local';

/** Indicator for a configured alias, or null for unmapped identities. */
export function identityIndicator(aliases, userId) {
  const identities = sharedIdentityMetadata(aliases);
  const index = identities.findIndex(identity => identity.userId === String(userId) || identity.alias === String(userId));
  if (index < 0) return null;
  return { alias: identities[index].alias, ...INDICATOR_PALETTE[index % INDICATOR_PALETTE.length] };
}

function relativeLuminance(hex) {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map(c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two #rrggbb colors. */
export function contrastRatio(a, b) {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

function labelSvg({ alias, frame }) {
  // Aliases are validated as [a-z][a-z0-9_-]*, so they need no XML escaping.
  const width = 28 + alias.length * 9;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width + 8}" height="30">`
    + `<rect x="4" y="4" width="${width}" height="22" rx="11" fill="#ffffff"/>`
    + `<text x="${4 + width / 2}" y="20" text-anchor="middle" font-family="-apple-system, Helvetica, Arial, sans-serif" `
    + `font-size="13" font-weight="700" fill="${frame}">${alias}</text></svg>\n`;
}

/** The generated extension's files for one indicator. */
export function indicatorAddonFiles(indicator) {
  const theme = {
    images: { additional_backgrounds: ['label.svg'] },
    properties: { additional_backgrounds_alignment: ['right top'], additional_backgrounds_tiling: ['no-repeat'] },
    colors: {
      frame: indicator.frame,
      frame_inactive: indicator.frame,
      tab_background_text: '#ffffff',
      toolbar: indicator.toolbar,
      toolbar_text: '#ffffff',
      toolbar_field: indicator.frame,
      toolbar_field_text: '#ffffff',
    },
  };
  return {
    'manifest.json': `${JSON.stringify({
      manifest_version: 2,
      name: `Camofox identity: ${indicator.alias}`,
      version: '1.0',
      browser_specific_settings: { gecko: { id: ADDON_ID } },
      permissions: ['theme'],
      background: { scripts: ['background.js'] },
    }, null, 2)}\n`,
    'background.js': `browser.theme.update(${JSON.stringify(theme)});\n`,
    'label.svg': labelSvg(indicator),
  };
}

/**
 * Write the indicator extension to a content-addressed directory and return
 * its path. Existing identical content is reused.
 */
export async function writeIndicatorAddon(indicator, { rootDir = path.join(os.tmpdir(), 'camofox-identity-indicators') } = {}) {
  const files = indicatorAddonFiles(indicator);
  const digest = crypto.createHash('sha256').update(JSON.stringify(files)).digest('hex').slice(0, 16);
  const dir = path.join(rootDir, `${indicator.alias}-${digest}`);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(dir, name);
    const current = await fs.readFile(target, 'utf8').catch(() => null);
    if (current !== content) await fs.writeFile(target, content, { mode: 0o600 });
  }
  return dir;
}
