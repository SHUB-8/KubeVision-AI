import React, { useState, useMemo } from 'react';
import { Trace, Span } from '../../types/api';
import { SpanDetail } from './SpanDetail';
import { formatNs } from '../../lib/format';
import {
  ArrowLeft,
  Clock,
  GitBranch,
  Layers,
  Copy,
  Check,
  AlertTriangle,
  Zap,
  Info,
} from 'lucide-react';

interface TraceWaterfallProps {
  trace: Trace;
  onBack: () => void;
}

const SERVICE_COLORS: Record<string, { bg: string; border: string; bar: string; text: string }> = {
  frontend: { bg: 'bg-cyan-500/10', border: 'border-cyan-500/30', bar: 'bg-cyan-500', text: 'text-cyan-400' },
  checkoutservice: { bg: 'bg-indigo-500/10', border: 'border-indigo-500/30', bar: 'bg-indigo-500', text: 'text-indigo-400' },
  cartservice: { bg: 'bg-emerald-500/10', border: 'border-emerald-500/30', bar: 'bg-emerald-500', text: 'text-emerald-400' },
  productcatalogservice: { bg: 'bg-amber-500/10', border: 'border-amber-500/30', bar: 'bg-amber-500', text: 'text-amber-400' },
  currencyservice: { bg: 'bg-purple-500/10', border: 'border-purple-500/30', bar: 'bg-purple-500', text: 'text-purple-400' },
  shippingservice: { bg: 'bg-sky-500/10', border: 'border-sky-500/30', bar: 'bg-sky-500', text: 'text-sky-400' },
  paymentservice: { bg: 'bg-rose-500/10', border: 'border-rose-500/30', bar: 'bg-rose-500', text: 'text-rose-400' },
  emailservice: { bg: 'bg-teal-500/10', border: 'border-teal-500/30', bar: 'bg-teal-500', text: 'text-teal-400' },
  recommendationservice: { bg: 'bg-fuchsia-500/10', border: 'border-fuchsia-500/30', bar: 'bg-fuchsia-500', text: 'text-fuchsia-400' },
  'redis-cart': { bg: 'bg-red-500/10', border: 'border-red-500/30', bar: 'bg-red-500', text: 'text-red-400' },
};

function getServiceColor(name: string) {
  if (SERVICE_COLORS[name]) return SERVICE_COLORS[name];
  return { bg: 'bg-slate-500/10', border: 'border-slate-500/30', bar: 'bg-slate-400', text: 'text-slate-300' };
}

