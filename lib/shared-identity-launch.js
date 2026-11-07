import fs from 'node:fs/promises';
import path from 'node:path';
import { contextIdentityOptions, launchLocale } from './browser-identity.js';
import { syncProfileExtensions } from './profile-extensions.js';
import { writeIndicatorAddon } from './identity-indicator.js';
import { nativeHumanizeEnabled } from './camoufox-executable.js';
import { findMainDisplay, windowBounds } from './park-display-launcher.js';
import { prepareParkedProfile } from './shared-identity-visibility.js';
import { fingerprintScreen, fingerprintWindowSize, fittedFingerprintWindow } from './shared-identity-geometry.js';
import { prepareRuntimeAddons as prepareAddons } from './runtime-addons.js';

const UBLOCK_ORIGIN_ID = 'uBlock0@raymondhill.net';
// Present while newly installed extensions still need their activation
// startup. It survives failed launches and process restarts, so a retry still
// warms up even though the sync then reports the files as unchanged.
export const PENDING_ACTIVATION_FILE = 'camofox-extensions-pending-activation';

export async function launchSharedIdentityContext(profilePath, { headed = false, extensions = [], indicator = null, visibility = null, launchOptions, firefox, os, getHostOS, config, hasProxy = false, events, log, discoverMainDisplay = findMainDisplay, prepareRuntimeAddons = prepareAddons }) {
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
  // Headed windows of a mapped identity load the generated chrome indicator.
  // It is a temporary add-on, never written to the profile; headless and
  // warm-up launches never load it.
  const indicatorAddon = headed && indicator ? await writeIndicatorAddon(indicator) : null;
  const identity = { hasProxy: !!hasProxy, directIdentity: config?.directIdentity ?? null };
  const fingerprintLocale = launchLocale(identity);
  const launch = async ({ headless }) => {
    let displays = !headless ? visibility?.launchDisplays : null;
    if (!headless && !displays && os.platform() === 'darwin') {
      try { displays = [await discoverMainDisplay()]; }
      catch (error) {
        // Display discovery is optional for agent acquisition. The app-hidden
        // controller independently records/refuses unavailable human handoff.
        log?.('warn', 'headed display discovery unavailable; launching without geometry seed', { error: error.message });
      }
    }
    const screen = displays ? fingerprintScreen(displays) : null;
    let fittedWindow;
    const generateOptions = () => launchOptions({
      ...(managesExtensions || visibility ? { config: { allowAddonNewtab: true } } : {}),
      headless,
      ...(screen ? { screen: fittedWindow ? { ...screen, minWidth: fittedWindow[0], minHeight: fittedWindow[1] } : screen } : {}),
      ...(fittedWindow ? { window: fittedWindow } : {}),
      os: getHostOS(),
      humanize: nativeHumanizeEnabled({ platform: os.platform(), log }),
      enable_cache: true,
      exclude_addons: config.disableDefaultAddons || pinsUblock ? ['UBO'] : undefined,
      ...(fingerprintLocale ? { locale: fingerprintLocale } : {}),
    });
    // Fit outliers through Camoufox's coherent window override. Bound the new
    // sample's *minimum* screen too, so resampling cannot put that fitted window
    // on a smaller fingerprint screen. No random rejection loop is needed.
    let options = await generateOptions();
    if (screen) {
      const size = fingerprintWindowSize(options);
      const fitted = fittedFingerprintWindow(options, screen);
      if (size.width !== fitted[0] || size.height !== fitted[1]) {
        fittedWindow = fitted;
        options = await generateOptions();
      }
    }
    // Only the direct identity fields apply here. Shared persistent contexts
    // are never proxied or GeoIP-spoofed, so the proxy branch's geolocation
    // grant would expose an unspoofed browser.
    if (!identity.hasProxy) Object.assign(options, contextIdentityOptions(identity));
    if (!headless && visibility) options.ignoreDefaultArgs = [...(options.ignoreDefaultArgs || []), '-foreground'];
    options.handleSIGTERM = false;
    options.handleSIGINT = false;
    options.handleSIGHUP = false;
    await events.emitAsync('browser:launching', { options });
    if (screen) {
      const size = fingerprintWindowSize(options);
      const fitted = fittedFingerprintWindow(options, screen);
      if (size.width !== fitted[0] || size.height !== fitted[1])
        throw new Error('Camoufox outer window exceeds the headed identity display');
      visibility?.setWindowSize?.(size);
      const bounds = visibility?.initialBounds || windowBounds(displays[0], false, size);
      await prepareParkedProfile(profilePath, bounds);
    }
    const runtimeAddons = headless ? [] : [...new Set([indicatorAddon, visibility?.addon].filter(Boolean))];
    if (!runtimeAddons.length) return firefox.launchPersistentContext(profilePath, options);
    const installer = await prepareRuntimeAddons(runtimeAddons, { platform: os.platform(), profilePath });
    let context, failure, closed = false;
    const onClosed = () => { closed = true; };
    try {
      options.args = [...(options.args || []), ...installer.args];
      options.firefoxUserPrefs = { ...options.firefoxUserPrefs, ...installer.firefoxUserPrefs };
      context = await firefox.launchPersistentContext(profilePath, options);
      context.once('close', onClosed);
      await installer.install(context);
      await installer.close();
      if (closed) throw new Error('Browser closed before runtime addon installation completed');
      return context;
    } catch (error) {
      failure = error;
      if (context) {
        let timer;
        try {
          await Promise.race([context.close(), new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('Runtime addon failure cleanup timed out')), 5000);
          })]);
        } catch (closeError) {
          error.closeError = closeError;
          if (!closed) error.profileOwnershipUnconfirmed = true;
        } finally { clearTimeout(timer); }
      }
      throw error;
    } finally {
      context?.removeListener('close', onClosed);
      if (failure) try { await installer.close(); } catch (cleanupError) { if (cleanupError !== failure) failure.cleanupError = cleanupError; }
    }
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
