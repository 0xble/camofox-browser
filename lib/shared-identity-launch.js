import { syncProfileExtensions } from './profile-extensions.js';

export async function launchSharedIdentityContext(profilePath, { headed = false, extensions = [], launchOptions, firefox, os, getHostOS, config, events, log }) {
  // Firefox reads <profile>/extensions only at startup, so the pinned set must
  // be in place before launch. Extension state then persists in the profile.
  await syncProfileExtensions(profilePath, extensions, log);
  const options = await launchOptions({
    headless: !headed,
    os: getHostOS(),
    humanize: os.platform() !== 'darwin',
    enable_cache: true,
    exclude_addons: config.disableDefaultAddons ? ['UBO'] : undefined,
  });
  options.handleSIGTERM = false;
  options.handleSIGINT = false;
  options.handleSIGHUP = false;
  await events.emitAsync('browser:launching', { options });
  return firefox.launchPersistentContext(profilePath, options);
}
