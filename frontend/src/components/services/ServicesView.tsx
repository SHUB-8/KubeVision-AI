import React, { useState, useEffect, useMemo } from 'react';
import { useApp } from '../../context/AppContext';
import { api } from '../../services/api';
import { Service, Endpoint } from '../../types/api';
import { MetricCard } from '../common/MetricCard';
import { formatMs, formatPercent, formatRate } from '../../lib/format';
import { StatusBadge } from '../common/StatusBadge';
import { LoadingSpinner } from '../common/LoadingSpinner';
import { EmptyState } from '../common/EmptyState';
import { EndpointList } from './EndpointList';
import { BaselinesModal } from './BaselinesModal';
import {
  Server,
  Activity,
  AlertTriangle,
  GitBranch,
  Terminal,
  Database,
  Search,
  ChevronDown,
  ChevronRight,
  TrendingUp,
  Layers,
  Zap,
} from 'lucide-react';

/**
 * eBPF instrumentation currently covers Go services natively; other runtimes
 * are discovered from the K8s API but report no RED metrics until the OTel SDK
 * is injected. A zero rate with zero latency means "not measured", which must
 * not be presented as "healthy at 0% errors".
 */
const NO_TELEMETRY_HINT =
  'No eBPF telemetry for this service. Beyla instruments Go natively; Java/Node/Python/.NET need OTel SDK injection.';

