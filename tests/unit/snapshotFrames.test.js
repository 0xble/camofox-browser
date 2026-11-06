import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../../server.js', import.meta.url), 'utf8');
const patterns = source.slice(source.indexOf('const IFRAME_SKIP_PATTERNS = ['), source.indexOf('const MAX_IFRAMES_TO_PROCESS'));
const candidateStart = source.indexOf('function snapshotCandidateFrames(');
const candidateEnd = source.indexOf('\nasync function getAriaSnapshot(', candidateStart);
const snapshotCandidateFrames = vm.runInNewContext(`${patterns}\n${source.slice(candidateStart, candidateEnd)}\nsnapshotCandidateFrames`, { URL });
const frame = (url, name = '') => ({ url: () => url, name: () => name });
const candidates = (...children) => {
  const main = frame('https://merchant.example/checkout');
  return snapshotCandidateFrames({ mainFrame: () => main, frames: () => [main, ...children] });
};
const encodedFontFragment = Array.from({ length: 8 }, (_, index) =>
  `${encodeURIComponent(`fonts[${index}][src]`)}=${encodeURIComponent(`https://fonts.gstatic.com/s/fixture-${index}.woff2`)}`,
).join('&');

describe('snapshot frame URL classification', () => {
  test.each([
    `https://js.stripe.com/v3/elements-inner-card-fixture.html?integration=synthetic#${encodedFontFragment}`,
    'https://js.stripe.com/v3/elements-inner-card-fixture.html#fonts[0][src]=https://fonts.gstatic.com/s/fixture.woff2',
    'https://js.stripe.com/v3/elements-inner-card-fixture.html#fonts%5B0%5D%5Bsrc%5D=https%3A%2F%2Ffonts.gstatic.com%2Fs%2Ffixture.woff2',
    'https://fields.provider.example/field?return_url=https://www.google.com/recaptcha/api2/anchor&analytics=true',
    'https://fields.provider.example/field#metadata=https://tracking.example/segment/sentry',
    'https://fields.provider.example/field?font=fonts.gstatic.com#integration=facebook-gtm-hotjar',
    'https://gstatic.example@fields.provider.example/field',
  ])('keeps legitimate frame despite embedded URL text: %s', url => {
    const child = frame(url, '__privatePaymentFrameFixture');
    expect(candidates(child)).toEqual([child]);
  });

  test.each([
    'https://fonts.gstatic.com/s/fixture.woff2?next=https://fields.provider.example/field',
    'https://www.google.com/recaptcha/api2/anchor#https://fields.provider.example/field',
    'https://www.googletagmanager.com/ns.html',
    'https://tracking.example/pixel',
    'https://www.facebook.com/plugins/fixture',
    'https://stats.doubleclick.net/pixel',
    'https://cdn.segment.com/frame',
    'https://js.hcaptcha.com/frame',
    'https://iframe.arkoselabs.com/fixture',
    'https://captcha.provider.example/frame',
    'https://frame.provider.example/analytics/widget',
    'https://frame.provider.example/web-pixel',
    'https://frame.provider.example/px-captcha',
    'https://frame.provider.example/funcaptcha',
    'https://frame.provider.example/perimeterx/frame',
    'https://frame.provider.example/datadome/frame',
    'https://extensions.shopifycdn.com/frame',
    'https://frame.provider.example/app-bridge',
  ])('still skips tracking/captcha host or path: %s', url => {
    expect(candidates(frame(url))).toEqual([]);
  });

  test.each(['px-iframe-123', 'px-captcha', 'recaptcha-widget', 'tracking-frame', 'hcaptcha-frame', 'arkose-frame'])('still skips guarded frame name: %s', name => {
    expect(candidates(frame('https://fields.provider.example/field', name))).toEqual([]);
  });

  test.each(['', 'about:blank', 'about:srcdoc'])('still skips empty or placeholder URL: %s', url => {
    expect(candidates(frame(url))).toEqual([]);
  });

  test('keeps ordinary frames in order and excludes the main frame', () => {
    const one = frame('https://fields.provider.example/number');
    const two = frame('https://other-provider.example/expiry');
    expect(candidates(one, two)).toEqual([one, two]);
  });
});
