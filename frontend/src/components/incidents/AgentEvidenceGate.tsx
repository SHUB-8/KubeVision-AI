import React from 'react';
import { Activity, Terminal, AlertOctagon, GitBranch, CheckCircle2, XCircle, ShieldCheck } from 'lucide-react';

interface AgentEvidenceGateProps {
  evidence: {
    metrics: boolean;
    logs: boolean;
    k8sEvents: boolean;
    networkTraces: boolean;
  };
  reflectionPassed: boolean;
  confidenceScore: number;
}

export const AgentEvidenceGate: React.FC<AgentEvidenceGateProps> = ({
  evidence,
  reflectionPassed,
  confidenceScore,
}) => {
  const agents = [
    {
      name: 'Metrics Agent',
      desc: 'Prometheus golden signals, saturation & baselines',
      icon: Activity,
      passed: evidence.metrics,
      color: 'cyan',
    },
    {
      name: 'Log Agent',
      desc: 'Loki error logs, exception signatures & panics',
      icon: Terminal,
      passed: evidence.logs,
      color: 'emerald',
    },
    {
      name: 'K8s Event Agent',
      desc: 'Pod lifecycle, OOMKills & readiness probe status',
      icon: AlertOctagon,
      passed: evidence.k8sEvents,
      color: 'amber',
    },
    {
      name: 'Network Agent',
      desc: 'Tempo distributed traces & per-hop latency stats',
      icon: GitBranch,
      passed: evidence.networkTraces,
      color: 'indigo',
    },
  ];

  const gatheredCount = Object.values(evidence).filter(Boolean).length;

  return (
    <div className="p-5 rounded-md bg-slate-900/80 border border-slate-800 space-y-4">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-slate-800/80 pb-3">
        <div>
          <h4 className="text-xs font-bold uppercase tracking-wider text-slate-300 flex items-center gap-2">
            <span>LangGraph Hybrid Supervisor</span>
            <span className="text-[10px] px-2 py-0.5 rounded font-mono bg-slate-800 text-slate-300 border border-slate-700">
              4 Parallel Subagents
            </span>
          </h4>
          <p className="text-[11px] text-slate-400 font-mono mt-0.5">
            Reflection gate requires ≥ 3/4 telemetry domains to validate root cause hypothesis
          </p>
        </div>

        {/* Reflection Gate Status Badge */}
        <div className="flex items-center gap-2">
          <div
            className={`flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-mono font-bold border ${
              reflectionPassed
                ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30'
                : 'bg-rose-500/10 text-rose-400 border-rose-500/30'
            }`}
          >
            {reflectionPassed ? (
              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
            ) : (
              <XCircle className="w-3.5 h-3.5 text-rose-400" />
            )}
            <span>
              Reflection Gate: {gatheredCount}/4 {reflectionPassed ? 'Passed' : 'Failed'}
            </span>
          </div>

          <div className="px-2.5 py-1 rounded-full text-xs font-mono bg-slate-800 text-cyan-300 border border-slate-700">
            Conf: {(confidenceScore * 100).toFixed(0)}%
          </div>
        </div>
      </div>

      {/* 4 Parallel Agents Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        {agents.map((ag) => {
          const Icon = ag.icon;
          return (
            <div
              key={ag.name}
              className={`p-3.5 rounded-md border transition ${
                ag.passed
                  ? 'bg-slate-800/50 border-slate-700/80'
                  : 'bg-slate-900/40 border-slate-800/60 opacity-60'
              }`}
            >
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <div className="p-1.5 rounded-lg bg-slate-800 text-cyan-400 border border-slate-700">
                    <Icon className="w-3.5 h-3.5" />
                  </div>
                  <span className="text-xs font-semibold text-slate-200">{ag.name}</span>
                </div>
                {ag.passed ? (
                  <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                ) : (
                  <XCircle className="w-4 h-4 text-slate-500" />
                )}
              </div>
              <p className="text-[11px] text-slate-400 leading-snug">{ag.desc}</p>
            </div>
          );
        })}
      </div>
    </div>
  );
};
