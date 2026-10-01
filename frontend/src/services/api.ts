import {
  HealthResponse,
  Topology,
  Service,
  Endpoint,
  Trace,
  LogEntry,
  ClusterInfo,
  UISettings,
  Baseline,
  AnomalyEvent,
  RCAReport,
} from '../types/api';

const BASE_URL = '/api/v1';

async function handleResponse<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let errorMsg = `HTTP Error ${res.status}: ${res.statusText}`;
    try {
      const json = await res.json();
      if (json.error) errorMsg = json.error;
    } catch {
      // ignore
    }
    throw new Error(errorMsg);
  }
  return res.json();
}

export const api = {
  async getHealth(): Promise<HealthResponse> {
    const res = await fetch(`${BASE_URL}/health`);
    return handleResponse<HealthResponse>(res);
  },

  async getTopology(namespace?: string, window?: string): Promise<Topology> {
    const params = new URLSearchParams();
    if (namespace) params.set('namespace', namespace);
    if (window) params.set('window', window);
    const res = await fetch(`${BASE_URL}/topology?${params.toString()}`);
    return handleResponse<Topology>(res);
  },

  async getServices(namespace?: string, window?: string): Promise<Service[]> {
    const params = new URLSearchParams();
    if (namespace) params.set('namespace', namespace);
    if (window) params.set('window', window);
    const res = await fetch(`${BASE_URL}/services?${params.toString()}`);
    return handleResponse<Service[]>(res);
  },

  async getServiceEndpoints(name: string, namespace?: string, window?: string): Promise<Endpoint[]> {
    const params = new URLSearchParams();
    if (namespace) params.set('namespace', namespace);
    if (window) params.set('window', window);
    const res = await fetch(`${BASE_URL}/services/${encodeURIComponent(name)}/endpoints?${params.toString()}`);
    return handleResponse<Endpoint[]>(res);
  },

  async getBaselines(serviceName: string, window?: string): Promise<Baseline[]> {
    const params = new URLSearchParams();
    if (window) params.set('window', window);
    const res = await fetch(`${BASE_URL}/services/${encodeURIComponent(serviceName)}/baselines?${params.toString()}`);
    return handleResponse<Baseline[]>(res);
  },

  async recalculateBaselines(namespace?: string, window?: string): Promise<{ status: string; message: string }> {
    const params = new URLSearchParams();
    if (namespace) params.set('namespace', namespace);
    if (window) params.set('window', window);
    const res = await fetch(`${BASE_URL}/baselines/recalculate?${params.toString()}`, {
      method: 'POST',
    });
    return handleResponse<{ status: string; message: string }>(res);
  },

  async getTraces(serviceName?: string, limit: number = 25): Promise<Trace[]> {
    const params = new URLSearchParams();
    if (serviceName) params.set('serviceName', serviceName);
    params.set('limit', limit.toString());
    const res = await fetch(`${BASE_URL}/traces?${params.toString()}`);
    return handleResponse<Trace[]>(res);
  },

  async getTraceDetail(traceId: string): Promise<Trace> {
    const res = await fetch(`${BASE_URL}/traces/${encodeURIComponent(traceId)}`);
    return handleResponse<Trace>(res);
  },

  async getLogs(params: {
    namespace?: string;
    pod?: string;
    filter?: string;
    limit?: number;
    start?: string;
    end?: string;
  }): Promise<LogEntry[]> {
    const query = new URLSearchParams();
    if (params.namespace) query.set('namespace', params.namespace);
    if (params.pod) query.set('pod', params.pod);
    if (params.filter) query.set('filter', params.filter);
    if (params.limit) query.set('limit', params.limit.toString());
    if (params.start) query.set('start', params.start);
    if (params.end) query.set('end', params.end);

    const res = await fetch(`${BASE_URL}/logs?${query.toString()}`);
    return handleResponse<LogEntry[]>(res);
  },

  async getConfig(): Promise<UISettings> {
    const res = await fetch(`${BASE_URL}/config`);
    return handleResponse<UISettings>(res);
  },

  async updateConfig(settings: UISettings): Promise<UISettings> {
    const res = await fetch(`${BASE_URL}/config`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(settings),
    });
    return handleResponse<UISettings>(res);
  },

  async getClusterInfo(): Promise<ClusterInfo> {
    const res = await fetch(`${BASE_URL}/cluster`);
    return handleResponse<ClusterInfo>(res);
  },
};

