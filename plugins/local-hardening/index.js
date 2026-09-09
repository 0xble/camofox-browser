// Local deployment hardening, using the supported browser:launching hook.
export default function register(app, ctx) {
  ctx.events.on('browser:launching', ({ options }) => {
    options.firefoxUserPrefs = {
      ...options.firefoxUserPrefs,
      'browser.shell.checkDefaultBrowser': false,
      'browser.shell.defaultBrowserCheckCount': 0,
      'browser.startup.homepage_override.mstone': 'ignore',
      'toolkit.telemetry.enabled': false,
      'toolkit.telemetry.unified': false,
      'datareporting.healthreport.uploadEnabled': false,
      'datareporting.policy.dataSubmissionEnabled': false,
      'app.shield.optoutstudies.enabled': false,
    };
    ctx.log('info', 'local browser hardening applied', { defaultBrowserCheck: false, telemetry: false });
  });
}
