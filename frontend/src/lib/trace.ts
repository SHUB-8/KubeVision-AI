import type { Span, Trace } from '../types/api';

/**
 * Tempo's search response carries a trace-level duration, but the backend only
 * forwards it when Tempo reports one. When it is absent, derive the duration
 * from the spans we do have so the trace list never shows a bare dash for a
 * trace that clearly took time.
 */
export function traceDurationMs(trace: Trace): number | null {
  if (typeof trace.durationMs === 'number' && trace.durationMs > 0) {
    return trace.durationMs;
  }
  const spans = trace.spans ?? [];
  if (spans.length === 0) return null;

  let minStart = Number.POSITIVE_INFINITY;
  let maxEnd = Number.NEGATIVE_INFINITY;
  for (const span of spans) {
    if (!Number.isFinite(span.startTime)) continue;
    minStart = Math.min(minStart, span.startTime);
    maxEnd = Math.max(maxEnd, span.startTime + (span.duration || 0));
  }
  if (!Number.isFinite(minStart) || !Number.isFinite(maxEnd)) return null;
  return (maxEnd - minStart) / 1_000_000;
}

/** Number of spans actually attached to a search result. */
export function traceSpanCount(trace: Trace): number {
  return trace.spanCount ?? trace.spans?.length ?? 0;
}

/**
 * True when one span recorded a failure — via OTLP status or failure
 * attributes (HTTP 5xx, gRPC non-OK, error=true). Shared by the trace list's
 * error dot and by cascade attribution, so both agree on what "failing" means.
 */
export function isFailingSpan(span: Span): boolean {
  if (
    span.statusCode &&
    span.statusCode !== 'STATUS_CODE_UNSET' &&
    span.statusCode !== '0' &&
    !span.statusCode.includes('OK')
  ) {
    return true;
  }
  const attrs = span.attributes || {};
  if (attrs['error'] === 'true' || attrs['error.type']) return true;
  const httpStatus = parseInt(attrs['http.status_code'] || attrs['http.response.status_code'] || '0', 10);
  if (httpStatus >= 500) return true;
  const grpcCode = attrs['rpc.grpc.status_code'] || attrs['rpc.status_code'] || attrs['rpc.response.status_code'];
  if (grpcCode && grpcCode !== '0' && grpcCode !== 'OK') return true;
  return false;
}

/** True when any span in the trace recorded a failure. */
export function traceHasError(trace: Trace): boolean {
  return (trace.spans ?? []).some(isFailingSpan);
}

/**
 * Absolute start of the trace in epoch nanoseconds, from the earliest span.
 * The trace list has no "when did this happen" column today — this makes one
 * possible without a backend change.
 */
export function traceStartNs(trace: Trace): number | null {
  let minStart = Number.POSITIVE_INFINITY;
  for (const span of trace.spans ?? []) {
    if (!Number.isFinite(span.startTime)) continue;
    minStart = Math.min(minStart, span.startTime);
  }
  return Number.isFinite(minStart) ? minStart : null;
}
