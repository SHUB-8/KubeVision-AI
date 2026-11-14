import type { Edge, Node } from '../types/api';

export type TopologyErrorRole = 'origin' | 'inherited';

export interface TopologyCascade {
  /** Service id → measured error rate; only services that actually report errors. */
  failing: Map<string, number>;
  roles: Map<string, TopologyErrorRole>;
  /** Inherited service id → the downstream service whose failures explain it. */
  cause: Map<string, string>;
  /** Upstream → … → origin service chains, real cascades only (length ≥ 2). */
  chains: string[][];
}

/**
 * Attribute failures on the topology the same way the trace view does.
 *
 * Direction matters: an edge points caller → callee, so a failing service whose
 * *outgoing* call also fails inherited the failure from downstream. The service
 * at the end of that chain (no failing callee) is the origin. Only error rates
 * measured on the graph are used — traffic shape alone is not evidence.
 */
export function analyzeTopologyCascade(nodes: Node[], edges: Edge[]): TopologyCascade {
  const failing = new Map<string, number>();
  for (const node of nodes) {
    const rate = node.errorRate;
    if (typeof rate === 'number' && Number.isFinite(rate) && rate > 0) {
      failing.set(node.id, rate);
    }
  }

  const failingEdges = edges.filter(
    (edge) => typeof edge.errorRate === 'number' && edge.errorRate > 0
  );
  const roles = new Map<string, TopologyErrorRole>();
  const cause = new Map<string, string>();

  for (const id of failing.keys()) {
    const downstream = failingEdges
      .filter((edge) => edge.source === id && edge.target !== id && failing.has(edge.target))
      .sort((a, b) => (b.errorRate ?? 0) - (a.errorRate ?? 0))[0];
    if (downstream) {
      roles.set(id, 'inherited');
      cause.set(id, downstream.target);
    } else {
      roles.set(id, 'origin');
    }
  }

  const chains: string[][] = [];
  for (const [id, role] of roles) {
    if (role !== 'origin') continue;
    const chain = [id];
    const seen = new Set<string>(chain);
    let cursor = id;
    for (;;) {
      const upstream = failingEdges
        .filter(
          (edge) =>
            edge.target === cursor && roles.get(edge.source) === 'inherited' && !seen.has(edge.source)
        )
        .sort((a, b) => (b.errorRate ?? 0) - (a.errorRate ?? 0))[0];
      if (!upstream) break;
      chain.unshift(upstream.source);
      seen.add(upstream.source);
      cursor = upstream.source;
    }
    if (chain.length > 1) chains.push(chain);
  }
  chains.sort((a, b) => b.length - a.length);

  return { failing, roles, cause, chains };
}
