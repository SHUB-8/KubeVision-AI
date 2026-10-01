import React from 'react';
import { RCAReport } from '../../types/api';
import { useApp } from '../../context/AppContext';
import {
  BrainCircuit,
  AlertTriangle,
  Layers,
  ArrowRight,
  GitBranch,
  Terminal,
  Activity,
  CheckCircle2,
  Sparkles,
  ShieldAlert,
} from 'lucide-react';

interface RCASummaryCardProps {
  report: RCAReport;
}

export const RCASummaryCard: React.FC<RCASummaryCardProps> = ({ report }) => {
  const { setActiveTab, setSelectedService, setSelectedTraceId } = useApp();

  const handleTraceClick = (traceId: string) => {
    setSelectedTraceId(traceId);
    setActiveTab('traces');
  };

  const handleLogClick = (serviceName: string) => {
    setSelectedService(serviceName);
    setActiveTab('logs');
  };

  return (
    <div className="space-y-6 animate-in fade-in duration-300">
      {/* Title & Metadata Header */}
      <div className="p-6 rounded-md bg-slate-900/80 border border-slate-800">
        <div className="flex items-center gap-2 mb-2 text-xs font-mono text-cyan-400">
          <BrainCircuit className="w-4 h-4" />
          <span>AUTONOMOUS RCA REPORT — {report.id.toUpperCase()}</span>
          <span>•</span>
          <span className="text-slate-400">{new Date(report.timestamp).toLocaleString()}</span>
        </div>

        <h2 className="text-lg font-bold text-slate-100 tracking-tight leading-snug">
          {report.title}
        </h2>

        {/* Executive Summary */}
        <p className="mt-3 text-xs text-slate-300 leading-relaxed font-sans">
          {report.executiveSummary}
        </p>

        {/* Blast Radius Pills */}
        <div className="mt-4 pt-4 border-t border-slate-800/80 flex items-center gap-2 flex-wrap">
          <span className="text-[11px] font-mono uppercase text-slate-400 font-semibold mr-1 flex items-center gap-1">
            <ShieldAlert className="w-3.5 h-3.5 text-rose-400" />
            Blast Radius:
          </span>
          {report.blastRadius.map((svc) => (
            <span
              key={svc}
              className="px-2 py-0.5 rounded-lg text-xs font-mono font-medium bg-rose-500/10 text-rose-300 border border-rose-500/30 shadow-sm shadow-rose-950/20"
            >
              {svc}
            </span>
          ))}
        </div>
      </div>

      {/* Root Cause Hypothesis Box */}
      <div className="p-5 rounded-md bg-amber-500/5 border border-amber-500/30">
        <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-amber-400 mb-2">
          <AlertTriangle className="w-4 h-4" />
          <span>Root Cause Hypothesis</span>
        </div>
        <p className="text-xs text-amber-200 leading-relaxed font-mono">
          {report.rootCauseHypothesis}
        </p>
      </div>

      {/* Supporting Evidence Breakdown */}
      <div className="p-6 rounded-md bg-slate-900/80 border border-slate-800 space-y-4">
        <h3 className="text-xs font-bold uppercase tracking-wider text-slate-300 flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-cyan-400" />
          <span>Corroborating Telemetry Evidence</span>
        </h3>

        <div className="space-y-3">
          {report.supportingEvidence.map((ev, idx) => {
            let icon = <Activity className="w-4 h-4 text-cyan-400 shrink-0" />;
            let actionBtn = null;

            if (ev.type === 'trace') {
              icon = <GitBranch className="w-4 h-4 text-indigo-400 shrink-0" />;
              if (ev.refId) {
                actionBtn = (
                  <button
                    onClick={() => handleTraceClick(ev.refId!)}
                    className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-indigo-500/15 hover:bg-indigo-500/25 border border-indigo-500/30 text-indigo-300 text-[11px] font-mono transition shrink-0"
                  >
                    <span>View Waterfall</span>
                    <ArrowRight className="w-3 h-3" />
                  </button>
                );
              }
            } else if (ev.type === 'log') {
              icon = <Terminal className="w-4 h-4 text-emerald-400 shrink-0" />;
              actionBtn = (
                <button
                  onClick={() => handleLogClick(report.service)}
                  className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-500/30 text-emerald-300 text-[11px] font-mono transition shrink-0"
                >
                  <span>Filter Logs</span>
                  <ArrowRight className="w-3 h-3" />
                </button>
              );
            }

            return (
              <div
                key={idx}
                className="p-3.5 rounded-md bg-slate-800/40 border border-slate-700/60 flex items-start justify-between gap-3 text-xs"
              >
                <div className="flex items-start gap-2.5">
                  <div className="mt-0.5 p-1 rounded-md bg-slate-800 border border-slate-700">
                    {icon}
                  </div>
                  <span className="text-slate-300 font-mono text-[11px] leading-relaxed">
                    {ev.description}
                  </span>
                </div>
                {actionBtn}
              </div>
            );
          })}
        </div>
      </div>

      {/* Recommended Actions */}
      <div className="p-6 rounded-md bg-slate-900/80 border border-slate-800 space-y-4">
        <h3 className="text-xs font-bold uppercase tracking-wider text-slate-300 flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 text-emerald-400" />
          <span>Recommended Remediation Actions</span>
        </h3>

        <div className="space-y-2.5">
          {report.recommendedActions.map((act, idx) => (
            <div
              key={idx}
              className="flex items-start gap-3 p-3 rounded-md bg-slate-800/40 border border-slate-700/60 text-xs text-slate-200 font-mono"
            >
              <div className="w-5 h-5 rounded-full bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 flex items-center justify-center shrink-0 text-[11px] font-bold">
                {idx + 1}
              </div>
              <span className="leading-relaxed">{act}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
