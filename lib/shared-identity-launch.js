import fs from 'node:fs/promises';
import path from 'node:path';
import { syncProfileExtensions } from './profile-extensions.js';

const UBLOCK_ORIGIN_ID = 'uBlock0@raymondhill.net';
// Present while newly installed extensions still need their activation
// startup. It survives failed launches and process restarts, so a retry still
// warms up even though the sync then reports the files as unchanged.
export const PENDING_ACTIVATION_FILE = 'camofox-extensions-pending-activation';

export async function launchSharedIdentityContext(profilePath, { headed = false, extensions = [], launchOptions, firefox, os, getHostOS, config, events, log }) {
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
