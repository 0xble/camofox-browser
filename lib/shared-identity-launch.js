import { syncProfileExtensions } from './profile-extensions.js';

const UBLOCK_ORIGIN_ID = 'uBlock0@raymondhill.net';

export async function launchSharedIdentityContext(profilePath, { headed = false, extensions = [], launchOptions, firefox, os, getHostOS, config, events, log }) {
  // Firefox reads <profile>/extensions only at startup, so the pinned set must
  // be in place before launch. Extension state then persists in the profile.
  // `extensions === null` means the configuration was invalid: leave the
  // profile's extensions exactly as they are rather than pruning them.
  let installed = [];
  if (extensions === null) {
    log?.('warn', 'invalid extension configuration; profile extensions left unchanged', { profilePath });
  } else {
    ({ installed } = await syncProfileExtensions(profilePath, extensions, log));
  }
  // A pinned local uBlock Origin replaces Camoufox's launch-time download.
  const pinsUblock = Array.isArray(extensions) && extensions.some(ext => ext.id === UBLOCK_ORIGIN_ID);
  const launch = async ({ headless }) => {
    const options = await launchOptions({
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
  if (installed.length) {
    // Firefox registers a newly sideloaded (or replaced) extension during the
    // startup that discovers it, but only starts it on the next startup. A
    // brief headless warm-up launch lets the real launch run it immediately.
    const warmup = await launch({ headless: true });
    await warmup.close();
    log?.('info', 'extension warm-up launch completed', { installed });
  }
  return launch({ headless: !headed });
}
