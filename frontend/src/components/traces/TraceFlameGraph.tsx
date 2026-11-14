import React, { useCallback, useMemo, useState } from 'react';
import { Trace, Span } from '../../types/api';
import { formatNs } from '../../lib/format';
import { serviceStep } from '../../lib/serviceColor';
import { isFailingSpan } from '../../lib/trace';
import type { CascadeInfo } from '../../lib/cascade';
import { Search, RotateCcw, ChevronRight, X } from 'lucide-react';

interface TraceFlameGraphProps {
  trace: Trace;
  /** Cascade attribution from the parent, so both layouts mark the same origin. */
  cascade?: CascadeInfo;
  selectedSpanId?: string;
  onSelectSpan: (span: Span) => void;
}

interface FlameNode {
  span: Span;
  depth: number;
  leftPct: number;
  widthPct: number;
  selfTimeNs: number;
  /** Sub-row inside its depth, assigned by lane packing (see below). */
  lane: number;
  children: FlameNode[];
  parent?: FlameNode;
}

/** One depth level, packed into as many lanes as overlaps demand. */
interface FlameRow {
  nodes: FlameNode[];
  lanes: number;
}

const ROW_H = 24;
const BAR_H = 22;

/**
 * Fill styles for the one accent hue at eight lightness steps — the same
 * `seq-*` tokens and the same service→step mapping the waterfall uses, so a
 * service keeps its shade when you switch layouts. Text flips to ink on the
 * three lightest steps so every label clears AA contrast.
 */
const STEP_STYLES = [
  { bg: 'bg-seq-1', border: 'border-seq-1/70', text: 'text-slate-950' },
  { bg: 'bg-seq-2', border: 'border-seq-2/70', text: 'text-slate-950' },
  { bg: 'bg-seq-3', border: 'border-seq-3/70', text: 'text-slate-950' },
  { bg: 'bg-seq-4', border: 'border-seq-4/70', text: 'text-white' },
  { bg: 'bg-seq-5', border: 'border-seq-5/70', text: 'text-white' },
  { bg: 'bg-seq-6', border: 'border-seq-6/70', text: 'text-white' },
  { bg: 'bg-seq-7', border: 'border-seq-7/70', text: 'text-white' },
  { bg: 'bg-seq-8', border: 'border-seq-8/70', text: 'text-white' },
];

// Status outranks identity: an error span must never look like a healthy one.
// The origin of a cascade is solid; spans that only inherited it are dimmed.
const ERROR_STYLE = { bg: 'bg-rose-600', border: 'border-rose-300', text: 'text-white' };
const ERROR_INHERITED_STYLE = { bg: 'bg-rose-600/45', border: 'border-rose-400/60', text: 'text-white' };
const NEUTRAL_STYLE = { bg: 'bg-slate-700', border: 'border-slate-500', text: 'text-slate-100' };

const styleFor = (serviceName: string) => {
  const step = serviceStep(serviceName);
  if (step === 0) return NEUTRAL_STYLE;
  // A bar is a solid block, not a tint: clamp the two lightest steps upward so
  // no fill reads as "near-white" (which would collide with the search-match
  // outline) while keeping the same hue and ordering as the waterfall chips.
  return STEP_STYLES[Math.max(step, 3) - 1];
};

const AXIS_TICKS = [0, 0.25, 0.5, 0.75, 1];
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** Zero is exactly zero; everything else keeps the sub-millisecond precision. */
const axisLabel = (ns: number) => (ns <= 0 ? '0' : formatNs(ns));

