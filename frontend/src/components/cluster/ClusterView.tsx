import React, { useState, useEffect, useMemo, useRef } from 'react';
import { useApp } from '../../context/AppContext';
import { api } from '../../services/api';
import { ClusterInfo, PodInfo, PVCInfo } from '../../types/api';
import { formatAge, formatCores, formatBytes } from '../../lib/format';
import { PodDetailModal } from './PodDetailModal';
import { StatusBadge } from '../common/StatusBadge';
import { LoadingSpinner } from '../common/LoadingSpinner';
import { EmptyState } from '../common/EmptyState';
import {
  Cpu,
  Search,
  Terminal,
  Database,
  HardDrive,
  Layers,
} from 'lucide-react';

export const ClusterView: React.FC = () => {
  const { refreshCount, setActiveTab, setSelectedService } = useApp();
  const [clusterInfo, setClusterInfo] = useState<ClusterInfo | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const [searchQuery, setSearchQuery] = useState<string>('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [selectedPod, setSelectedPod] = useState<PodInfo | null>(null);
  const [subTab, setSubTab] = useState<'pods' | 'storage'>('pods');

  const requestSeq = useRef(0);
  const isFirstRender = useRef(true);

  const fetchClusterInfo = async (background = false) => {
    if (!background) setLoading(true);
    setError(null);
    const seq = ++requestSeq.current;
    try {
      const data = await api.getClusterInfo();
      if (seq !== requestSeq.current) return;
      setClusterInfo(data);
    } catch (err: any) {
      if (seq !== requestSeq.current) return;
      setError(err.message);
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  };

  // Cluster info has no other query inputs: the first refreshCount tick loads
  // visibly, later ticks refetch in the background.
  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      fetchClusterInfo();
      return;
    }
    fetchClusterInfo(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshCount]);

  const pods = clusterInfo?.pods || [];

  const filteredPods = useMemo(() => {
    return pods.filter((p) => {
      const matchesSearch =
        p.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        (p.ip && p.ip.includes(searchQuery));

      if (!matchesSearch) return false;

      if (statusFilter === 'running') return p.status === 'Running';
      if (statusFilter === 'restarted') return p.restarts > 0;
      if (statusFilter === 'issues') return p.status !== 'Running' || p.restarts > 0;

      return true;
    });
  }, [pods, searchQuery, statusFilter]);

  const totalRestarts = useMemo(
    () => pods.reduce((acc, p) => acc + p.restarts, 0),
    [pods]
  );
  const runningPods = useMemo(
    () => pods.filter((p) => p.status === 'Running').length,
    [pods]
  );

  const handleOpenPodLogs = (pod: PodInfo) => {
    const parts = pod.name.split('-');
    const svcName = pod.workloadName || (parts.length > 2 ? parts.slice(0, -2).join('-') : parts[0]);
    setSelectedService(svcName);
    setActiveTab('logs');
  };

  return (
    <div className="p-4 lg:p-8 space-y-4">
      {/* Summary strip — cluster identity & resource usage */}
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 px-4 py-2.5 rounded-md border border-slate-800 bg-slate-900/60 text-xs">
        <span className="text-slate-400">
          Pods running
          <span className={`ml-1.5 font-mono ${runningPods < pods.length ? 'text-amber-400' : 'text-slate-100'}`}>
            {runningPods}/{pods.length}
          </span>
        </span>
        <span className="text-slate-400">
          Restarts
          <span className={`ml-1.5 font-mono ${totalRestarts > 0 ? 'text-amber-400' : 'text-slate-100'}`}>
            {totalRestarts}
          </span>
        </span>
        {clusterInfo?.cpuUsageCores ? (
          <span className="text-slate-400">
            Cluster CPU
            <span className="ml-1.5 font-mono text-cyan-300">
              {formatCores(clusterInfo.cpuUsageCores)}
              {clusterInfo.cpuTotalCores ? ` / ${formatCores(clusterInfo.cpuTotalCores)}` : ''}
            </span>
          </span>
        ) : null}
        {clusterInfo?.memoryUsageBytes ? (
          <span className="text-slate-400">
            Cluster Mem
            <span className="ml-1.5 font-mono text-indigo-300">
              {formatBytes(clusterInfo.memoryUsageBytes)}
              {clusterInfo.memoryTotalBytes ? ` / ${formatBytes(clusterInfo.memoryTotalBytes)}` : ''}
            </span>
          </span>
        ) : null}
        <span className="text-slate-400">
          Storage (PVCs)
          <span className="ml-1.5 font-mono text-slate-200">
            {clusterInfo?.pvcs?.length ?? 0}
          </span>
        </span>
        {clusterInfo?.version && (
          <span className="text-slate-400 font-mono text-[11px] ml-auto">
            {clusterInfo.version} · {clusterInfo.node || 'local node'}
          </span>
        )}
      </div>

      {/* Sub-Tabs: Pods vs Persistent Volumes */}
      <div className="flex border-b border-slate-800 text-xs font-mono gap-1">
        <button
          onClick={() => setSubTab('pods')}
          className={`flex items-center gap-2 px-4 py-2 font-medium border-b-2 transition -mb-px ${
            subTab === 'pods'
              ? 'border-cyan-400 text-cyan-300 bg-slate-800/40'
              : 'border-transparent text-slate-400 hover:text-slate-200 hover:bg-slate-800/20'
          }`}
        >
          <Cpu className="w-3.5 h-3.5" />
          <span>Workload Pods ({pods.length})</span>
        </button>
        <button
          onClick={() => setSubTab('storage')}
          className={`flex items-center gap-2 px-4 py-2 font-medium border-b-2 transition -mb-px ${
            subTab === 'storage'
              ? 'border-cyan-400 text-cyan-300 bg-slate-800/40'
              : 'border-transparent text-slate-400 hover:text-slate-200 hover:bg-slate-800/20'
          }`}
        >
          <HardDrive className="w-3.5 h-3.5" />
          <span>Persistent Storage ({clusterInfo?.pvcs?.length ?? 0})</span>
        </button>
      </div>

      {/* Sub-tab view: Pods vs Storage */}
      {subTab === 'pods' ? (
        <>
          {/* Controls Bar: Search & Status Filter */}
          <div className="flex flex-col sm:flex-row items-center justify-between gap-4 p-4 rounded-md bg-slate-900/60 border border-slate-800">
            <div className="relative w-full sm:w-80">
              <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <input
                type="text"
                placeholder="Search pod name or IP..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pl-9 pr-3 py-2 rounded-md bg-slate-800/80 border border-slate-700/80 text-xs text-slate-200 placeholder:text-slate-400 focus:outline-none focus:border-cyan-500 font-mono"
              />
            </div>

            <div className="flex items-center gap-3 w-full sm:w-auto justify-end text-xs font-mono">
              <span className="text-slate-400">Filter:</span>
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
                className="bg-slate-800 border border-slate-700 rounded-md px-3 py-1.5 text-slate-200 focus:outline-none focus:border-cyan-500 cursor-pointer"
              >
                <option value="all">All Pods ({pods.length})</option>
                <option value="running">Running Only</option>
                <option value="restarted">Restarted (&gt;0)</option>
                <option value="issues">Degraded or Restarts</option>
              </select>
            </div>
          </div>

          {/* Pods Table */}
          {loading ? (
            <LoadingSpinner message="Loading cluster info…" size="lg" />
          ) : error ? (
            <EmptyState
              title="Cluster Query Failed"
              description={error}
              actionText="Retry"
              onAction={() => fetchClusterInfo()}
            />
          ) : filteredPods.length === 0 ? (
            <EmptyState
              title="No Pods Found"
              description={
                searchQuery
                  ? `No pods matched "${searchQuery}".`
                  : 'No pods returned from cluster API.'
              }
            />
          ) : (
            <div className="rounded-md border border-slate-800 bg-slate-900/60 overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs font-mono">
                  <thead className="bg-slate-800/60 text-slate-400 border-b border-slate-800 text-[10px] uppercase tracking-wider">
                    <tr>
                      <th className="p-4">Pod Name</th>
                      <th className="p-4">Namespace</th>
                      <th className="p-4">Status</th>
                      <th className="p-4">CPU Usage</th>
                      <th className="p-4">Memory</th>
                      <th className="p-4">IP Address</th>
                      <th className="p-4">Node</th>
                      <th className="p-4 text-center">Restarts</th>
                      <th className="p-4 text-right">Age</th>
                      <th className="p-4 text-center">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/60">
                    {filteredPods.map((p) => {
                      const hasRestarts = p.restarts > 0;
                      const hasCpu = (p.cpuUsageCores ?? 0) > 0;
                      const hasMem = (p.memoryUsageBytes ?? 0) > 0;
                      const memRatio = p.memoryLimitBytes && p.memoryUsageBytes ? p.memoryUsageBytes / p.memoryLimitBytes : 0;

                      return (
                        <tr
                          key={p.name}
                          onClick={() => setSelectedPod(p)}
                          className="hover:bg-slate-800/40 cursor-pointer transition group"
                        >
                          <td className="p-4 font-semibold text-slate-100 group-hover:text-cyan-300 transition">
                            <div className="flex items-center gap-2">
                              <Cpu className="w-4 h-4 text-cyan-400 shrink-0" />
                              <span className="truncate max-w-xs">{p.name}</span>
                            </div>
                          </td>
                          <td className="p-4 text-slate-400">{p.namespace}</td>
                          <td className="p-4">
                            <StatusBadge status={p.status} size="sm" />
                          </td>
                          <td className="p-4 text-slate-200">
                            {hasCpu ? (
                              <span>
                                {formatCores(p.cpuUsageCores)}
                                {p.cpuLimitCores ? (
                                  <span className="text-slate-400 text-[10px] ml-1">/ {formatCores(p.cpuLimitCores)}</span>
                                ) : null}
                              </span>
                            ) : (
                              <span className="text-slate-500">—</span>
                            )}
                          </td>
                          <td className="p-4 text-slate-200">
                            {hasMem ? (
                              <span>
                                <span className={memRatio > 0.85 ? 'text-rose-400 font-semibold' : ''}>
                                  {formatBytes(p.memoryUsageBytes)}
                                </span>
                                {p.memoryLimitBytes ? (
                                  <span className="text-slate-400 text-[10px] ml-1">/ {formatBytes(p.memoryLimitBytes)}</span>
                                ) : null}
                              </span>
                            ) : (
                              <span className="text-slate-500">—</span>
                            )}
                          </td>
                          <td className="p-4 text-cyan-400 font-semibold">{p.ip || '-'}</td>
                          <td className="p-4 text-slate-400">{p.node}</td>
                          <td className="p-4 text-center">
                            <span
                              className={`px-2 py-0.5 rounded text-[11px] font-semibold ${
                                hasRestarts
                                  ? 'bg-amber-500/10 text-amber-400 border border-amber-500/20'
                                  : 'text-slate-400'
                              }`}
                            >
                              {p.restarts}
                            </span>
                          </td>
                          <td className="p-4 text-right text-slate-400 text-[11px]">
                            {formatAge(p.age)}
                          </td>
                          <td className="p-4 text-center">
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                handleOpenPodLogs(p);
                              }}
                              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-emerald-500/10 hover:bg-emerald-500 text-emerald-400 hover:text-slate-950 font-semibold border border-emerald-500/30 transition text-[11px]"
                              title="Stream Pod Logs"
                            >
                              <Terminal className="w-3.5 h-3.5" />
                              <span>Logs</span>
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
        </>
      ) : (
        /* Storage / Persistent Volume Claims View */
        <div className="rounded-md border border-slate-800 bg-slate-900/60 overflow-hidden">
          {(!clusterInfo?.pvcs || clusterInfo.pvcs.length === 0) ? (
            <div className="p-8 text-center text-xs text-slate-400 font-mono">
              <Database className="w-8 h-8 text-slate-600 mx-auto mb-2" />
              <p>No Persistent Volume Claims (PVCs) found in this namespace.</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs font-mono">
                <thead className="bg-slate-800/60 text-slate-400 border-b border-slate-800 text-[10px] uppercase tracking-wider">
                  <tr>
                    <th className="p-4">Claim Name</th>
                    <th className="p-4">Namespace</th>
                    <th className="p-4">Status</th>
                    <th className="p-4">Capacity</th>
                    <th className="p-4">Storage Class</th>
                    <th className="p-4">Volume</th>
                    <th className="p-4">Access Modes</th>
                    <th className="p-4 text-right">Age</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60">
                  {clusterInfo.pvcs.map((pvc) => (
                    <tr key={pvc.name} className="hover:bg-slate-800/40 transition">
                      <td className="p-4 font-semibold text-slate-100">
                        <div className="flex items-center gap-2">
                          <Database className="w-4 h-4 text-cyan-400 shrink-0" />
                          <span>{pvc.name}</span>
                        </div>
                      </td>
                      <td className="p-4 text-slate-400">{pvc.namespace}</td>
                      <td className="p-4">
                        <span
                          className={`px-2 py-0.5 rounded text-[11px] font-semibold border ${
                            pvc.status === 'Bound'
                              ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30'
                              : 'bg-amber-500/10 text-amber-400 border-amber-500/30'
                          }`}
                        >
                          {pvc.status}
                        </span>
                      </td>
                      <td className="p-4 text-cyan-300 font-semibold">{pvc.capacity || '—'}</td>
                      <td className="p-4 text-slate-400">{pvc.storageClass || 'default'}</td>
                      <td className="p-4 text-slate-400 truncate max-w-xs" title={pvc.volumeName}>
                        {pvc.volumeName || '—'}
                      </td>
                      <td className="p-4 text-slate-400">
                        {pvc.accessModes?.join(', ') || '—'}
                      </td>
                      <td className="p-4 text-right text-slate-400 text-[11px]">
                        {formatAge(pvc.age)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Pod Detail Modal */}
      {selectedPod && (
        <PodDetailModal pod={selectedPod} onClose={() => setSelectedPod(null)} />
      )}
    </div>
  );
};