export const TraceWaterfall: React.FC<TraceWaterfallProps> = ({ trace, onBack }) => {
  const [selectedSpan, setSelectedSpan] = useState<Span | null>(null);
  const [copied, setCopied] = useState(false);

  const copyTraceId = () => {
    navigator.clipboard.writeText(trace.traceId);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // Compute timeline boundaries
  const { minStart, maxEnd, totalDurationNs, bottleneckSpan } = useMemo(() => {
    if (!trace.spans || trace.spans.length === 0) {
      return { minStart: 0, maxEnd: 1, totalDurationNs: 1, bottleneckSpan: null };
    }

    let min = trace.spans[0].startTime;
    let max = trace.spans[0].startTime + (trace.spans[0].duration || 250_000);
    let longestSpan: Span | undefined;
    let longestDur = -1;

    for (const s of trace.spans) {
      const dur = s.duration > 0 ? s.duration : 250_000;
      if (s.startTime < min) min = s.startTime;
      const end = s.startTime + dur;
      if (end > max) max = end;
      // The root span covers the whole request by definition — it is never
      // the bottleneck. Only child spans are candidates.
      if (!s.parentSpanId && s.duration > 0) continue;
      if (dur > longestDur) {
        longestDur = dur;
        longestSpan = s;
      }
    }

    const diff = Math.max(max - min, 1_000_000); // at least 1ms to prevent divide-by-zero
    return {
      minStart: min,
      maxEnd: max,
      totalDurationNs: diff,
      // A single-span trace has nothing to compare against, so calling that
      // span "the bottleneck" is noise rather than signal.
      bottleneckSpan: trace.spans.length > 1 ? longestSpan ?? null : null,
    };
  }, [trace]);


  const totalDurationMs = (totalDurationNs / 1_000_000).toFixed(1);

  // Axis tick labels: keep precision below 10 ms, whole ms above.
  const axisLabel = (ms: number) =>
    `${ms < 10 ? ms.toFixed(1) : Math.round(ms)} ms`;

  return (
    <div className="space-y-6">
      {/* Top Navigation & Trace Overview Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 p-5 rounded-md bg-slate-900/80 border border-slate-800">
        <div className="flex items-start gap-4">
          <button
            onClick={onBack}
            className="p-2 rounded-md bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white border border-slate-700 transition"
            title="Back to trace list"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>

          <div>
            <div className="flex items-center gap-2.5 flex-wrap">
              <h2 className="text-base font-bold text-slate-100 tracking-tight">
                {trace.rootTraceName || 'Distributed Trace'}
              </h2>
              {trace.rootServiceName && (
                <span className="px-2 py-0.5 rounded-full text-xs font-mono font-semibold bg-cyan-500/10 text-cyan-400 border border-cyan-500/20">
                  {trace.rootServiceName}
                </span>
              )}
            </div>

            <div className="flex items-center gap-2 mt-1 text-xs font-mono text-slate-400">
              <span>Trace ID:</span>
              <span className="text-slate-300 truncate max-w-xs">{trace.traceId}</span>
              <button
                onClick={copyTraceId}
                className="p-1 hover:text-cyan-400 rounded hover:bg-slate-800 transition"
                title="Copy Trace ID"
              >
                {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
              </button>
            </div>
          </div>
        </div>

        {/* Stats summary */}
        <div className="flex items-center gap-6 font-mono text-xs border-t md:border-t-0 md:border-l border-slate-800 pt-3 md:pt-0 md:pl-6">
          <div>
            <span className="text-[10px] text-slate-400 uppercase tracking-wider block">Duration</span>
            <span className="text-base font-bold text-cyan-300">{totalDurationMs} ms</span>
          </div>
          <div>
            <span className="text-[10px] text-slate-400 uppercase tracking-wider block">Spans</span>
            <span className="text-base font-bold text-slate-200">{trace.spans?.length || 0}</span>
          </div>
        </div>
      </div>

      {/* Bottleneck Warning Banner */}
      {bottleneckSpan && (
        <div className="flex items-center justify-between p-3.5 rounded-md bg-amber-500/10 border border-amber-500/20 text-amber-200 text-xs font-mono">
          <div className="flex items-center gap-2.5">
            <Zap className="w-4 h-4 text-amber-400 shrink-0" />
            <span>
              <strong>Primary Bottleneck:</strong> Span{' '}
              <code className="text-amber-300 font-semibold">{bottleneckSpan.operationName}</code> on{' '}
              <code className="text-cyan-300">{bottleneckSpan.serviceName}</code> took{' '}
              <strong>{formatNs(bottleneckSpan.duration)}</strong> (
              {(() => {
                const pct = (bottleneckSpan.duration / totalDurationNs) * 100;
                // A sub-span near 100% reads as a bug ("how can a part be
                // the whole?") — show the fraction that makes it credible.
                return pct >= 99 ? `${pct.toFixed(1)}%` : `${pct.toFixed(0)}%`;
              })()} of total request).
            </span>
          </div>
          <button
            onClick={() => setSelectedSpan(bottleneckSpan)}
            className="text-[11px] underline hover:text-amber-100 shrink-0"
          >
            Inspect Span
          </button>
        </div>
      )}

      {/* Waterfall Gantt Chart Container */}
      <div className="rounded-md border border-slate-800 bg-slate-900/60 overflow-hidden">
        {/* Waterfall Header Axis */}
        <div className="grid grid-cols-12 gap-2 p-3 bg-slate-800/60 border-b border-slate-800 text-[11px] font-mono text-slate-400 select-none">
          <div className="col-span-5 font-semibold">SPAN HIERARCHY & OPERATION</div>
          <div className="col-span-7 flex justify-between pr-4">
            <span>0</span>
            <span>{axisLabel(Number(totalDurationMs) * 0.25)}</span>
            <span>{axisLabel(Number(totalDurationMs) * 0.5)}</span>
            <span>{axisLabel(Number(totalDurationMs) * 0.75)}</span>
            <span>{totalDurationMs} ms</span>
          </div>
        </div>

        {/* Spans List */}
        <div className="divide-y divide-slate-800/50">
          {trace.spans && trace.spans.length > 0 ? (
            trace.spans.map((span, idx) => {
              const startOffset = Math.max(0, span.startTime - minStart);
              const leftPercent = Math.min(100, Math.max(0, (startOffset / totalDurationNs) * 100));
              const spanDur = span.duration > 0 ? span.duration : 250_000;
              const widthPercent = Math.min(
                100 - leftPercent,
                Math.max(2.5, (spanDur / totalDurationNs) * 100)
              );
              const sColor = getServiceColor(span.serviceName);
              const isBottleneck = bottleneckSpan?.spanId === span.spanId;
              const isError = span.statusCode && !span.statusCode.includes('OK');

              return (
                <div
                  key={idx}
                  onClick={() => setSelectedSpan(span)}
                  className={`grid grid-cols-12 gap-2 p-3 items-center hover:bg-slate-800/40 cursor-pointer transition text-xs font-mono group ${
                    isBottleneck ? 'bg-amber-500/5' : ''
                  }`}
                >
                  {/* Left Column: Service & Operation */}
                  <div className="col-span-5 flex items-center gap-2 overflow-hidden pr-2">
                    <span
                      className={`text-[10px] px-2 py-0.5 rounded border font-semibold shrink-0 ${sColor.bg} ${sColor.border} ${sColor.text}`}
                    >
                      {span.serviceName}
                    </span>
                    <span
                      className={`truncate font-medium text-slate-200 group-hover:text-cyan-300 transition ${
                        isError ? 'text-rose-400 font-bold' : ''
                      }`}
                      title={span.operationName}
                    >
                      {span.operationName}
                    </span>
                  </div>

                  {/* Right Column: Timeline Duration Bar */}
                  <div className="col-span-7 relative h-7 flex items-center pr-4">
                    {/* Background grid guide line */}
                    <div className="absolute inset-0 flex justify-between pointer-events-none opacity-20">
                      <div className="border-r border-slate-600 h-full w-1/4" />
                      <div className="border-r border-slate-600 h-full w-1/4" />
                      <div className="border-r border-slate-600 h-full w-1/4" />
                      <div className="border-r border-slate-600 h-full w-1/4" />
                    </div>

                    {/* Gantt Bar */}
                    <div
                      style={{
                        left: `${leftPercent}%`,
                        width: `${widthPercent}%`,
                      }}
                      className={`absolute h-4 rounded-md shadow-sm transition-all duration-150 ${
                        isError ? 'bg-rose-500' : isBottleneck ? 'bg-amber-500' : sColor.bar
                      } group-hover:brightness-125 opacity-90`}
                    />

                    {/* Duration Label */}
                    <span
                      style={{
                        left: `calc(${leftPercent}% + ${widthPercent}% + 8px)`,
                      }}
                      className="absolute text-[10px] font-mono text-slate-400 whitespace-nowrap"
                    >
                      {formatNs(span.duration)}
                    </span>
                  </div>
                </div>
              );

            })
          ) : (
            <div className="p-8 text-center text-slate-400 italic">No spans recorded for this trace.</div>
          )}
        </div>
      </div>

      {/* Span Attributes Modal */}
      {selectedSpan && (
        <SpanDetail span={selectedSpan} onClose={() => setSelectedSpan(null)} />
      )}
    </div>
  );
};
