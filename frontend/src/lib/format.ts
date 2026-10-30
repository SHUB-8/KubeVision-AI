/**
 * Shared formatting helpers for telemetry values.
 *
 * Durations arrive from Tempo/Beyla as nanoseconds (spans) or milliseconds
 * (trace summaries), and are frequently sub-millisecond for eBPF-observed
 * gRPC calls. Rounding those to a whole millisecond renders them as a
 * meaningless "0 ms", so small values keep sub-millisecond precision.
 */

/** Formats a nanosecond span duration for display. */
export function formatNs(ns: number | null | undefined): string {
  if (ns === null || ns === undefined || Number.isNaN(ns)) return '—';
  if (ns <= 0) return '<0.1 ms';
  if (ns < 1_000_000) return `${(ns / 1_000_000).toFixed(2)} ms`;
  if (ns < 1_000_000_000) return `${(ns / 1_000_000).toFixed(1)} ms`;
  return `${(ns / 1_000_000_000).toFixed(2)} s`;
}

/** Formats a millisecond duration for display. */
export function formatMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || Number.isNaN(ms)) return '—';
  if (ms <= 0) return '<0.1 ms';
  if (ms < 1) return `${ms.toFixed(2)} ms`;
  if (ms < 10) return `${ms.toFixed(1)} ms`;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

/** Formats a request rate; returns an em dash when nothing was measured. */
export function formatRate(ratePerSecond: number | null | undefined, digits = 2): string {
  if (ratePerSecond === null || ratePerSecond === undefined || Number.isNaN(ratePerSecond)) return '—';
  return `${ratePerSecond.toFixed(digits)}/s`;
}

/** Formats a 0..1 ratio as a percentage. */
export function formatPercent(ratio: number | null | undefined, digits = 1): string {
  if (ratio === null || ratio === undefined || Number.isNaN(ratio)) return '—';
  return `${(ratio * 100).toFixed(digits)}%`;
}

/**
 * Formats a timestamp (e.g. a pod creation time) as a relative age.
 * "11:34:24 PM" answers the wrong question; an age column must read "6h 12m".
 */
export function formatAge(timestamp: string | number | null | undefined): string {
  if (timestamp === null || timestamp === undefined || timestamp === '') return '—';
  const created = new Date(timestamp).getTime();
  if (Number.isNaN(created)) return '—';
  const seconds = Math.max(0, Math.floor((Date.now() - created) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}
