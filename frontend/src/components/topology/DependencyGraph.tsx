import React, { useState, useEffect, useMemo, useCallback } from 'react';
import dagre from '@dagrejs/dagre';
import {
  ReactFlow,
  MiniMap,
  Controls,
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
  const [filterQuery, setFilterQuery] = useState<string>('');
  // True when the API returned no peer edges and we fell back to the known
  // boutique dependency map. Those links are structural only: their rates are
  // unknown, so the UI must say so rather than invent numbers.
  const [usingStaticMap, setUsingStaticMap] = useState<boolean>(false);

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
      let rawEdges = topoData.edges || [];

      // If eBPF has not emitted cross-service peer spans yet, infer topology links between discovered nodes
      if (rawEdges.length === 0 && rawNodes.length > 0) {
        const nodeSet = new Set(rawNodes.map((n) => n.id));
        const defaultLinks = [
          { source: 'loadgenerator', target: 'frontend', protocol: 'HTTP/1.1' },
          { source: 'frontend', target: 'checkoutservice', protocol: 'gRPC' },
          { source: 'frontend', target: 'cartservice', protocol: 'gRPC' },
          { source: 'frontend', target: 'productcatalogservice', protocol: 'gRPC' },
          { source: 'frontend', target: 'recommendationservice', protocol: 'gRPC' },
          { source: 'frontend', target: 'currencyservice', protocol: 'gRPC' },
          { source: 'frontend', target: 'shippingservice', protocol: 'gRPC' },
          { source: 'frontend', target: 'adservice', protocol: 'gRPC' },
          { source: 'checkoutservice', target: 'paymentservice', protocol: 'gRPC' },
          { source: 'checkoutservice', target: 'emailservice', protocol: 'gRPC' },
          { source: 'checkoutservice', target: 'cartservice', protocol: 'gRPC' },
          { source: 'cartservice', target: 'redis-cart', protocol: 'TCP' },
          { source: 'recommendationservice', target: 'productcatalogservice', protocol: 'gRPC' },
        ];

        rawEdges = defaultLinks
          .filter((link) => nodeSet.has(link.source) && nodeSet.has(link.target))
          .map((link) => ({
            id: `${link.source}-${link.target}`,
            source: link.source,
            target: link.target,
            protocol: link.protocol,
            // No peer telemetry means the rate is unknown, not zero and
            // certainly not a made-up fraction of the caller's rate.
            rate: 0,
            errorRate: 0,
            inferred: true,
          }));
      }
      setUsingStaticMap(rawEdges.length > 0 && rawEdges.every((e: any) => e.inferred));

      // Layout: dagre layered DAG (left-to-right). Handles orphans, uneven
      // columns and edge crossings; the heuristic rank map could not.
      const NODE_W = 248;
      const NODE_H = 108;
      const g = new dagre.graphlib.Graph();
      g.setGraph({ rankdir: 'LR', nodesep: 44, ranksep: 96, edgesep: 24, marginx: 24, marginy: 24 });
      g.setDefaultEdgeLabel(() => ({}));
      rawNodes.forEach((n) => g.setNode(n.id, { width: NODE_W, height: NODE_H }));
      rawEdges.forEach((e) => {
        if (g.hasNode(e.source) && g.hasNode(e.target)) g.setEdge(e.source, e.target);
      });
      dagre.layout(g);

            // Compute X and Y
      const flowNodes: FlowNode[] = rawNodes.map((node) => {
        const pos = g.node(node.id);
        const svc = serviceMap.get(node.id);

        return {
          id: node.id,
          type: 'serviceNode',
          position: { x: (pos?.x ?? 0) - NODE_W / 2, y: (pos?.y ?? 0) - NODE_H / 2 },
          data: {
            label: node.label || node.id,
            type: node.type,
            namespace: node.namespace || activeNamespace,
            protocol: node.protocol || (node.id.includes('redis') ? 'TCP' : 'gRPC'),
            rate: svc?.rate || 0,
            errorRate: svc?.errorRate || 0,
            latencyP95: svc?.latencyP95 || 0,
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
        } else if (edge.rate && edge.rate > 0) {
          edgeLabel = `${edge.rate.toFixed(1)} req/s`;
        }

        return {
          id: edge.id,
          source: edge.source,
          target: edge.target,
          animated: !edge.inferred,
          style: {
            stroke: strokeColor,
            strokeWidth: hasErrors ? 2.5 : 1.8,
            strokeDasharray: edge.inferred ? '2 4' : hasErrors ? '4 2' : undefined,
          },
          label: edgeLabel,
          labelStyle: {
            fill: edge.inferred ? '#8b98ad' : hasErrors ? '#f8a199' : '#b6c2d4',
            fontSize: 12,
            fontFamily: '"IBM Plex Mono", monospace',
            fontWeight: 500,
          },
          labelBgStyle: {
            fill: 'var(--color-slate-950)',
            fillOpacity: 0.9,
          },
          labelBgPadding: [6, 2],
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
  }, [activeNamespace, timeWindow, setNodes, setEdges]);

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
          <div className="flex items-center gap-1.5">
            <span className="px-1 py-0.2 rounded bg-slate-800 text-cyan-300 border border-slate-700 text-[9px]">
              gRPC
            </span>
            <span className="text-slate-400">eBPF Discovered</span>
          </div>
        </div>
      </div>

      {/* React Flow Viewport */}
      <div className="flex-1 w-full h-full">
        {usingStaticMap && (
          <div className="absolute top-16 left-4 z-20 max-w-md px-3 py-2 rounded-md bg-amber-500/10 border border-amber-500/30 text-[11px] font-mono text-amber-200">
            No eBPF peer telemetry yet — showing the known boutique dependency map.
            Links are structural only, so rates and error rates are unavailable.
          </div>
        )}
        {nodes.length === 0 ? (
          <EmptyState
            title="No Services Discovered"
            description={`No microservices with active traffic found in namespace "${activeNamespace}".`}
            actionText="Refresh"
            onAction={fetchTopologyData}
          />
        ) : (
          <ReactFlow
            nodes={filteredNodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onNodeClick={onNodeClick}
            nodeTypes={nodeTypes as any}
            fitView
            fitViewOptions={{ padding: 0.15, maxZoom: 1 }}
            minZoom={0.35}
            maxZoom={1.8}
            className="bg-[#090d16]"
          >
            <Background color="#1e293b" gap={24} size={1} />
            <Controls className="!bg-slate-900/90 !border !border-slate-700 !rounded-md ! overflow-hidden" />
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
