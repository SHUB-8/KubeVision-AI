import React from 'react';
import { Endpoint } from '../../types/api';
import { Layers, Activity, AlertTriangle, ArrowUpRight } from 'lucide-react';

interface EndpointListProps {
  endpoints: Endpoint[];
  loading?: boolean;
}

export const EndpointList: React.FC<EndpointListProps> = ({ endpoints, loading }) => {
  if (loading) {
    return (
      <div className="py-6 text-center text-xs text-slate-400 font-mono">
        Querying endpoint metrics...
      </div>
    );
  }

  if (endpoints.length === 0) {
    return (
      <div className="p-4 text-center text-xs text-slate-400 italic bg-slate-900/40 rounded-md border border-slate-800">
        No active endpoint transactions recorded in this time window.
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-md border border-slate-800 bg-slate-950/40 shadow-inner">
      <table className="w-full text-left text-xs font-mono">
        <thead className="bg-slate-900/80 text-slate-400 border-b border-slate-800 text-[10px] uppercase tracking-wider">
          <tr>
            <th className="p-3">Endpoint Route</th>
            <th className="p-3">Method</th>
            <th className="p-3 text-right">Req Rate</th>
            <th className="p-3 text-right">Error Rate</th>
            <th className="p-3 text-right">P50</th>
            <th className="p-3 text-right">P95</th>
            <th className="p-3 text-right">P99</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-800/60">
          {endpoints.map((ep, idx) => {
            const hasErrors = ep.errorRate > 0.01;
            const isSlowP95 = ep.latencyP95 > 0.5;

            return (
              <tr key={idx} className="hover:bg-slate-800/40 transition">
                <td className="p-3 font-medium text-cyan-300 break-all max-w-xs">
                  {ep.path}
                </td>
                <td className="p-3">
                  <span className="px-1.5 py-0.5 rounded text-[10px] bg-slate-800 border border-slate-700 font-semibold text-slate-300">
                    {ep.method || 'RPC'}
                  </span>
                </td>
                <td className="p-3 text-right text-slate-200">
                  {ep.rate.toFixed(2)}/s
                  {ep.rateSource === 'traces' && (
                    <span
                      className="ml-1 text-[9px] text-slate-500"
                      title="Derived from sampled traces, not a full request count."
                    >
                      trace
                    </span>
                  )}
                </td>
                <td className={`p-3 text-right font-semibold ${hasErrors ? 'text-rose-400' : 'text-slate-400'}`}>
                  {(ep.errorRate * 100).toFixed(1)}%
                </td>
                <td className="p-3 text-right text-slate-300">
                  {(ep.latencyP50 * 1000).toFixed(1)} ms
                </td>
                <td className={`p-3 text-right font-semibold ${isSlowP95 ? 'text-amber-400' : 'text-slate-200'}`}>
                  {(ep.latencyP95 * 1000).toFixed(1)} ms
                  {ep.latencySource === 'traces' && (
                    <span
                      className="ml-1 text-[9px] font-normal text-slate-500"
                      title="Derived from sampled traces, not a full request count."
                    >
                      trace
                    </span>
                  )}
                </td>
                <td className="p-3 text-right text-slate-400">
                  {(ep.latencyP99 * 1000).toFixed(1)} ms
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
};
