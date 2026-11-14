import React, { useState, useEffect, useMemo, useRef } from 'react';
import { useApp } from '../../context/AppContext';
import { api } from '../../services/api';
import { LogEntry, LogVolumeBucket } from '../../types/api';
import { LogEntryRow } from './LogEntryRow';
import { LoadingSpinner } from '../common/LoadingSpinner';
import { EmptyState } from '../common/EmptyState';
import {
  Search,
  Server,
  RefreshCw,
  Code2,
  Trash2,
} from 'lucide-react';

const podOf = (entry: LogEntry): string =>
  entry.labels?.kubernetes_pod_name || entry.labels?.pod || entry.stream || 'unknown';

// The window picker emits short Prometheus-style durations ("5m", "24h"). Parse
// generically so a stored config value outside the picker list still bounds the
// query; fall back to the backend's own 1h default when it cannot be parsed.
const windowDurationMs = (window: string): number => {
  const units: Record<string, number> = { ms: 1, s: 1e3, m: 6e4, h: 36e5, d: 864e5, w: 6048e5 };
  let total = 0;
  for (const [, value, unit] of window.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h|d|w)/g)) {
    total += Number(value) * units[unit];
  }
  return total > 0 ? total : 3_600_000;
};

// Loki takes unix-nanosecond bounds. BigInt keeps them exact: a Number near
// 1.7e18 is already far past Number.MAX_SAFE_INTEGER.
const toUnixNanos = (ms: number): string => (BigInt(Math.floor(ms)) * 1_000_000n).toString();

