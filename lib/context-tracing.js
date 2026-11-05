// Playwright traces retain evaluate arguments/results even without sources or
// snapshots. Track starts (including plugin starts) on each owning context.
const contexts = new WeakMap();

export function trackContextTracing(context) {
  if (contexts.has(context)) return;
  const state = { tracing: false, protected: false, generation: 0 };
  contexts.set(context, state);
  const tracing = context.tracing;
  for (const method of ['start', 'startChunk']) {
    const original = tracing[method];
    tracing[method] = async function (...args) {
      // A protected expression may still be awaiting its result, or may have
      // left card data in the DOM. Never begin tracing later in that context.
      if (state.protected) throw new Error('Tracing refused for a protected context.');
      // Mark before awaiting; failed/partial starts remain fail-closed until a
      // successful stop proves tracing has ended.
      state.generation++;
      state.tracing = true;
      return original.apply(this, args);
    };
  }
  const stop = tracing.stop;
  tracing.stop = async function (...args) {
    const generation = state.generation;
    const result = await stop.apply(this, args);
    if (state.generation === generation) state.tracing = false;
    return result;
  };
  // stopChunk does not disable context tracing, so it must not clear the guard.
}

export function reserveUntracedContext(context) {
  assertUntracedContext(context);
  contexts.get(context).protected = true;
}

export function assertUntracedContext(context) {
  // Unknown contexts are not evidence of an untraced context.
  if (contexts.get(context)?.tracing !== false) {
    const error = new Error('Protected evaluation requires an untraced browser context.');
    error.code = 'payment_frame_binding';
    throw error;
  }
}