// Mock incidents data demonstrating the LangGraph 4-agent RCA pipeline
export const SAMPLE_INCIDENTS: AnomalyEvent[] = [
  {
    id: 'inc-9402',
    timestamp: '2026-10-01T17:15:20Z',
    service: 'checkoutservice',
    metric: 'http_server_request_duration_seconds',
    stage1Score: 0.94,
    stage2ZScore: 3.82,
    confidenceGatePassed: true,
    severity: 'critical',
    status: 'analyzed',
    summary: 'Sudden P95 latency spike (>850ms) with payment gateway timeout and cart lock contention.',
  },
  {
    id: 'inc-9388',
    timestamp: '2026-10-01T16:48:10Z',
    service: 'cartservice',
    metric: 'redis_connection_errors_total',
    stage1Score: 0.81,
    stage2ZScore: 2.14,
    confidenceGatePassed: false,
    severity: 'warning',
    status: 'resolved',
    summary: 'Intermittent socket drop between cartservice and redis-cart pod due to node network saturation.',
  },
];

export const SAMPLE_RCA_REPORTS: Record<string, RCAReport> = {
  'inc-9402': {
    id: 'rca-9402',
    anomalyId: 'inc-9402',
    timestamp: '2026-10-01T17:15:45Z',
    service: 'checkoutservice',
    title: 'Root Cause Analysis: Downstream Paymentservice gRPC Timeout Cascades to Checkout Saturation',
    executiveSummary: 'During load burst, checkoutservice experienced a 12x surge in P95 latency (from 14ms to 890ms). The LangGraph hybrid supervisor agent verified 4 of 4 telemetry sources, pinpointing a slow query in paymentservice triggering thread pool starvation.',
    rootCauseHypothesis: 'paymentservice unhandled latency spike caused upstream HTTP handler backpressure in checkoutservice, exhausting client connection pools across frontend and recommendation services.',
    blastRadius: ['checkoutservice', 'frontend', 'cartservice', 'paymentservice'],
    confidenceScore: 0.96,
    reflectionPassed: true,
    evidenceGathered: {
      metrics: true,
      logs: true,
      k8sEvents: true,
      networkTraces: true,
    },
    supportingEvidence: [
      {
        type: 'metric',
        description: 'Prometheus metric http_server_duration_seconds P95 exceeded baseline threshold by 610%.',
        refId: 'checkoutservice:p95:890ms',
      },
      {
        type: 'trace',
        description: 'Tempo distributed trace 84023fce shows span paymentservice.ChargeCard taking 740ms (83% of total request time).',
        refId: '84023fce5c507820b303d8e2e6cfa8',
      },
      {
        type: 'log',
        description: 'Loki logs recorded 14 occurrences of context deadline exceeded in checkoutservice stdout.',
        refId: 'log:deadline_exceeded',
      },
      {
        type: 'k8s',
        description: 'K8s events report 0 OOMKills, but 2 readiness probe degradations on paymentservice-7c98b.',
        refId: 'probe_degradation',
      },
    ],
    recommendedActions: [
      'Scale paymentservice replicas from 1 to 3 to alleviate concurrency bottleneck.',
      'Adjust gRPC client timeout in checkoutservice from 1500ms to 600ms with circuit breaker.',
      'Audit paymentservice authorization token validation latency.',
    ],
    validationStatus: 'validated',
  },
};
