import {
  type Attributes,
  type Span,
  SpanStatusCode,
  type Tracer,
} from '@opentelemetry/api';

export interface ActiveSpanOptions {
  attributes?: Attributes;
  /**
   * Decide whether a thrown error is a failure of this operation. Return
   * false for expected outcomes (for example a client disconnect): the span
   * then ends without an exception or ERROR status. Called before the error
   * is rethrown; it may annotate the span.
   */
  isFailure?: (error: unknown, span: Span) => boolean;
}

/**
 * Run `run` inside an active span. Success sets OK; a failure records the
 * exception and sets ERROR with its message; the span always ends and the
 * original error is always rethrown.
 */
export function withActiveSpan<T>(
  tracer: Tracer,
  name: string,
  options: ActiveSpanOptions,
  run: (span: Span) => Promise<T>,
): Promise<T> {
  return tracer.startActiveSpan(
    name,
    { attributes: options.attributes },
    async (span) => {
      try {
        const result = await run(span);
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (error) {
        if (options.isFailure?.(error, span) ?? true) {
          const message =
            error instanceof Error ? error.message : String(error);
          span.recordException(
            error instanceof Error ? error : new Error(message),
          );
          span.setStatus({ code: SpanStatusCode.ERROR, message });
        }
        throw error;
      } finally {
        span.end();
      }
    },
  );
}