export const TraceFlameGraph: React.FC<TraceFlameGraphProps> = ({
  trace,
  cascade,
  selectedSpanId,
  onSelectSpan,
}) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [hoveredNode, setHoveredNode] = useState<FlameNode | null>(null);
  const [pointer, setPointer] = useState<{ x: number; y: number } | null>(null);
  const [pinnedId, setPinnedId] = useState<string | null>(null);
  const [zoomRootId, setZoomRootId] = useState<string | null>(null);

  const { flameRows, windowNs, traceNs, nodeMap, errorCount } = useMemo(() => {
    const spans = trace.spans ?? [];
    if (spans.length === 0) {
      return {
        flameRows: [] as FlameRow[],
        windowNs: 1,
        traceNs: 1,
        nodeMap: new Map<string, FlameNode>(),
        errorCount: 0,
      };
    }

    let minStart = Infinity;
    let maxEnd = -Infinity;
    const spanMap = new Map<string, Span>();
    const childrenMap = new Map<string, Span[]>();

    for (const span of spans) {
      spanMap.set(span.spanId, span);
      const end = span.startTime + (span.duration || 250_000);
      if (span.startTime < minStart) minStart = span.startTime;
      if (end > maxEnd) maxEnd = end;
      const key = span.parentSpanId || '__root__';
      const list = childrenMap.get(key) ?? [];
      list.push(span);
      childrenMap.set(key, list);
    }

    const traceNs = Math.max(1, maxEnd - minStart);
    const roots = spans.filter((s) => !s.parentSpanId || !spanMap.has(s.parentSpanId));
    if (roots.length === 0) roots.push(spans[0]);
    roots.sort((a, b) => a.startTime - b.startTime);

    const zoomSpan = zoomRootId ? spanMap.get(zoomRootId) : undefined;
    const windowStart = zoomSpan ? zoomSpan.startTime : minStart;
    const windowNs = zoomSpan ? Math.max(1, zoomSpan.duration) : traceNs;

    const rows: FlameNode[][] = [];
    const nodeMap = new Map<string, FlameNode>();
    const visited = new Set<string>();
    let errorCount = 0;

    const build = (
      span: Span,
      depth: number,
      parent?: FlameNode,
      parentStart?: number
    ): FlameNode | null => {
      if (visited.has(span.spanId) || depth > 40) return null;
      visited.add(span.spanId);

      const dur = span.duration > 0 ? span.duration : 250_000;
      // Clock-skew guard, same rule as the waterfall: a child cannot begin
      // before its caller, so both layouts agree on where a span starts.
      const start =
        parentStart !== undefined && span.startTime < parentStart ? parentStart : span.startTime;
      const leftPct = clamp(((start - windowStart) / windowNs) * 100, 0, 100);
      const widthPct = clamp((dur / windowNs) * 100, 0.2, 100 - leftPct);

      const node: FlameNode = {
        span,
        depth,
        leftPct,
        widthPct,
        selfTimeNs: dur,
        lane: 0, // assigned when the row is packed
        children: [],
        parent,
      };
      nodeMap.set(span.spanId, node);

      const children = [...(childrenMap.get(span.spanId) ?? [])].sort(
        (a, b) => a.startTime - b.startTime
      );
      let childTotal = 0;
      for (const child of children) {
        const childNode = build(child, depth + 1, node, start);
        if (childNode) {
          childTotal += child.duration;
          node.children.push(childNode);
        }
      }
      node.selfTimeNs = Math.max(0, dur - childTotal);
      if (span.statusCode && !span.statusCode.includes('OK')) errorCount += 1;

      (rows[depth] ??= []).push(node);
      return node;
    };

    if (zoomSpan) build(zoomSpan, 0);
    else for (const root of roots) build(root, 0);

    // Sibling spans can overlap in time — the collector reports both ends of
    // the same RPC, and inferred parent links re-attach a server span to its
    // caller's hosting span. Painting one row per depth made the later bar
    // cover the earlier one's label, which is why labels appeared to start
    // mid-word. Pack each row into lanes so no bar can ever occlude another.
    const packedRows: FlameRow[] = rows.map((row) => {
      const ordered = [...row].sort((a, b) => a.leftPct - b.leftPct || b.widthPct - a.widthPct);
      const laneEnds: number[] = [];
      for (const node of ordered) {
        const end = node.leftPct + node.widthPct;
        let lane = laneEnds.findIndex((laneEnd) => laneEnd <= node.leftPct + 0.001);
        if (lane === -1) {
          lane = laneEnds.length;
          laneEnds.push(end);
        } else {
          laneEnds[lane] = end;
        }
        node.lane = lane;
      }
      return { nodes: ordered, lanes: Math.max(1, laneEnds.length) };
    });

    return { flameRows: packedRows, windowNs, traceNs, nodeMap, errorCount };
  }, [trace, zoomRootId]);

  const searchActive = searchTerm.trim() !== '';

  const matchCount = useMemo(() => {
    const term = searchTerm.trim().toLowerCase();
    if (!term) return 0;
    let count = 0;
    for (const row of flameRows) {
      for (const node of row.nodes) {
        if (
          node.span.serviceName.toLowerCase().includes(term) ||
          node.span.operationName.toLowerCase().includes(term)
        ) {
          count += 1;
        }
      }
    }
    return count;
  }, [flameRows, searchTerm]);

  const breadcrumbs = useMemo(() => {
    if (!zoomRootId) return [] as FlameNode[];
    const crumbs: FlameNode[] = [];
    let cursor: FlameNode | undefined = nodeMap.get(zoomRootId);
    while (cursor) {
      crumbs.unshift(cursor);
      cursor = cursor.parent;
    }
    return crumbs;
  }, [zoomRootId, nodeMap]);

  const handlePointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    setPointer({ x: event.clientX, y: event.clientY });
  }, []);

  const pinnedNode = pinnedId ? nodeMap.get(pinnedId) ?? null : null;
  // A span opened in the detail drawer stays highlighted, even from the
  // waterfall view, so switching layouts never loses the selection.
  const highlightedId = pinnedId ?? selectedSpanId ?? null;
  const percentOfTrace = (node: FlameNode) => ((node.span.duration / traceNs) * 100).toFixed(1);

  return (
    <div className="space-y-3 font-mono">
      {/* One control. The trace's own numbers already live in the page header,
          so the graph does not restate depth/span/window counts here. */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-full sm:w-80">
          <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            type="text"
            placeholder="Search service or operation…"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            aria-label="Search spans by service or operation"
            className="w-full pl-8 pr-14 py-1.5 rounded-md bg-slate-800/80 border border-slate-700 text-xs text-slate-200 placeholder:text-slate-400 focus:outline-none focus:border-cyan-500"
          />
          {searchActive && (
            <>
              <span
                className="absolute right-7 top-1/2 -translate-y-1/2 text-[10px] text-slate-400 tabular-nums"
                title={`${matchCount} matching span${matchCount === 1 ? '' : 's'}`}
              >
                {matchCount}
              </span>
              <button
                onClick={() => setSearchTerm('')}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 p-0.5 rounded-sm text-slate-400 hover:text-slate-200"
                aria-label="Clear search"
              >
                <X className="w-3 h-3" />
              </button>
            </>
          )}
        </div>

        {zoomRootId && (
          <button
            onClick={() => setZoomRootId(null)}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md bg-slate-800 hover:bg-slate-700 border border-slate-700 text-xs text-slate-300 hover:text-white transition-colors"
            title="Reset zoom to the whole trace"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            Reset zoom
          </button>
        )}
      </div>

      {breadcrumbs.length > 0 && (
        <div className="flex items-center gap-1 px-1 text-[11px] text-slate-400 overflow-x-auto">
          <button
            onClick={() => setZoomRootId(null)}
            className="shrink-0 hover:text-cyan-300 transition-colors"
          >
            trace
          </button>
          {breadcrumbs.map((crumb, idx) => (
            <React.Fragment key={crumb.span.spanId}>
              <ChevronRight className="w-3 h-3 text-slate-600 shrink-0" />
              <button
                onClick={() => setZoomRootId(crumb.span.spanId)}
                className={`truncate max-w-[220px] shrink-0 ${
                  idx === breadcrumbs.length - 1
                    ? 'text-cyan-300 font-semibold cursor-default'
                    : 'text-slate-300 hover:text-cyan-300 transition-colors'
                }`}
                title={`${crumb.span.serviceName}: ${crumb.span.operationName}`}
              >
                {crumb.span.serviceName}
              </button>
            </React.Fragment>
          ))}
        </div>
      )}

      {/* Canvas: axis, guides and bars share one min-width wrapper, so they stay
          registered with each other when the graph scrolls horizontally. */}
      <div
        onPointerMove={handlePointerMove}
        onPointerLeave={() => {
          setHoveredNode(null);
          setPointer(null);
        }}
        role="group"
        aria-label="Flame graph of trace spans"
        className="relative rounded-md border border-slate-800 bg-slate-950/60 p-4 overflow-x-auto select-none"
      >
        <div className="relative min-w-[760px]">
          <div className="relative h-5 mb-2 border-b border-slate-800 text-[10px] text-slate-400">
            {AXIS_TICKS.map((t, idx) => {
              const first = idx === 0;
              const last = idx === AXIS_TICKS.length - 1;
              // Edge labels align to their own edge instead of centring, which
              // is what clipped "0" and the right-hand duration before.
              const style: React.CSSProperties = first
                ? { left: 0 }
                : last
                  ? { right: 0 }
                  : { left: `${t * 100}%`, transform: 'translateX(-50%)' };
              return (
                <span key={t} className="absolute top-0 whitespace-nowrap" style={style}>
                  {axisLabel(windowNs * t)}
                </span>
              );
            })}
          </div>

          <div className="relative">
            {[25, 50, 75].map((t) => (
              <div
                key={t}
                className="absolute inset-y-0 w-px border-l border-dashed border-slate-800/70 pointer-events-none"
                style={{ left: `${t}%` }}
              />
            ))}

            <div className="relative">
              {flameRows.map((row, depth) => (
                <div key={depth} className="relative" style={{ height: row.lanes * ROW_H }}>
                  {row.nodes.map((node) => {
                    const isPinned = highlightedId === node.span.spanId;
                    const isError = isFailingSpan(node.span);
                    const errorRole = cascade?.roles.get(node.span.spanId);
                    const term = searchTerm.trim().toLowerCase();
                    const isMatch =
                      term !== '' &&
                      (node.span.serviceName.toLowerCase().includes(term) ||
                        node.span.operationName.toLowerCase().includes(term));
                    const dimmed = term !== '' && !isMatch;
                    const style = isError
                      ? errorRole === 'propagated'
                        ? ERROR_INHERITED_STYLE
                        : ERROR_STYLE
                      : styleFor(node.span.serviceName);

                    return (
                      <button
                        key={node.span.spanId}
                        type="button"
                        aria-pressed={isPinned}
                        aria-label={`${node.span.serviceName}: ${node.span.operationName} — ${formatNs(node.span.duration)}`}
                        onClick={() => setPinnedId(node.span.spanId)}
                        onDoubleClick={() => {
                          setZoomRootId(node.span.spanId);
                          setPinnedId(null);
                        }}
                        onMouseEnter={() => setHoveredNode(node)}
                        style={{
                          left: `${node.leftPct}%`,
                          width: `${node.widthPct}%`,
                          top: node.lane * ROW_H,
                          height: BAR_H,
                        }}
                        className={`absolute flex items-center gap-1 overflow-hidden rounded-[2px] border px-1.5 text-left text-[10px] cursor-pointer transition-[filter,box-shadow] duration-150 hover:brightness-110 ${style.bg} ${style.border} ${style.text} ${
                          isPinned ? 'ring-2 ring-cyan-400 z-20' : 'z-10'
                        } ${dimmed ? 'opacity-25' : ''} ${
                          isMatch ? 'outline outline-1 outline-slate-100/80 z-20' : ''
                        }`}
                      >
                        {/* Label steps down with the bar instead of truncating
                            everything to the same useless fragment. */}
                        {node.widthPct >= 4 && (
                          <span className="truncate font-medium">
                            {node.widthPct >= 12 ? (
                              <>
                                <span className="font-semibold">{node.span.serviceName}</span>
                                <span className="opacity-75">: {node.span.operationName}</span>
                              </>
                            ) : node.widthPct >= 7 ? (
                              node.span.operationName
                            ) : (
                              node.span.serviceName
                            )}
                          </span>
                        )}
                        {node.widthPct >= 16 && (
                          <span className="ml-auto shrink-0 text-[9px] font-semibold tabular-nums opacity-85">
                            {formatNs(node.span.duration)}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
          </div>
        </div>

        {flameRows.length === 0 && (
          <div className="p-8 text-center text-xs text-slate-400 italic">
            No spans recorded for this trace.
          </div>
        )}

        {/* Cursor tooltip. Fixed positioning keeps it clear of the horizontal
            scroll container; it is clamped so it never leaves the viewport. */}
        {hoveredNode && pointer && (
          <div
            className="pointer-events-none fixed z-50 max-w-xs rounded-md border border-slate-700 bg-slate-900 p-2.5 text-xs text-slate-100"
            style={{
              left: clamp(pointer.x + 14, 8, window.innerWidth - 300),
              top: clamp(pointer.y + 14, 8, window.innerHeight - 190),
            }}
          >
            <div className="flex items-center justify-between gap-3 border-b border-slate-800 pb-1.5 mb-1.5">
              <span className="font-semibold text-cyan-300 truncate">
                {hoveredNode.span.serviceName}
              </span>
              <span className="text-[10px] text-slate-400 tabular-nums shrink-0">
                {percentOfTrace(hoveredNode)}% of trace
              </span>
            </div>
            <div className="text-[11px] font-medium text-slate-200 mb-1.5 break-all">
              {hoveredNode.span.operationName}
            </div>
            {hoveredNode.span.statusCode && !hoveredNode.span.statusCode.includes('OK') && (
              <div className="mb-1.5 text-[10px]">
                {cascade?.roles.get(hoveredNode.span.spanId) === 'propagated' ? (
                  <span className="text-rose-300/80">inherited failure</span>
                ) : (
                  <span className="text-rose-300">failure origin</span>
                )}
              </div>
            )}
            <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[10px] text-slate-400">
              <div>
                Total <span className="text-slate-100 font-semibold">{formatNs(hoveredNode.span.duration)}</span>
              </div>
              <div>
                Self <span className="text-slate-100 font-semibold">{formatNs(hoveredNode.selfTimeNs)}</span>
              </div>
              {hoveredNode.span.podName && (
                <div className="col-span-2 truncate">
                  Pod <span className="text-slate-300">{hoveredNode.span.podName}</span>
                </div>
              )}
            </div>
            <div className="mt-1.5 pt-1.5 border-t border-slate-800 text-[9px] text-slate-400">
              click to pin · double-click to zoom
            </div>
          </div>
        )}
      </div>

      {errorCount > 0 && (
        <div
          className="flex items-center gap-1.5 px-1 text-[10px] text-slate-400"
          title="Spans whose recorded status is not OK"
        >
          <span className="h-2 w-2 rounded-[1px] bg-rose-600" />
          error span
        </div>
      )}

      {/* Pinned span. Rendered on click, never on hover: hovering across bars
          used to insert this card and shift the page under the cursor. */}
      {pinnedNode && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-slate-800 bg-slate-900/80 p-3 text-xs">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-1.5 min-w-0">
            <div className="min-w-0">
              <span className="text-[10px] text-slate-400 uppercase tracking-wider block">Service</span>
              <span className="text-cyan-300 font-semibold truncate block">
                {pinnedNode.span.serviceName}
              </span>
            </div>
            <div className="min-w-0">
              <span className="text-[10px] text-slate-400 uppercase tracking-wider block">Operation</span>
              <span
                className="text-slate-100 truncate block max-w-xs"
                title={pinnedNode.span.operationName}
              >
                {pinnedNode.span.operationName}
              </span>
            </div>
            <div>
              <span className="text-[10px] text-slate-400 uppercase tracking-wider block">Duration</span>
              <span className="text-slate-100 font-semibold">{formatNs(pinnedNode.span.duration)}</span>
            </div>
            <div>
              <span className="text-[10px] text-slate-400 uppercase tracking-wider block">Self time</span>
              <span className="text-slate-100 font-semibold">{formatNs(pinnedNode.selfTimeNs)}</span>
            </div>
            <div>
              <span className="text-[10px] text-slate-400 uppercase tracking-wider block">% of trace</span>
              <span className="text-slate-200 tabular-nums">{percentOfTrace(pinnedNode)}%</span>
            </div>
            {pinnedNode.span.podName && (
              <div className="min-w-0">
                <span className="text-[10px] text-slate-400 uppercase tracking-wider block">Pod</span>
                <span
                  className="text-slate-300 truncate block max-w-[160px]"
                  title={pinnedNode.span.podName}
                >
                  {pinnedNode.span.podName}
                </span>
              </div>
            )}
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => {
                setZoomRootId(pinnedNode.span.spanId);
                setPinnedId(null);
              }}
              className="px-2.5 py-1 rounded-sm border border-slate-700 bg-slate-800 text-slate-300 hover:text-white hover:bg-slate-700 text-[11px] font-semibold transition-colors"
              title="Zoom into this span's subtree"
            >
              Zoom subtree
            </button>
            <button
              onClick={() => onSelectSpan(pinnedNode.span)}
              className="px-2.5 py-1 rounded-sm bg-cyan-500 hover:bg-cyan-400 text-slate-950 text-[11px] font-semibold transition-colors"
            >
              Inspect span
            </button>
            <button
              onClick={() => setPinnedId(null)}
              className="p-1 rounded-sm text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition-colors"
              title="Unpin span"
              aria-label="Unpin span"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
