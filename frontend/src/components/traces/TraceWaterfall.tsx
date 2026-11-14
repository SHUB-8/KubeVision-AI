import React, { useState, useMemo, useRef, useCallback } from 'react';
import { Trace, Span } from '../../types/api';
import { SpanDetail } from './SpanDetail';
import { TraceLogsPanel } from './TraceLogsPanel';
import { TraceFlameGraph } from './TraceFlameGraph';
import { formatNs, formatAge } from '../../lib/format';
import { serviceStep } from '../../lib/serviceColor';
import { traceStartNs, isFailingSpan } from '../../lib/trace';
import { analyzeCascade } from '../../lib/cascade';
import {
  ArrowLeft,
  Copy,
  Check,
  ChevronRight,
  ChevronDown,
  Terminal,
  Flame,
  AlertTriangle,
} from 'lucide-react';

interface TraceWaterfallProps {
  trace: Trace;
  onBack: () => void;
}

// Service identity is an ordinal step in one hue, not a categorical color:
// a service keeps its step in the rows and the minimap, and the ramp cannot be
// mistaken for a status (those stay rose/amber/emerald). Class names are
// literal strings so Tailwind's JIT can see every utility it must emit.
//
// The step is free to get dark for the *fill* (a 14px bar needs no text
// contrast), but the 10px chip label must stay readable: steps 5-8 drop below
// 4.5:1 on paper, so their label is pinned to step 4 while the chip's fill and
// border keep the service's real step.
const SERVICE_STEPS = [
  { bar: 'bg-seq-1', chip: 'bg-seq-1/10 border-seq-1/40 text-seq-1' },
  { bar: 'bg-seq-2', chip: 'bg-seq-2/10 border-seq-2/40 text-seq-2' },
  { bar: 'bg-seq-3', chip: 'bg-seq-3/10 border-seq-3/40 text-seq-3' },
  { bar: 'bg-seq-4', chip: 'bg-seq-4/10 border-seq-4/40 text-seq-4' },
  { bar: 'bg-seq-5', chip: 'bg-seq-5/10 border-seq-5/40 text-seq-4' },
  { bar: 'bg-seq-6', chip: 'bg-seq-6/10 border-seq-6/40 text-seq-4' },
  { bar: 'bg-seq-7', chip: 'bg-seq-7/10 border-seq-7/40 text-seq-4' },
  { bar: 'bg-seq-8', chip: 'bg-seq-8/10 border-seq-8/40 text-seq-4' },
];

// No service name means no identity to encode — stay neutral rather than
// assigning a step that would imply a real service.
const NEUTRAL_STEP = {
  bar: 'bg-slate-400',
  chip: 'bg-slate-500/10 border-slate-500/30 text-slate-300',
};

function getServiceColor(name: string) {
  // Shared with the flame graph, so a service keeps its step across layouts.
  const step = serviceStep(name);
  return step === 0 ? NEUTRAL_STEP : SERVICE_STEPS[step - 1];
}

/** A visible [start, end] window over the trace, as fractions of the full duration. */
interface ViewRange {
  start: number;
  end: number;
}

const FULL_VIEW: ViewRange = { start: 0, end: 1 };
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

// Axis tick labels: keep precision below 10 ms, whole ms above.
const axisLabel = (ms: number) => `${ms < 10 ? ms.toFixed(1) : Math.round(ms)} ms`;