export const LogsView: React.FC = () => {
  const {
    activeNamespace,
    refreshCount,
    timeWindow,
    selectedService,
    logSeed,
    setLogSeed,
  } = useApp();

  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [logVolume, setLogVolume] = useState<LogVolumeBucket[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const [podQuery, setPodQuery] = useState<string>(selectedService || '');
  const [filterText, setFilterText] = useState<string>('');
  const [limit, setLimit] = useState<number>(100);
  const [rawMode, setRawMode] = useState<boolean>(false);
  const [viewMode, setViewMode] = useState<'interleaved' | 'byPod'>('interleaved');

  // A keyword seeded by a cross-view pivot ("view error logs") can legitimately
  // match nothing: most services never log transport-level failures. Track that
  // provenance so an empty result falls back to the unfiltered stream instead of
  // reporting "no logs" while the service is clearly emitting.
  const [seedFilter, setSeedFilter] = useState<string | null>(null);
  // Time range seeded by a trace pivot; null means "use the live header window".
  const [seededRange, setSeededRange] = useState<{ fromNs: number; toNs: number } | null>(null);
  const [filterFallback, setFilterFallback] = useState<{ keyword: string; count: number } | null>(null);

  // One-shot seed: a cross-view navigation (e.g. topology "Error logs") may
  // preset the keyword filter. Apply once, then clear so a later manual edit
  // is not overwritten.
  useEffect(() => {
    if (logSeed?.keyword !== undefined) {
      setFilterText(logSeed.keyword);
      setSeedFilter(logSeed.keyword || null);
      setFilterFallback(null);
    }
    if (logSeed?.pod !== undefined) {
      setPodQuery(logSeed.pod);
    }
    if (logSeed?.fromNs !== undefined && logSeed?.toNs !== undefined) {
      setSeededRange({ fromNs: logSeed.fromNs, toNs: logSeed.toNs });
    }
    if (logSeed) {
      setLogSeed(null);
    }
  }, [logSeed, setLogSeed]);

  // Debounced copies: typing in either input must not fire one backend query
  // per keystroke.
  const [debouncedPod, setDebouncedPod] = useState(podQuery);
  const [debouncedFilter, setDebouncedFilter] = useState(filterText);

  const logContainerRef = useRef<HTMLDivElement>(null);
  const requestSeq = useRef(0);
  const isFirstRender = useRef(true);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedPod(podQuery), 300);
    return () => clearTimeout(t);
  }, [podQuery]);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedFilter(filterText), 300);
    return () => clearTimeout(t);
  }, [filterText]);

  const fetchLogs = async (background = false) => {
    if (!background) setLoading(true);
    setError(null);
    const seq = ++requestSeq.current;
    // Bounds are computed per request so a refetch covers the window ending now.
    const endMs = Date.now();
    const start = seededRange
      ? String(Math.floor(seededRange.fromNs))
      : toUnixNanos(endMs - windowDurationMs(timeWindow));
    const end = seededRange ? String(Math.floor(seededRange.toNs)) : toUnixNanos(endMs);
    try {
      api.getLogVolume({
        namespace: activeNamespace,
        service: debouncedPod || undefined,
        ...(seededRange
          ? {
              start: Math.floor(seededRange.fromNs / 1e9),
              end: Math.ceil(seededRange.toNs / 1e9),
            }
          : { window: timeWindow }),
      }).then((vol) => {
        if (seq === requestSeq.current) setLogVolume(vol);
      }).catch(() => {});

      const data = await api.getLogs({
        namespace: activeNamespace,
        pod: debouncedPod || undefined,
        filter: debouncedFilter || undefined,
        limit,
        start,
        end,
      });
      if (seq !== requestSeq.current) return; // a newer query superseded this one
      if (data.length === 0 && debouncedFilter && seedFilter && debouncedFilter === seedFilter) {
        const unfiltered = await api.getLogs({
          namespace: activeNamespace,
          pod: debouncedPod || undefined,
          limit,
          start,
          end,
        });
        if (seq !== requestSeq.current) return;
        if (unfiltered.length > 0) {
          setLogs(unfiltered);
          setFilterFallback({ keyword: debouncedFilter, count: unfiltered.length });
          setSeedFilter(null);
          return;
        }
      }
      setFilterFallback(null);
      setLogs(data);
    } catch (err: any) {
      if (seq !== requestSeq.current) return;
      setError(err.message);
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  };

  useEffect(() => {
    if (selectedService && selectedService !== podQuery) {
      setPodQuery(selectedService);
    }
  }, [selectedService]);

  // Query changes reload visibly; the auto-refresh tick refetches in the
  // background so the open view never blanks out or loses scroll position.
  useEffect(() => {
    fetchLogs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeNamespace, debouncedPod, debouncedFilter, limit, timeWindow, seededRange]);

  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }
    fetchLogs(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshCount]);

  // Pods actually present in the current result set — the discovery facet.
  const podNames = useMemo(() => {
    const set = new Set<string>();
    for (const e of logs) set.add(podOf(e));
    return Array.from(set).sort();
  }, [logs]);

  const totalVolumeLogs = useMemo(() => logVolume.reduce((acc, b) => acc + b.total, 0), [logVolume]);
  const totalVolumeErrors = useMemo(() => logVolume.reduce((acc, b) => acc + b.errors, 0), [logVolume]);
  const maxBucketTotal = useMemo(() => Math.max(1, ...logVolume.map((b) => b.total)), [logVolume]);

  // "By pod" grouping: one section per pod, most recently active pod first.
  const groupedByPod = useMemo(() => {
    if (viewMode !== 'byPod') return null;
    const byPod = new Map<string, LogEntry[]>();
    for (const e of logs) {
      const pod = podOf(e);
      const list = byPod.get(pod) || [];
      list.push(e);
      byPod.set(pod, list);
    }
    return Array.from(byPod.entries()).sort(
      (a, b) => Number(b[1][0]?.timestamp || 0) - Number(a[1][0]?.timestamp || 0)
    );
  }, [logs, viewMode]);

  const isolatePod = (pod: string) => {
    // Local filter only — typing/filtering here must not leak into the
    // Traces page. selectedService stays a one-way drill-down channel.
    setPodQuery(pod);
  };

  return (
    <div className="p-4 lg:p-8 space-y-4">
      {/* Log Search and Control Bar */}
      <div className="flex flex-col lg:flex-row items-center justify-between gap-4 p-4 rounded-md bg-slate-900/60 border border-slate-800">
        <div className="flex flex-col sm:flex-row items-center gap-3 w-full lg:w-auto flex-1">
          {/* Pod / Service filter input */}
          <div className="relative w-full sm:w-64">
            <Server className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              placeholder="Pod / Service name..."
              value={podQuery}
              onChange={(e) => setPodQuery(e.target.value)}
              className="w-full pl-9 pr-3 py-1.5 rounded-md bg-slate-800/80 border border-slate-700/80 text-xs text-slate-200 placeholder:text-slate-400 focus:outline-none focus:border-cyan-500 font-mono"
            />
          </div>

          {/* Seeded from a trace: the window is the failure's own time, not
              "now". Show it, and offer a way back to the live window. */}
          {seededRange && (
            <span
              className="inline-flex shrink-0 items-center gap-1.5 rounded-sm border border-slate-700 bg-slate-800 px-2 py-1 text-[10px] font-mono text-slate-300"
              title="Scoped to the time of the span you opened, not the live window"
            >
              around trace
              <span className="text-slate-600">·</span>
              <button
                onClick={() => setSeededRange(null)}
                className="text-cyan-300 hover:text-cyan-200"
                title="Switch back to the live time window"
              >
                live window
              </button>
            </span>
          )}

          {/* Keyword filter input */}
          <div className="relative w-full sm:w-72">
            <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              placeholder="Search keyword (e.g. error, timeout)..."
              value={filterText}
              onChange={(e) => {
                setFilterText(e.target.value);
                setSeedFilter(null);
                setFilterFallback(null);
              }}
              className="w-full pl-9 pr-3 py-1.5 rounded-md bg-slate-800/80 border border-slate-700/80 text-xs text-slate-200 placeholder:text-slate-400 focus:outline-none focus:border-cyan-500 font-mono"
            />
          </div>
        </div>

        {/* Right options: pod facet, view mode, limit, raw toggle */}
        <div className="flex items-center gap-2.5 w-full lg:w-auto justify-end text-xs font-mono">
          {/* Pod facet: discovery for what streams exist in this result set */}
          <div className="relative">
            <Server className="w-3 h-3 absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500 pointer-events-none" />
            <select
              value={podNames.includes(podQuery) ? podQuery : podQuery ? '__custom' : ''}
              onChange={(e) => {
                if (e.target.value !== '__custom') isolatePod(e.target.value);
              }}
              className="appearance-none pl-7 pr-6 py-1.5 rounded-md bg-slate-800 border border-slate-700 text-slate-200 focus:outline-none focus:border-cyan-500 cursor-pointer"
              title="Isolate one pod's stream"
            >
              <option value="">All pods</option>
              {podQuery && !podNames.includes(podQuery) && (
                <option value="__custom">{podQuery}</option>
              )}
              {podNames.map((p) => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>
          </div>

          <select
            value={limit}
            onChange={(e) => setLimit(Number(e.target.value))}
            className="bg-slate-800 border border-slate-700 rounded-md px-2.5 py-1.5 text-slate-200 focus:outline-none focus:border-cyan-500 cursor-pointer"
          >
            <option value={50}>50 lines</option>
            <option value={100}>100 lines</option>
            <option value={250}>250 lines</option>
            <option value={500}>500 lines</option>
          </select>

          {/* View mode: merged timeline vs one section per pod */}
          <div className="flex items-center rounded-md border border-slate-700 overflow-hidden">
            <button
              onClick={() => setViewMode('interleaved')}
              className={`whitespace-nowrap px-2.5 py-1.5 text-[11px] font-medium transition ${
                viewMode === 'interleaved'
                  ? 'bg-cyan-500/15 text-cyan-300'
                  : 'bg-slate-800/80 text-slate-400 hover:text-slate-200'
              }`}
              title="Single merged timeline, newest first"
            >
              Interleaved
            </button>
            <button
              onClick={() => setViewMode('byPod')}
              className={`whitespace-nowrap px-2.5 py-1.5 text-[11px] font-medium transition ${
                viewMode === 'byPod'
                  ? 'bg-cyan-500/15 text-cyan-300'
                  : 'bg-slate-800/80 text-slate-400 hover:text-slate-200'
              }`}
              title="One section per pod, most recently active first"
            >
              By pod
            </button>
          </div>

          <button
            onClick={() => setRawMode(!rawMode)}
            className={`flex items-center gap-1 px-2.5 py-1.5 rounded-md border text-[11px] font-medium transition ${
              rawMode
                ? 'bg-cyan-500/15 border-cyan-500/30 text-cyan-300'
                : 'bg-slate-800/80 border-slate-700 text-slate-400 hover:text-slate-200'
            }`}
            title="Toggle Raw JSON format"
          >
            <Code2 className="w-3.5 h-3.5" />
            <span>Raw</span>
          </button>

          <button
            onClick={() => fetchLogs()}
            className="p-2 rounded-md bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white border border-slate-700 transition"
            title="Refresh Logs Now"
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {filterFallback && (
        <div className="flex items-start justify-between gap-3 px-3 py-2 rounded-md border border-amber-500/30 bg-amber-500/10 text-[11px] text-amber-200">
          <span>
            No log lines match “{filterFallback.keyword}” — showing the latest {filterFallback.count} lines
            for this service. Errors counted in metrics or traces can be transport-level (status
            codes) that the application never writes to its logs.
          </span>
          <button
            onClick={() => {
              setFilterText('');
              setFilterFallback(null);
            }}
            className="shrink-0 font-semibold text-amber-300 hover:text-amber-100 transition"
          >
            Clear filter
          </button>
        </div>
      )}

      {/* Log Volume & Error Spikes Timeline */}
      {logVolume.length > 0 && (
        <div className="p-3.5 rounded-md border border-slate-800 bg-slate-900/60 font-mono text-xs space-y-2">
          <div className="flex items-center justify-between text-[11px] text-slate-400">
            <div className="flex items-center gap-4">
              <span className="font-semibold text-slate-300">Log Volume &amp; Spikes</span>
              <span>
                Total: <strong className="text-slate-100">{totalVolumeLogs.toLocaleString()}</strong> lines
              </span>
              <span>
                Errors: <strong className={totalVolumeErrors > 0 ? 'text-rose-400 font-semibold' : 'text-slate-100'}>{totalVolumeErrors.toLocaleString()}</strong>
              </span>
              {totalVolumeLogs > 0 && totalVolumeErrors > 0 && (
                <span className="text-rose-400/80">
                  ({((totalVolumeErrors / totalVolumeLogs) * 100).toFixed(1)}%)
                </span>
              )}
            </div>
            <span className="text-[10px] text-slate-400">
              {seededRange ? 'Timeline (around trace)' : `Timeline (${timeWindow})`}
            </span>
          </div>

          <div className="flex items-end gap-1 h-12 pt-2 border-t border-slate-800/80">
            {logVolume.map((bucket, idx) => {
              const heightPct = Math.max(8, Math.round((bucket.total / maxBucketTotal) * 100));
              const errorPct = bucket.total > 0 ? Math.round((bucket.errors / bucket.total) * 100) : 0;
              const timeLabel = new Date(bucket.timestamp * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

              return (
                <div
                  key={idx}
                  className="flex-1 flex flex-col justify-end h-full group relative cursor-pointer"
                  title={`${timeLabel} — ${bucket.total} lines (${bucket.errors} errors)`}
                >
                  <div
                    style={{ height: `${heightPct}%` }}
                    className={`w-full rounded-t-sm transition-all flex flex-col justify-between overflow-hidden ${
                      bucket.errors > 0 ? 'bg-slate-700 group-hover:bg-slate-600' : 'bg-cyan-600/50 group-hover:bg-cyan-500/70'
                    }`}
                  >
                    {bucket.errors > 0 && (
                      <div
                        style={{ height: `${Math.max(25, errorPct)}%` }}
                        className="w-full bg-rose-500"
                      />
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Terminal Logs Viewer */}
      <div className="rounded-md border border-slate-800 bg-[#060a12] overflow-hidden flex flex-col h-[580px]">
        {/* Terminal Header */}
        <div className="px-4 py-2.5 bg-slate-900/90 border-b border-slate-800 flex items-center justify-between text-xs font-mono text-slate-400">
          <span className="font-semibold text-slate-300">
            Pod logs — {activeNamespace}
          </span>

          <div className="flex items-center gap-3 text-[11px]">
            <span>{logs.length} entries</span>
            {logs.length > 0 && (
              <button
                onClick={() => setLogs([])}
                className="hover:text-rose-400 transition"
                title="Clear current log view"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>

        {/* Terminal Log Rows — newest first, so the latest entry is where the eye lands */}
        <div
          ref={logContainerRef}
          className="flex-1 overflow-y-auto divide-y divide-slate-800/40 p-2 font-mono"
        >
          {loading ? (
            <div className="h-full flex items-center justify-center">
              <LoadingSpinner message="Loading logs…" size="md" />
            </div>
          ) : error ? (
            <div className="p-8">
              <EmptyState
                title="Log Query Error"
                description={error}
                actionText="Retry"
                onAction={() => fetchLogs()}
              />
            </div>
          ) : logs.length === 0 ? (
            <div className="h-full flex items-center justify-center">
              <EmptyState
                title="No Log Entries Found"
                description={
                  debouncedFilter
                    ? `No lines from ${debouncedPod ? `"${debouncedPod}"` : 'this namespace'} match “${debouncedFilter}” in the last ${timeWindow}.`
                    : `No lines from ${debouncedPod ? `"${debouncedPod}"` : 'this namespace'} were ingested in the last ${timeWindow} — check that the service is emitting logs.`
                }
                actionText={debouncedFilter ? 'Clear keyword' : 'Refresh'}
                onAction={() => (debouncedFilter ? setFilterText('') : fetchLogs())}
              />
            </div>
          ) : groupedByPod ? (
            /* By pod: sections per pod, most recently active first */
            groupedByPod.map(([pod, entries]) => (
              <div key={pod}>
                <div className="sticky top-0 z-10 flex items-center justify-between px-3 py-1.5 bg-slate-900/95 border-b border-slate-800 text-[10px] font-mono text-slate-400 uppercase tracking-wider">
                  <span className="text-slate-300">{pod}</span>
                  <span>{entries.length} entries</span>
                </div>
                {entries.map((entry, idx) => (
                  <LogEntryRow
                    key={idx}
                    entry={entry}
                    rawMode={rawMode}
                    onPodClick={isolatePod}
                  />
                ))}
              </div>
            ))
          ) : (
            logs.map((entry, idx) => (
              <LogEntryRow
                key={idx}
                entry={entry}
                rawMode={rawMode}
                onPodClick={isolatePod}
              />
            ))
          )}
        </div>
      </div>
    </div>
  );
};
