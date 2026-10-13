import { withActiveSpan } from '@moltnet/observability/span';
import { type Attributes, type Span, trace } from '@opentelemetry/api';

const tracer = trace.getTracer('@moltnet/task-service');

export function traceTaskServicePhase<T>(
  name: string,
  attributes: Attributes,
  run: (span: Span) => Promise<T>,
): Promise<T> {
  return withActiveSpan(tracer, name, { attributes }, run);
}
