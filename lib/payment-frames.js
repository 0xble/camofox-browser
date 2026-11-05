import { randomUUID } from 'node:crypto';
import { assertUntracedContext, reserveUntracedContext } from './context-tracing.js';

// Exact HTTPS origins only. These host Stripe Elements, Braintree Hosted Fields,
// and Adyen Secured Fields; caller-supplied origins never expand this list.
export const PAYMENT_FRAME_ORIGINS = Object.freeze([
  'https://js.stripe.com',
  'https://assets.braintreegateway.com',
  'https://checkoutshopper-live.adyen.com',
  'https://checkoutshopper-test.adyen.com',
]);

function denied() {
  const error = new Error('Payment frame binding is invalid or stale; rediscover frames.');
  error.code = 'payment_frame_binding';
  return error;
}

export function exactOrigin(value) {
  if (typeof value !== 'string') throw denied();
  const url = new URL(value);
  if (!['https:', 'http:'].includes(url.protocol) || url.origin !== value) throw denied();
  return value;
}

// Dependency injection is deliberately module-only, not HTTP/config/env input.
// Local synthetic-browser tests inject their ephemeral processor origin here.
export function createPaymentFrames({ allowedOrigins = PAYMENT_FRAME_ORIGINS } = {}) {
  const allowed = new Set(allowedOrigins);
  const pages = new WeakMap();
  const epochs = new WeakMap();

  function watch(page) {
    if (epochs.has(page)) return;
    epochs.set(page, 0);
    const invalidate = frame => {
      const binding = pages.get(page);
      if (frame !== page.mainFrame() && ![...binding?.frames?.values() || []].some(record => record.frame === frame)) return;
      epochs.set(page, epochs.get(page) + 1);
      void clear(page);
    };
    page.on('framenavigated', invalidate);
    page.on('framedetached', invalidate);
    page.on('close', () => { void clear(page); });
  }

  async function clear(page) {
    const old = pages.get(page);
    pages.delete(page);
    if (old) await Promise.allSettled([
      old.merchantDocument.dispose(),
      ...[...old.frames.values()].map(record => record.document.dispose()),
    ]);
  }

  async function discover(page, merchantOrigin) {
    exactOrigin(merchantOrigin);
    watch(page);
    await clear(page);
    const epoch = epochs.get(page);
    const main = page.mainFrame();
    const merchantDocument = await main.evaluateHandle(() => document);
    const frames = new Map();
    try {
      if (!await merchantDocument.evaluate((doc, origin) => doc === document && location.origin === origin, merchantOrigin)) throw denied();
      for (const frame of main.childFrames().slice(0, 64)) {
        let document;
        try {
          if (!allowed.has(new URL(frame.url()).origin)) continue;
          const element = await frame.frameElement();
          const sandboxed = await element.evaluate(el => el.hasAttribute('sandbox'));
          await element.dispose();
          if (sandboxed) continue;
          document = await frame.evaluateHandle(() => window.document);
          const origin = await document.evaluate(doc => doc === window.document && window.origin === location.origin ? location.origin : null);
          if (!allowed.has(origin) || frame.parentFrame() !== main || frame.isDetached()) {
            await document.dispose();
            continue;
          }
          frames.set(randomUUID(), { frame, document, origin });
        } catch {
          await document?.dispose().catch(() => {});
        }
      }
      if (!await merchantDocument.evaluate((doc, origin) => doc === document && location.origin === origin, merchantOrigin)) throw denied();
      if (epochs.get(page) !== epoch) throw denied();
      pages.set(page, { main, merchantDocument, merchantOrigin, frames, epoch });
      return [...frames].map(([frame_id, { origin }]) => ({ frame_id, origin }));
    } catch {
      await Promise.allSettled([merchantDocument.dispose(), ...[...frames.values()].map(record => record.document.dispose())]);
      throw denied();
    }
  }

  async function evaluate(page, { frameId, expression, merchantOrigin, frameOrigin }) {
    try {
      assertUntracedContext(page.context());
      exactOrigin(merchantOrigin);
      exactOrigin(frameOrigin);
      if (typeof expression !== 'string' || !expression.trim()) throw denied();
      const binding = pages.get(page);
      const record = binding?.frames.get(frameId);
      if (!record || binding.epoch !== epochs.get(page) || binding.merchantOrigin !== merchantOrigin || record.origin !== frameOrigin || !allowed.has(frameOrigin)) throw denied();
      if (binding.main !== page.mainFrame() || record.frame.parentFrame() !== binding.main || record.frame.isDetached()) throw denied();
      if (!await binding.merchantDocument.evaluate((doc, origin) => doc === document && location.origin === origin, merchantOrigin)) throw denied();
      // Evaluate against the captured document handle, not a fresh frame context.
      // Identity + origin check and synchronous write share one JS execution task.
      // A navigation destroys this context; a same-URL reload cannot reuse it.
      reserveUntracedContext(page.context());
      return await record.document.evaluate((doc, { origin, expression }) => {
        if (doc !== document || location.origin !== origin || window.origin !== origin || window.parent === window) throw new Error('Payment frame binding refused');
        return (0, eval)(expression);
      }, { origin: frameOrigin, expression });
    } catch {
      // Playwright exceptions may include the expression, result, or input value.
      // Never propagate them into route logging, plugins, telemetry, or the client.
      throw denied();
    }
  }

  return { discover, evaluate };
}
