import type { Trace } from '../types/api';

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
