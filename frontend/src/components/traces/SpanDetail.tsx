import React from 'react';
import { Span } from '../../types/api';
import { X, GitBranch, Copy, Check } from 'lucide-react';
import { useState } from 'react';
import { formatNs } from '../../lib/format';

interface SpanDetailProps {
  span: Span;
  onClose: () => void;
}

/**
 * Right-docked details panel for a selected span (Jaeger-style split view).
 * The waterfall stays visible and interactive next to it.
 */
export const SpanDetail: React.FC<SpanDetailProps> = ({ span, onClose }) => {
  const [copied, setCopied] = useState(false);

  const copyJson = () => {
    navigator.clipboard.writeText(JSON.stringify(span, null, 2));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const isError = span.statusCode && !span.statusCode.includes('OK');

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
                <span className="ml-1 text-amber-400" title="Inferred by time-window adjacency — original parent was not captured by eBPF">(inferred)</span>
              )}
            </span>
          </div>
          <div>
            <span className="text-slate-400 text-[10px] block">Started</span>
            <span className="text-slate-300">
              {Number.isFinite(span.startTime) ? new Date(span.startTime / 1_000_000).toLocaleTimeString() : '—'}
            </span>
          </div>
        </div>

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
