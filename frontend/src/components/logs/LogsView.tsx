import React, { useState, useEffect, useMemo, useRef } from 'react';
import { useApp } from '../../context/AppContext';
import { api } from '../../services/api';
import { LogEntry } from '../../types/api';
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

export const LogsView: React.FC = () => {
  const {
    activeNamespace,
    refreshCount,
    selectedService,
    logSeed,
    setLogSeed,
  } = useApp();

  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const [podQuery, setPodQuery] = useState<string>(selectedService || '');
  const [filterText, setFilterText] = useState<string>('');
  const [limit, setLimit] = useState<number>(100);
  const [rawMode, setRawMode] = useState<boolean>(false);
  const [viewMode, setViewMode] = useState<'interleaved' | 'byPod'>('interleaved');

  // One-shot seed: a cross-view navigation (e.g. topology "Error logs") may
  // preset the keyword filter. Apply once, then clear so a later manual edit
  // is not overwritten.
  useEffect(() => {
    if (logSeed?.keyword !== undefined) {
      setFilterText(logSeed.keyword);
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
    try {
      const data = await api.getLogs({
        namespace: activeNamespace,
        pod: debouncedPod || undefined,
        filter: debouncedFilter || undefined,
        limit,
      });
      if (seq !== requestSeq.current) return; // a newer query superseded this one
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
  }, [activeNamespace, debouncedPod, debouncedFilter, limit]);

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

          {/* Keyword filter input */}
          <div className="relative w-full sm:w-72">
            <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              placeholder="Search keyword (e.g. error, timeout)..."
              value={filterText}
              onChange={(e) => setFilterText(e.target.value)}
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
                description={`No logs matching your query in namespace "${activeNamespace}".`}
                actionText="Refresh"
                onAction={() => fetchLogs()}
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
