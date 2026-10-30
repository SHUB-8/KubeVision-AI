import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import dagre from '@dagrejs/dagre';
import {
  ReactFlow,
  MiniMap,
  Controls,
  Panel,
  Background,
  useNodesState,
  useEdgesState,
  MarkerType,
  Node as FlowNode,
  Edge as FlowEdge,
} from '@xyflow/react';
import { useApp } from '../../context/AppContext';
import { api } from '../../services/api';
import type { MetricSource } from '../../types/api';
import { ServiceNode } from './ServiceNode';

// Dagre layered layout with responsive direction and viewport-adaptive spacing.
// Automatically chooses horizontal (LR) or vertical (TB) based on container
// aspect ratio, scales spacing by zoom, and wraps isolated/orphan nodes into
// responsive grid rows under the main graph.
interface LayoutOptions {
  containerWidth?: number;
  containerHeight?: number;
  zoom?: number;
  direction?: 'LR' | 'TB' | 'auto';
}

function computeLayoutMap(
  ids: string[],
  conns: { source: string; target: string }[],
  options?: LayoutOptions,
  NODE_W = 248,
  NODE_H = 108
): { positions: Map<string, { x: number; y: number }>; direction: 'LR' | 'TB' } {
  const width = options?.containerWidth ?? (typeof window !== 'undefined' ? window.innerWidth : 1200);
  const height = options?.containerHeight ?? (typeof window !== 'undefined' ? window.innerHeight : 800);
  const zoom = Math.min(1.8, Math.max(0.35, options?.zoom ?? 1));

  // Determine direction:
  // Auto picks 'TB' if container is taller than wide (aspect ratio < 1.05) or narrow (< 850px), else 'LR'
  let direction: 'LR' | 'TB';
  if (options?.direction && options.direction !== 'auto') {
    direction = options.direction;
  } else {
    direction = (height > width * 0.95 || width < 850) ? 'TB' : 'LR';
  }

  // Adaptive spacing scaled by viewport size & zoom
  const zoomScale = 0.85 + 0.15 * Math.min(1.5, Math.max(0.6, zoom));
  const nodesep = Math.round((direction === 'LR' ? 48 : 56) * zoomScale);
  const ranksep = Math.round((direction === 'LR' ? 104 : 76) * zoomScale);

  const g = new dagre.graphlib.Graph();
  g.setGraph({
    rankdir: direction,
    nodesep,
    ranksep,
    edgesep: 24,
    marginx: 36,
    marginy: 36,
  });
  g.setDefaultEdgeLabel(() => ({}));

  ids.forEach((id) => g.setNode(id, { width: NODE_W, height: NODE_H }));
  conns.forEach((c) => {
    if (g.hasNode(c.source) && g.hasNode(c.target)) {
      g.setEdge(c.source, c.target);
    }
  });
  dagre.layout(g);

  const connected = new Set<string>();
  conns.forEach((c) => {
    connected.add(c.source);
    connected.add(c.target);
  });
  const orphans = ids.filter((id) => !connected.has(id));

  let mainMinX = Infinity;
  let mainMaxX = -Infinity;
  let mainMinY = Infinity;
  let mainMaxY = -Infinity;

  ids.forEach((id) => {
    if (connected.has(id)) {
      const p = g.node(id);
      if (p) {
        mainMinX = Math.min(mainMinX, p.x - NODE_W / 2);
        mainMaxX = Math.max(mainMaxX, p.x + NODE_W / 2);
        mainMinY = Math.min(mainMinY, p.y - NODE_H / 2);
        mainMaxY = Math.max(mainMaxY, p.y + NODE_H / 2);
      }
    }
  });

  if (mainMinX === Infinity) {
    mainMinX = 36;
    mainMaxX = 36 + NODE_W;
    mainMinY = 36;
    mainMaxY = 36 + NODE_H;
  }

  const positions = new Map<string, { x: number; y: number }>();
  ids.forEach((id) => {
    const p = g.node(id);
    positions.set(id, { x: (p?.x ?? 0) - NODE_W / 2, y: (p?.y ?? 0) - NODE_H / 2 });
  });

  // Responsive Grid for Isolated / Orphan Nodes:
  // Instead of an infinite horizontal line, wrap orphans into grid rows that
  // fit within the available width of the main graph or viewport.
  if (orphans.length > 0) {
    const orphanGapX = 24;
    const orphanGapY = 24;
    const slotW = NODE_W + orphanGapX;
    const slotH = NODE_H + orphanGapY;

    const effectiveContainerWidth = width / zoom;
    const targetWidth = Math.max(mainMaxX - mainMinX, Math.min(effectiveContainerWidth * 0.9, slotW * 4));
    const maxCols = Math.max(1, Math.min(orphans.length, Math.floor((targetWidth + orphanGapX) / slotW)));

    const orphanStartY = mainMaxY + 72;
    const orphanStartX = mainMinX;

    orphans.forEach((id, i) => {
      const col = i % maxCols;
      const row = Math.floor(i / maxCols);
      positions.set(id, {
        x: orphanStartX + col * slotW,
        y: orphanStartY + row * slotH,
      });
    });
  }

  return { positions, direction };
}
import { NodeDetailPanel } from './NodeDetailPanel';
import { LoadingSpinner } from '../common/LoadingSpinner';
import { EmptyState } from '../common/EmptyState';
import {
  Search,
  Filter,
  Maximize2,
  RefreshCw,
  Zap,
  Layers,
  ArrowRight,
} from 'lucide-react';

