export async function launchSharedIdentityContext(profilePath, { headed = false, launchOptions, firefox, os, getHostOS, config, events }) {
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
