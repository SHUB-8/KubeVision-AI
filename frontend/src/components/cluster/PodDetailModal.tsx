import React from 'react';
import { PodInfo } from '../../types/api';
import { useApp } from '../../context/AppContext';
import { X, Cpu, Server, Terminal, ShieldCheck, Clock, Activity } from 'lucide-react';
import { StatusBadge } from '../common/StatusBadge';

interface PodDetailModalProps {
  pod: PodInfo;
  onClose: () => void;
}

export const PodDetailModal: React.FC<PodDetailModalProps> = ({ pod, onClose }) => {
  const { setActiveTab, setSelectedService } = useApp();

  const handleOpenLogs = () => {
    // extract service name from pod name (e.g. cartservice-xxx -> cartservice)
    const parts = pod.name.split('-');
    const svcName = parts.length > 2 ? parts.slice(0, -2).join('-') : parts[0];
    setSelectedService(svcName);
    setActiveTab('logs');
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 animate-in fade-in duration-200">
      <div className="bg-slate-900 border border-slate-700/80 rounded-md w-full max-w-lg overflow-hidden flex flex-col">
        {/* Header */}
        <div className="p-4 border-b border-slate-800 flex items-center justify-between bg-slate-800/40">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-md bg-cyan-500/10 border border-cyan-500/20 text-cyan-400">
              <Cpu className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-slate-100 truncate max-w-sm" title={pod.name}>
                {pod.name}
              </h3>
              <p className="text-xs text-slate-400 font-mono">
                Kubernetes Pod
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 text-slate-400 hover:text-slate-200 rounded-lg hover:bg-slate-800 transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="p-6 space-y-4 font-mono text-xs">
          <div className="grid grid-cols-2 gap-3 p-4 bg-slate-800/50 rounded-md border border-slate-700/60">
            <div>
              <span className="text-slate-400 text-[10px] block">Status</span>
              <StatusBadge status={pod.status} size="sm" />
            </div>
            <div>
              <span className="text-slate-400 text-[10px] block">Restarts</span>
              <span className={`font-semibold ${pod.restarts > 0 ? 'text-amber-400' : 'text-slate-200'}`}>
                {pod.restarts} times
              </span>
            </div>
            <div>
              <span className="text-slate-400 text-[10px] block">Pod IP</span>
              <span className="text-cyan-300 font-semibold">{pod.ip || 'Pending'}</span>
            </div>
            <div>
              <span className="text-slate-400 text-[10px] block">Worker Node</span>
              <span className="text-slate-200">{pod.node || 'unassigned'}</span>
            </div>
            <div>
              <span className="text-slate-400 text-[10px] block">Namespace</span>
              <span className="text-slate-300">{pod.namespace}</span>
            </div>
            <div>
              <span className="text-slate-400 text-[10px] block">Created Age</span>
              <span className="text-slate-300 truncate">{pod.age}</span>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="p-4 bg-slate-800/40 border-t border-slate-800 flex justify-between items-center">
          <button
            onClick={handleOpenLogs}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold shadow-emerald-600/20 transition active:scale-95"
          >
            <Terminal className="w-3.5 h-3.5" />
            <span>Stream Pod Logs</span>
          </button>

          <button
            onClick={onClose}
            className="px-4 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs font-medium text-slate-300 transition"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};
