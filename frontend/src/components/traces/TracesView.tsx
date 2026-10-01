import React, { useState, useEffect } from 'react';
import { useApp } from '../../context/AppContext';
import { api } from '../../services/api';
import { Trace } from '../../types/api';
import { TraceWaterfall } from './TraceWaterfall';
import { traceDurationMs, traceSpanCount } from '../../lib/trace';
import { formatMs } from '../../lib/format';
import { LoadingSpinner } from '../common/LoadingSpinner';
import { EmptyState } from '../common/EmptyState';
import { MetricCard } from '../common/MetricCard';
import {
  GitBranch,
  Search,
  Clock,
  Layers,
  ChevronRight,
  Filter,
  RefreshCw,
  Server,
  Zap,
} from 'lucide-react';

export const TracesView: React.FC = () => {
  const {
    activeNamespace,
    refreshCount,
    selectedService,
    setSelectedService,
    selectedTraceId,
    setSelectedTraceId,
  } = useApp();

  const [traces, setTraces] = useState<Trace[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const [serviceFilter, setServiceFilter] = useState<string>(selectedService || '');
  const [limit, setLimit] = useState<number>(25);

  // Active deep-dive trace
  const [activeTrace, setActiveTrace] = useState<Trace | null>(null);
  const [loadingDetail, setLoadingDetail] = useState<boolean>(false);

  const fetchTraces = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.getTraces(serviceFilter || undefined, limit);
      setTraces(data);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (selectedService && selectedService !== serviceFilter) {
      setServiceFilter(selectedService);
    }
  }, [selectedService]);

  useEffect(() => {
    fetchTraces();
  }, [serviceFilter, limit, refreshCount]);

  // Load specific trace if requested
  useEffect(() => {
    if (selectedTraceId) {
      loadTraceDetail(selectedTraceId);
    }
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
    <div className="p-4 lg:p-8 space-y-6">
      {/* Metric Cards Row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <MetricCard
          title="Traces Captured"
          value={traces.length}
          subtitle="Tempo OTLP storage"
          icon={<GitBranch className="w-4 h-4 text-cyan-400" />}
        />
        <MetricCard
          title="Active Filter"
          value={serviceFilter || 'All Services'}
          subtitle={`Namespace: ${activeNamespace}`}
          icon={<Server className="w-4 h-4 text-indigo-400" />}
        />
        <MetricCard
          title="Ingestion Engine"
          value="Grafana Beyla"
          subtitle="Zero-code eBPF autoinstrumentation"
          icon={<Zap className="w-4 h-4 text-emerald-400" />}
        />
        <MetricCard
          title="Trace Protocol"
          value="OTLP / gRPC"
          subtitle="OpenTelemetry v1.3"
          icon={<Layers className="w-4 h-4 text-amber-400" />}
        />
      </div>

      {/* Search & Filter Controls */}
      <div className="flex flex-col sm:flex-row items-center justify-between gap-4 p-4 rounded-md bg-slate-900/60 border border-slate-800">
        <div className="relative w-full sm:w-80">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            type="text"
            placeholder="Filter by service name..."
            value={serviceFilter}
            onChange={(e) => {
              setServiceFilter(e.target.value);
              setSelectedService(e.target.value || null);
            }}
            className="w-full pl-9 pr-3 py-2 rounded-md bg-slate-800/80 border border-slate-700/80 text-xs text-slate-200 placeholder:text-slate-400 focus:outline-none focus:border-cyan-500 font-mono"
          />
        </div>

        <div className="flex items-center gap-3 w-full sm:w-auto justify-end text-xs font-mono">
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
            onClick={fetchTraces}
            className="p-2 rounded-md bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white border border-slate-700 transition"
            title="Refresh Traces"
          >
            <RefreshCw className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Traces List Table */}
      {loading ? (
        <LoadingSpinner message="Querying Grafana Tempo traces..." size="lg" />
      ) : error ? (
        <EmptyState
          title="Failed to Load Traces"
          description={error}
          actionText="Retry"
          onAction={fetchTraces}
        />
      ) : traces.length === 0 ? (
        <EmptyState
          title="No Traces Found"
          description={
            serviceFilter
              ? `No traces found for service "${serviceFilter}". Try clearing the filter.`
              : 'No traces ingested into Tempo yet. Ensure application traffic is generating requests.'
          }
          actionText={serviceFilter ? 'Clear Filter' : 'Refresh'}
          onAction={() => {
            if (serviceFilter) {
              setServiceFilter('');
              setSelectedService(null);
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
                  <th className="p-4">Root Service</th>
                  <th className="p-4">Operation / Endpoint</th>
                  <th className="p-4">Trace ID</th>
                  <th className="p-4 text-right">Duration</th>
                  <th className="p-4 text-right">Spans</th>
                  <th className="p-4 text-center">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60">
                {traces.map((t) => (
                  <tr
                    key={t.traceId}
                    onClick={() => loadTraceDetail(t.traceId)}
                    className="hover:bg-slate-800/40 cursor-pointer transition group"
                  >
                    <td className="p-4 font-semibold text-cyan-400">
                      <span className="px-2 py-0.5 rounded bg-cyan-500/10 border border-cyan-500/20 text-cyan-300">
                        {t.rootServiceName || 'unknown'}
                      </span>
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
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {loadingDetail && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60">
          <LoadingSpinner message="Fetching distributed spans from Tempo..." size="lg" />
        </div>
      )}
    </div>
  );
};
