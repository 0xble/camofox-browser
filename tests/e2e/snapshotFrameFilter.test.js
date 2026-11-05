import { createServer } from 'node:http';
import { createClient } from '../helpers/client.js';
import { getSharedEnv } from './sharedEnv.js';

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
const close = server => new Promise(resolve => server.close(resolve));

const encodedFontFragment = Array.from({ length: 8 }, (_, index) =>
  `${encodeURIComponent(`fonts[${index}][src]`)}=${encodeURIComponent(`https://fonts.gstatic.com/s/fixture-${index}.woff2`)}`,
).join('&');
const providerReferences = [
  ['Stripe-shaped eight-font fragment', `/v3/elements-inner-card-fixture.html?integration=synthetic#${encodedFontFragment}`],
  ['Stripe-shaped font fragment', '/v3/elements-inner-card-fixture.html#fonts[0][src]=https://fonts.gstatic.com/s/fixture.woff2'],
  ['other provider query', '/field?return_url=https://www.google.com/recaptcha/api2/anchor&analytics=true'],
  ['other provider fragment', '/field#metadata=https://tracking.example/segment/sentry'],
];

describe('snapshot and refs for synthetic cross-origin provider frames', () => {
  let merchant, processor, merchantOrigin, processorOrigin, serverUrl;

  beforeAll(async () => {
    ({ serverUrl } = getSharedEnv());
    processor = createServer((req, res) => {
      res.setHeader('Content-Type', 'text/html');
      if (req.url.startsWith('/excluded')) {
        return res.end('<button>Excluded named frame control</button>');
      }
      if (req.url.startsWith('/recaptcha/') || req.url.startsWith('/analytics/')) {
        return res.end('<button>Excluded URL frame control</button>');
      }
      res.end(`<label>Synthetic field<input id="field"></label>
        <button onclick="document.querySelector('output').textContent = 'Recorded: ' + document.querySelector('input').value">Record synthetic action</button><output></output>`);
    });
    processorOrigin = await listen(processor);
    merchant = createServer((req, res) => {
      res.setHeader('Content-Type', 'text/html');
      const fixture = Number(new URL(req.url, 'http://fixture').searchParams.get('fixture'));
      res.end(`<h1>Synthetic merchant</h1>
        <iframe name="__privateProviderFrameFixture" src="${processorOrigin}${providerReferences[fixture][1]}"></iframe>
        <iframe src="${processorOrigin}/recaptcha/api2/anchor"></iframe>
        <iframe src="${processorOrigin}/analytics/frame"></iframe>
        <iframe name="px-iframe-123" src="${processorOrigin}/excluded"></iframe>
        <iframe src="about:blank"></iframe><iframe srcdoc="<button>Excluded srcdoc control</button>"></iframe>`);
    });
    merchantOrigin = await listen(merchant);
  });

  afterAll(async () => {
    await Promise.all([merchant, processor].filter(Boolean).map(close));
  });

  test.each(providerReferences.map(([name], index) => [name, index]))('%s retains visible controls and usable frame refs', async (_name, index) => {
    const client = createClient(serverUrl);
    try {
      const { tabId } = await client.createTab(`${merchantOrigin}/?fixture=${index}`);
      const before = await client.getSnapshot(tabId);
      expect(before.snapshot).toContain('Synthetic field');
      expect(before.snapshot).not.toContain('Excluded');
      const fieldRef = before.snapshot.match(/textbox "Synthetic field" \[(e\d+)\]/)?.[1];
      const buttonRef = before.snapshot.match(/button "Record synthetic action" \[(e\d+)\]/)?.[1];
      expect(fieldRef).toBeDefined();
      expect(buttonRef).toBeDefined();
      await client.type(tabId, { ref: fieldRef, text: 'synthetic-frame-value' });
      await client.click(tabId, { ref: buttonRef });
      const after = await client.getSnapshot(tabId);
      expect(after.snapshot).toContain('Recorded: synthetic-frame-value');
      expect(after.snapshot).not.toContain('Excluded');
    } finally {
      await client.cleanup();
    }
  });
});
