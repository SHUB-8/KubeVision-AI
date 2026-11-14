import React, { useState } from 'react';
import { Span } from '../../types/api';
import { X, GitBranch, Copy, Check, Terminal, Server } from 'lucide-react';
import { useApp } from '../../context/AppContext';
import { formatNs } from '../../lib/format';
import type { ErrorRole } from '../../lib/cascade';

interface SpanDetailProps {
  span: Span;
  onClose: () => void;
  /** 'origin' = this span recorded the failure, 'propagated' = it inherited it. */
  cascadeRole?: ErrorRole;
  /** Deepest span that recorded the failure. */
  origin?: Span | null;
  /** Span whose service actually holds the cause (usually the callee). */
  culprit?: Span | null;
  onSelectSpan?: (span: Span) => void;
}

/**
 * Right-docked details panel for a selected span (Jaeger-style split view).
 * The waterfall stays visible and interactive next to it.
 */
export const SpanDetail: React.FC<SpanDetailProps> = ({
  span,
  onClose,
  cascadeRole,
  origin,
  culprit,
  onSelectSpan,
}) => {
  const { setActiveTab, setSelectedService, setLogSeed } = useApp();
  const [copied, setCopied] = useState(false);

  const copyJson = () => {
    navigator.clipboard.writeText(JSON.stringify(span, null, 2));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const podName = span.podName || span.attributes?.['k8s.pod.name'];
  const nodeName = span.nodeName || span.attributes?.['k8s.node.name'];

  const handleOpenPodLogs = () => {
    if (span.serviceName) setSelectedService(span.serviceName);
    if (podName) setLogSeed({ pod: podName });
    setActiveTab('logs');
  };

  const isError = span.statusCode && !span.statusCode.includes('OK');
  const culpritService = culprit?.serviceName;

  // The cause is frequently logged by the callee, not by this span's service —
  // this is the one-click path from a victim span to the service that logged it.
  const openCulpritLogs = () => {
    if (!culpritService) return;
    // Anchor on the failing call itself: a trace opened minutes later must not
    // land in the live window where the failure is already gone.
    const anchor = origin ?? span;
    const pad = 2_000_000_000; // 2s either side, in nanoseconds
    setSelectedService(culpritService);
    setLogSeed({
      keyword: 'error',
      fromNs: Math.max(0, anchor.startTime - pad),
      toNs: anchor.startTime + (anchor.duration || 0) + pad,
    });
    setActiveTab('logs');
  };

  return (
    <div className="fixed top-4 right-4 bottom-4 w-[420px] max-w-[calc(100vw-2rem)] bg-slate-900 border border-slate-700/80 rounded-md flex flex-col z-40 overflow-hidden shadow-2xl">
      {/* Header */}
      <div className="p-4 border-b border-slate-800 flex items-center justify-between bg-slate-800/40">
        <div className="flex items-center gap-3 overflow-hidden">
          <div className="p-2 rounded-md bg-cyan-500/10 border border-cyan-500/20 text-cyan-400">
            <GitBranch className="w-5 h-5" />
          </div>
          <div className="overflow-hidden">
            <h3 className="text-sm font-bold text-slate-100 truncate max-w-[260px]" title={span.operationName}>
              {span.operationName}
            </h3>
            <p className="text-xs text-slate-400 font-mono truncate">
              {span.serviceName} · {span.spanId}
            </p>
            {span.rpcNameInferred && (
              <p className="text-[10px] text-amber-400 mt-0.5" title="OBI could not decode this connection's HPACK path (the connection predates OBI). The method was copied from the opposite end of the same call — an inference, not an observation.">
                method inferred from the paired span
              </p>
            )}
          </div>
        </div>
        <button
          onClick={onClose}
          className="p-1.5 text-slate-400 hover:text-slate-200 rounded-md hover:bg-slate-800 transition shrink-0"
          title="Close span details"
        >
          <X className="w-5 h-5" />
        </button>
      </div>

      {/* Body */}
      <div className="p-4 overflow-y-auto space-y-4 text-xs font-mono">
        {/* Metadata Grid */}
        <div className="grid grid-cols-2 gap-3 p-3 bg-slate-800/50 rounded-md border border-slate-700/60">
          <div>
            <span className="text-slate-400 text-[10px] block">Duration</span>
            <span className="text-slate-100 font-semibold">{formatNs(span.duration)}</span>
          </div>
          <div>
            <span className="text-slate-400 text-[10px] block">Status Code</span>
            <span className={`font-semibold ${isError ? 'text-rose-400' : 'text-emerald-400'}`}>
              {isError ? span.statusCode : 'OK'}
            </span>
          </div>
          <div>
            <span className="text-slate-400 text-[10px] block">Parent Span</span>
            <span className="text-slate-400 truncate block" title={span.parentSpanId || undefined}>
              {span.parentSpanId || 'Root Span'}
              {span.parentInferred && (
                <span className="ml-1 text-amber-400" title="Inferred by time-window adjacency — original parent was not captured by eBPF">(link inferred)</span>
              )}
            </span>
          </div>
          <div>
            <span className="text-slate-400 text-[10px] block">Started</span>
            <span className="text-slate-300">
              {Number.isFinite(span.startTime) ? new Date(span.startTime / 1_000_000).toLocaleTimeString() : '—'}
            </span>
          </div>
          {podName && (
            <div className="col-span-2">
              <span className="text-slate-400 text-[10px] block">Pod Replica</span>
              <span className="text-cyan-300 font-semibold truncate block" title={podName}>
                {podName}
              </span>
            </div>
          )}
          {nodeName && (
            <div className="col-span-2">
              <span className="text-slate-400 text-[10px] block">Worker Node</span>
              <span className="text-slate-300 truncate block" title={nodeName}>
                {nodeName}
              </span>
            </div>
          )}
        </div>

        {podName && (
          <button
            onClick={handleOpenPodLogs}
            className="w-full flex items-center justify-center gap-1.5 py-1.5 px-3 rounded-md bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 transition text-xs font-semibold"
          >
            <Terminal className="w-3.5 h-3.5" />
            <span>Stream Logs for this Pod</span>
          </button>
        )}

        {isError && cascadeRole && culprit && (
          <div className="p-3 rounded-md bg-slate-800/40 border border-rose-500/25 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[10px] uppercase tracking-wider text-rose-300/80">
                {cascadeRole === 'origin' ? 'Failure origin' : 'Inherited failure'}
              </span>
              <span className="text-[10px] text-slate-400 truncate" title={culprit.operationName}>
                {culpritService}
              </span>
            </div>
            <p className="text-[11px] text-slate-300 leading-relaxed">
              {cascadeRole === 'origin' ? (
                culpritService !== span.serviceName ? (
                  <>
                    This span recorded the failure; the cause is in{' '}
                    <span className="text-rose-300 font-semibold">{culpritService}</span>.
                  </>
                ) : (
                  <>This span recorded the failure — every other failing span inherited it.</>
                )
              ) : (
                <>
                  This span only reflects a failure that started in{' '}
                  <span className="text-rose-300 font-semibold">{culpritService}</span>. Its own
                  logs may never mention it.
                </>
              )}
            </p>
            <div className="flex flex-wrap gap-2">
              {origin && origin.spanId !== span.spanId && onSelectSpan && (
                <button
                  onClick={() => onSelectSpan(origin)}
                  className="px-2 py-1 rounded-sm border border-slate-700 bg-slate-800 text-slate-300 hover:text-white hover:bg-slate-700 text-[10px] font-semibold transition-colors"
                >
                  Open origin span
                </button>
              )}
              {culpritService && (
                <button
                  onClick={openCulpritLogs}
                  className="px-2 py-1 rounded-sm bg-rose-500/15 border border-rose-500/30 text-rose-300 hover:bg-rose-500/25 text-[10px] font-semibold transition-colors"
                  title={`Open error logs for ${culpritService}`}
                >
                  Logs in {culpritService}
                </button>
              )}
            </div>
          </div>
        )}

        {span.statusMessage && (
          <div className="p-3 rounded-md bg-rose-500/10 border border-rose-500/30">
            <span className="text-rose-300 font-semibold text-[10px] uppercase tracking-wider block mb-1">
              Failure reason
            </span>
            <p className="text-rose-200 break-words whitespace-pre-wrap leading-relaxed">
              {span.statusMessage}
            </p>
            <p className="mt-1 text-[10px] text-rose-300/60">
              Recorded on the span (OTLP status.message). The service may not log this line at all.
            </p>
          </div>
        )}

        {/* Attributes List */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <span className="text-slate-400 font-semibold uppercase tracking-wider text-[11px]">
              Span Attributes ({span.attributes ? Object.keys(span.attributes).length : 0})
            </span>
            <button
              onClick={copyJson}
              className="flex items-center gap-1 text-[11px] text-slate-400 hover:text-cyan-400 transition"
            >
              {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
              <span>{copied ? 'Copied' : 'Copy JSON'}</span>
            </button>
          </div>

          {span.attributes && Object.keys(span.attributes).length > 0 ? (
            <div className="divide-y divide-slate-800/80 border border-slate-800 rounded-md overflow-hidden bg-slate-950/40">
              {Object.entries(span.attributes).map(([key, val]) => (
                <div key={key} className="p-2.5 flex items-start justify-between gap-3 hover:bg-slate-800/30">
                  <span className="text-slate-400 text-[11px] shrink-0">{key}</span>
                  <span className="text-slate-200 text-right break-all">{val || '""'}</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="p-4 text-center text-slate-400 italic bg-slate-800/20 rounded-md border border-slate-800">
              No specific attributes attached to this span.
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
