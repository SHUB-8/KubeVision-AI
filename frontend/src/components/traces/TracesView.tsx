import React, { useState, useEffect, useMemo, useRef } from 'react';
import { useApp } from '../../context/AppContext';
import { api } from '../../services/api';
import { Trace } from '../../types/api';
import { TraceWaterfall } from './TraceWaterfall';
import { traceDurationMs, traceSpanCount, traceStartNs } from '../../lib/trace';
import { formatMs, formatAge } from '../../lib/format';
import { LoadingSpinner } from '../common/LoadingSpinner';
import { EmptyState } from '../common/EmptyState';
import {
  Search,
  ChevronRight,
  RefreshCw,
  AlertTriangle,
} from 'lucide-react';

const MIN_DURATIONS = [
  { label: 'Any duration', value: 0 },
  { label: '≥ 10 ms', value: 10 },
  { label: '≥ 50 ms', value: 50 },
  { label: '≥ 100 ms', value: 100 },
  { label: '≥ 500 ms', value: 500 },
];

export const TracesView: React.FC = () => {
  const {
    activeNamespace,
    timeWindow,
    refreshCount,
    selectedService,
    selectedTraceId,
    setSelectedTraceId,
    traceSeed,
    setTraceSeed,
  } = useApp();

  const [traces, setTraces] = useState<Trace[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const [serviceFilter, setServiceFilter] = useState<string>(selectedService || '');
  const [limit, setLimit] = useState<number>(25);

  // Debounced copy of the filter so typing doesn't fire one query per keystroke.
  const [debouncedService, setDebouncedService] = useState<string>(serviceFilter);

  // Client-side result filters: error spans only, and a minimum duration.
  const [errorsOnly, setErrorsOnly] = useState<boolean>(false);
  const [minDurMs, setMinDurMs] = useState<number>(0);
  // One-shot seed: a cross-view navigation (e.g. topology "Slow traces") may
  // preset the minimum-duration filter. Apply once, then clear.
  useEffect(() => {
    if (traceSeed?.minDurationMs !== undefined) {
      setMinDurMs((prev) => Math.max(prev, traceSeed.minDurationMs ?? 0));
      setTraceSeed(null);
    }
  }, [traceSeed, setTraceSeed]);

  // Service names for the search autocomplete (datalist), from the services API.
  const [serviceNames, setServiceNames] = useState<string[]>([]);

  // Active deep-dive trace
  const [activeTrace, setActiveTrace] = useState<Trace | null>(null);
  const [loadingDetail, setLoadingDetail] = useState<boolean>(false);

  const requestSeq = useRef(0);
  const isFirstRender = useRef(true);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedService(serviceFilter), 300);
    return () => clearTimeout(t);
  }, [serviceFilter]);

  const fetchTraces = async (background = false) => {
    if (!background) setLoading(true);
    setError(null);
    const seq = ++requestSeq.current;
    try {
      const data = await api.getTraces(debouncedService || undefined, limit, timeWindow || undefined);
      if (seq !== requestSeq.current) return;
      setTraces(data);
    } catch (err: any) {
      if (seq !== requestSeq.current) return;
      setError(err.message);
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  };

  useEffect(() => {
    if (selectedService && selectedService !== serviceFilter) {
      setServiceFilter(selectedService);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedService]);

  // Filter/limit/window changes reload visibly; the auto-refresh tick refetches
  // in the background so the table never flashes back to a spinner.
  useEffect(() => {
    fetchTraces();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedService, limit, timeWindow]);

  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }
    fetchTraces(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshCount]);

  useEffect(() => {
    api.getServices(activeNamespace, timeWindow)
      .then((svcs) => setServiceNames(svcs.map((s) => s.name)))
      .catch(() => {});
  }, [activeNamespace, timeWindow]);

  // The two result filters are applied client-side: the fetched set already
  // carries spans (status codes) and durations, so filtering stays instant.
  const displayedTraces = useMemo(
    () =>
      traces.filter((t) => {
        if (errorsOnly && !(t.spans ?? []).some((s) => s.statusCode && !s.statusCode.includes('OK'))) {
          return false;
        }
        if (minDurMs > 0) {
          const d = traceDurationMs(t);
          if (d === null || d < minDurMs) return false;
        }
        return true;
      }),
    [traces, errorsOnly, minDurMs]
  );

  // Load the requested trace (deep link / list click); a null id closes the
  // waterfall so browser-back works.
  useEffect(() => {
    if (selectedTraceId) {
      loadTraceDetail(selectedTraceId);
    } else {
      setActiveTrace(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTraceId]);

  const loadTraceDetail = async (traceId: string) => {
    setLoadingDetail(true);
    try {
      const data = await api.getTraceDetail(traceId);
      setActiveTrace(data);
    } catch (err: any) {
      console.error('Failed to load trace detail:', err);
    } finally {
      setLoadingDetail(false);
    }
  };

  if (activeTrace) {
    return (
      <div className="p-4 lg:p-8">
        <TraceWaterfall
          trace={activeTrace}
          onBack={() => {
            setActiveTrace(null);
            setSelectedTraceId(null);
          }}
        />
      </div>
    );
  }

  return (
    <div className="p-4 lg:p-8 space-y-4">
      {/* Search & Filter Controls */}
      <div className="flex flex-col sm:flex-row items-center justify-between gap-4 p-4 rounded-md bg-slate-900/60 border border-slate-800">
        <div className="relative w-full sm:w-80">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            type="text"
            list="trace-services"
            placeholder="Filter by service name..."
            value={serviceFilter}
            onChange={(e) => setServiceFilter(e.target.value)}
            className="w-full pl-9 pr-3 py-2 rounded-md bg-slate-800/80 border border-slate-700/80 text-xs text-slate-200 placeholder:text-slate-400 focus:outline-none focus:border-cyan-500 font-mono"
          />
          <datalist id="trace-services">
            {serviceNames.map((name) => (
              <option key={name} value={name} />
            ))}
          </datalist>
        </div>

        <div className="flex items-center gap-3 w-full sm:w-auto justify-end text-xs font-mono">
          <button
            onClick={() => setErrorsOnly((v) => !v)}
            className={`flex items-center gap-1 px-2.5 py-1.5 rounded-md border text-[11px] font-medium transition ${
              errorsOnly
                ? 'bg-rose-500/15 border-rose-500/40 text-rose-300'
                : 'bg-slate-800/80 border-slate-700 text-slate-400 hover:text-slate-200'
            }`}
            title="Show only traces containing an error span"
          >
            <AlertTriangle className="w-3.5 h-3.5" />
            <span>Errors</span>
          </button>

          <select
            value={minDurMs}
            onChange={(e) => setMinDurMs(Number(e.target.value))}
            className="bg-slate-800 border border-slate-700 rounded-md px-2.5 py-1.5 text-slate-200 focus:outline-none focus:border-cyan-500 cursor-pointer"
            title="Minimum trace duration"
          >
            {MIN_DURATIONS.map((d) => (
              <option key={d.value} value={d.value}>{d.label}</option>
            ))}
          </select>

          <span className="text-slate-400">Limit:</span>
          <select
            value={limit}
            onChange={(e) => setLimit(Number(e.target.value))}
            className="bg-slate-800 border border-slate-700 rounded-md px-3 py-1.5 text-slate-200 focus:outline-none focus:border-cyan-500 cursor-pointer"
          >
            <option value={10}>10 Traces</option>
            <option value={25}>25 Traces</option>
            <option value={50}>50 Traces</option>
          </select>

          <button
            onClick={() => fetchTraces()}
            className="p-2 rounded-md bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white border border-slate-700 transition"
            title="Refresh Traces"
          >
            <RefreshCw className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Traces List Table */}
      {loading ? (
        <LoadingSpinner message="Loading traces…" size="lg" />
      ) : error ? (
        <EmptyState
          title="Failed to Load Traces"
          description={error}
          actionText="Retry"
          onAction={() => fetchTraces()}
        />
      ) : displayedTraces.length === 0 ? (
        <EmptyState
          title={traces.length > 0 ? 'No Traces Match the Filters' : 'No Traces Found'}
          description={
            traces.length > 0
              ? 'Traces were found in this window, but none match the error/duration filters. Loosen them or widen the time window.'
              : serviceFilter
                ? `No traces found for service "${serviceFilter}". Try clearing the filter.`
                : 'No traces captured in this time window. Make sure the services are receiving traffic.'
          }
          actionText={traces.length > 0 ? 'Reset Filters' : serviceFilter ? 'Clear Filter' : 'Refresh'}
          onAction={() => {
            if (traces.length > 0) {
              setErrorsOnly(false);
              setMinDurMs(0);
            } else if (serviceFilter) {
              setServiceFilter('');
            } else {
              fetchTraces();
            }
          }}
        />
      ) : (
        <div className="rounded-md border border-slate-800 bg-slate-900/60 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs font-mono">
              <thead className="bg-slate-800/60 text-slate-400 border-b border-slate-800 text-[10px] uppercase tracking-wider">
                <tr>
                  <th className="p-4">Time</th>
                  <th className="p-4">Root Service</th>
                  <th className="p-4">Operation / Endpoint</th>
                  <th className="p-4">Trace ID</th>
                  <th className="p-4 text-right">Duration</th>
                  <th className="p-4 text-right">Spans</th>
                  <th className="p-4 text-center">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60">
                {displayedTraces.map((t) => {
                  const startNs = traceStartNs(t);
                  const startMs = startNs !== null ? startNs / 1_000_000 : null;
                  return (
                  <tr
                    key={t.traceId}
                    onClick={() => loadTraceDetail(t.traceId)}
                    className="hover:bg-slate-800/40 cursor-pointer transition group"
                  >
                    <td
                      className="p-4 text-slate-300 whitespace-nowrap"
                      title={startMs !== null ? new Date(startMs).toLocaleString() : undefined}
                    >
                      {startMs !== null ? `${formatAge(startMs)} ago` : '—'}
                    </td>
                    <td className="p-4 font-semibold text-cyan-400">
                      <span className="px-2 py-0.5 rounded bg-cyan-500/10 border border-cyan-500/20 text-cyan-300">
                        {t.rootServiceName || 'unknown'}
                      </span>
                      {t.rootInferred && (
                        <span
                          className="ml-1.5 rounded border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-[9px] font-medium text-amber-300"
                          title="Display root chosen from the earliest visible span; the trace may omit its true entry span."
                        >
                          heuristic
                        </span>
                      )}
                    </td>
                    <td className="p-4 text-slate-200 font-medium truncate max-w-xs" title={t.rootTraceName}>
                      {t.rootTraceName || '/'}
                    </td>
                    <td className="p-4 text-slate-400 truncate max-w-[180px]">
                      {t.traceId}
                    </td>
                    <td className="p-4 text-right font-bold text-slate-200">
                      {formatMs(traceDurationMs(t))}
                    </td>
                    <td className="p-4 text-right text-slate-400">
                      <span className="px-2 py-0.5 rounded bg-slate-800 text-slate-300 border border-slate-700 text-[11px]">
                        {traceSpanCount(t)}
                      </span>
                    </td>
                    <td className="p-4 text-center">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          loadTraceDetail(t.traceId);
                        }}
                        className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-cyan-500/10 hover:bg-cyan-500 text-cyan-400 hover:text-slate-950 font-semibold border border-cyan-500/30 transition text-[11px]"
                      >
                        <span>Waterfall</span>
                        <ChevronRight className="w-3.5 h-3.5" />
                      </button>
                    </td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {loadingDetail && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60">
          <LoadingSpinner message="Loading spans…" size="lg" />
        </div>
      )}
    </div>
  );
};
