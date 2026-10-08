import fs from 'node:fs/promises';
import path from 'node:path';
import { syncProfileExtensions } from './profile-extensions.js';

const UBLOCK_ORIGIN_ID = 'uBlock0@raymondhill.net';
const CUSTOMIZATION_PREF = 'user_pref("toolkit.legacyUserProfileCustomizations.stylesheets", true);';
const INDICATOR_START = '/* CAMOFOX_IDENTITY_INDICATOR_START */';
const INDICATOR_END = '/* CAMOFOX_IDENTITY_INDICATOR_END */';
// Present while newly installed extensions still need their activation
// startup. It survives failed launches and process restarts, so a retry still
// warms up even though the sync then reports the files as unchanged.
export const PENDING_ACTIVATION_FILE = 'camofox-extensions-pending-activation';

function indicatorCss({ alias, displayName, accent, background, text }) {
  const label = `Camofox · ${displayName || alias}`;
  return `@namespace url("http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul");

#TabsToolbar::after {
  content: "${label}";
  display: -moz-box;
  -moz-box-align: center;
  margin: 4px 8px 4px 4px;
  padding: 3px 9px;
  border: 1px solid ${accent};
  border-radius: 999px;
  background: ${background};
  color: ${text};
  font: menu;
  font-weight: 600;
  white-space: nowrap;
}

#main-window[chromehidden~="toolbar"] #TabsToolbar::after {
  display: none;
}
`;
}

async function writeIdentityIndicator(profilePath, indicator) {
  const chromeDir = path.join(profilePath, 'chrome');
  const userChrome = path.join(chromeDir, 'userChrome.css');
  let existing = '';
  try { existing = await fs.readFile(userChrome, 'utf8'); } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const managedPattern = new RegExp(`\n?${INDICATOR_START}[\s\S]*?${INDICATOR_END}\n?`, 'g');
  const withoutIndicator = existing.replace(managedPattern, '').trimEnd();
  if (!indicator) {
    if (withoutIndicator !== existing.trimEnd()) {
      if (withoutIndicator) {
        await fs.writeFile(userChrome, `${withoutIndicator}\n`, { mode: 0o600 });
      } else {
        await fs.rm(userChrome, { force: true });
      }
    }
    return;
  }

  await fs.mkdir(chromeDir, { recursive: true, mode: 0o700 });
  const managedCss = `${INDICATOR_START}\n${indicatorCss(indicator).trim()}\n${INDICATOR_END}`;
  const updated = `${withoutIndicator}${withoutIndicator ? '\n\n' : ''}${managedCss}\n`;
  if (updated !== existing) await fs.writeFile(userChrome, updated, { mode: 0o600 });

  const userPrefs = path.join(profilePath, 'user.js');
  let existingPrefs = '';
  try { existingPrefs = await fs.readFile(userPrefs, 'utf8'); } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const lines = existingPrefs ? existingPrefs.split(/\r?\n/) : [];
  const retained = lines.filter(line => line.trim() !== CUSTOMIZATION_PREF);
  retained.push(CUSTOMIZATION_PREF);
  const updatedPrefs = `${retained.join('\n')}\n`;
  if (updatedPrefs !== existingPrefs) await fs.writeFile(userPrefs, updatedPrefs, { mode: 0o600 });
}

export async function launchSharedIdentityContext(profilePath, { headed = false, extensions = [], identityIndicator, launchOptions, firefox, os, getHostOS, config, events, log }) {
  // Firefox reads <profile>/extensions only at startup, so the pinned set must
  // be in place before launch. Extension state then persists in the profile.
  // `extensions === null` means the configuration was invalid: leave the
  // profile's extensions exactly as they are rather than pruning them.
  const pending = path.join(profilePath, PENDING_ACTIVATION_FILE);
  const exists = file => fs.access(file).then(() => true, () => false);
  let installed = [];
  if (extensions === null) {
    log?.('warn', 'invalid extension configuration; profile extensions left unchanged', { profilePath });
  } else if (extensions.length) {
    // Mark before syncing so a crash between committing a file and recording
    // it can only cause one extra warm-up, never a skipped one.
    const alreadyPending = await exists(pending);
    if (!alreadyPending) await fs.writeFile(pending, '', { mode: 0o600 });
    ({ installed } = await syncProfileExtensions(profilePath, extensions, log));
    if (!installed.length && !alreadyPending) await fs.rm(pending, { force: true });
  } else {
    await syncProfileExtensions(profilePath, extensions, log);
  }
  await writeIdentityIndicator(profilePath, headed ? identityIndicator : null);
  const needsWarmup = await exists(pending);
  // A pinned local uBlock Origin replaces Camoufox's launch-time download.
  const pinsUblock = Array.isArray(extensions) && extensions.some(ext => ext.id === UBLOCK_ORIGIN_ID);
  // Camoufox rejects extension calls to tabs.create and openOptionsPage unless
  // allowAddonNewtab is set. Extensions such as 1Password await those calls
  // during startup, so their pages stay blank without it. Only identities with
  // a managed extension set opt in; everything else keeps the engine default.
  const managesExtensions = Array.isArray(extensions) && extensions.length > 0;
  const launch = async ({ headless }) => {
    const options = await launchOptions({
      ...(managesExtensions ? { config: { allowAddonNewtab: true } } : {}),
      headless,
      os: getHostOS(),
      humanize: os.platform() !== 'darwin',
      enable_cache: true,
      exclude_addons: config.disableDefaultAddons || pinsUblock ? ['UBO'] : undefined,
    });
    options.handleSIGTERM = false;
    options.handleSIGINT = false;
    options.handleSIGHUP = false;
    await events.emitAsync('browser:launching', { options });
    return firefox.launchPersistentContext(profilePath, options);
  };
  if (needsWarmup) {
    // Firefox registers a newly sideloaded (or replaced) extension during the
    // startup that discovers it, but only starts it on the next startup. A
    // brief headless warm-up launch lets the real launch run it immediately.
    const warmup = await launch({ headless: true });
    let closed = false;
    warmup.on?.('close', () => { closed = true; });
    try {
      await warmup.close();
    } catch (error) {
      // A close event is stronger evidence than a rejected close promise.
      // Without it, the warm-up browser may still hold the profile, so the
      // caller must not launch on this profile again.
      if (!closed) {
        error.profileOwnershipUnconfirmed = true;
        throw error;
      }
    }
    await fs.rm(pending, { force: true });
    log?.('info', 'extension warm-up launch completed', { installed });
  }
  return launch({ headless: !headed });
}
