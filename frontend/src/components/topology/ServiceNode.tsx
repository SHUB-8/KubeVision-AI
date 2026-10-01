import React, { memo } from 'react';
import { Handle, Position, NodeProps } from '@xyflow/react';
import { AlertTriangle } from 'lucide-react';

interface ServiceNodeData {
  label: string;
  type: string;
  namespace: string;
  protocol?: string;
  rate?: number;
  errorRate?: number;
  latencyP95?: number;
  status?: string;
  replicas?: number;
  ready?: number;
  selected?: boolean;
}

export const ServiceNode = memo(({ data, selected }: NodeProps<any>) => {
  const nodeData = data as ServiceNodeData;
  const hasErrors = (nodeData.errorRate || 0) > 0.01;
  const isHighLatency = (nodeData.latencyP95 || 0) > 0.5;

  let borderColor = 'border-slate-700/80 hover:border-cyan-500/60';
  let badgeColor = 'bg-cyan-500/10 text-cyan-400 border-cyan-500/20';

  if (hasErrors) {
    borderColor = 'border-rose-500/80';
    badgeColor = 'bg-rose-500/10 text-rose-400 border-rose-500/30';
  } else if (isHighLatency) {
    borderColor = 'border-amber-500/80';
    badgeColor = 'bg-amber-500/10 text-amber-400 border-amber-500/30';
  } else if (selected) {
    borderColor = 'border-cyan-400 ring-2 ring-cyan-500/30';
  }

  // A service can be discovered from the K8s API while eBPF reports nothing
  // for it (non-Go runtimes need OTel SDK injection). That is "not measured",
  // which must not be rendered as "0 req/s, 0 ms" - that reads as healthy-idle.
  const hasTelemetry = (nodeData.rate || 0) > 0 || (nodeData.latencyP95 || 0) > 0;
  const noDataHint =
    'No eBPF telemetry for this service. Beyla instruments Go natively; Java/Node/Python/.NET need OTel SDK injection.';

  const formatRate = (rate?: number) => {
    if (!hasTelemetry) return 'no data';
    return `${(rate || 0).toFixed(1)} req/s`;
  };

  const formatLatency = (lat?: number) => {
    if (!hasTelemetry) return 'no data';
    return `${((lat || 0) * 1000).toFixed(0)} ms`;
  };

  return (
    <div
      className={`group relative w-60 rounded-md bg-slate-900/95 border p-4 transition-all duration-200 cursor-pointer ${borderColor}`}
    >
      {/* Target Handles (incoming) */}
      <Handle
        id="target-left"
        type="target"
        position={Position.Left}
        className="!bg-cyan-400 !w-2.5 !h-2.5 !border-slate-950"
      />
      <Handle
        id="target-top"
        type="target"
        position={Position.Top}
        className="!bg-cyan-400 !w-2.5 !h-2.5 !border-slate-950"
      />

      {/* Source Handles (outgoing) */}
      <Handle
        id="source-right"
        type="source"
        position={Position.Right}
        className="!bg-indigo-400 !w-2.5 !h-2.5 !border-slate-950"
      />
      <Handle
        id="source-bottom"
        type="source"
        position={Position.Bottom}
        className="!bg-indigo-400 !w-2.5 !h-2.5 !border-slate-950"
      />

      {/* Top row: Name & Pods / Status Badge */}
      <div className="flex items-start justify-between gap-2 mb-2">
        <div className="flex items-center overflow-hidden">
          <span className="font-semibold text-sm text-slate-100 truncate tracking-tight" title={nodeData.label}>
            {nodeData.label}
          </span>
        </div>

        <span className="text-[10px] font-mono px-1.5 py-0.5 rounded border border-slate-700/80 bg-slate-800/80 text-slate-300 font-medium flex items-center gap-1 shrink-0">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
          {nodeData.ready ?? 1}/{nodeData.replicas ?? 1}
        </span>
      </div>

      {/* Bottom metrics row */}
      <div className="grid grid-cols-2 gap-2 pt-2.5 border-t border-slate-800/80 text-sm font-mono">
        <div title={hasTelemetry ? undefined : noDataHint}>
          <span className="text-slate-400 text-[10px] uppercase block tracking-wider">Inbound Req</span>
          <span className={`font-medium ${hasTelemetry ? 'text-slate-200' : 'text-slate-500'}`}>
            {formatRate(nodeData.rate)}
          </span>
        </div>

        <div className="text-right" title={hasTelemetry ? undefined : noDataHint}>
          <span className="text-slate-400 text-[10px] uppercase block tracking-wider">P95 Latency</span>
          <span
            className={`font-medium ${
              !hasTelemetry ? 'text-slate-500' : isHighLatency ? 'text-amber-400' : 'text-slate-200'
            }`}
          >
            {formatLatency(nodeData.latencyP95)}
          </span>
        </div>
      </div>

      {hasErrors && (
        <div className="mt-2 flex items-center justify-between text-[11px] font-mono text-rose-400 bg-rose-500/10 px-2 py-1 rounded border border-rose-500/20">
          <span className="flex items-center gap-1">
            <AlertTriangle className="w-3 h-3" /> Errors
          </span>
          <span>{((nodeData.errorRate || 0) * 100).toFixed(1)}%</span>
        </div>
      )}
    </div>
  );
});
