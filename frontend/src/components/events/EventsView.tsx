import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { useApp } from '../../context/AppContext';
import { api } from '../../services/api';
import { formatAge } from '../../lib/format';
import type { KubernetesEvent } from '../../types/api';

/** Relative age with the absolute time in the cell tooltip. */
function displayTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Unknown' : `${formatAge(date.getTime())} ago`;
}

// The window picker emits short Prometheus-style durations ("5m", "24h"); parse
// them here so the client-side filter matches the label the bar shows.
function windowDurationMs(window: string): number {
  const units: Record<string, number> = { ms: 1, s: 1e3, m: 6e4, h: 36e5, d: 864e5, w: 6048e5 };
  let total = 0;
  for (const [, value, unit] of window.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h|d|w)/g)) {
    total += Number(value) * units[unit];
  }
  return total > 0 ? total : 3_600_000;
}

export const EventsView: React.FC = () => {
  const { activeNamespace, refreshCount, refreshInterval, timeWindow } = useApp();
  const [events, setEvents] = useState<KubernetesEvent[]>([]);
  const [limit, setLimit] = useState(100);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestSeq = useRef(0);
  const isFirstRender = useRef(true);

  const fetchEvents = async (background = false) => {
    if (!background) setLoading(true);
    setError(null);
    const seq = ++requestSeq.current;
    try {
      const data = await api.getKubernetesEvents(activeNamespace, limit);
      if (seq !== requestSeq.current) return;
      setEvents(data);
    } catch (err: any) {
      if (seq !== requestSeq.current) return;
      setError(err.message);
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  };

  useEffect(() => {
    fetchEvents();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeNamespace, limit]);

  // Auto-refresh ticks refetch in the background so the table never blanks.
  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }
    fetchEvents(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshCount]);

  // The events endpoint has no window parameter — it returns the latest
  // persisted events regardless of age. Scope them here by last-seen time and
  // keep the raw result so the empty state can tell "nothing in this window"
  // from "nothing at all". A malformed timestamp cannot be proven in-window.
  const windowedEvents = useMemo(() => {
    const cutoff = Date.now() - windowDurationMs(timeWindow);
    return events.filter((event) => {
      const lastSeen = Date.parse(event.lastObservedAt);
      return Number.isFinite(lastSeen) && lastSeen >= cutoff;
    });
  }, [events, timeWindow]);

  return (
    <div className="p-4 lg:p-8 space-y-5">
      {/* Toolbar. The time range lives in the header (one place), so the only
          local control is how many persisted events to pull. */}
      <div className="flex flex-wrap items-center justify-end gap-2 text-xs font-mono">
        <span className="text-slate-400">Limit:</span>
        <select
          value={limit}
          onChange={(e) => setLimit(Number(e.target.value))}
          aria-label="Number of persisted events to load"
          title="Warning events persisted for 7 days; the time range comes from the header"
          className="bg-slate-800 border border-slate-700 rounded-md px-2.5 py-1.5 text-slate-200 focus:outline-none focus:border-cyan-500 cursor-pointer"
        >
          <option value={50}>50 events</option>
          <option value={100}>100 events</option>
          <option value={250}>250 events</option>
        </select>
      </div>

      {loading ? (
        <div className="rounded-md border border-slate-800 bg-slate-900/40 p-8 text-center text-xs text-slate-400">
          Loading persisted events…
        </div>
      ) : error ? (
        <div role="alert" className="rounded-md border border-rose-500/30 bg-rose-500/10 p-4 text-sm text-rose-300">
          Could not load Kubernetes events: {error}
        </div>
      ) : events.length === 0 ? (
        <div className="rounded-md border border-slate-800 bg-slate-900/40 p-8 text-center">
          <AlertTriangle className="mx-auto mb-2 h-5 w-5 text-slate-400" />
          <p className="text-sm text-slate-300">No warning events retained for this namespace.</p>
        </div>
      ) : windowedEvents.length === 0 ? (
        <div className="rounded-md border border-slate-800 bg-slate-900/40 p-8 text-center">
          <AlertTriangle className="mx-auto mb-2 h-5 w-5 text-slate-400" />
          <p className="text-sm text-slate-300">No warning events in the last {timeWindow}.</p>
          <p className="mt-1 text-xs text-slate-400">
            {events.length} outside this range — widen the time range to see them.
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-md border border-slate-800 bg-slate-950/40">
          <table className="w-full min-w-[900px] text-left text-xs">
            <thead className="border-b border-slate-800 bg-slate-900/80 text-[10px] uppercase tracking-wider text-slate-400">
              <tr>
                <th className="p-3">Last Seen</th>
                <th className="p-3">Reason</th>
                <th className="p-3">Object</th>
                <th className="p-3 text-right">Count</th>
                <th className="p-3">Message</th>
                <th className="p-3">Reported By</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60">
              {windowedEvents.map((event) => (
                <tr key={event.uid} className="align-top hover:bg-slate-800/30">
                  <td className="whitespace-nowrap p-3 font-mono text-slate-400" title={`First seen ${new Date(event.firstObservedAt).toLocaleString()}`}>
                    {displayTime(event.lastObservedAt)}
                  </td>
                  <td className="p-3">
                    <span className="inline-flex items-center gap-1 rounded border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 font-semibold text-amber-300">
                      <AlertTriangle className="h-3 w-3" /> {event.reason || 'Warning'}
                    </span>
                  </td>
                  <td className="p-3 font-mono text-slate-300">
                    <span className="text-slate-400">{event.involvedObjectKind || 'Object'}/</span>{event.involvedObjectName || 'unknown'}
                  </td>
                  <td className="p-3 text-right font-mono text-slate-200">{event.count}</td>
                  <td className="max-w-xl whitespace-normal p-3 text-slate-300">{event.message || '—'}</td>
                  <td className="p-3 text-slate-400">{event.reportingComponent || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="flex items-center justify-between border-t border-slate-800 px-3 py-2 text-[10px] text-slate-400">
            <span title={`${windowedEvents.length} of ${events.length} loaded events fall inside the selected time range`}>
              {windowedEvents.length} / {events.length}
            </span>
            <span
              className="inline-flex items-center gap-1"
              title={refreshInterval > 0 ? `Auto-refresh every ${refreshInterval}s` : 'Auto-refresh off'}
            >
              <RefreshCw className="h-3 w-3" />
              {refreshInterval > 0 ? `${refreshInterval}s` : 'off'}
            </span>
          </div>
        </div>
      )}
    </div>
  );
};