export const ServicesView: React.FC = () => {
  const {
    activeNamespace,
    timeWindow,
    refreshCount,
    setActiveTab,
    setSelectedService,
  } = useApp();

  const [services, setServices] = useState<Service[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [sortBy, setSortBy] = useState<'name' | 'rate' | 'latency' | 'error'>('name');

  // Expanded endpoints per service
  const [expandedEndpoints, setExpandedEndpoints] = useState<Record<string, Endpoint[]>>({});
  const [loadingEndpoints, setLoadingEndpoints] = useState<Record<string, boolean>>({});

  // Active baseline modal service
  const [baselineModalService, setBaselineModalService] = useState<string | null>(null);

  const fetchServices = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.getServices(activeNamespace, timeWindow);
      setServices(data);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchServices();
  }, [activeNamespace, timeWindow, refreshCount]);

  const toggleEndpoints = async (serviceName: string) => {
    if (expandedEndpoints[serviceName]) {
      const updated = { ...expandedEndpoints };
      delete updated[serviceName];
      setExpandedEndpoints(updated);
      return;
    }

    setLoadingEndpoints((prev) => ({ ...prev, [serviceName]: true }));
    try {
      const epData = await api.getServiceEndpoints(serviceName, activeNamespace, timeWindow);
      setExpandedEndpoints((prev) => ({ ...prev, [serviceName]: epData }));
    } catch (err: any) {
      console.error('Failed to load endpoints for service', serviceName, err);
    } finally {
      setLoadingEndpoints((prev) => ({ ...prev, [serviceName]: false }));
    }
  };

  const handleDrilldownTraces = (svcName: string) => {
    setSelectedService(svcName);
    setActiveTab('traces');
  };

  const handleDrilldownLogs = (svcName: string) => {
    setSelectedService(svcName);
    setActiveTab('logs');
  };

  const filteredAndSortedServices = useMemo(() => {
    let list = services.filter((s) =>
      s.name.toLowerCase().includes(searchQuery.toLowerCase())
    );

    list.sort((a, b) => {
      if (sortBy === 'rate') return b.rate - a.rate;
      if (sortBy === 'latency') return b.latencyP95 - a.latencyP95;
      if (sortBy === 'error') return b.errorRate - a.errorRate;
      return a.name.localeCompare(b.name);
    });

    return list;
  }, [services, searchQuery, sortBy]);

  // Summary calculations
  const totalReplicas = useMemo(
    () => services.reduce((acc, s) => acc + s.replicas, 0),
    [services]
  );
  const totalReady = useMemo(
    () => services.reduce((acc, s) => acc + s.ready, 0),
    [services]
  );
  const totalRate = useMemo(
    () => services.reduce((acc, s) => acc + s.rate, 0),
    [services]
  );
  const maxLatency = useMemo(
    () => Math.max(0, ...services.map((s) => s.latencyP95)),
    [services]
  );

  return (
    <div className="p-4 lg:p-8 space-y-6">
      {/* Metric Cards Row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <MetricCard
          title="Discovered Services"
          value={services.length}
          subtitle={`Namespace: ${activeNamespace}`}
          icon={<Server className="w-4 h-4 text-cyan-400" />}
        />
        <MetricCard
          title="Pod Replicas"
          value={`${totalReady} / ${totalReplicas}`}
          subtitle="Available / Desired"
          icon={<Layers className="w-4 h-4 text-indigo-400" />}
        />
        <MetricCard
          title="Aggregate Rate"
          value={totalRate.toFixed(1)}
          unit="req/s"
          subtitle="eBPF RED throughput"
          icon={<Zap className="w-4 h-4 text-emerald-400" />}
        />
        <MetricCard
          title="Max P95 Latency"
          value={(maxLatency * 1000).toFixed(0)}
          unit="ms"
          subtitle="Across all microservices"
          status={maxLatency > 0.5 ? 'warning' : 'normal'}
          icon={<Activity className="w-4 h-4 text-amber-400" />}
        />
      </div>

      {/* Controls Bar: Search & Sort */}
      <div className="flex flex-col sm:flex-row items-center justify-between gap-4 p-4 rounded-md bg-slate-900/60 border border-slate-800">
        <div className="relative w-full sm:w-80">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            type="text"
            placeholder="Search service name..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-9 pr-3 py-2 rounded-md bg-slate-800/80 border border-slate-700/80 text-xs text-slate-200 placeholder:text-slate-400 focus:outline-none focus:border-cyan-500 font-mono"
          />
        </div>

        <div className="flex items-center gap-2 w-full sm:w-auto justify-end text-xs font-mono">
          <span className="text-slate-400">Sort By:</span>
          <select
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value as any)}
            className="bg-slate-800 border border-slate-700 rounded-md px-3 py-1.5 text-slate-200 focus:outline-none focus:border-cyan-500 cursor-pointer"
          >
            <option value="name">Service Name (A-Z)</option>
            <option value="rate">Highest Request Rate</option>
            <option value="latency">Highest P95 Latency</option>
            <option value="error">Highest Error Rate</option>
          </select>
        </div>
      </div>

      {/* Main Services Table / List */}
      {loading ? (
        <LoadingSpinner message="Polling services & Beyla metrics..." size="lg" />
      ) : error ? (
        <EmptyState
          title="Failed to Load Services"
          description={error}
          actionText="Retry"
          onAction={fetchServices}
        />
      ) : filteredAndSortedServices.length === 0 ? (
        <EmptyState
          title="No Services Found"
          description={`No services matched your query in namespace "${activeNamespace}".`}
        />
      ) : (
        <div className="space-y-3">
          {filteredAndSortedServices.map((svc) => {
            const isExpanded = !!expandedEndpoints[svc.name];
            const isLoadingEp = !!loadingEndpoints[svc.name];
            const hasErrors = svc.errorRate > 0.01;
            const isHighLatency = svc.latencyP95 > 0.5;
            const hasTelemetry = svc.rate > 0 || svc.latencyP95 > 0;

            return (
              <div
                key={svc.name}
                className="rounded-md border border-slate-800 bg-slate-900/60 overflow-hidden transition-all duration-200 hover:border-slate-700"
              >
                {/* Service Header Row */}
                <div className="p-4 sm:p-5 flex flex-col md:flex-row md:items-center justify-between gap-4">
                  {/* Left: Expander, Name & Replicas */}
                  <div className="flex items-center gap-3">
                    <button
                      onClick={() => toggleEndpoints(svc.name)}
                      className="p-1 rounded-lg text-slate-400 hover:text-cyan-400 hover:bg-slate-800 transition"
                      title={isExpanded ? 'Collapse Endpoints' : 'Expand Endpoints'}
                    >
                      {isExpanded ? (
                        <ChevronDown className="w-5 h-5 text-cyan-400" />
                      ) : (
                        <ChevronRight className="w-5 h-5" />
                      )}
                    </button>

                    <div className="p-2.5 rounded-md bg-slate-800/80 border border-slate-700/60 text-cyan-400 shrink-0">
                      <Server className="w-5 h-5" />
                    </div>

                    <div>
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-bold text-slate-100 tracking-tight">
                          {svc.name}
                        </span>
                        <StatusBadge
                          status={svc.ready === svc.replicas ? 'Running' : 'Degraded'}
                          size="sm"
                        />
                      </div>
                      <div className="flex items-center gap-2 mt-1 text-xs font-mono text-slate-400">
                        <span>ns: {svc.namespace}</span>
                        <span>•</span>
                        <span className="text-slate-300">
                          {svc.ready}/{svc.replicas} Pods Ready
                        </span>
                      </div>
                    </div>
                  </div>

                  {/* Middle: RED Telemetry Metrics */}
                  <div className="grid grid-cols-3 gap-4 font-mono text-xs border-y md:border-y-0 md:border-x border-slate-800 py-3 md:py-0 md:px-6">
                    <div>
                      <span className="text-[10px] text-slate-400 uppercase tracking-wider block">
                        Rate
                      </span>
                      <span
                        className={`text-sm font-semibold ${
                          hasTelemetry ? 'text-slate-200' : 'text-slate-500'
                        }`}
                        title={hasTelemetry ? undefined : NO_TELEMETRY_HINT}
                      >
                        {hasTelemetry ? formatRate(svc.rate) : 'no data'}
                      </span>
                    </div>

                    <div>
                      <span className="text-[10px] text-slate-400 uppercase tracking-wider block">
                        Error Rate
                      </span>
                      <span
                        className={`text-sm font-semibold ${
                          !hasTelemetry
                            ? 'text-slate-500'
                            : hasErrors
                              ? 'text-rose-400'
                              : 'text-slate-300'
                        }`}
                        title={hasTelemetry ? undefined : NO_TELEMETRY_HINT}
                      >
                        {hasTelemetry ? formatPercent(svc.errorRate) : 'no data'}
                      </span>
                    </div>

                    <div>
                      <span className="text-[10px] text-slate-400 uppercase tracking-wider block">
                        P95 Latency
                      </span>
                      <span
                        className={`text-sm font-semibold ${
                          !hasTelemetry
                            ? 'text-slate-500'
                            : isHighLatency
                              ? 'text-amber-400'
                              : 'text-slate-200'
                        }`}
                        title={hasTelemetry ? undefined : NO_TELEMETRY_HINT}
                      >
                        {hasTelemetry ? formatMs(svc.latencyP95 * 1000) : 'no data'}
                      </span>
                    </div>
                  </div>

                  {/* Right: Actions */}
                  <div className="flex items-center gap-1.5 flex-wrap justify-end">
                    <button
                      onClick={() => setBaselineModalService(svc.name)}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-slate-800/80 hover:bg-slate-700 border border-slate-700 text-xs font-medium text-slate-300 hover:text-white transition"
                      title="View BadgerDB Historical Baselines"
                    >
                      <Database className="w-3.5 h-3.5 text-indigo-400" />
                      <span>Baselines</span>
                    </button>

                    <button
                      onClick={() => handleDrilldownTraces(svc.name)}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-slate-800/80 hover:bg-slate-700 border border-slate-700 text-xs font-medium text-slate-300 hover:text-white transition"
                      title="Drilldown to Tempo Traces"
                    >
                      <GitBranch className="w-3.5 h-3.5 text-cyan-400" />
                      <span>Traces</span>
                    </button>

                    <button
                      onClick={() => handleDrilldownLogs(svc.name)}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-slate-800/80 hover:bg-slate-700 border border-slate-700 text-xs font-medium text-slate-300 hover:text-white transition"
                      title="Drilldown to Loki Logs"
                    >
                      <Terminal className="w-3.5 h-3.5 text-emerald-400" />
                      <span>Logs</span>
                    </button>
                  </div>
                </div>

                {/* Inline Endpoints Drilldown */}
                {isExpanded && (
                  <div className="p-4 bg-slate-950/60 border-t border-slate-800/80 space-y-2">
                    <div className="flex items-center justify-between text-xs text-slate-400">
                      <span className="font-semibold uppercase tracking-wider text-[11px]">
                        Service Endpoints ({expandedEndpoints[svc.name]?.length || 0})
                      </span>
                      <span className="font-mono text-[10px]">P50 / P95 / P99 quantiles</span>
                    </div>
                    <EndpointList
                      endpoints={expandedEndpoints[svc.name] || []}
                      loading={isLoadingEp}
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Baselines Modal */}
      {baselineModalService && (
        <BaselinesModal
          serviceName={baselineModalService}
          onClose={() => setBaselineModalService(null)}
        />
      )}
    </div>
  );
};
