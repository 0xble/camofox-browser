import { describe, test, expect, jest } from '@jest/globals';
import { trackContextTracing, assertUntracedContext, reserveUntracedContext } from '../../lib/context-tracing.js';
import { createEvaluateOperation } from '../../lib/evaluate-operation.js';

function contextFixture() {
  const context = { tracing: { start: jest.fn(), startChunk: jest.fn(), stop: jest.fn(), stopChunk: jest.fn() } };
  trackContextTracing(context);
  return context;
}

describe('protected evaluation tracing state', () => {
  test('unknown contexts are refused before page evaluation', async () => {
    const page = { context: () => ({}), evaluate: jest.fn() };
    const operation = createEvaluateOperation({ events: { emit: jest.fn() } });
    await expect(operation(page, { expression: 'dummy-sensitive', secret: true }, {})).rejects.toThrow('untraced');
    expect(page.evaluate).not.toHaveBeenCalled();
  });

  test('starts are guarded before awaiting, stopChunk never clears the guard', async () => {
    const context = contextFixture();
    const starting = context.tracing.start();
    expect(() => assertUntracedContext(context)).toThrow('untraced');
    await starting;
    await context.tracing.stopChunk();
    expect(() => assertUntracedContext(context)).toThrow('untraced');
    await context.tracing.stop();
    expect(() => assertUntracedContext(context)).not.toThrow();
  });

  test('failed starts and stops remain fail-closed', async () => {
    const context = { tracing: {
      start: jest.fn().mockRejectedValue(new Error('fixture start failed')),
      startChunk: jest.fn(), stop: jest.fn().mockRejectedValue(new Error('fixture stop failed')),
    } };
    trackContextTracing(context);
    await expect(context.tracing.start()).rejects.toThrow('start failed');
    expect(() => assertUntracedContext(context)).toThrow();
    await expect(context.tracing.stop()).rejects.toThrow('stop failed');
    expect(() => assertUntracedContext(context)).toThrow();
  });

  test('a start racing a successful stop cannot clear tracing state', async () => {
    let finishStop;
    const context = { tracing: { start: jest.fn(), startChunk: jest.fn(),
      stop: () => new Promise(resolve => { finishStop = resolve; }) } };
    trackContextTracing(context);
    await context.tracing.start();
    const stopping = context.tracing.stop();
    await context.tracing.start();
    finishStop();
    await stopping;
    expect(() => assertUntracedContext(context)).toThrow();
  });

  test('protected contexts cannot begin tracing while or after secrets are evaluated', async () => {
    const context = contextFixture();
    reserveUntracedContext(context);
    await expect(context.tracing.start()).rejects.toThrow('protected context');
    await expect(context.tracing.startChunk()).rejects.toThrow('protected context');
    expect(() => assertUntracedContext(context)).not.toThrow();
  });
});
