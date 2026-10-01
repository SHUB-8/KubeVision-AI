import React from 'react';
import { Span } from '../../types/api';
import { X, GitBranch, Clock, Server, CheckCircle2, AlertTriangle, Hash, Copy, Check } from 'lucide-react';
import { useState } from 'react';

interface SpanDetailProps {
  span: Span;
  onClose: () => void;
}

export const SpanDetail: React.FC<SpanDetailProps> = ({ span, onClose }) => {
  const [copied, setCopied] = useState(false);

  const copyJson = () => {
    navigator.clipboard.writeText(JSON.stringify(span, null, 2));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const isError = span.statusCode && !span.statusCode.includes('OK');

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 animate-in fade-in duration-200">
      <div className="bg-slate-900 border border-slate-700/80 rounded-md w-full max-w-xl overflow-hidden flex flex-col max-h-[85vh]">
        {/* Header */}
        <div className="p-4 border-b border-slate-800 flex items-center justify-between bg-slate-800/40">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-md bg-cyan-500/10 border border-cyan-500/20 text-cyan-400">
              <GitBranch className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-slate-100 truncate max-w-sm" title={span.operationName}>
                {span.operationName}
              </h3>
              <p className="text-xs text-slate-400 font-mono">
                Span ID: {span.spanId}
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

        {/* Body */}
        <div className="p-6 overflow-y-auto space-y-4 text-xs font-mono">
          {/* Metadata Grid */}
          <div className="grid grid-cols-2 gap-3 p-3 bg-slate-800/50 rounded-md border border-slate-700/60">
            <div>
              <span className="text-slate-400 text-[10px] block">Service Name</span>
              <span className="text-cyan-400 font-semibold">{span.serviceName}</span>
            </div>
            <div>
              <span className="text-slate-400 text-[10px] block">Duration</span>
              <span className="text-slate-100 font-semibold">
                {(span.duration / 1_000_000).toFixed(2)} ms
              </span>
            </div>
            <div>
              <span className="text-slate-400 text-[10px] block">Status Code</span>
              <span className={`font-semibold ${isError ? 'text-rose-400' : 'text-emerald-400'}`}>
                {span.statusCode || 'STATUS_CODE_OK'}
              </span>
            </div>
            <div>
              <span className="text-slate-400 text-[10px] block">Parent Span</span>
              <span className="text-slate-400 truncate block">
                {span.parentSpanId || 'Root Span'}
              </span>
            </div>
          </div>

          {/* Attributes List */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-slate-400 font-semibold uppercase tracking-wider text-[11px]">
                OTEL Attributes ({span.attributes ? Object.keys(span.attributes).length : 0})
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
