import React, { useEffect, useState } from 'react';
import { useApp } from '../../context/AppContext';
import { api } from '../../services/api';
import { Endpoint } from '../../types/api';
import {
  X,
  Server,
  Activity,
  GitBranch,
  Terminal,
  ExternalLink,
  Layers,
  Clock,
  AlertTriangle,
} from 'lucide-react';
import { LoadingSpinner } from '../common/LoadingSpinner';

interface NodeDetailPanelProps {
  serviceName: string;
  onClose: () => void;
  /** Live RED stats of the selected node, for degraded-state actions. */
  stats?: { errorRate?: number; latencyP95?: number; rate?: number };
}

export const NodeDetailPanel: React.FC<NodeDetailPanelProps> = ({
  serviceName,
  onClose,
  stats,
}) => {
  const { activeNamespace, timeWindow, setActiveTab, setSelectedService, setLogSeed, setTraceSeed } = useApp();
  const [endpoints, setEndpoints] = useState<Endpoint[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let isMounted = true;
    async function loadEndpoints() {
      setLoading(true);
      setError(null);
      try {
        const data = await api.getServiceEndpoints(serviceName, activeNamespace, timeWindow);
        if (isMounted) setEndpoints(data);
      } catch (err: any) {
        if (isMounted) setError(err.message);
      } finally {
        if (isMounted) setLoading(false);
      }
    }
    loadEndpoints();
    return () => {
      isMounted = false;
    };
  }, [serviceName, activeNamespace, timeWindow]);

  const goToTraces = () => {
    setSelectedService(serviceName);
    setActiveTab('traces');
  };

  // Degraded-state actions: jump straight to the evidence instead of making
  // the user re-type filters. Thresholds match the row coloring used across
  // the app (>1% errors, >500ms p95).
  const isDegraded =
    (stats?.errorRate ?? 0) > 0.01 || (stats?.latencyP95 ?? 0) > 0.5;
  const goWithErrorLogs = () => {
    setLogSeed({ keyword: 'error' });
    setSelectedService(serviceName);
    setActiveTab('logs');
  };
  const goWithSlowTraces = () => {
    setTraceSeed({ minDurationMs: 100 });
    setSelectedService(serviceName);
    setActiveTab('traces');
  };

  const goToLogs = () => {
    setSelectedService(serviceName);
    setActiveTab('logs');
  };

  const goToServices = () => {
    setSelectedService(serviceName);
    setActiveTab('services');
  };

  return (
    <div className="absolute top-4 right-4 bottom-4 w-96 max-w-[calc(100vw-2rem)] bg-slate-900/95 border border-slate-700/80 rounded-md flex flex-col z-30 overflow-hidden animate-in fade-in slide-in-from-right-4 duration-200">
      {/* Header */}
      <div className="p-4 border-b border-slate-800 flex items-center justify-between bg-slate-800/40">
        <div className="flex items-center gap-2.5 overflow-hidden">
          <div className="p-2 rounded-md bg-cyan-500/10 border border-cyan-500/20 text-cyan-400">
            <Server className="w-4 h-4" />
          </div>
          <div>
            <h3 className="text-sm font-bold text-slate-100 truncate" title={serviceName}>
              {serviceName}
            </h3>
            <p className="text-[11px] font-mono text-slate-400">ns: {activeNamespace}</p>
          </div>
        </div>
        <button
          onClick={onClose}
          className="p-1.5 text-slate-400 hover:text-slate-200 rounded-lg hover:bg-slate-800 transition"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Action Shortcut Bar */}
      <div className="grid grid-cols-3 gap-1 p-2 bg-slate-950/40 border-b border-slate-800/80 text-[11px] font-medium">
        <button
          onClick={goToServices}
          className="flex items-center justify-center gap-1.5 py-1.5 px-2 rounded-lg bg-slate-800/70 hover:bg-cyan-500/15 text-slate-300 hover:text-cyan-300 border border-slate-700/50 transition"
        >
          <Activity className="w-3 h-3 text-cyan-400" />
          <span>Metrics</span>
        </button>
        <button
          onClick={goToTraces}
          className="flex items-center justify-center gap-1.5 py-1.5 px-2 rounded-lg bg-slate-800/70 hover:bg-indigo-500/15 text-slate-300 hover:text-indigo-300 border border-slate-700/50 transition"
        >
          <GitBranch className="w-3 h-3 text-indigo-400" />
          <span>Traces</span>
        </button>
        <button
          onClick={goToLogs}
          className="flex items-center justify-center gap-1.5 py-1.5 px-2 rounded-lg bg-slate-800/70 hover:bg-emerald-500/15 text-slate-300 hover:text-emerald-300 border border-slate-700/50 transition"
        >
          <Terminal className="w-3 h-3 text-emerald-400" />
          <span>Logs</span>
        </button>
      </div>

      {/* Degraded strip: only when the node is actually failing or slow */}
      {isDegraded && (
        <div
          className={`mx-3 mt-3 rounded-md border p-2.5 text-xs space-y-2 ${
            (stats?.errorRate ?? 0) > 0.01
              ? 'border-rose-500/40 bg-rose-500/10 text-rose-200'
              : 'border-amber-500/40 bg-amber-500/10 text-amber-200'
          }`}
        >
          <div className="flex items-center gap-1.5 font-semibold">
            <AlertTriangle className="w-3.5 h-3.5" />
            <span>
              {(stats?.errorRate ?? 0) > 0.01
                ? `Failing: ${((stats?.errorRate ?? 0) * 100).toFixed(1)}% errors`
                : `Slow: p95 ${((stats?.latencyP95 ?? 0) * 1000).toFixed(0)} ms`}
            </span>
          </div>
          <div className="grid grid-cols-2 gap-1.5">
            <button
              onClick={goWithErrorLogs}
              className="flex items-center justify-center gap-1 py-1.5 rounded-md bg-rose-500/15 hover:bg-rose-500/25 border border-rose-500/40 text-rose-200 transition"
            >
              <Terminal className="w-3 h-3" />
              <span>Error logs</span>
            </button>
            <button
              onClick={goWithSlowTraces}
              className="flex items-center justify-center gap-1 py-1.5 rounded-md bg-amber-500/15 hover:bg-amber-500/25 border border-amber-500/40 text-amber-200 transition"
            >
              <Clock className="w-3 h-3" />
              <span>Slow traces</span>
            </button>
          </div>
        </div>
      )}

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        <div>
          <div className="flex items-center justify-between mb-2">
            <h4 className="text-xs font-semibold uppercase tracking-wider text-slate-400">
              Live Endpoints ({endpoints.length})
            </h4>
            <span className="text-[10px] font-mono text-slate-400">{timeWindow}</span>
          </div>

          {loading ? (
            <LoadingSpinner message="Loading endpoints…" size="sm" />
          ) : error ? (
            <div className="p-3 rounded-lg bg-rose-500/10 border border-rose-500/20 text-rose-300 text-xs">
              {error}
            </div>
          ) : endpoints.length === 0 ? (
            <p className="text-xs text-slate-400 italic py-2">
              No HTTP/gRPC endpoints recorded in this window.
            </p>
          ) : (
            <div className="space-y-2">
              {endpoints.map((ep, idx) => (
                <div
                  key={idx}
                  className="p-2.5 rounded-md bg-slate-800/50 border border-slate-700/60 hover:border-slate-600 transition"
                >
                  <div className="flex items-center justify-between gap-1 mb-1.5">
                    <span className="text-[11px] font-mono font-medium text-cyan-300 break-all">
                      {ep.path}
                    </span>
                    {ep.method && (
                      <span className="text-[9px] px-1 py-0.5 font-mono uppercase bg-slate-700 text-slate-300 rounded font-semibold shrink-0">
                        {ep.method}
                      </span>
                    )}
                  </div>

                  <div className="grid grid-cols-3 gap-1 pt-1.5 border-t border-slate-700/40 text-[10px] font-mono">
                    <div>
                      <span className="text-slate-400 block">Rate</span>
                      <span className="text-slate-200">
                        {ep.rate > 0 ? `${ep.rate.toFixed(2)}/s` : <span className="text-slate-500">not measured</span>}
                      </span>
                    </div>
                    <div>
                      <span className="text-slate-400 block">P95</span>
                      <span className="text-slate-200">
                        {ep.latencyP95 > 0 ? `${(ep.latencyP95 * 1000).toFixed(0)} ms` : <span className="text-slate-500">not measured</span>}
                      </span>
                    </div>
                    <div>
                      <span className="text-slate-400 block">P99</span>
                      <span className="text-slate-200">
                        {ep.latencyP99 > 0 ? `${(ep.latencyP99 * 1000).toFixed(0)} ms` : <span className="text-slate-500">not measured</span>}
                      </span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
