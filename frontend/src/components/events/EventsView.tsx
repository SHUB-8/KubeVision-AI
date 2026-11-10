import React, { useEffect, useRef, useState } from 'react';
import { Activity, AlertTriangle, RefreshCw } from 'lucide-react';
import { useApp } from '../../context/AppContext';
import { api } from '../../services/api';
import { formatAge } from '../../lib/format';
import type { KubernetesEvent } from '../../types/api';

/** Relative age with the absolute time in the cell tooltip. */
function displayTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Unknown' : `${formatAge(date.getTime())} ago`;
}

export const EventsView: React.FC = () => {
  const { activeNamespace, refreshCount } = useApp();
  const [events, setEvents] = useState<KubernetesEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestSeq = useRef(0);
  const isFirstRender = useRef(true);

  const fetchEvents = async (background = false) => {
    if (!background) setLoading(true);
    setError(null);
    const seq = ++requestSeq.current;
    try {
      const data = await api.getKubernetesEvents(activeNamespace);
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
  }, [activeNamespace]);

  // Auto-refresh ticks refetch in the background so the table never blanks.
  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }
    fetchEvents(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshCount]);

  return (
    <div className="p-4 lg:p-8 space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-slate-800 bg-slate-900/60 p-4">
        <div className="flex items-center gap-3">
          <div className="rounded-md border border-amber-500/20 bg-amber-500/10 p-2 text-amber-400">
            <Activity className="h-4 w-4" />
          </div>
          <div>
            <h2 className="text-sm font-semibold text-slate-100">Warning Events</h2>
            <p className="text-xs text-slate-400">
              Persisted Kubernetes events for namespace <span className="font-mono text-slate-300">{activeNamespace || '—'}</span>
            </p>
          </div>
        </div>
        <span className="rounded border border-slate-700 bg-slate-800 px-2 py-1 text-[10px] font-mono text-slate-300">
          7 day retention · latest 100
        </span>
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
          <AlertTriangle className="mx-auto mb-2 h-5 w-5 text-slate-500" />
          <p className="text-sm text-slate-300">No Warning Events retained for this namespace.</p>
          <p className="mt-1 text-xs text-slate-500">The informer stores warning events as Kubernetes reports them.</p>
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
              {events.map((event) => (
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
                    <span className="text-slate-500">{event.involvedObjectKind || 'Object'}/</span>{event.involvedObjectName || 'unknown'}
                  </td>
                  <td className="p-3 text-right font-mono text-slate-200">{event.count}</td>
                  <td className="max-w-xl whitespace-normal p-3 text-slate-300">{event.message || '—'}</td>
                  <td className="p-3 text-slate-500">{event.reportingComponent || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="flex items-center justify-between border-t border-slate-800 px-3 py-2 text-[10px] text-slate-500">
            <span>{events.length} recent Warning Events</span>
            <span className="inline-flex items-center gap-1"><RefreshCw className="h-3 w-3" /> Auto-refresh enabled</span>
          </div>
        </div>
      )}
    </div>
  );
};
