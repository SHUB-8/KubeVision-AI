import React, { useState, useEffect, useRef } from 'react';
import { useApp } from '../../context/AppContext';
import { api } from '../../services/api';
import { LogEntry } from '../../types/api';
import { LogEntryRow } from './LogEntryRow';
import { LoadingSpinner } from '../common/LoadingSpinner';
import { EmptyState } from '../common/EmptyState';
import { MetricCard } from '../common/MetricCard';
import {
  Terminal,
  Search,
  Filter,
  RefreshCw,
  ArrowDown,
  Layers,
  Server,
  Code2,
  Trash2,
} from 'lucide-react';

export const LogsView: React.FC = () => {
  const {
    activeNamespace,
    refreshCount,
    selectedService,
    setSelectedService,
  } = useApp();

  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const [podQuery, setPodQuery] = useState<string>(selectedService || '');
  const [filterText, setFilterText] = useState<string>('');
  const [limit, setLimit] = useState<number>(100);
  const [rawMode, setRawMode] = useState<boolean>(false);
  const [autoScroll, setAutoScroll] = useState<boolean>(false);

  const logContainerRef = useRef<HTMLDivElement>(null);

  const fetchLogs = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.getLogs({
        namespace: activeNamespace,
        pod: podQuery || undefined,
        filter: filterText || undefined,
        limit,
      });
      setLogs(data);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (selectedService && selectedService !== podQuery) {
      setPodQuery(selectedService);
    }
  }, [selectedService]);

  useEffect(() => {
    fetchLogs();
  }, [activeNamespace, podQuery, filterText, limit, refreshCount]);

  useEffect(() => {
    if (autoScroll && logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }
  }, [logs, autoScroll]);

  return (
    <div className="p-4 lg:p-8 space-y-6">
      {/* Metric Cards Row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <MetricCard
          title="Logs Ingested"
          value={logs.length}
          subtitle={`Namespace: ${activeNamespace}`}
          icon={<Terminal className="w-4 h-4 text-emerald-400" />}
        />
        <MetricCard
          title="Log Collector"
          value="Fluent Bit"
          subtitle="DaemonSet pod log forwarder"
          icon={<Layers className="w-4 h-4 text-cyan-400" />}
        />
        <MetricCard
          title="Indexed Storage"
          value="Grafana Loki"
          subtitle="High-efficiency LogQL store"
          icon={<Server className="w-4 h-4 text-indigo-400" />}
        />
        <MetricCard
          title="Active Filter"
          value={podQuery || 'All Pods'}
          subtitle={filterText ? `Keyword: "${filterText}"` : 'Unfiltered stream'}
          icon={<Filter className="w-4 h-4 text-amber-400" />}
        />
      </div>

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
              onChange={(e) => {
                setPodQuery(e.target.value);
                setSelectedService(e.target.value || null);
              }}
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

        {/* Right options: limit, raw toggle, follow */}
        <div className="flex items-center gap-2.5 w-full lg:w-auto justify-end text-xs font-mono">
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
            onClick={() => setAutoScroll(!autoScroll)}
            className={`flex items-center gap-1 px-2.5 py-1.5 rounded-md border text-[11px] font-medium transition ${
              autoScroll
                ? 'bg-emerald-500/15 border-emerald-500/30 text-emerald-300'
                : 'bg-slate-800/80 border-slate-700 text-slate-400 hover:text-slate-200'
            }`}
            title="Auto-scroll to bottom as logs arrive"
          >
            <ArrowDown className="w-3.5 h-3.5" />
            <span>Follow</span>
          </button>

          <button
            onClick={fetchLogs}
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
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-full bg-rose-500/80 inline-block" />
              <span className="w-2.5 h-2.5 rounded-full bg-amber-500/80 inline-block" />
              <span className="w-2.5 h-2.5 rounded-full bg-emerald-500/80 inline-block" />
            </div>
            <span className="ml-2 font-semibold text-slate-300">
              Loki LogQL Stream — {activeNamespace}
            </span>
          </div>

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

        {/* Terminal Log Rows */}
        <div
          ref={logContainerRef}
          className="flex-1 overflow-y-auto divide-y divide-slate-800/40 p-2 font-mono scroll-smooth"
        >
          {loading ? (
            <div className="h-full flex items-center justify-center">
              <LoadingSpinner message="Streaming logs from Loki gateway..." size="md" />
            </div>
          ) : error ? (
            <div className="p-8">
              <EmptyState
                title="Log Query Error"
                description={error}
                actionText="Retry"
                onAction={fetchLogs}
              />
            </div>
          ) : logs.length === 0 ? (
            <div className="h-full flex items-center justify-center">
              <EmptyState
                title="No Log Entries Found"
                description={`No logs matching your query in namespace "${activeNamespace}".`}
                actionText="Refresh"
                onAction={fetchLogs}
              />
            </div>
          ) : (
            logs.map((entry, idx) => (
              <LogEntryRow key={idx} entry={entry} rawMode={rawMode} />
            ))
          )}
        </div>
      </div>
    </div>
  );
};
