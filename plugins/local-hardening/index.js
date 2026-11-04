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
      // Keep beta.30 automation semantics: beta.41's driver-only exemption
      // does not reach target=_blank retargeting in Firefox's parent process.
      'dom.disable_open_during_load': false,
    };
    ctx.log('info', 'local browser hardening applied', { defaultBrowserCheck: false, telemetry: false });
  });
}
