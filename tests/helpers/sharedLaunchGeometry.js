// Deterministic launchOptions boundary for tests which do not start Firefox.
export const testMainDisplay = async () => ({ left: 0, top: 0, width: 2048, height: 1152 });
export function withWindowConfig(options) {
  return { ...options, env: { CAMOU_CONFIG_1: JSON.stringify({ 'window.outerWidth': 1100, 'window.outerHeight': 760 }) } };
}