export const TraceWaterfall: React.FC<TraceWaterfallProps> = ({ trace, onBack }) => {
  const [selectedSpan, setSelectedSpan] = useState<Span | null>(null);
  const [copied, setCopied] = useState(false);
  const [showRelatedLogs, setShowRelatedLogs] = useState(false);
  const [traceLayout, setTraceLayout] = useState<'waterfall' | 'flamegraph'>('waterfall');
  const [view, setView] = useState<ViewRange | null>(null);
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(new Set());

  const stripRef = useRef<HTMLDivElement>(null);
  const dragState = useRef<{
    mode: 'pan' | 'resizeL' | 'resizeR';
    startX: number;
    orig: ViewRange;
  } | null>(null);

  const copyTraceId = () => {
    navigator.clipboard.writeText(trace.traceId);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // Build parent-child tree hierarchy, chronological DFS ordering & Clock Skew Adjustment
  const { hierarchicalSpans, minStart, totalDurationNs, rawWindowNs, childrenCount, rootSpan } = useMemo(() => {
    const spans = trace.spans ?? [];
    if (spans.length === 0) {
      return {
        hierarchicalSpans: [] as { span: Span; depth: number; adjustedStartTime: number; adjustedDuration: number }[],
        minStart: 0,
        totalDurationNs: 1,
        rawWindowNs: 1,
        childrenCount: new Map<string, number>(),
        rootSpan: null as Span | null,
      };
    }

    const spanMap = new Map<string, Span>();
    const childrenMap = new Map<string, Span[]>();

    for (const span of spans) {
      spanMap.set(span.spanId, span);
      if (span.parentSpanId) {
        const list = childrenMap.get(span.parentSpanId) || [];
        list.push(span);
        childrenMap.set(span.parentSpanId, list);
      }
    }

    // Sort children chronologically by raw start time
    for (const [, children] of childrenMap) {
      children.sort((a, b) => a.startTime - b.startTime);
    }

    // Identify root spans: either parentSpanId is absent, or parent does not exist in this trace
    const roots: Span[] = [];
    for (const span of spans) {
      if (!span.parentSpanId || !spanMap.has(span.parentSpanId)) {
        roots.push(span);
      }
    }

    roots.sort((a, b) => a.startTime - b.startTime);

    // Depth-first traversal with Jaeger-style Clock Skew Adjustment:
    // A child span (e.g. server RPC) cannot start before its caller (client RPC)
    // or finish after its caller. If clock skew or timestamp precision truncation
    // (such as Node.js millisecond truncation vs Go nanoseconds) causes
    // child.startTime < parent.startTime, clamp the child's timeline within parent window.
    interface RenderSpanItem {
      span: Span;
      depth: number;
      adjustedStartTime: number;
      adjustedDuration: number;
    }

    const result: RenderSpanItem[] = [];
    const visited = new Set<string>();

    let min = spans[0].startTime;
    let max = spans[0].startTime + (spans[0].duration || 250_000);

    function dfs(
      current: Span,
      depth: number,
      parentStart?: number
    ) {
      if (visited.has(current.spanId)) return;
      visited.add(current.spanId);

      let adjStart = current.startTime;
      let adjDur = current.duration > 0 ? current.duration : 250_000;

      // Clock Skew Adjustment against parent span boundaries: a child span
      // cannot START before its caller. When a parent's clock disagrees
      // (or the exporter truncated precision), shift the child forward so
      // the tree rows stay inside their parent's window.
      if (parentStart !== undefined) {
        if (adjStart < parentStart) {
          adjStart = parentStart;
        }
      }

      if (adjStart < min) min = adjStart;
      const end = adjStart + adjDur;
      if (end > max) max = end;

      result.push({
        span: current,
        depth,
        adjustedStartTime: adjStart,
        adjustedDuration: adjDur,
      });

      const children = childrenMap.get(current.spanId) || [];
      for (const child of children) {
        dfs(child, depth + 1, adjStart);
      }
    }

    for (const root of roots) {
      dfs(root, 0);
    }

    for (const span of spans) {
      if (!visited.has(span.spanId)) {
        dfs(span, 0);
      }
    }

    const diff = Math.max(max - min, 1_000_000);

    // Header figures must describe the trace AS RECORDED, not the adjusted
    // layout: clamping for the tree can compress children into their caller's
    // window, which is what made the header read "15.1 ms" for a trace whose
    // spans plainly extended a few seconds.
    let rawMinStart = min;
    let rawMaxEnd = max;
    for (const span of spans) {
      rawMinStart = Math.min(rawMinStart, span.startTime);
      rawMaxEnd = Math.max(rawMaxEnd, span.startTime + (span.duration || 0));
    }
    const rawWindowNs = Math.max(rawMaxEnd - rawMinStart, 1_000_000);

    const counts = new Map<string, number>();
    for (const [parent] of childrenMap) {
      counts.set(parent, (childrenMap.get(parent) || []).length);
    }

    return {
      hierarchicalSpans: result,
      minStart: min,
      maxEnd: max,
      totalDurationNs: diff,
      rawWindowNs,
      childrenCount: counts,
      // First root in start order: the detail API omits the trace-level names,
      // so the header falls back to what the root span itself recorded.
      rootSpan: roots[0] ?? null,
    };
  }, [trace]);

  // Rows currently visible under the collapsed-subtree state: a collapsed span
  // renders its own row and hides everything beneath it.
  const visibleRows = useMemo(() => {
    const hidden = new Set<string>();
    const hideDescendants = (spanId: string) => {
      for (const child of (childrenMapRef(spanId))) {
        hidden.add(child.spanId);
        hideDescendants(child.spanId);
      }
    };
    function childrenMapRef(spanId: string): Span[] {
      return ((trace.spans ?? []).filter(
        (s) => s.parentSpanId === spanId
      ) as Span[]);
    }
    for (const id of collapsedIds) {
      hideDescendants(id);
    }
    return hierarchicalSpans.filter((row) => !hidden.has(row.span.spanId));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hierarchicalSpans, collapsedIds, trace]);

  // Header duration = the recorded window (earliest span start to latest span
  // end), NOT the adjusted layout extent: async fire-and-forget spans can
  // outlive their callers by seconds and that time is real.
  const totalDurationMs = (rawWindowNs / 1_000_000).toFixed(1);
  const startNs = traceStartNs(trace);
  // Cascading failures: which span recorded the failure, and which spans only
  // inherited it. Shared with the flame graph so both views agree.
  const cascade = useMemo(() => analyzeCascade(trace), [trace]);
  const cascadeOrigin = cascade.origin;
  // The detail API returns spans only, so the trace-level names are often
  // absent; fall back to what the root span recorded before showing a bare
  // "Trace" title with no service chip.
  const detailTitle = trace.rootTraceName || rootSpan?.operationName || 'Trace';
  const detailService = trace.rootServiceName || rootSpan?.serviceName;
  const eff = view ?? FULL_VIEW;
  const viewDenom = eff.end - eff.start;
  const windowMs = viewDenom * totalDurationNs / 1_000_000;

  const toggleCollapse = useCallback((spanId: string) => {
    setCollapsedIds((prev) => {
      const next = new Set(prev);
      if (next.has(spanId)) next.delete(spanId);
      else next.add(spanId);
      return next;
    });
  }, []);

  // Overview strip drag: pan with the window body, resize from either edge.
  const beginDrag = (mode: 'pan' | 'resizeL' | 'resizeR') => (e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    dragState.current = { mode, startX: e.clientX, orig: view ?? FULL_VIEW };
  };

  const onDragMove = (e: React.PointerEvent) => {
    const st = dragState.current;
    if (!st || !stripRef.current) return;
    const rect = stripRef.current.getBoundingClientRect();
    const dFrac = (e.clientX - st.startX) / Math.max(1, rect.width);
    const range = st.orig.end - st.orig.start;
    if (st.mode === 'pan') {
      let start = clamp01(st.orig.start + dFrac);
      let end = start + range;
      if (end > 1) { end = 1; start = 1 - range; }
      setView({ start, end });
    } else if (st.mode === 'resizeL') {
      setView({ start: clamp01(Math.min(st.orig.start + dFrac, st.orig.end - 0.02)), end: st.orig.end });
    } else {
      setView({ start: st.orig.start, end: clamp01(Math.max(st.orig.end + dFrac, st.orig.start + 0.02)) });
    }
  };

  const endDrag = () => {
    dragState.current = null;
  };

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
                {detailTitle}
              </h2>
              {detailService && (
                <span className="px-2 py-0.5 rounded text-xs font-mono font-semibold bg-cyan-500/10 text-cyan-400 border border-cyan-500/20">
                  {detailService}
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

            {/* Cascade summary. Logs cannot answer "who caused this": the victim
                usually returns the failure without logging it. The trace can. */}
            {cascadeOrigin && cascade.chain.length > 0 && (
              <button
                onClick={() => setSelectedSpan(cascadeOrigin)}
                className="mt-2 inline-flex max-w-full items-center gap-1.5 rounded-sm border border-rose-500/30 bg-rose-500/10 px-2 py-1 text-[10px] font-mono text-rose-300 hover:border-rose-500/50 hover:text-rose-200 transition-colors"
                title={`${cascade.failingCount} failing span${cascade.failingCount === 1 ? '' : 's'}. Failure recorded on ${cascadeOrigin.serviceName} / ${cascadeOrigin.operationName}${
                  cascadeOrigin.statusMessage ? ` — ${cascadeOrigin.statusMessage}` : ''
                }`}
              >
                <AlertTriangle className="w-3 h-3 shrink-0" />
                <span className="truncate">
                  {cascade.chain.map((step) => step.service).join(' → ')}
                </span>
                <span className="shrink-0 text-rose-300/70">
                  {cascade.failingCount} failing
                </span>
              </button>
            )}
          </div>
        </div>

        {/* Stats summary */}
        <div className="flex items-center gap-6 font-mono text-xs border-t md:border-t-0 md:border-l border-slate-800 pt-3 md:pt-0 md:pl-6">
          {startNs !== null && (
            <div title={new Date(startNs / 1_000_000).toLocaleString()}>
              <span className="text-[10px] text-slate-400 uppercase tracking-wider block">Started</span>
              <span className="text-sm font-semibold text-slate-200">
                {formatAge(startNs / 1_000_000)} ago
              </span>
            </div>
          )}
          <div>
            <span className="text-[10px] text-slate-400 uppercase tracking-wider block">Duration</span>
            <span className="text-base font-bold text-cyan-300">{totalDurationMs} ms</span>
          </div>
          <div>
            <span className="text-[10px] text-slate-400 uppercase tracking-wider block">Spans</span>
            <span className="text-base font-bold text-slate-200">{trace.spans?.length || 0}</span>
          </div>
          {/* View mode toggle: Waterfall vs Flame Graph */}
          <div className="flex items-center rounded-md border border-slate-700 overflow-hidden">
            <button
              onClick={() => setTraceLayout('waterfall')}
              className={`px-2.5 py-1.5 text-[11px] font-medium transition ${
                traceLayout === 'waterfall'
                  ? 'bg-cyan-500/15 text-cyan-300'
                  : 'bg-slate-800/80 text-slate-400 hover:text-slate-200'
              }`}
            >
              Waterfall
            </button>
            <button
              onClick={() => setTraceLayout('flamegraph')}
              className={`flex items-center gap-1 px-2.5 py-1.5 text-[11px] font-medium transition ${
                traceLayout === 'flamegraph'
                  ? 'bg-cyan-500/15 text-cyan-300'
                  : 'bg-slate-800/80 text-slate-400 hover:text-slate-200'
              }`}
            >
              <Flame className="w-3 h-3 text-amber-400" />
              <span>Flame Graph</span>
            </button>
          </div>

          <button
            onClick={() => setShowRelatedLogs(true)}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md bg-slate-800/80 hover:bg-slate-700 border border-slate-700 text-[11px] font-medium text-slate-300 hover:text-white transition"
            title="Logs emitted by every service in this trace, around its time window"
          >
            <Terminal className="w-3.5 h-3.5 text-emerald-400" />
            <span>Related logs</span>
          </button>
        </div>
      </div>

      {traceLayout === 'flamegraph' ? (
        <TraceFlameGraph
          trace={trace}
          cascade={cascade}
          selectedSpanId={selectedSpan?.spanId}
          onSelectSpan={(span) => setSelectedSpan(span)}
        />
      ) : (
        /* Waterfall Gantt Chart Container */
        <div className="rounded-md border border-slate-800 bg-slate-900/60 overflow-hidden">
        {/* Sticky header: overview strip (drag to zoom / pan) + time axis */}
        <div className="sticky top-0 z-10 bg-slate-900 border-b border-slate-800">
          {/* Overview strip — Jaeger-style: drag window to pan, edges to zoom, double-click to reset */}
          <div
            ref={stripRef}
            onPointerMove={onDragMove}
            onPointerUp={endDrag}
            onPointerLeave={endDrag}
            onDoubleClick={() => setView(null)}
            className="relative h-10 mx-3 mt-2 rounded-sm bg-slate-950/60 border border-slate-800 select-none touch-none cursor-grab"
            title="Drag the window to pan, drag its edges to zoom. Double-click to reset."
          >
            {/* Full-trace density minimap */}
            {hierarchicalSpans.map(({ span, adjustedStartTime, adjustedDuration }, idx) => {
              const f0 = (adjustedStartTime - minStart) / totalDurationNs;
              const f1 = f0 + (adjustedDuration > 0 ? adjustedDuration : 250_000) / totalDurationNs;
              const sColor = getServiceColor(span.serviceName);
              const rows = hierarchicalSpans.length;
              const rowH = 36 / rows;
              return (
                <div
                  key={span.spanId || idx}
                  className={`absolute rounded-[1px] ${rowH < 2 ? 'opacity-80' : ''} ${
                    isFailingSpan(span)
                      ? cascade.roles.get(span.spanId) === 'propagated'
                        ? 'bg-rose-500/40'
                        : 'bg-rose-500'
                      : sColor.bar
                  }`}
                  style={{
                    left: `${f0 * 100}%`,
                    width: `${Math.max(0.4, (f1 - f0) * 100)}%`,
                    top: `${idx * rowH}px`,
                    height: `${Math.max(1, rowH - 1)}px`,
                  }}
                />
              );
            })}

            {/* Draggable view window */}
            <div
              onPointerDown={beginDrag('pan')}
              className="absolute top-0 bottom-0 bg-cyan-400/10 border-x-2 border-cyan-400 cursor-grab active:cursor-grabbing"
              style={{ left: `${eff.start * 100}%`, width: `${viewDenom * 100}%` }}
            >
              <div
                onPointerDown={beginDrag('resizeL')}
                className="absolute -left-1 top-0 bottom-0 w-2 cursor-ew-resize"
              />
              <div
                onPointerDown={beginDrag('resizeR')}
                className="absolute -right-1 top-0 bottom-0 w-2 cursor-ew-resize"
              />
            </div>

            {view && (
              <button
                onClick={() => setView(null)}
                className="absolute -top-0.5 right-1 z-10 px-1.5 py-0.5 rounded-sm bg-slate-800 border border-slate-700 text-[9px] font-mono text-slate-300 hover:text-white"
                title="Reset zoom"
              >
                reset
              </button>
            )}
          </div>

          {/* Waterfall Header Axis — sticky so the time scale stays visible on long traces */}
          <div className="grid grid-cols-12 gap-2 p-3 text-[11px] font-mono text-slate-400 select-none">
            <div className="col-span-5 font-semibold">SPAN HIERARCHY &amp; OPERATION</div>
            <div className="col-span-7 flex justify-between pr-4">
              {[0, 0.25, 0.5, 0.75, 1].map((f) => (
                <span key={f}>{axisLabel(eff.start * (totalDurationNs / 1_000_000) + f * windowMs)}</span>
              ))}
            </div>
          </div>
          {/* Compact legend: one word plus a tooltip. The long-form explanation
              belongs in the hover title, not in a sentence across the header. */}
          <div
            className="flex items-center gap-1.5 px-3 py-1.5 text-[10px] font-mono text-slate-400 border-t border-slate-800/60"
            title="Amber marker = value recovered by KubeVision (parent link or RPC method), inferred from the paired span — not observed on the wire."
          >
            <span className="inline-block w-2 h-2 rounded-full bg-amber-400 shrink-0" />
            <span>inferred</span>
          </div>
        </div>

        {/* Spans List */}
        <div className="divide-y divide-slate-800/50">
          {visibleRows.length > 0 ? (
            visibleRows.map(({ span, depth, adjustedStartTime, adjustedDuration }, idx) => {
              const startOffset = Math.max(0, adjustedStartTime - minStart);
              const spanDur = adjustedDuration > 0 ? adjustedDuration : 250_000;
              // Fractions of the FULL trace, then mapped into the view window.
              const f0 = startOffset / totalDurationNs;
              const f1 = (startOffset + spanDur) / totalDurationNs;
              const leftPercent = clamp01((f0 - eff.start) / viewDenom) * 100;
              const rightPercent = clamp01((f1 - eff.start) / viewDenom) * 100;
              const widthPercent = rightPercent - leftPercent;
              const sColor = getServiceColor(span.serviceName);
              const isError = isFailingSpan(span);
              // Only the span where the failure started gets full rose; the
              // spans that inherited it stay visible but subordinate.
              const errorFill =
                cascade.roles.get(span.spanId) === 'propagated' ? 'bg-rose-500/40' : 'bg-rose-500';
              const isSelected = selectedSpan?.spanId === span.spanId;
              const nChildren = childrenCount.get(span.spanId) || 0;
              const isCollapsed = collapsedIds.has(span.spanId);

              // Duration label placement: after the bar when there is room,
              // inside the bar when it ends near the axis edge (always true
              // for the root span), or before the bar start when the bar is
              // too narrow to hold the text.
              const endPercent = leftPercent + widthPercent;
              const inView = widthPercent > 0.05;
              const labelAfter = endPercent <= 80;
              const labelInside = !labelAfter && widthPercent >= 12;

              return (
                <div
                  key={span.spanId || idx}
                  onClick={() => setSelectedSpan(span)}
                  className={`grid grid-cols-12 gap-2 p-2.5 items-center cursor-pointer transition text-xs font-mono group ${
                    isSelected ? 'bg-slate-800/70' : 'hover:bg-slate-800/40'
                  }`}
                >
                  {/* Left Column: Service & Operation with tree indentation */}
                  <div
                    className="col-span-5 flex flex-wrap sm:flex-nowrap items-center gap-1.5 overflow-hidden pr-2"
                    style={{ paddingLeft: `min(${Math.min(depth * 1.15, 10)}em, 24%)` }}
                  >
                    {nChildren > 0 ? (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleCollapse(span.spanId);
                        }}
                        className="p-0.5 rounded-sm text-slate-400 hover:text-cyan-300 hover:bg-slate-800 shrink-0"
                        title={isCollapsed ? 'Expand children' : 'Collapse children'}
                      >
                        {isCollapsed ? (
                          <ChevronRight className="w-3.5 h-3.5" />
                        ) : (
                          <ChevronDown className="w-3.5 h-3.5" />
                        )}
                      </button>
                    ) : (
                      <span className="w-4 shrink-0 text-center text-slate-700 select-none">·</span>
                    )}
                    {(span.rpcNameInferred || span.parentInferred) && (
                      <span
                        className="sm:hidden shrink-0 w-1.5 h-1.5 rounded-full bg-amber-400"
                        title="Inferred by KubeVision (recovered, not observed) — open the span for details."
                      />
                    )}
                    <span
                      className={`text-[10px] px-2 py-0.5 rounded border font-semibold shrink-0 max-w-[75%] truncate sm:max-w-none ${sColor.chip}`}
                      title={span.serviceName}
                    >
                      {span.serviceName}
                    </span>
                    <span
                      className={`w-full sm:w-auto min-w-0 truncate font-medium text-slate-200 group-hover:text-cyan-300 transition ${
                        isError ? 'text-rose-400 font-bold' : ''
                      }`}
                      title={span.operationName}
                    >
                      {span.operationName}
                    </span>
                    {span.parentInferred && (
                      <span
                        className="hidden sm:inline-block shrink-0 text-[9px] px-1.5 py-0.5 rounded border border-amber-500/30 bg-amber-500/10 text-amber-400 font-semibold"
                        title="Parent link inferred by KubeVision: the eBPF collector could not capture the in-process call-site parent (known limitation on long-lived multiplexed HTTP/2/gRPC connections). This span was re-attached to its caller's hosting span by time-window adjacency — an inference, not an observation."
                      >
                        link inferred
                      </span>
                    )}
                    {span.rpcNameInferred && (
                      <span
                        className="hidden sm:inline-block shrink-0 text-[9px] px-1.5 py-0.5 rounded border border-amber-500/30 bg-amber-500/10 text-amber-400 font-semibold"
                        title="Method recovered by KubeVision: the eBPF collector could not decode this connection's HPACK-compressed gRPC path (the connection predates OBI, so the method never crossed the wire while OBI was attached). The method was copied from the opposite end of the same call in this trace — an inference, not an observation."
                      >
                        method inferred
                      </span>
                    )}
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
                    {inView && (
                      <div
                        style={{
                          left: `${leftPercent}%`,
                          width: `${widthPercent}%`,
                          minWidth: 2,
                        }}
                        className={`absolute h-4 rounded-md shadow-sm transition-all duration-150 ${
                          isError ? errorFill : sColor.bar
                        } group-hover:brightness-125 opacity-90`}
                      />
                    )}

                    {/* Duration Label */}
                    {inView && (
                      <span
                        style={
                          labelAfter
                            ? { left: `calc(${leftPercent}% + ${widthPercent}% + 8px)` }
                            : labelInside
                              ? { right: `${100 - endPercent}%`, paddingRight: 8 }
                              : { right: `${100 - leftPercent}%`, paddingRight: 8 }
                        }
                        className={`absolute text-[10px] font-mono whitespace-nowrap ${
                          labelInside ? 'text-white font-medium' : 'text-slate-400'
                        }`}
                      >
                        {formatNs(span.duration)}
                      </span>
                    )}
                  </div>
                </div>
              );
            })
          ) : (
            <div className="p-8 text-center text-slate-400 italic">No spans recorded for this trace.</div>
          )}
        </div>
      </div>
      )}

      {/* Span Details — right-docked panel so the waterfall stays visible */}
      {selectedSpan && (
        <SpanDetail
          span={selectedSpan}
          onClose={() => setSelectedSpan(null)}
          cascadeRole={cascade.roles.get(selectedSpan.spanId)}
          origin={cascade.origin}
          culprit={cascade.culprit}
          onSelectSpan={(span) => setSelectedSpan(span)}
        />
      )}

      {showRelatedLogs && (
        <TraceLogsPanel traceId={trace.traceId} onClose={() => setShowRelatedLogs(false)} />
      )}
    </div>
  );
};