const nodeTypes: any = {
  serviceNode: ServiceNode,
};

export const DependencyGraph: React.FC = () => {
  const { activeNamespace, timeWindow, refreshCount } = useApp();
  const [nodes, setNodes, onNodesChange] = useNodesState<any>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<any>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [filterQuery, setFilterQuery] = useState<string>('');
  const [layoutDirection, setLayoutDirection] = useState<'LR' | 'TB'>('LR');
  // Edge traffic animation: edges with a measured request rate animate by
  // default (the pre-existing behavior); the toggle switches motion off.
  const [showTrafficAnim, setShowTrafficAnim] = useState<boolean>(true);
  const containerRef = useRef<HTMLDivElement>(null);
  const flowInstanceRef = useRef<any>(null);
  // Layout stability across refreshes: the structure key decides when the
  // graph may re-layout, and the ref carries the live LR/TB choice into the
  // fetch callback without making it a dependency.
  const structureKeyRef = useRef<string | null>(null);
  const layoutDirectionRef = useRef<'LR' | 'TB'>('LR');

  const getContainerSize = useCallback(() => {
    if (containerRef.current) {
      const { clientWidth, clientHeight } = containerRef.current;
      if (clientWidth > 0 && clientHeight > 0) {
        return { width: clientWidth, height: clientHeight };
      }
    }
    return {
      width: typeof window !== 'undefined' ? window.innerWidth : 1200,
      height: typeof window !== 'undefined' ? window.innerHeight : 800,
    };
  }, []);

  const fetchTopologyData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [topoData, servicesData] = await Promise.all([
        api.getTopology(activeNamespace, timeWindow),
        api.getServices(activeNamespace, timeWindow),
      ]);

      const serviceMap = new Map(servicesData.map((s) => [s.name, s]));

      const rawNodes = topoData.nodes || [];
      const rawEdges = topoData.edges || [];

      // A refresh must not reshuffle the graph: layout (and the auto
      // LR/TB choice) recompute only when the node/edge STRUCTURE changes.
      // Pure metric updates keep every node exactly where it was — including
      // anywhere the user dragged it.
      const structureKey = JSON.stringify([
        ...rawNodes.map((n) => n.id).sort(),
        ...rawEdges.map((e) => `${e.source}->${e.target}`).sort(),
      ]);
      const structureChanged = structureKey !== structureKeyRef.current;

      // Layout: responsive adaptive dagre layout based on container dimensions
      let positions = new Map<string, { x: number; y: number }>();
      if (structureChanged) {
        structureKeyRef.current = structureKey;
        const { width, height } = getContainerSize();
        const layout = computeLayoutMap(
          rawNodes.map((n) => n.id),
          rawEdges.map((e) => ({ source: e.source, target: e.target })),
          { containerWidth: width, containerHeight: height, zoom: 1, direction: 'auto' }
        );
        positions = layout.positions;
        layoutDirectionRef.current = layout.direction;
        setLayoutDirection(layout.direction);
      }

      // Isolated services (no peer telemetry) are moved out of the flow
      // columns by computeLayoutMap — a disconnected node mid-column reads
      // as a layout bug.
      const connectedSet = new Set<string>();
      rawEdges.forEach((e) => {
        connectedSet.add(e.source);
        connectedSet.add(e.target);
      });
      const orphans = rawNodes.filter((n) => !connectedSet.has(n.id));
      const orphanSet = new Set(orphans.map((n) => n.id));

            const flowNodes: FlowNode[] = rawNodes.map((node) => {
        const svc = serviceMap.get(node.id);
        const pos = positions.get(node.id) ?? { x: 0, y: 0 };

        // Never coalesce an absent value to 0: undefined means "not measured"
        // and must stay distinguishable from a measured zero on the card.
        const rate = node.rate || svc?.rate || undefined;
        const rateSource: MetricSource | undefined = node.rate
          ? node.rateSource
          : rate
            ? 'metrics'
            : undefined;
        const latencyP95 = node.latencyP95 || svc?.latencyP95 || undefined;
        const latencySource: MetricSource | undefined = node.latencyP95
          ? node.latencySource
          : latencyP95
            ? 'metrics'
            : undefined;

        return {
          id: node.id,
          type: 'serviceNode',
          position: { x: pos.x, y: pos.y },
          data: {
            label: node.label || node.id,
            type: node.type,
            namespace: node.namespace || activeNamespace,
            rate,
            errorRate: node.errorRate ?? svc?.errorRate ?? undefined,
            latencyP95,
            rateSource,
            latencySource,
            status: svc?.status || 'Running',
            replicas: svc?.replicas,
            ready: svc?.ready,
          },
        };
      });

      const flowEdges: FlowEdge[] = rawEdges.map((edge) => {
        const hasErrors = (edge.errorRate || 0) > 0.01;
        const strokeColor = edge.inferred ? '#475569' : hasErrors ? '#f43f5e' : '#06b6d4';

        let edgeLabel = '';
        if (edge.inferred) {
          edgeLabel = 'static map';
        } else {
          const parts: string[] = [];
          if (edge.protocol) parts.push(edge.protocol);
          // "(est.)" flags a rate inferred from a peer's traffic rather than
          // observed on this link - it must not read as measured.
          if (edge.rate && edge.rate > 0) {
            parts.push(`${edge.rate.toFixed(1)} req/s${edge.rateSource === 'estimated' ? ' (est.)' : ''}`);
          }
          if (edge.latencyP95 && edge.latencyP95 > 0) parts.push(`${(edge.latencyP95 * 1000).toFixed(1)}ms`);
          if (edge.errorRate && edge.errorRate > 0) parts.push(`${(edge.errorRate * 100).toFixed(1)}% err`);
          edgeLabel = parts.join(' • ');
        }

        return {
          id: edge.id,
          source: edge.source,
          target: edge.target,
          sourceHandle: layoutDirectionRef.current === 'LR' ? 'source-right' : 'source-bottom',
          targetHandle: layoutDirectionRef.current === 'LR' ? 'target-left' : 'target-top',
          // Solid line; dashed is reserved for static-map links. Edges with a
          // measured request rate animate by default (traffic-as-data); the
          // Traffic toggle switches the motion off.
          animated: showTrafficAnim && !edge.inferred && (edge.rate || 0) > 0,
          style: {
            stroke: strokeColor,
            strokeWidth: hasErrors ? 2.5 : 1.8,
            strokeDasharray: edge.inferred ? '2 4' : undefined,
          },
          // Protocol/rate labels render on every edge (user preference) —
          // they hide only while focus-mode dims non-adjacent edges.
          label: edgeLabel,
          labelStyle: {
            fill: edge.inferred ? '#8b98ad' : hasErrors ? '#f8a199' : '#38bdf8',
            fontSize: 11,
            fontFamily: '"IBM Plex Mono", "JetBrains Mono", monospace',
            fontWeight: 600,
          },
          labelBgStyle: {
            fill: '#090d16',
            fillOpacity: 0.95,
            stroke: hasErrors ? '#f43f5e' : '#1e293b',
            strokeWidth: 1,
          },
          labelBgPadding: [6, 3],
          labelBgBorderRadius: 4,
          markerEnd: {
            type: MarkerType.ArrowClosed,
            width: 14,
            height: 14,
            color: strokeColor,
          },
          // Kept off React Flow's schema — display-layer metadata for the
          // hover/selection label logic in displayedEdges.
          _label: edgeLabel,
          _hasErrors: hasErrors,
          _inferred: !!edge.inferred,
        } as any;
      });


      // Merge instead of replace: fresh metrics land on the SAME node objects
      // (positions preserved — including user drags — when structure unchanged).
      setNodes((prev: any[]) => {
        const prevById = new Map(prev.map((n) => [n.id, n]));
        return flowNodes.map((fn) => {
          const prevNode = prevById.get(fn.id);
          const position = positions.get(fn.id) ?? prevNode?.position ?? fn.position;
          return prevNode ? { ...fn, position } : fn;
        });
      });
      setEdges(flowEdges);
      if (structureChanged) {
        setTimeout(() => {
          flowInstanceRef.current?.fitView({ padding: 0.15, maxZoom: 1, duration: 350 });
        }, 50);
      }
    } catch (err: any) {
      console.error('Error fetching topology:', err);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [activeNamespace, timeWindow, setNodes, setEdges, getContainerSize]);

  useEffect(() => {
    fetchTopologyData();
  }, [fetchTopologyData, refreshCount]);

  const onNodeClick = (_: React.MouseEvent, node: FlowNode) => {
    setSelectedNodeId(node.id);
  };

  const filteredNodes = useMemo(() => {
    if (!filterQuery.trim()) return nodes;
    const query = filterQuery.toLowerCase();
    return nodes.map((node) => ({
      ...node,
      hidden: !node.id.toLowerCase().includes(query) && !((node.data as any)?.label || '').toLowerCase().includes(query),
    }));
  }, [nodes, filterQuery]);

  // Focus mode: hovering (or selecting) a node dims everything that is not
  // part of its immediate in/out edges — the fastest way to answer "what
  // does this service talk to".
  const activeId = hoveredId ?? selectedNodeId;
  const neighborIds = useMemo(() => {
    if (!activeId) return null;
    const s = new Set<string>([activeId]);
    edges.forEach((e: any) => {
      if (e.source === activeId) s.add(e.target);
      if (e.target === activeId) s.add(e.source);
    });
    return s;
  }, [activeId, edges]);

  const displayedNodes = useMemo(() => {
    if (!neighborIds) return filteredNodes;
    return filteredNodes.map((n: any) => ({
      ...n,
      style: { ...(n.style || {}), opacity: neighborIds.has(n.id) ? 1 : 0.3 },
    }));
  }, [filteredNodes, neighborIds]);

  const displayedEdges = useMemo(() => {
    const stripLabel = (e: any) => ({
      ...e,
      label: undefined,
      labelStyle: undefined,
      labelBgStyle: undefined,
    });
    if (!activeId) {
      // Idle: every edge shows its protocol/rate label (user preference).
      return edges;
    }
    return edges.map((e: any) => {
      const keep = e.source === activeId || e.target === activeId;
      if (!keep) {
        return { ...stripLabel(e), style: { ...(e.style || {}), opacity: 0.06 } };
      }
      return { ...e, label: e._label ?? e.label };
    });
  }, [edges, activeId]);

  const orphanCount = useMemo(
    () => nodes.filter((n: any) => !edges.some((e: any) => e.source === n.id || e.target === n.id)).length,
    [nodes, edges]
  );

  if (loading && nodes.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center min-h-[600px]">
        <LoadingSpinner message="Loading topology…" size="lg" />
      </div>
    );
  }

  if (error && nodes.length === 0) {
    return (
      <div className="p-8">
        <EmptyState
          title="Could not load topology"
          description={error}
          actionText="Retry"
          onAction={fetchTopologyData}
        />
      </div>
    );
  }

  return (
    <div className="relative w-full h-full min-h-[480px] bg-slate-950 overflow-hidden flex flex-col">
      {/* Top Overlay Controls Bar */}
      <div className="absolute top-4 left-4 z-20 flex items-center gap-3">
        {/* Search filter */}
        <div className="relative">
          <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            type="text"
            placeholder="Search service..."
            value={filterQuery}
            onChange={(e) => setFilterQuery(e.target.value)}
            className="w-56 pl-8 pr-3 py-1.5 rounded-md bg-slate-900/90 border border-slate-700/80 text-xs text-slate-200 placeholder:text-slate-400 focus:outline-none focus:border-cyan-500 font-mono"
          />
        </div>

        {/* Legend — every visual encoding explained (Kiali practice) */}
        <div className="hidden md:flex items-center gap-3 px-3 py-1.5 rounded-md bg-slate-900/80 border border-slate-700/70 text-[11px] font-mono">
          <div className="flex items-center gap-1.5">
            <span className="w-4 h-0 border-t-2 border-cyan-400" />
            <span className="text-slate-300">Live traffic</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="w-4 h-0 border-t-2 border-rose-500" />
            <span className="text-slate-300">Errors (&gt;1%)</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="w-4 h-0 border-t-2 border-dashed border-slate-500" />
            <span className="text-slate-300">Static map</span>
          </div>
        </div>

        {/* Traffic animation: edges with measured rate animate; toggle switches motion off */}
        <button
          onClick={() => setShowTrafficAnim((v) => !v)}
          className={`hidden sm:flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border text-[11px] font-mono transition ${
            showTrafficAnim
              ? 'bg-cyan-500/15 border-cyan-500/40 text-cyan-300'
              : 'bg-slate-900/90 hover:bg-slate-800 border-slate-700/80 text-slate-300 hover:text-cyan-400'
          }`}
          title="Animate edges that carry a measured request rate"
        >
          <Zap className="w-3.5 h-3.5" />
          <span>{showTrafficAnim ? 'Traffic: On' : 'Traffic: Off'}</span>
        </button>
      </div>

      {/* React Flow Viewport */}
      <div ref={containerRef} className="flex-1 w-full h-full relative">
        {nodes.length === 0 ? (
          <EmptyState
            title="No Services Discovered"
            description={`No microservices with active traffic found in namespace "${activeNamespace}".`}
            actionText="Refresh"
            onAction={fetchTopologyData}
          />
        ) : (
          <ReactFlow
            nodes={displayedNodes}
            edges={displayedEdges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onNodeClick={onNodeClick}
            onNodeMouseEnter={(_, node) => setHoveredId(node.id)}
            onNodeMouseLeave={() => setHoveredId(null)}
            nodeTypes={nodeTypes as any}
            fitView
            onInit={(instance) => {
              flowInstanceRef.current = instance;
            }}
            fitViewOptions={{ padding: 0.15, maxZoom: 1 }}
            minZoom={0.35}
            maxZoom={1.8}
            className="bg-[#090d16]"
          >
            <Background color="#1e293b" gap={24} size={1} />
            {orphanCount > 0 && (
              <Panel position="bottom-center" className="!text-[10px] font-mono text-slate-500">
                isolated · no eBPF peer telemetry
              </Panel>
            )}
            <Controls className="!bg-slate-900/90 !border !border-slate-700 !rounded-md overflow-hidden" />
            <MiniMap
              nodeStrokeWidth={3}
              zoomable
              pannable
              className="!bg-slate-900/90 !border !border-slate-800 !rounded-md overflow-hidden"
              nodeColor={(node: any) => {
                if ((node.data?.errorRate || 0) > 0.01) return '#f43f5e';
                return '#06b6d4';
              }}
              maskColor="rgba(9, 13, 22, 0.75)"
            />
          </ReactFlow>
        )}
      </div>

      {/* Side Detail Panel */}
      {(() => {
        const selected = nodes.find((node) => node.id === selectedNodeId);
        if (!selected || selected.data?.type !== 'service') return null;
        return (
          <NodeDetailPanel
            serviceName={selected.id}
            onClose={() => setSelectedNodeId(null)}
            stats={{
              errorRate: selected.data?.errorRate,
              latencyP95: selected.data?.latencyP95,
              rate: selected.data?.rate,
            }}
          />
        );
      })()}
    </div>
  );
};
