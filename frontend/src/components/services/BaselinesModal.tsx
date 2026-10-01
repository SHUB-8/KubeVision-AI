import React, { useState, useEffect } from 'react';
import { useApp } from '../../context/AppContext';
import { api } from '../../services/api';
import { Baseline } from '../../types/api';
import { X, RefreshCw, Database, Clock, TrendingUp, AlertCircle, CheckCircle } from 'lucide-react';
import { LoadingSpinner } from '../common/LoadingSpinner';

interface BaselinesModalProps {
  serviceName: string;
  onClose: () => void;
}

export const BaselinesModal: React.FC<BaselinesModalProps> = ({
  serviceName,
  onClose,
}) => {
  const { activeNamespace, timeWindow, addToast } = useApp();
  const [baselines, setBaselines] = useState<Baseline[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [recalculating, setRecalculating] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const fetchBaselines = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.getBaselines(serviceName, timeWindow);
      setBaselines(data);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchBaselines();
  }, [serviceName, timeWindow]);

  const handleRecalculate = async () => {
    setRecalculating(true);
    try {
      const res = await api.recalculateBaselines(activeNamespace, timeWindow);
      addToast('success', res.message || 'Baselines recalculated successfully in BadgerDB');
      await fetchBaselines();
    } catch (err: any) {
      addToast('error', `Recalculation failed: ${err.message}`);
    } finally {
      setRecalculating(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 animate-in fade-in duration-200">
      <div className="bg-slate-900 border border-slate-700/80 rounded-md w-full max-w-2xl overflow-hidden flex flex-col max-h-[85vh]">
        {/* Modal Header */}
        <div className="p-4 border-b border-slate-800 flex items-center justify-between bg-slate-800/40">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-md bg-indigo-500/10 border border-indigo-500/20 text-indigo-400">
              <Database className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-slate-100 flex items-center gap-2">
                <span>Historical Baselines</span>
                <span className="font-mono text-cyan-400">({serviceName})</span>
              </h3>
              <p className="text-xs text-slate-400 font-mono">
                Persisted in BadgerDB (7-day exponential moving norm)
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

        {/* Modal Body */}
        <div className="p-6 overflow-y-auto flex-1 space-y-4">
          <div className="flex items-center justify-between">
            <span className="text-xs text-slate-400">
              Baseliner calculates moving standard deviations and expected golden signal envelopes.
            </span>
            <button
              onClick={handleRecalculate}
              disabled={recalculating}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-xs font-semibold shadow-indigo-600/20 transition active:scale-95 shrink-0"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${recalculating ? 'animate-spin' : ''}`} />
              <span>{recalculating ? 'Calculating...' : 'Recalculate Now'}</span>
            </button>
          </div>

          {loading ? (
            <LoadingSpinner message="Querying BadgerDB baselines..." />
          ) : error ? (
            <div className="p-4 rounded-md bg-rose-500/10 border border-rose-500/20 text-rose-300 text-xs">
              {error}
            </div>
          ) : baselines.length === 0 ? (
            <div className="p-8 text-center bg-slate-800/30 rounded-md border border-dashed border-slate-700">
              <TrendingUp className="w-8 h-8 text-slate-500 mx-auto mb-2" />
              <p className="text-xs text-slate-300 font-medium">No saved baselines found for this service</p>
              <p className="text-[11px] text-slate-400 mt-1">
                Click "Recalculate Now" to evaluate Prometheus telemetry over the last window and establish baselines.
              </p>
            </div>
          ) : (
            <div className="border border-slate-800 rounded-md overflow-hidden">
              <table className="w-full text-left text-xs font-mono">
                <thead className="bg-slate-800/60 text-slate-400 border-b border-slate-800 text-[11px] uppercase">
                  <tr>
                    <th className="p-3">Endpoint / Metric</th>
                    <th className="p-3">Metric Type</th>
                    <th className="p-3 text-right">Baseline Value</th>
                    <th className="p-3 text-right">Window</th>
                    <th className="p-3 text-right">Updated</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60 text-slate-200">
                  {baselines.map((b, idx) => (
                    <tr key={idx} className="hover:bg-slate-800/30 transition">
                      <td className="p-3 font-semibold text-cyan-300 break-all">{b.endpoint || '/'}</td>
                      <td className="p-3 text-slate-400">{b.metric}</td>
                      <td className="p-3 text-right text-emerald-400 font-bold">
                        {b.metric.includes('latency') ? `${(b.value * 1000).toFixed(1)} ms` : b.value.toFixed(2)}
                      </td>
                      <td className="p-3 text-right text-slate-400">{b.window}</td>
                      <td className="p-3 text-right text-slate-400 text-[10px]">
                        {b.updatedAt ? new Date(b.updatedAt).toLocaleTimeString() : 'Recent'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="p-3 bg-slate-800/40 border-t border-slate-800 flex justify-end">
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
