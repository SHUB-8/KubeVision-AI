import React, { useState, useEffect, useMemo, useRef } from 'react';
import { useApp } from '../../context/AppContext';
import { api } from '../../services/api';
import { Service, Endpoint, MetricSource } from '../../types/api';
import { formatMs, formatPercent, formatRate } from '../../lib/format';
import { StatusBadge } from '../common/StatusBadge';
import { LoadingSpinner } from '../common/LoadingSpinner';
import { EmptyState } from '../common/EmptyState';
import { EndpointList } from './EndpointList';
import { BaselinesModal } from './BaselinesModal';
import {
  Server,
  GitBranch,
  Terminal,
  Database,
  Search,
  ChevronDown,
  ChevronRight,
} from 'lucide-react';

const NO_METRIC_HINT = 'No matching metric was returned in the selected time window.';

const sourceLabel = (source?: MetricSource) => {
  switch (source) {
    case 'metrics': return 'metrics';
    case 'client-observed': return 'client-observed';
    case 'traces': return 'trace';
    case 'estimated': return 'est.';
    default: return '';
  }
};

export const ServicesView: React.FC = () => {
  const {
    activeNamespace,
    timeWindow,
    refreshCount,
    setActiveTab,
    setSelectedService,
    selectedService,
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

  const requestSeq = useRef(0);
  const isFirstRender = useRef(true);

  const fetchServices = async (background = false) => {
    if (!background) setLoading(true);
    setError(null);
    const seq = ++requestSeq.current;
    try {
      const data = await api.getServices(activeNamespace, timeWindow);
      if (seq !== requestSeq.current) return;
      setServices(data);
    } catch (err: any) {
      if (seq !== requestSeq.current) return;
      setError(err.message);
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  };

  useEffect(() => {
    fetchServices();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeNamespace, timeWindow]);

  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }
    fetchServices(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshCount]);

  // Arriving from the topology panel's "Metrics" shortcut: narrow the list
  // to that service and expand its endpoints once loaded.
  useEffect(() => {
    if (!selectedService) return;
    setSearchQuery(selectedService);
    if (services.some((s) => s.name === selectedService) && !expandedEndpoints[selectedService]) {
      toggleEndpoints(selectedService);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedService, services]);

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
    <div className="p-4 lg:p-8 space-y-4">
      {/* Summary strip — one line, only measured values */}
      <div className="flex flex-wrap items-center gap-x-6 gap-y-1 px-4 py-2.5 rounded-md border border-slate-800 bg-slate-900/60 text-xs">
        <span className="text-slate-400">
          Services
          <span className="ml-1.5 font-mono text-slate-100">{services.length}</span>
        </span>
        <span className="text-slate-400">
          Pods ready
          <span className={`ml-1.5 font-mono ${totalReady < totalReplicas ? 'text-amber-400' : 'text-slate-100'}`}>
            {totalReady}/{totalReplicas}
          </span>
        </span>
        {totalRate > 0 && (
          <span className="text-slate-400">
            Aggregate rate
            <span className="ml-1.5 font-mono text-slate-100">{totalRate.toFixed(1)} req/s</span>
          </span>
        )}
        <span className="text-slate-400">
          Max P95
          <span className={`ml-1.5 font-mono ${maxLatency > 0.5 ? 'text-amber-400' : 'text-slate-100'}`}>
            {maxLatency > 0 ? formatMs(maxLatency * 1000) : '—'}
          </span>
        </span>
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
        <LoadingSpinner message="Loading services…" size="lg" />
      ) : error ? (
        <EmptyState
          title="Failed to Load Services"
          description={error}
          actionText="Retry"
          onAction={() => fetchServices()}
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
            const hasRate = svc.rate > 0;
            const hasMeasuredRate = hasRate && svc.rateSource === 'metrics';
            const hasLatency = svc.latencyP95 > 0;

            return (
              <div
                key={svc.name}
                className="rounded-md border border-slate-800 bg-slate-900/60 overflow-hidden transition-all duration-200 hover:border-slate-700"
              >
                {/* Service Header Row */}
                <div className="p-4 sm:p-5 flex flex-col md:flex-row md:items-center justify-between gap-4">
                  {/* Left: Expander, Name & Replicas. Fixed width on md+ so the
                      RED columns below align across rows regardless of name and
                      source-label length ("client-observed" vs "metrics"). */}
                  <div className="flex items-center gap-3 md:w-[20rem] md:shrink-0">
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
                        <StatusBadge status={svc.status} size="sm" />
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

                  {/* Middle: RED Telemetry Metrics. Fixed width on md+ keeps the
                      three columns aligned across every row. */}
                  <div className="grid grid-cols-3 gap-4 font-mono text-xs border-y md:border-y-0 md:border-x border-slate-800 py-3 md:py-0 md:px-6 md:w-[24rem] md:shrink-0">
                    <div>
                      <span className="text-[10px] text-slate-400 uppercase tracking-wider block">
                        Rate
                      </span>
                      <span
                        className={`text-sm font-semibold ${
                          hasRate ? 'text-slate-200' : 'text-slate-500'
                        }`}
                        title={hasRate ? undefined : NO_METRIC_HINT}
                      >
                        {hasRate ? formatRate(svc.rate) : 'no data'}
                        {hasRate && svc.rateSource && (
                          <span className="ml-1 text-[9px] text-slate-500">{sourceLabel(svc.rateSource)}</span>
                        )}
                      </span>
                    </div>

                    <div>
                      <span className="text-[10px] text-slate-400 uppercase tracking-wider block">
                        Error Rate
                      </span>
                      <span
                        className={`text-sm font-semibold ${
                          !hasMeasuredRate
                            ? 'text-slate-500'
                            : hasErrors
                              ? 'text-rose-400'
                              : 'text-slate-300'
                        }`}
                        title={hasMeasuredRate ? undefined : NO_METRIC_HINT}
                      >
                        {hasMeasuredRate ? formatPercent(svc.errorRate) : 'no data'}
                      </span>
                    </div>

                    <div>
                      <span className="text-[10px] text-slate-400 uppercase tracking-wider block">
                        P95 Latency
                      </span>
                      <span
                        className={`text-sm font-semibold ${
                          !hasLatency
                            ? 'text-slate-500'
                            : isHighLatency
                              ? 'text-amber-400'
                              : 'text-slate-200'
                        }`}
                        title={hasLatency ? undefined : NO_METRIC_HINT}
                      >
                        {hasLatency ? formatMs(svc.latencyP95 * 1000) : 'no data'}
                        {hasLatency && svc.latencySource && (
                          <span className="ml-1 text-[9px] text-slate-500">{sourceLabel(svc.latencySource)}</span>
                        )}
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
