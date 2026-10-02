import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import dagre from '@dagrejs/dagre';
import { LayoutGrid } from 'lucide-react';
import {
  ReactFlow,
  MiniMap,
  Controls,
  ControlButton,
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
  const containerRef = useRef<HTMLDivElement>(null);
  const flowInstanceRef = useRef<any>(null);

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

      // Layout: responsive adaptive dagre layout based on container dimensions
      const { width, height } = getContainerSize();
      const { positions, direction } = computeLayoutMap(
        rawNodes.map((n) => n.id),
        rawEdges.map((e) => ({ source: e.source, target: e.target })),
        { containerWidth: width, containerHeight: height, zoom: 1, direction: 'auto' }
      );
      setLayoutDirection(direction);

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

        return {
          id: node.id,
          type: 'serviceNode',
          position: { x: pos.x, y: pos.y },
          data: {
            label: node.label || node.id,
            type: node.type,
            namespace: node.namespace || activeNamespace,
            rate: node.rate || svc?.rate || 0,
            errorRate: node.errorRate ?? svc?.errorRate ?? 0,
            latencyP95: node.latencyP95 || svc?.latencyP95 || 0,
            status: svc?.status || 'Running',
            replicas: svc?.replicas || 1,
            ready: svc?.ready || 1,
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
          if (edge.rate && edge.rate > 0) parts.push(`${edge.rate.toFixed(1)} req/s`);
          if (edge.latencyP95 && edge.latencyP95 > 0) parts.push(`${(edge.latencyP95 * 1000).toFixed(1)}ms`);
          if (edge.errorRate && edge.errorRate > 0) parts.push(`${(edge.errorRate * 100).toFixed(1)}% err`);
          edgeLabel = parts.join(' • ');
        }

        return {
          id: edge.id,
          source: edge.source,
          target: edge.target,
          sourceHandle: direction === 'LR' ? 'source-right' : 'source-bottom',
          targetHandle: direction === 'LR' ? 'target-left' : 'target-top',
          animated: !edge.inferred,
          style: {
            stroke: strokeColor,
            strokeWidth: hasErrors ? 2.5 : 1.8,
            strokeDasharray: edge.inferred ? '2 4' : hasErrors ? '4 2' : undefined,
          },
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
        };
      });


      setNodes(flowNodes);
      setEdges(flowEdges);
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

  // Rearrange: adaptively re-compute layout according to window dimensions,
  // aspect ratio, and zoom level. Toggles between horizontal and vertical flow
  // and smoothly centers the graph.
  const handleRearrange = () => {
    const { width, height } = getContainerSize();
    const currentZoom = flowInstanceRef.current?.getZoom() || 1;

    // Toggle orientation or re-adapt dynamically
    const nextDir: 'LR' | 'TB' = layoutDirection === 'LR' ? 'TB' : 'LR';

    const { positions, direction } = computeLayoutMap(
      nodes.map((n: any) => n.id),
      edges.map((e: any) => ({ source: e.source, target: e.target })),
      {
        containerWidth: width,
        containerHeight: height,
        zoom: currentZoom,
        direction: nextDir,
      }
    );
    setLayoutDirection(direction);

    // Update node positions
    setNodes((prev: any[]) =>
      prev.map((n) => ({
        ...n,
        position: positions.get(n.id) ?? n.position,
      }))
    );

    // Update edge source/target handles to match the new layout direction
    setEdges((prev: any[]) =>
      prev.map((e) => ({
        ...e,
        sourceHandle: direction === 'LR' ? 'source-right' : 'source-bottom',
        targetHandle: direction === 'LR' ? 'target-left' : 'target-top',
      }))
    );

    // Smoothly animate fitView to the newly rearranged layout
    setTimeout(() => {
      flowInstanceRef.current?.fitView({
        padding: 0.15,
        maxZoom: 1,
        duration: 350,
      });
    }, 50);
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
    if (!activeId) return edges;
    return edges.map((e: any) => {
      const keep = e.source === activeId || e.target === activeId;
      return keep
        ? e
        : { ...e, label: undefined, labelStyle: undefined, labelBgStyle: undefined, style: { ...(e.style || {}), opacity: 0.06 } };
    });
  }, [edges, activeId]);

  const orphanCount = useMemo(
    () => nodes.filter((n: any) => !edges.some((e: any) => e.source === n.id || e.target === n.id)).length,
    [nodes, edges]
  );

  if (loading && nodes.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center min-h-[600px]">
        <LoadingSpinner message="Reconstructing eBPF service mesh topology..." size="lg" />
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

        {/* Legend */}
        <div className="hidden md:flex items-center gap-3 px-3 py-1.5 rounded-md bg-slate-900/80 border border-slate-700/70 text-[11px] font-mono">
          <div className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-cyan-400 animate-pulse" />
            <span className="text-slate-300">Healthy Flow</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-rose-500" />
            <span className="text-slate-300">Errors (&gt;1%)</span>
          </div>
        </div>

        {/* Layout Rearrange & Toggle Button */}
        <button
          onClick={handleRearrange}
          className="hidden sm:flex items-center gap-1.5 px-2.5 py-1.5 rounded-md bg-slate-900/90 hover:bg-slate-800 border border-slate-700/80 text-[11px] font-mono text-slate-300 hover:text-cyan-400 transition"
          title={`Rearrange layout (Current: ${layoutDirection === 'LR' ? 'Horizontal' : 'Vertical'} — Click to adapt & toggle)`}
        >
          <LayoutGrid className="w-3.5 h-3.5 text-cyan-400" />
          <span>{layoutDirection === 'LR' ? 'Horizontal Flow' : 'Vertical Flow'}</span>
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
            <Controls className="!bg-slate-900/90 !border !border-slate-700 !rounded-md ! overflow-hidden">
              <ControlButton
                onClick={handleRearrange}
                title={`Rearrange layout (${layoutDirection === 'LR' ? 'Horizontal → Click for Vertical' : 'Vertical → Click for Horizontal'})`}
              >
                <LayoutGrid className="w-3.5 h-3.5" />
              </ControlButton>
            </Controls>
            <MiniMap
              nodeStrokeWidth={3}
              zoomable
              pannable
              className="!bg-slate-900/90 !border !border-slate-800 !rounded-md overflow-hidden !"
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
      {selectedNodeId && (
        <NodeDetailPanel
          serviceName={selectedNodeId}
          onClose={() => setSelectedNodeId(null)}
        />
      )}
    </div>
  );
};
