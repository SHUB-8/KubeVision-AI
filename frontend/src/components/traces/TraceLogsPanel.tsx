import React, { useEffect, useState } from 'react';
import { X, Terminal } from 'lucide-react';
import { api } from '../../services/api';
import { TraceLogs } from '../../types/api';
import { LoadingSpinner } from '../common/LoadingSpinner';

interface TraceLogsPanelProps {
  traceId: string;
  onClose: () => void;
}

/** Fluent Bit may forward the whole structured record; show the message field. */
const displayLine = (line: string): string => {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return trimmed;
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const message = parsed.message ?? parsed.log ?? parsed.msg;
    return typeof message === 'string' ? message : trimmed;
  } catch {
    return trimmed;
  }
};

/** Nanosecond strings exceed Number precision; keep only the millisecond prefix. */
const nsToMs = (ns: string): number => Number(ns.slice(0, 13));

const formatTime = (ns: string): string => {
  const ms = nsToMs(ns);
  if (!Number.isFinite(ms)) return '—';
  return new Date(ms).toLocaleTimeString();
};

/** Lines that plausibly explain a failure: error words, 4xx/5xx statuses, stack traces. */
const SUSPICIOUS = /(\berror\b|\bfail(ed|ure)?\b|\bexception\b|\bpanic\b|\bdenied\b|\brefused\b|\btimeout\b|code:\s*[45]\d\d|status["']?\s*[:=]\s*["']?[45]\d\d|\bat\s+process\.)/i;

export const TraceLogsPanel: React.FC<TraceLogsPanelProps> = ({ traceId, onClose }) => {
  const [data, setData] = useState<TraceLogs | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [onlySuspicious, setOnlySuspicious] = useState<boolean>(true);

  useEffect(() => {
    let mounted = true;
    setLoading(true);
    api.getTraceLogs(traceId)
      .then((result) => {
        if (mounted) {
          setData(result);
          const count = (result?.entries ?? []).filter((entry) => SUSPICIOUS.test(displayLine(entry.line))).length;
          if (count === 0 && (result?.entries ?? []).length > 0) {
            setOnlySuspicious(false);
          }
        }
      })
      .catch((err: Error) => {
        if (mounted) setError(err.message);
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, [traceId]);

  const windowSeconds =
    data && data.endNs > data.startNs ? Math.round((data.endNs - data.startNs) / 1_000_000_000) : 0;

  const suspiciousCount = (data?.entries ?? []).filter((entry) => SUSPICIOUS.test(displayLine(entry.line))).length;
  const visibleEntries = (data?.entries ?? []).filter(
    (entry) => !onlySuspicious || SUSPICIOUS.test(displayLine(entry.line))
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="w-full max-w-4xl max-h-[80vh] flex flex-col rounded-md border border-slate-700 bg-slate-900 shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 p-4 border-b border-slate-800">
          <div className="min-w-0">
            <h3 className="flex items-center gap-2 text-sm font-bold text-slate-100">
              <Terminal className="w-4 h-4 text-emerald-400" />
              Logs around this trace
            </h3>
            <p className="mt-1 text-[11px] font-mono text-slate-400 truncate">
              every service in the trace · {windowSeconds}s window · {data?.entries.length ?? 0} lines
            </p>
            {data && data.entries.length > 0 && (
              <div className="mt-2 flex items-center gap-1.5">
                <button
                  onClick={() => setOnlySuspicious(true)}
                  className={`px-2 py-0.5 rounded border text-[10px] font-mono transition ${
                    onlySuspicious
                      ? 'bg-rose-500/15 border-rose-500/40 text-rose-300'
                      : 'bg-slate-800 border-slate-700 text-slate-400 hover:text-slate-200'
                  }`}
                  title="Lines that look like an error or a stack trace"
                >
                  suspicious {suspiciousCount}
                </button>
                <button
                  onClick={() => setOnlySuspicious(false)}
                  className={`px-2 py-0.5 rounded border text-[10px] font-mono transition ${
                    !onlySuspicious
                      ? 'bg-slate-700 border-slate-600 text-slate-200'
                      : 'bg-slate-800 border-slate-700 text-slate-400 hover:text-slate-200'
                  }`}
                  title="Every line emitted by these services in the window"
                >
                  all {data.entries.length}
                </button>
              </div>
            )}
            {data && data.services.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1">
                {data.services.map((service) => (
                  <span
                    key={service}
                    className="px-1.5 py-0.5 rounded bg-slate-800 border border-slate-700 text-[10px] font-mono text-slate-300"
                  >
                    {service}
                  </span>
                ))}
              </div>
            )}
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-md text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition shrink-0"
            title="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto divide-y divide-slate-800/60 font-mono text-[11px]">
          {loading ? (
            <div className="h-40 flex items-center justify-center">
              <LoadingSpinner message="Loading logs for every service…" size="sm" />
            </div>
          ) : error ? (
            <div className="p-6 text-rose-300 text-xs">Failed to load logs: {error}</div>
          ) : !data || data.entries.length === 0 ? (
            <div className="p-6 space-y-1 text-xs text-slate-400">
              <p className="text-slate-300 font-semibold">No log line was emitted by any service in this window.</p>
              <p>
                That is normal: a failure can exist only as a span status. The failing span's
                status message (shown in the trace) is often the only recorded explanation.
              </p>
            </div>
          ) : visibleEntries.length === 0 ? (
            <div className="p-6 space-y-1 text-xs text-slate-400">
              <p className="text-slate-300 font-semibold">No suspicious line in this window.</p>
              <p>Switch to “all” to read everything the trace's services logged around it.</p>
            </div>
          ) : (
            visibleEntries.map((entry, index) => (
              <div key={index} className="flex gap-3 px-3 py-1.5 hover:bg-slate-800/40">
                <span className="shrink-0 text-slate-400">{formatTime(entry.timestamp)}</span>
                <span className="shrink-0 w-32 truncate text-cyan-300" title={entry.service}>
                  {entry.service || entry.labels?.kubernetes_pod_name || 'unknown'}
                </span>
                <span className="min-w-0 whitespace-pre-wrap break-words text-slate-200">
                  {displayLine(entry.line)}
                </span>
              </div>
            ))
          )}
        </div>

        <div className="px-4 py-2 border-t border-slate-800 text-[10px] text-slate-400">
          Logs are timestamped on receipt, so the window is padded ±seconds around the trace.
        </div>
      </div>
    </div>
  );
};
