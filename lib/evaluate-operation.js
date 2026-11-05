import { createPaymentFrames } from './payment-frames.js';
import { reserveUntracedContext } from './context-tracing.js';

// One route operation, also exercised by fixture HTTP integration tests. The
// server still owns authentication, tab ownership, per-user and per-tab locking.
export function createEvaluateOperation({ paymentFrames = createPaymentFrames(), events }) {
  return async function evaluateOperation(page, body, { userId, tabId }) {
    const { expression, paymentOperation, frameId, merchantOrigin, frameOrigin, secret } = body;
    if (paymentOperation === 'discover') {
      return paymentFrames.discover(page, merchantOrigin);
    }
    if (paymentOperation === 'evaluate') {
      return paymentFrames.evaluate(page, { expression, frameId, merchantOrigin, frameOrigin });
    }
    // Never downgrade a misspelled/malformed frame request to page evaluation.
    if (paymentOperation !== undefined || frameId !== undefined || merchantOrigin !== undefined || frameOrigin !== undefined) {
      const err = new Error('Invalid payment frame operation');
      err.code = 'payment_frame_binding';
      throw err;
    }
    if (secret === true) reserveUntracedContext(page.context());
    if (secret !== true) events.emit('tab:evaluate', { userId, tabId, expression });
    const result = await page.evaluate(expression);
    if (secret !== true) events.emit('tab:evaluated', { userId, tabId, result });
    return result;
  };
}
