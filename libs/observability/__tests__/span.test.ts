import { SpanStatusCode, type Tracer } from '@opentelemetry/api';
import { describe, expect, it, vi } from 'vitest';

import { withActiveSpan } from '../src/span.js';

function fakeTracer() {
  const span = {
    end: vi.fn(),
    recordException: vi.fn(),
    setStatus: vi.fn(),
    setAttribute: vi.fn(),
  };
  const startActiveSpan = vi.fn(
    (_name: string, _options: unknown, fn: (s: typeof span) => unknown) =>
      fn(span),
  );
  return {
    tracer: { startActiveSpan } as unknown as Tracer,
    span,
    startActiveSpan,
  };
}

describe('withActiveSpan', () => {
  it('sets OK and ends the span on success', async () => {
    const { tracer, span, startActiveSpan } = fakeTracer();
    await expect(
      withActiveSpan(tracer, 'moltnet.test', { attributes: { a: 1 } }, () =>
        Promise.resolve('done'),
      ),
    ).resolves.toBe('done');
    expect(startActiveSpan).toHaveBeenCalledWith(
      'moltnet.test',
      { attributes: { a: 1 } },
      expect.any(Function),
    );
    expect(span.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.OK });
    expect(span.end).toHaveBeenCalledOnce();
  });

  it('records a failure, sets ERROR and rethrows the original error', async () => {
    const { tracer, span } = fakeTracer();
    const error = new Error('boom');
    await expect(
      withActiveSpan(tracer, 'moltnet.test', {}, () => Promise.reject(error)),
    ).rejects.toBe(error);
    expect(span.recordException).toHaveBeenCalledWith(error);
    expect(span.setStatus).toHaveBeenCalledWith({
      code: SpanStatusCode.ERROR,
      message: 'boom',
    });
    expect(span.end).toHaveBeenCalledOnce();
  });

  it('wraps a non-Error rejection for the exception record', async () => {
    const { tracer, span } = fakeTracer();
    await expect(
      withActiveSpan(tracer, 'moltnet.test', {}, () => Promise.reject('nope')),
    ).rejects.toBe('nope');
    expect(span.recordException).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'nope' }),
    );
  });

  it('lets the caller classify an expected error without ERROR status', async () => {
    const { tracer, span } = fakeTracer();
    const error = new Error('Client disconnected');
    await expect(
      withActiveSpan(
        tracer,
        'moltnet.test',
        {
          isFailure: (_error, active) => {
            active.setAttribute('moltnet.test.aborted_by', 'caller');
            return false;
          },
        },
        () => Promise.reject(error),
      ),
    ).rejects.toBe(error);
    expect(span.setAttribute).toHaveBeenCalledWith(
      'moltnet.test.aborted_by',
      'caller',
    );
    expect(span.recordException).not.toHaveBeenCalled();
    expect(span.setStatus).not.toHaveBeenCalled();
    expect(span.end).toHaveBeenCalledOnce();
  });
});
