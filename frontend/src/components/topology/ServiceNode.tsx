import React, { memo } from 'react';
import { Handle, Position, NodeProps } from '@xyflow/react';
import { AlertTriangle } from 'lucide-react';
import type { MetricSource } from '../../types/api';
import { formatBytesRate, formatErrorRate } from '../../lib/format';
import { languageLabel } from '../common/LanguageBadge';

interface ServiceNodeData {
  label: string;
  type: string;
  namespace: string;
  protocol?: string;
  language?: string;
  rate?: number;
  errorRate?: number;
  latencyP95?: number;
  bytesRate?: number;
  rateSource?: MetricSource;
  latencySource?: MetricSource;
  status?: string;
  /** Jump to the failing traces of this service (server-filtered by status). */
  onFailingTraces?: () => void;
  /** 'origin' started the cascade, 'inherited' only passed it on. */
  errorRole?: 'origin' | 'inherited';
  /** For an inherited service: the downstream service that failed first. */
  errorCause?: string;
  onFocusCause?: () => void;
  replicas?: number;
  ready?: number;
  selected?: boolean;
}

export const ServiceNode = memo(({ data, selected }: NodeProps<any>) => {
  const nodeData = data as ServiceNodeData;
  const isExternal = nodeData.type === 'external';
  const isCrossNamespace = nodeData.type === 'cross-namespace';
  const isOutgoingEgress = isExternal && (nodeData.label === 'outgoing' || nodeData.label.includes('outgoing'));
  const hasErrors = (nodeData.errorRate || 0) > 0;
  const isHighLatency = (nodeData.latencyP95 || 0) > 0.5;

  let borderColor = 'border-slate-700/80 hover:border-cyan-500/60';

  if (isExternal) {
    borderColor = 'border-slate-600 border-dashed hover:border-slate-400';
  } else if (isCrossNamespace) {
    borderColor = 'border-violet-500/60 border-dashed hover:border-violet-300';
  } else if (hasErrors) {
    // Only the service that started the cascade gets the full-strength border;
    // victims stay visible but subordinate.
    borderColor = nodeData.errorRole === 'inherited' ? 'border-rose-400/40' : 'border-rose-500/80';
  } else if (isHighLatency) {
    borderColor = 'border-amber-500/80';
  } else if (selected) {
    borderColor = 'border-cyan-400 ring-2 ring-cyan-500/30';
  }

  // "Not measured" must never render as "0 req/s / 0 ms" - that reads as
  // healthy-idle. Each field is judged on its own: a service can have a
  // measured request rate but no latency data at all (a cache speaking RESP
  // has no duration histogram), and a combined check would hide that.
  const hasRate = (nodeData.rate ?? 0) > 0;
  const hasLatency = (nodeData.latencyP95 ?? 0) > 0;

  // The old hint blamed non-Go runtimes for needing SDK injection. That was
  // wrong: OBI instruments every supported language natively. When all
  // non-Go services are dark while Go services report, the cause is almost
  // always the HOST KERNEL - Clang LTO/ThinLTO mangles the kprobe symbols the
  // generic tracer attaches to, which aborts the whole generic tracer.
  const noDataHint = isOutgoingEgress
    ? 'External egress: captures network calls exiting the cluster (cloud metadata, external endpoints, APIs). Server-side latencies are not instrumented on external hosts.'
    : isExternal
      ? 'External dependency: no Kubernetes workload metrics are available for this node.'
      : isCrossNamespace
        ? 'Dependency in another namespace. Its workload metrics are outside the selected namespace view.'
        : 'No eBPF telemetry for this service. If every non-Go service is dark while Go services ' +
          'report, suspect the host kernel: Clang LTO/ThinLTO builds mangle the kprobe symbols the ' +
          'generic tracer needs. Verify with: grep unix_stream_recvmsg /proc/kallsyms';

  // Provenance. Rendered as plain text rather than an icon so the caveat is
  // visible without hovering - the whole point is that the number is weaker
  // evidence than a Prometheus histogram quantile.
  const sourceNote = (source?: MetricSource) => {
    if (source === 'traces') return 'Derived from sampled traces, not from every request.';
    if (source === 'estimated') return "Estimated from a peer service's traffic, not observed on this link.";
    return undefined;
  };
  const sourceTag = (source?: MetricSource) => {
    if (source === 'traces') return 'trace';
    if (source === 'estimated') return 'est.';
    return null;
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

      {/* Top row: Name and workload / boundary label */}
      <div className="flex items-start justify-between gap-2 mb-2">
        <div className="flex items-center gap-1.5 min-w-0 overflow-hidden">
          <span
            className="font-semibold text-sm text-slate-100 truncate tracking-tight"
            title={
              isOutgoingEgress
                ? 'External egress traffic leaving the cluster (e.g. cloud metadata queries, external APIs, third-party services)'
                : nodeData.label
            }
          >
            {isOutgoingEgress ? 'outgoing (egress)' : nodeData.label}
          </span>
          {nodeData.language && (
            <span
              title={`Runtime language reported by telemetry for ${nodeData.label}: ${nodeData.language}`}
              className="shrink-0 px-1 py-px rounded bg-slate-800 border border-slate-700 text-[9px] leading-4 text-violet-300 font-mono"
            >
              {languageLabel(nodeData.language)}
            </span>
          )}
        </div>

        {isExternal || isCrossNamespace ? (
          <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded border font-medium shrink-0 ${
            isCrossNamespace
              ? 'border-violet-500/30 bg-violet-500/10 text-violet-300'
              : 'border-slate-600 bg-slate-800 text-slate-400'
          }`}>
            {isCrossNamespace ? nodeData.namespace || 'cross-namespace' : 'external'}
          </span>
        ) : nodeData.replicas !== undefined ? (
          <span className="text-[10px] font-mono px-1.5 py-0.5 rounded border border-slate-700/80 bg-slate-800/80 text-slate-300 font-medium flex items-center gap-1 shrink-0">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
            {nodeData.ready ?? 0}/{nodeData.replicas}
          </span>
        ) : (
          <span className="text-[10px] font-mono px-1.5 py-0.5 rounded border border-slate-700/80 bg-slate-800/80 text-slate-400 font-medium shrink-0">
            service
          </span>
        )}
      </div>

      {/* Bottom metrics row */}
      <div className="grid grid-cols-2 gap-2 pt-2.5 border-t border-slate-800/80 text-sm font-mono">
        <div title={hasRate ? sourceNote(nodeData.rateSource) : noDataHint}>
          <span className="text-slate-400 text-[10px] uppercase block tracking-wider">Inbound Req</span>
          <span className={`font-medium ${hasRate ? 'text-slate-200' : 'text-slate-400'}`}>
            {hasRate ? `${nodeData.rate!.toFixed(2)} req/s` : (nodeData.bytesRate ? formatBytesRate(nodeData.bytesRate) : 'no data')}
            {hasRate && sourceTag(nodeData.rateSource) && (
              <span className="ml-1 text-[9px] font-normal text-slate-400">{sourceTag(nodeData.rateSource)}</span>
            )}
          </span>
          {hasRate && nodeData.bytesRate ? (
            <span className="block text-[10px] text-cyan-400/90 font-normal">{formatBytesRate(nodeData.bytesRate)}</span>
          ) : null}
        </div>

        <div className="text-right" title={hasLatency ? sourceNote(nodeData.latencySource) : noDataHint}>
          <span className="text-slate-400 text-[10px] uppercase block tracking-wider">P95 Latency</span>
          <span
            className={`font-medium ${
              !hasLatency ? 'text-slate-400' : isHighLatency ? 'text-amber-400' : 'text-slate-200'
            }`}
          >
            {hasLatency ? `${(nodeData.latencyP95! * 1000).toFixed(2)} ms` : 'no data'}
            {hasLatency && sourceTag(nodeData.latencySource) && (
              <span className="ml-1 text-[9px] font-normal text-slate-400">{sourceTag(nodeData.latencySource)}</span>
            )}
          </span>
        </div>
      </div>

      {hasErrors && (
        <button
          type="button"
          onClick={(event) => {
            // Do not also select the node: the strip is a direct shortcut to
            // the traces that explain the error rate.
            event.stopPropagation();
            nodeData.onFailingTraces?.();
          }}
          title={
            nodeData.errorRole === 'inherited' && nodeData.errorCause
              ? `Errors here follow a failing call to ${nodeData.errorCause}. Open the failing traces.`
              : 'Error rate from measured request status codes. Open the failing traces.'
          }
          className={`mt-2 w-full flex items-center justify-between text-[11px] font-mono px-2 py-1 rounded border transition cursor-pointer ${
            nodeData.errorRole === 'inherited'
              ? 'text-rose-300/80 bg-rose-500/5 border-rose-500/20 hover:bg-rose-500/10'
              : 'text-rose-400 bg-rose-500/10 border-rose-500/20 hover:bg-rose-500/20 hover:border-rose-500/40'
          }`}
        >
          <span className="flex items-center gap-1">
            <AlertTriangle className="w-3 h-3" />
            {nodeData.errorRole === 'inherited' && nodeData.errorCause ? (
              <span className="truncate">via {nodeData.errorCause}</span>
            ) : (
              'Errors'
            )}
          </span>
          <span>{formatErrorRate(nodeData.errorRate)}</span>
        </button>
      )}
    </div>
  );
});
