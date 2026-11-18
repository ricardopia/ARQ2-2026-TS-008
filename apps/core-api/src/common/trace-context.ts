import { context, propagation } from '@opentelemetry/api';

/** W3C traceparent of the active span, or null when there is no trace. */
export function currentTraceparent(): string | null {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  return carrier.traceparent ?? null;
}
