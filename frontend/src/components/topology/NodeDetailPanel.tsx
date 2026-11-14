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
  Clock,
  AlertTriangle,
  Globe,
} from 'lucide-react';
import { LoadingSpinner } from '../common/LoadingSpinner';
import { languageLabel } from '../common/LanguageBadge';
import { formatBytesRate, formatRate, formatMs, formatErrorRate } from '../../lib/format';

interface NodeDetailPanelProps {
  serviceName: string;
  nodeType?: string;
  onClose: () => void;
  /** Runtime language reported by telemetry for this node, when known. */
  language?: string;
  /** Live RED stats of the selected node, for degraded-state actions. */
  stats?: { errorRate?: number; latencyP95?: number; rate?: number; bytesRate?: number };
  /** 'origin' started the cascade, 'inherited' only passed it on. */
  errorRole?: 'origin' | 'inherited';
  /** For an inherited service: the downstream service that failed first. */
  causeName?: string;
  onFocusCause?: () => void;
}

export const NodeDetailPanel: React.FC<NodeDetailPanelProps> = ({
  serviceName,
  nodeType,
  onClose,
  language,
  stats,
  errorRole,
  causeName,
  onFocusCause,
}) => {
  const { activeNamespace, timeWindow, setActiveTab, setSelectedService, setLogSeed, setTraceSeed } = useApp();
  const [endpoints, setEndpoints] = useState<Endpoint[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const isExternal = nodeType === 'external' || serviceName.includes('outgoing') || serviceName.startsWith('external:');

  useEffect(() => {
    let isMounted = true;
    if (isExternal) {
      setLoading(false);
      return;
    }
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
  }, [serviceName, activeNamespace, timeWindow, isExternal]);

  const goToTraces = () => {
    setSelectedService(serviceName);
    setActiveTab('traces');
  };

  // Degraded-state actions: jump straight to the evidence instead of making
  // the user re-type filters. Thresholds match the row coloring used across
  // the app (>1% errors, >500ms p95).
  const hasErrors = (stats?.errorRate ?? 0) > 0;
  const isSlow = (stats?.latencyP95 ?? 0) > 0.5;
  const isDegraded = hasErrors || isSlow;
  const goToFailingTraces = () => {
    setTraceSeed({ status: 'error' });
    setSelectedService(serviceName);
    setActiveTab('traces');
  };
  const goWithErrorLogs = () => {
    setLogSeed({ keyword: 'error' });
    setSelectedService(serviceName);
    setActiveTab('logs');
  };
  const goWithSlowTraces = () => {
    const p95Ms = (stats?.latencyP95 ?? 0) * 1000;
    const threshold = p95Ms > 100 ? Math.round(p95Ms * 0.5) : 100;
    setTraceSeed({ minDurationMs: threshold });
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
            {isExternal ? <Globe className="w-4 h-4" /> : <Server className="w-4 h-4" />}
          </div>
          <div>
            <h3 className="text-sm font-bold text-slate-100 truncate" title={serviceName}>
              {isExternal && serviceName === 'outgoing' ? 'outgoing (egress)' : serviceName}
            </h3>
            <p className="text-[11px] font-mono text-slate-400">
              {isExternal ? 'type: external dependency' : `ns: ${activeNamespace}`}
              {language && (
                <span
                  title={`Runtime language reported by telemetry: ${language}`}
                  className="ml-1.5 px-1 py-px rounded bg-slate-800 border border-slate-700 text-[10px] text-violet-300"
                >
                  {languageLabel(language)}
                </span>
              )}
            </p>
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

      {/* Live Telemetry Summary */}
      <div className="grid grid-cols-3 gap-2 px-3 py-2 bg-slate-950/40 border-b border-slate-800 text-[10px] font-mono">
        <div>
          <span className="text-slate-400 uppercase block tracking-wider text-[9px]">Inbound</span>
          <span className="text-slate-200 font-medium">
            {stats?.rate ? `${stats.rate.toFixed(1)}/s` : '—'}
          </span>
        </div>
        <div>
          <span className="text-slate-400 uppercase block tracking-wider text-[9px]">P95 Latency</span>
          <span className={`font-medium ${isSlow ? 'text-amber-400' : 'text-slate-200'}`}>
            {stats?.latencyP95 ? `${(stats.latencyP95 * 1000).toFixed(1)} ms` : '—'}
          </span>
        </div>
        <div>
          <span className="text-slate-400 uppercase block tracking-wider text-[9px]">Throughput</span>
          <span className="text-cyan-300 font-medium">
            {stats?.bytesRate ? formatBytesRate(stats.bytesRate) : '—'}
          </span>
        </div>
      </div>

      {/* Degraded strip: only when the node is actually failing or slow */}
      {isDegraded && (
        <div
          className={`mx-3 mt-3 rounded-md border p-2.5 text-xs space-y-2 ${
            hasErrors
              ? 'border-rose-500/40 bg-rose-500/10 text-rose-200'
              : 'border-amber-500/40 bg-amber-500/10 text-amber-200'
          }`}
        >
          <div className="flex items-center gap-1.5 font-semibold">
            <AlertTriangle className="w-3.5 h-3.5" />
            <span>
              {hasErrors && isSlow
                ? `Degraded: ${formatErrorRate(stats?.errorRate)} errors, p95 ${((stats?.latencyP95 ?? 0) * 1000).toFixed(0)} ms`
                : hasErrors
                ? `Failing: ${formatErrorRate(stats?.errorRate)} errors`
                : `Slow: p95 ${((stats?.latencyP95 ?? 0) * 1000).toFixed(0)} ms`}
            </span>
          </div>
          {hasErrors && errorRole === 'inherited' && causeName && (
            <p className="text-[11px] leading-relaxed text-rose-200/90">
              Its own calls are failing downstream in{' '}
              <span className="font-semibold text-rose-200">{causeName}</span> — start there, not
              with this service's logs.
            </p>
          )}
          {hasErrors && errorRole === 'origin' && (
            <p className="text-[11px] leading-relaxed text-rose-200/90">
              This is where the failure starts: its own calls fail while its callers stay clean.
            </p>
          )}
          <div className={`grid gap-1.5 ${hasErrors && isSlow ? 'grid-cols-3' : hasErrors ? 'grid-cols-2' : 'grid-cols-1'}`}>
            {hasErrors && (
              <>
                <button
                  onClick={goToFailingTraces}
                  className="flex items-center justify-center gap-1 py-1.5 rounded-md bg-rose-500/15 hover:bg-rose-500/25 border border-rose-500/40 text-rose-200 transition"
                  title="Open Tempo traces filtered to failing spans (server-side)"
                >
                  <GitBranch className="w-3 h-3" />
                  <span>Failing traces</span>
                </button>
                {errorRole === 'inherited' && causeName && onFocusCause && (
                  <button
                    onClick={onFocusCause}
                    className="flex items-center justify-center gap-1 py-1.5 rounded-md bg-slate-800/70 hover:bg-slate-700 border border-slate-700 text-slate-200 transition"
                    title={`Inspect ${causeName}, the service where this cascade starts`}
                  >
                    <AlertTriangle className="w-3 h-3 text-rose-400" />
                    <span>Cause: {causeName}</span>
                  </button>
                )}
                <button
                  onClick={goWithErrorLogs}
                  className="flex items-center justify-center gap-1 py-1.5 rounded-md bg-rose-500/15 hover:bg-rose-500/25 border border-rose-500/40 text-rose-200 transition"
                  title="Open Loki logs filtered to error lines"
                >
                  <Terminal className="w-3 h-3" />
                  <span>Error logs</span>
                </button>
              </>
            )}
            {isSlow && (
              <button
                onClick={goWithSlowTraces}
                className="flex items-center justify-center gap-1 py-1.5 rounded-md bg-amber-500/15 hover:bg-amber-500/25 border border-amber-500/40 text-amber-200 transition"
                title="Open Tempo traces filtered to slow requests (≥ 100 ms)"
              >
                <Clock className="w-3 h-3" />
                <span>Slow traces</span>
              </button>
            )}
          </div>
        </div>
      )}

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {isExternal ? (
          <div className="p-3.5 bg-slate-800/40 border border-slate-700/60 rounded-md text-xs font-mono space-y-2.5">
            <div className="flex items-center gap-2 text-cyan-300 font-semibold">
              <Globe className="w-4 h-4 text-cyan-400" />
              <span>External Egress Traffic</span>
            </div>
            <p className="text-slate-300 text-[11px] leading-relaxed">
              This node aggregates network traffic originating from workloads in this namespace that exit the Kubernetes cluster.
            </p>
            <div className="p-2.5 rounded bg-slate-900/60 border border-slate-700/40 text-[10px] text-slate-400 space-y-1">
              <span className="text-slate-300 font-semibold block">Common Egress Targets:</span>
              <div>• Cloud Instance Metadata (<code className="text-cyan-300">169.254.169.254</code>)</div>
              <div>• External payment gateways &amp; third-party APIs</div>
              <div>• External DNS, monitoring, and telemetry ingestion</div>
            </div>
            <div className="text-[10px] text-slate-400 italic">
              Grouped and observed via eBPF socket flows (<code className="text-slate-300">rename_unresolved_hosts_outgoing</code>).
            </div>
          </div>
        ) : (
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
                          {ep.rate > 0 ? `${ep.rate.toFixed(2)}/s` : <span className="text-slate-400">not measured</span>}
                        </span>
                      </div>
                      <div>
                        <span className="text-slate-400 block">P95</span>
                        <span className="text-slate-200">
                          {ep.latencyP95 > 0 ? `${(ep.latencyP95 * 1000).toFixed(0)} ms` : <span className="text-slate-400">not measured</span>}
                        </span>
                      </div>
                      <div>
                        <span className="text-slate-400 block">P99</span>
                        <span className="text-slate-200">
                          {ep.latencyP99 > 0 ? `${(ep.latencyP99 * 1000).toFixed(0)} ms` : <span className="text-slate-400">not measured</span>}
                        </span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
