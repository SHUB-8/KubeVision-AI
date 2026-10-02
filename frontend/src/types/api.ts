export interface HealthResponse {
  status: string;
  prometheus: string;
  loki: string;
  tempo: string;
  k8s: string;
}

/**
 * Where a number came from. A p95 computed from a handful of sampled spans and
 * a histogram_quantile over every request on the wire are not the same evidence
 * and must not look identical on screen.
 *   metrics   - measured by eBPF/Beyla, read from Prometheus (full request stream)
 *   traces    - derived by the backend from sampled Tempo spans
 *   estimated - borrowed from a peer's measured rate, not observed on this edge
 * Absent (undefined) means "no data" and must render as such, never as 0.
 */
export type MetricSource = 'metrics' | 'traces' | 'estimated';

export interface Node {
  id: string;
  label: string;
  type: string;
  namespace: string;
  protocol?: string;
  rate?: number;
  errorRate?: number;
  latencyP95?: number;
  rateSource?: MetricSource;
  latencySource?: MetricSource;
  labels?: Record<string, string>;
}

export interface Edge {
  id: string;
  source: string;
  target: string;
  protocol?: string;
  rate?: number;
  errorRate?: number;
  latencyP95?: number;
  rateSource?: MetricSource;
  latencySource?: MetricSource;
  /** True on links from the static fallback map (no peer telemetry). */
  inferred?: boolean;
}

export interface Topology {
  nodes: Node[];
  edges: Edge[];
}

export interface Service {
  name: string;
  namespace: string;
  status: string;
  replicas: number;
  ready: number;
  labels?: Record<string, string>;
  rate: number;
  errorRate: number;
  latencyP95: number;
}

export interface Endpoint {
  service: string;
  path: string;
  method?: string;
  latencyP50: number;
  latencyP95: number;
  latencyP99: number;
  rate: number;
  errorRate: number;
  rateSource?: MetricSource;
  latencySource?: MetricSource;
}

export interface Span {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  operationName: string;
  serviceName: string;
  startTime: number;
  duration: number; // in nanoseconds or microseconds
  statusCode: string;
  attributes?: Record<string, string>;
}

export interface Trace {
  traceId: string;
  rootServiceName?: string;
  rootTraceName?: string;
  durationMs?: number;
  spanCount?: number;
  spans: Span[];
}

export interface LogEntry {
  timestamp: string;
  stream: string;
  labels?: Record<string, string>;
  line: string;
}

export interface PodInfo {
  name: string;
  namespace: string;
  status: string;
  node: string;
  ip: string;
  restarts: number;
  age: string;
}

export interface ClusterInfo {
  name: string;
  version: string;
  node: string;
  status: string;
  pods?: PodInfo[];
}

export interface ThresholdSettings {
  errorRateWarning: number;
  errorRateCritical: number;
  latencyWarning: number;
  latencyCritical: number;
  cpuWarning: number;
  cpuCritical: number;
  memoryWarning: number;
  memoryCritical: number;
}

export interface DisplaySettings {
  showAnnotations: boolean;
  showProtocolStats: boolean;
  showK8sMetadata: boolean;
}

export interface UISettings {
  theme: string;
  refreshInterval: number;
  timeWindow: string;
  namespace: string;
  thresholds: ThresholdSettings;
  display: DisplaySettings;
}

export interface Baseline {
  service: string;
  endpoint: string;
  metric: string;
  value: number;
  window: string;
  updatedAt: string;
}

export interface AnomalyEvent {
  id: string;
  timestamp: string;
  service: string;
  metric: string;
  stage1Score: number;
  stage2ZScore: number;
  confidenceGatePassed: boolean;
  severity: 'critical' | 'warning' | 'info';
  status: 'active' | 'analyzed' | 'resolved';
  summary: string;
}

export interface RCAReport {
  id: string;
  anomalyId: string;
  timestamp: string;
  service: string;
  title: string;
  executiveSummary: string;
  rootCauseHypothesis: string;
  blastRadius: string[];
  confidenceScore: number;
  reflectionPassed: boolean;
  evidenceGathered: {
    metrics: boolean;
    logs: boolean;
    k8sEvents: boolean;
    networkTraces: boolean;
  };
  supportingEvidence: {
    type: 'metric' | 'log' | 'trace' | 'k8s';
    description: string;
    refId?: string;
  }[];
  recommendedActions: string[];
  validationStatus: 'validated' | 'provisional';
}

export interface LLMConfig {
  role: string;
  provider: 'openai' | 'gemini' | 'groq' | 'ollama';
  model: string;
  temperature: number;
  maxTokens: number;
  fallbackProvider: string;
}
