import { jest } from '@jest/globals';
import { createPluginEvents } from '../../lib/plugins.js';
import register from './index.js';

describe('local-hardening plugin', () => {
  test('uses the supported browser launch hook without discarding existing preferences', () => {
    const events = createPluginEvents();
    const log = jest.fn();
    register({}, { events, log });

    const options = { firefoxUserPrefs: { 'existing.preference': true } };
    events.emit('browser:launching', { options });

    expect(options.firefoxUserPrefs).toEqual(expect.objectContaining({
      'existing.preference': true,
      'browser.shell.checkDefaultBrowser': false,
      'toolkit.telemetry.enabled': false,
      'datareporting.healthreport.uploadEnabled': false,
      'app.shield.optoutstudies.enabled': false,
    }));
    expect(log).toHaveBeenCalledWith('info', 'local browser hardening applied', {
      defaultBrowserCheck: false,
      telemetry: false,
    });
  });
});
