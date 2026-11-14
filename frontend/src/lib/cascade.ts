import type { Span, Trace } from '../types/api';
import { isFailingSpan } from './trace';

export type ErrorRole = 'origin' | 'propagated';

export interface CascadeStep {
  service: string;
  operationName: string;
  spanId: string;
}

export interface CascadeInfo {
  /** How many spans recorded a failure. */
  failingCount: number;
  /** spanId → whether it started the failure or merely inherited it. */
  roles: Map<string, ErrorRole>;
  /** Deepest span that recorded the failure (this is the one with a status message). */
  origin: Span | null;
  /**
   * Where the cause actually lives. A failing span is usually the *caller's*
   * client span: the eBPF collector often observes the callee's server span
   * without a status, so the callee never appears in the failing set. Attribution
   * therefore follows the failing call down to the callee's server span when the
   * trace contains one.
   */
  culprit: Span | null;
  /** Service path root → culprit, consecutive duplicates collapsed. */
  chain: CascadeStep[];
}

const depthOf = (span: Span, byId: Map<string, Span>): number => {
  let depth = 0;
  let cursor: Span | undefined = span;
  const seen = new Set<string>();
  while (cursor?.parentSpanId && !seen.has(cursor.spanId)) {
    seen.add(cursor.spanId);
    cursor = byId.get(cursor.parentSpanId);
    if (cursor) depth += 1;
  }
  return depth;
};

/**
 * Separate a cascading failure into the span that caused it and the spans that
 * only inherited it.
 *
 * Logs cannot answer this: an upstream service typically returns the failure
 * without logging it, so "error logs" for the victim are legitimately empty
 * while the callee logged the actual reason. The trace hierarchy plus the
 * callee server span is what carries the cause.
 */
export function analyzeCascade(trace: Trace): CascadeInfo {
  const spans = trace.spans ?? [];
  const byId = new Map(spans.map((span) => [span.spanId, span]));
  const children = new Map<string, Span[]>();
  for (const span of spans) {
    if (!span.parentSpanId) continue;
    const list = children.get(span.parentSpanId) ?? [];
    list.push(span);
    children.set(span.parentSpanId, list);
  }

  const roles = new Map<string, ErrorRole>();
  const failing = spans.filter(isFailingSpan);
  if (failing.length === 0) {
    return { failingCount: 0, roles, origin: null, culprit: null, chain: [] };
  }

  const inheritsFailure = (span: Span): boolean => {
    const stack = [...(children.get(span.spanId) ?? [])];
    const seen = new Set<string>();
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (seen.has(current.spanId)) continue;
      seen.add(current.spanId);
      if (isFailingSpan(current)) return true;
      stack.push(...(children.get(current.spanId) ?? []));
    }
    return false;
  };

  let origin: Span | null = null;
  let originDepth = -1;
  for (const span of failing) {
    const inherited = inheritsFailure(span);
    roles.set(span.spanId, inherited ? 'propagated' : 'origin');
    if (inherited) continue;
    // Prefer the deepest leaf failure, and among equals the span that recorded
    // a status message — that is the one carrying the human-readable cause.
    const depth = depthOf(span, byId);
    const better =
      depth > originDepth ||
      (depth === originDepth && !!span.statusMessage && !origin?.statusMessage);
    if (better) {
      origin = span;
      originDepth = depth;
    }
  }

  // The caller's client span fails; the callee's server span is the culprit even
  // when the collector left its status unset.
  const callee = origin
    ? (children.get(origin.spanId) ?? []).find(
        (child) => child.kind === 'server' && child.serviceName !== origin!.serviceName
      )
    : undefined;
  const culprit = callee ?? origin;

  const chain: CascadeStep[] = [];
  if (origin) {
    const path: Span[] = [];
    let cursor: Span | undefined = origin;
    const seen = new Set<string>();
    while (cursor && !seen.has(cursor.spanId)) {
      seen.add(cursor.spanId);
      path.unshift(cursor);
      cursor = cursor.parentSpanId ? byId.get(cursor.parentSpanId) : undefined;
    }
    if (callee) path.push(callee);
    for (const step of path) {
      const last = chain[chain.length - 1];
      // Repeated hops inside one process are one step: keep the deepest
      // operation name for that service.
      if (last && last.service === step.serviceName) {
        last.operationName = step.operationName;
        last.spanId = step.spanId;
        continue;
      }
      chain.push({ service: step.serviceName, operationName: step.operationName, spanId: step.spanId });
    }
  }

  return { failingCount: failing.length, roles, origin, culprit, chain };
}
